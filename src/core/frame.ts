/**
 * Framing probe logic, kept pure so it is testable without a VS Code host.
 *
 * WHY EMBEDDING USUALLY FAILS, measured 2026-10-16 against
 * 10.0.0.77:20128:
 *
 *   $ curl -sI http://10.0.0.77:20128/dashboard
 *   HTTP/1.1 307 Temporary Redirect
 *   Content-Security-Policy: ... frame-ancestors 'none'; ...
 *   X-Frame-Options: DENY
 *
 * OmniRoute refuses framing by two independent mechanisms. Relaxing them is a
 * BUILD-TIME opt-in (`DASHBOARD_ALLOW_EMBED=vscode`, read by
 * scripts/build/dashboardEmbed.mjs and baked into the Next route manifest).
 * Setting the variable on a running install does nothing. The prebuilt npm
 * package and the stock Docker image are not built with it.
 *
 * There is a second, independent blocker: even on an embed-enabled build the
 * dashboard needs a browser session, and `auth_token` is `sameSite: "lax"`,
 * so it is never sent to a `vscode-webview:` iframe.
 *
 * So this probe does not try to make embedding work. It determines whether the
 * server permits it and degrades honestly when it does not.
 *
 * `simpleBrowser.show` SUCCEEDS even when framing is blocked - the tab opens
 * and the iframe renders a refused-to-connect page. The probe therefore runs
 * before the open, never after.
 *
 * Logic adapted from OmniCopilot `src/embed.ts` (MIT).
 */

/** Minimal header reader, so this stays free of DOM and fetch types. */
export type HeaderReader = { get(name: string): string | null };

/** The origin VS Code assigns to a webview / Simple Browser document. */
const VSCODE_FRAME_ORIGIN = "vscode-webview:";

/** Extract the `frame-ancestors` token list from a CSP, lowercased. */
export function frameAncestorsOf(csp: string): string | null {
  for (const directive of csp.split(";")) {
    const trimmed = directive.trim();
    if (/^frame-ancestors\b/i.test(trimmed)) {
      return trimmed.slice("frame-ancestors".length).trim().toLowerCase();
    }
  }
  return null;
}

/**
 * Whether a VS Code webview may frame the page.
 *
 * Conservative by design: anything that reads as a block is a block.
 * `X-Frame-Options: SAMEORIGIN` also blocks, because a webview is a different
 * origin from OmniRoute.
 */
export function isFramingAllowed(headers: HeaderReader): boolean {
  const xfo = (headers.get("x-frame-options") ?? "").trim().toLowerCase();
  if (xfo === "deny" || xfo === "sameorigin") return false;

  const csp = headers.get("content-security-policy") ?? "";
  const ancestors = frameAncestorsOf(csp);
  if (ancestors === null) return true; // no directive, not blocked by CSP

  if (ancestors === "'none'") return false;
  return ancestors
    .split(/\s+/)
    .some((src) => src === "*" || src.startsWith(VSCODE_FRAME_ORIGIN));
}
