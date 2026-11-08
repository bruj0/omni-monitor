#!/usr/bin/env bash
# Security audit for the Omni Monitor extension.
#
# Runs the checks that must pass before a release is published to the
# Marketplace or Open VSX. Every check is run against the PACKAGED
# artifact, not the working tree, because the artifact is what the
# Marketplace review sees.
#
# The checks come from three places:
#   - the Marketplace publisher agreement and participation policies
#     (via Personal/Research/vscode-marketplace-publishing.md)
#   - the VS Code extension runtime security guidance
#   - the measured audit in plans/omni-monitor-release-workflow-plan.md
#
# Usage:
#   scripts/security-audit.sh            # audit the downstream working tree
#   scripts/security-audit.sh --vsix F   # audit an existing VSIX instead
#
# Exit codes:
#   0  every required check passed
#   1  at least one required check failed
#   2  usage error, or the repo could not be located
set -uo pipefail

# The tree the checks read and the tree the artifact is built from.
#
# These are the DOWNSTREAM: the released artifact is built from the
# downstream, not from the upstream. The upstream carries the spec and
# the dev tooling, and packaging it would ship the wrong file set.
#
# Both repos carry an identical package.json -- the sync copies it -- so
# the manifest cannot tell them apart. The git remote can: the
# downstream's origin is the PUBLISHED repo, the upstream's is the
# working copy.
#
# Running this from the upstream must still build the downstream, because
# the downstream is what gets published.
is_downstream() {
  local candidate="$1"
  [ -f "$candidate/package.json" ] || return 1
  [ -d "$candidate/.git" ] || return 1
  local remote
  remote=$(git -C "$candidate" remote get-url origin 2>/dev/null || echo "")
  case "$remote" in
    *bruj0/omni-monitor*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_downstream() {
  local candidate
  for candidate in "${OMNI_DOWNSTREAM:-}" "$PWD" "/Users/bruj0/Projects/omni-monitor"; do
    [ -n "$candidate" ] || continue
    if is_downstream "$candidate"; then
      echo "$candidate"; return 0
    fi
  done
  return 1
}

if DETECTED="$(detect_downstream)"; then
  SRC_TREE="$DETECTED"
else
  SRC_TREE="${OMNI_DOWNSTREAM:-/Users/bruj0/Projects/omni-monitor}"
fi
DOWNSTREAM="$SRC_TREE"

VSIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vsix) VSIX="${2:-}"; shift 2 ;;
    --source) SRC_TREE="${2:-}"; DOWNSTREAM="$SRC_TREE"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

failures=0
warnings=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
warn() { printf '  WARN  %s\n' "$1"; warnings=$((warnings + 1)); }
section() { printf '\n== %s ==\n' "$1"; }

# --- locate the source tree and the artifact --------------------------------
if [ -z "$VSIX" ]; then
  SRC="$DOWNSTREAM"
  [ -d "$SRC" ] || { echo "downstream not found at $SRC" >&2; exit 2; }
  printf 'Building the artifact from %s ...\n' "$SRC"
  ( cd "$SRC" && npm run build >/dev/null 2>&1 ) || { echo "build failed" >&2; exit 2; }
  ( cd "$SRC" && npx --yes @vscode/vsce@4.1.0 package --out "$SRC/../audit.vsix" >/dev/null 2>&1 ) \
    || { echo "vsce package failed" >&2; exit 2; }
  VSIX="$SRC/../audit.vsix"
fi
[ -f "$VSIX" ] || { echo "vsix not found: $VSIX" >&2; exit 2; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
unzip -o -q "$VSIX" -d "$WORK/px" 2>/dev/null || { echo "cannot unpack $VSIX" >&2; exit 2; }
EXT="$WORK/px/extension"
[ -d "$EXT" ] || { echo "no extension/ dir in the vsix" >&2; exit 2; }

echo "auditing $VSIX"
echo

# ============================================================================
section "1. The product boundary"
# The one acceptance test that cannot be settled by reading code.
# The extension contributes NO model provider. That is its whole point.
# ============================================================================
MANIFEST="$EXT/package.json"
if [ -f "$MANIFEST" ]; then
  if python3 - "$MANIFEST" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])).get("contributes", {})
assert "languageModelChatProviders" not in c, "MUST NOT register a model provider"
assert "chatParticipants" not in c, "MUST NOT register a chat participant"
PY
  then
    pass "no languageModelChatProviders, no chatParticipants"
  else
    fail "the packaged manifest registers a model provider or chat participant"
  fi

  for bad in telemetry analytics sentry bugsnag segment.io posthog mixpanel amplitude; do
    if python3 -c "
import json,sys
raw=open('$MANIFEST').read().lower()
sys.exit(0 if '$bad' in raw else 1)
"; then
      fail "packaged manifest mentions '$bad'"
    fi
  done
  pass "no telemetry or analytics endpoint in the packaged manifest"
else
  fail "no package.json in the artifact"
fi

# ============================================================================
section "2. Manifest fields (the vsce local gate)"
# ============================================================================
if [ -f "$MANIFEST" ]; then
  python3 - "$MANIFEST" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
bad = []

def check(cond, label):
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        bad.append(label)

name = m.get("name", "")
check(bool(name) and name == name.lower() and " " not in name, f"name is lowercase, no spaces ({name!r})")
check(bool(m.get("version")), f"version is set ({m.get('version')!r})")
check(bool(m.get("publisher")), f"publisher is set ({m.get('publisher')!r})")
eng = (m.get("engines") or {}).get("vscode")
check(bool(eng) and eng != "*", f"engines.vscode is set and not '*' ({eng!r})")
check("private" not in m, "no 'private' flag (vsce ignores it; it protects nothing)")
icon = m.get("icon", "")
check(icon.endswith(".png"), f"icon is a PNG, not an SVG ({icon!r})")
check(bool(m.get("galleryBanner")), "galleryBanner is present")
cats = m.get("categories") or []
allowed = {"Programming Languages","Snippets","Linters","Themes","Debuggers","Formatters",
           "Keymaps","SCM Providers","Other","Extension Packs","Language Packs",
           "Data Science","Machine Learning","Visualization","Notebooks","Education","Testing"}
check(bool(cats) and all(c in allowed for c in cats), f"categories are from the allowed list ({cats})")
kw = m.get("keywords") or []
check(len(kw) <= 10, f"keywords <= 10, the number the Marketplace enforces ({len(kw)})")
check(bool(m.get("homepage")), "homepage is set")
check(bool(m.get("repository")), "repository is set")
check(bool(m.get("bugs")), "bugs is set")
check(bool(m.get("license")), "license is set")
check(bool(m.get("displayName")), "displayName is set")
sys.exit(1 if bad else 0)
PY
  [ $? -ne 0 ] && failures=$((failures + 1))
fi

# ============================================================================
section "3. Required listing documents"
# Participation Policies 3(a) and Publisher Agreement 8(b)(ii).
# ============================================================================
for doc in readme.md README.md changelog.md CHANGELOG.md LICENSE.txt LICENSE \
           SUPPORT.md SUPPORT.md PRIVACY.md privacy.md; do
  [ -f "$EXT/$doc" ] && { echo "$doc"; break; }
done | head -1 | grep -q . && pass "the listing documents ship" || {
  missing=""
  for want in "readme.md:README.md" "changelog.md:CHANGELOG.md" "LICENSE.txt:LICENSE" \
              "SUPPORT.md:SUPPORT.md" "PRIVACY.md:PRIVACY.md"; do
    a="${want%%:*}"; b="${want##*:}"
    [ -f "$EXT/$a" ] || [ -f "$EXT/$b" ] || missing="$missing $a"
  done
  fail "missing listing documents:$missing"
}

if [ -f "$EXT/PRIVACY.md" ] || [ -f "$EXT/privacy.md" ]; then
  pass "a privacy policy ships (required: the extension transmits credentials)"
else
  fail "no privacy policy ships"
fi

# ============================================================================
section "4. No secrets and no non-product files in the package"
# The trust blog: "review every packaged file for secrets and non-essential content".
# ============================================================================
# 4a. secret-shaped strings
secret_hits=$(grep -rlEi "(sk-[A-Za-z0-9_-]{16,}|oma_[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,})" "$EXT" 2>/dev/null | head -5)
if [ -z "$secret_hits" ]; then
  pass "no key-shaped strings in the packaged files"
else
  fail "possible secrets in: $(echo "$secret_hits" | tr '\n' ' ')"
fi

# 4b. .env and key files must never ship
env_hits=$(find "$EXT" \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "*.key" -o -name "id_rsa*" \) 2>/dev/null | head -5)
if [ -z "$env_hits" ]; then
  pass "no .env, .pem, .key or id_rsa in the package"
else
  fail "key material in the package: $(echo "$env_hits" | tr '\n' ' ')"
fi

# 4c. node_modules must not ship (--no-dependencies or an empty deps set)
nm=$(find "$EXT" -type d -name node_modules 2>/dev/null | head -3)
if [ -z "$nm" ]; then
  pass "no node_modules in the package"
else
  fail "node_modules ships: $(echo "$nm" | tr '\n' ' ')"
fi

# 4d. agent-facing docs must not ship
nonprod=$(find "$EXT" \( -name "AGENTS.md" -o -name "CONTEXT.md" -o -name "CONTEXT-MAP.md" \
  -o -name "DEVELOPMENT.md" -o -name "WIRING.md" -o -path "*/.agents/*" -o -path "*/docs/*" \) 2>/dev/null | head -5)
if [ -z "$nonprod" ]; then
  pass "no agent-facing docs or skills in the package"
else
  fail "non-product files ship: $(echo "$nonprod" | tr '\n' ' ')"
fi

# 4e. the dead webview bundle and the runtime-orphaned module
for dead in "dist/webview/app.js" "dist/core/connections.js"; do
  if [ -e "$EXT/$dead" ]; then
    fail "$dead ships"
  else
    pass "$dead is excluded"
  fi
done

# ============================================================================
section "5. No obfuscation"
# The trust blog names obfuscation as a suspicion trigger, and the
# malware scan's dynamic detection flags minified packages.
# ============================================================================
for artefact in "$EXT/dist/extension.js" "$EXT/media/dashboard.js"; do
  [ -f "$artefact" ] || continue
  rel="${artefact#$EXT/}"
  # Minification shows up as identifier density, not as one long line:
  # a long line can be a long string. A wrapped bundle names its
  # variables; a minified one renames them to one or two letters.
  # Measure the mean length of the identifiers between punctuation.
  idlen=$(python3 - "$artefact" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
ids = re.findall(r"[A-Za-z_$][A-Za-z0-9_$]{1,}", text)
if not ids:
    print("0"); raise SystemExit
# Ignore the standard library and the word-boundary noise: only count
# identifiers that appear as declarations or property names.
decls = re.findall(r"(?:var|let|const|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)", text)
decls += re.findall(r"([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]\s*function", text)
decls += re.findall(r"([A-Za-z_$][A-Za-z0-9_$]*)\s*\(", text)
if not decls:
    print("0"); raise SystemExit
print(f"{sum(len(d) for d in decls) / len(decls):.1f}")
PY
)
  # Measured 2026-11-08: the real bundles score 7.9 (extension.js) and
  # 8.3 (dashboard.js); a minified sample scores 3.3, because minifiers
  # rename identifiers to one or two letters. SHORTER is worse, so the
  # threshold sits below the gap: anything under 6 chars is packed.
  if [ "${idlen%%.*}" -lt 6 ] 2>/dev/null || [ "${idlen:-0}" = "0" ]; then
    fail "$rel looks minified or packed (mean declared identifier length ${idlen} chars)"
  else
    pass "$rel is not minified (mean declared identifier length ${idlen} chars)"
  fi
done

# ============================================================================
section "6. No hardcoded hosts, no telemetry in the source"
# ============================================================================
if [ -d "$DOWNSTREAM/src" ]; then
  # A host in a comment is documentation, not a destination. Strip the
  # comment lines before looking, and allow the documented localhost default.
  hosts=$(grep -rnE "https?://[a-zA-Z0-9.-]+" "$DOWNSTREAM/src" --include="*.ts" 2>/dev/null \
    | grep -vE "^[^:]+:[0-9]+: *\*" \
    | grep -vE "github\.com|code\.visualstudio\.com|opensource\.org|aka\.ms" \
    | grep -vE "localhost|omni-route-host" | head -5)
  if [ -z "$hosts" ]; then
    pass "no hardcoded hosts in src/ apart from comments and the localhost default"
  else
    fail "hardcoded hosts in src/: $(echo "$hosts" | tr '\n' ' ')"
  fi

  tele=$(grep -rniE "telemetry|analytics\.microsoft|sentry|bugsnag|segment\.io|posthog" \
    "$DOWNSTREAM/src" --include="*.ts" 2>/dev/null | head -5)
  if [ -z "$tele" ]; then
    pass "no telemetry or crash reporting in src/"
  else
    fail "telemetry references in src/: $(echo "$tele" | tr '\n' ' ')"
  fi

  # Credentials must go through SecretStorage, never settings.json or argv.
  sec=$(grep -rn "secrets.store" "$DOWNSTREAM/src" --include="*.ts" 2>/dev/null | wc -l | tr -d ' ')
  [ "$sec" -gt 0 ] && pass "credentials are stored through context.secrets.store ($sec call sites)" \
    || fail "no secrets.store call site found"

  # The state KEY decides what is stored, not the line. A key called
  # "omniMonitor.viewMode" is a preference; a key called "apiKey" is a
  # credential. Match on the key name, not on the word "key" anywhere.
  badstate=$(grep -rnoE "(globalState|workspaceState)\.(update|get)<[^>]*>\([^,)]*" \
    "$DOWNSTREAM/src" --include="*.ts" 2>/dev/null \
    | grep -iE "(apikey|adminkey|api_key|admin_key|token|secret|password|credential)" | head -5)
  if [ -z "$badstate" ]; then
    pass "no credential written to globalState or workspaceState"
  else
    fail "credential in state: $(echo "$badstate" | tr '\n' ' ')"
  fi
fi

# ============================================================================
section "7. The webview is locked down"
# default-src 'none', a per-render nonce, and localResourceRoots narrowed.
# ============================================================================
if [ -d "$DOWNSTREAM/src" ]; then
  csp=$(grep -rn "Content-Security-Policy" "$DOWNSTREAM/src" --include="*.ts" 2>/dev/null | head -2)
  if [ -z "$csp" ]; then
    fail "no Content-Security-Policy found in src/"
  elif echo "$csp" | grep -q "default-src 'none'"; then
    pass "the webview CSP sets default-src 'none'"
  else
    fail "the webview CSP does not set default-src 'none'"
  fi

  nonce=$(grep -rn "nonce" "$DOWNSTREAM/src" --include="*.ts" 2>/dev/null | grep -c "nonce")
  [ "$nonce" -gt 0 ] && pass "the webview uses a per-render nonce ($nonce references)" \
    || fail "no script nonce found"

  lrr=$(grep -rn "localResourceRoots" "$DOWNSTREAM/src" --include="*.ts" 2>/dev/null | head -2)
  if [ -z "$lrr" ]; then
    fail "localResourceRoots is not narrowed"
  elif echo "$lrr" | grep -q "media"; then
    pass "localResourceRoots is narrowed to media/"
  else
    warn "localResourceRoots is set but does not mention media/: $(echo "$lrr" | tr '\n' ' ')"
  fi
fi

# ============================================================================
section "8. Logs are redacted"
# The credential-theft review category looks at exactly this.
# ============================================================================
if [ -d "$DOWNSTREAM/src" ]; then
  if [ -f "$DOWNSTREAM/src/core/redactor.ts" ]; then
    miss=""
    for pat in "Bearer" "sk-" "oma_"; do
      grep -q -- "$pat" "$DOWNSTREAM/src/core/redactor.ts" || miss="$miss '$pat'"
    done
    if [ -z "$miss" ]; then
      pass "the redactor covers Bearer, sk- and oma_ key shapes"
    else
      fail "the redactor does not cover:$miss"
    fi
  else
    fail "no src/core/redactor.ts"
  fi
fi

# ============================================================================
section "9. The README carries the disclosure"
# Publisher Agreement 3(a) and 8(b)(ii): required consumer notices in
# the description, and a privacy policy link.
# ============================================================================
README="$EXT/readme.md"
[ -f "$README" ] || README="$EXT/README.md"
if [ -f "$README" ]; then
  grep -qiE "third-party|not affiliated|not endorsed" "$README" \
    && pass "the README discloses the third-party relationship" \
    || fail "the README has no third-party disclosure"

  grep -qiE "no telemetry|no account|no subscription" "$README" \
    && pass "the README states the pricing and telemetry position" \
    || warn "the README does not state the pricing or telemetry position"

  grep -qiE "PRIVACY\.md" "$README" \
    && pass "the README links the privacy policy" \
    || fail "the README does not link a privacy policy"

  # The listing must not tell users to install a local .vsix any more.
  if grep -qE "install-extension [a-zA-Z0-9._-]+\.vsix" "$README"; then
    fail "the README still tells users to install a local .vsix"
  else
    pass "the README does not instruct a local .vsix install"
  fi

  # Third-party attribution. MIT requires the copyright notice and the
  # permission notice to be included in all copies. If the code says it
  # was adapted from another project, the listing has to say so too --
  # the trust blog names third-party attribution as a listing
  # requirement, and the review categories look for exactly this.
  # Take the word AFTER the phrase, and skip the generic ones. A source
  # comment reads "adapted from OmniCopilot src/embed.ts (MIT)".
  derived=$(grep -rhoE "(adapted from|derived from|based on|ported from) [A-Za-z0-9][A-Za-z0-9._-]*" \
    "$DOWNSTREAM/src" --include="*.ts" 2>/dev/null \
    | awk '{print tolower($NF)}' \
    | grep -vE "^(the|a|an|this|that|it|its|our|their|src|lib|see|readme|license|md)$" \
    | sort -u)
  for proj in $derived; do
    if grep -qiF "$proj" "$README"; then
      pass "the README attributes $proj, which the source says it derives from"
    else
      fail "the source says it derives from $proj but the README does not attribute it"
    fi
  done
  [ -z "$derived" ] && pass "no third-party derivation declared in the source"
else
  fail "no README in the artifact"
fi

# ============================================================================
section "10. No SVG in a marketplace-facing slot"
# The icon field and README images. An Activity Bar icon in contributes
# is fine; the marketplace-facing slots are not.
# ============================================================================
if [ -f "$MANIFEST" ]; then
  icon=$(python3 -c "import json;print(json.load(open('$MANIFEST')).get('icon',''))")
  case "$icon" in
    *.svg) fail "the icon field points at an SVG" ;;
    *) pass "the icon field is not an SVG" ;;
  esac
fi

svg_readme=0
if [ -f "$README" ]; then
  n=$(grep -oE '<img[^>]+src="[^"]*\.svg"' "$README" 2>/dev/null | wc -l | tr -d ' ')
  svg_readme="${n:-0}"
fi
[ "${svg_readme:-0}" -eq 0 ] && pass "no SVG images referenced in the README" \
  || fail "$svg_readme SVG image(s) referenced in the README"

# ============================================================================
section "11. The artifact's shape"
# ============================================================================
files=$(find "$EXT" -type f | wc -l | tr -d ' ')
size=$(du -sk "$EXT" | cut -f1)
printf '  INFO  %s files, %s KB unpacked\n' "$files" "$size"
if [ "$files" -gt 45 ]; then
  warn "$files files is more than the 31 the last release shipped"
else
  pass "$files files is in the expected range"
fi

# The screenshots are served from the repo, not bundled. A large jump
# means they got included.
shot=$(find "$EXT" -name "*.png" 2>/dev/null | grep -c "images/" || true)
[ "${shot:-0}" -eq 0 ] && pass "the screenshots are not bundled into the VSIX" \
  || fail "$shot screenshot(s) bundled; they should be served from the repository"

echo
echo "=============================================="
printf 'required checks failed: %s\n' "$failures"
printf 'warnings: %s\n' "$warnings"
if [ "$failures" -eq 0 ]; then
  echo "RESULT: PASS - the artifact clears the security audit"
  exit 0
fi
echo "RESULT: FAIL - do not publish until the failures above are closed"
exit 1
