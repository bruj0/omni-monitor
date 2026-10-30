/**
 * Log redaction.
 *
 * The extension holds bearer tokens for two endpoints. Nothing the extension
 * writes may contain one. This is the single choke point for that rule, so
 * call it on every payload before it reaches an OutputChannel.
 */

/** Keys whose values are secrets regardless of shape. */
const SECRET_KEY_RE = /(authorization|api[-_]?key|token|secret|password|bearer|credential)/i;

/**
 * Values that look like credentials even under an innocuous key.
 *
 * OmniRoute bearer keys observed in the wild: `sk-` prefixed strings and bare
 * 40-char tokens. Matching on length and alphabet rather than a prefix keeps
 * this useful across rotated key formats.
 */
function looksLikeCredential(value: string): boolean {
  if (value.length >= 32 && /^[A-Za-z0-9_\-.]+$/.test(value)) return true;
  return /^(sk-|oma_|Bearer\s)/i.test(value);
}

export function redactString(input: string): string {
  return input
    .replace(/(Bearer\s+)[A-Za-z0-9_\-.]+/gi, "$1[redacted]")
    .replace(/(sk-)[A-Za-z0-9_\-]{8,}/g, "$1[redacted]")
    .replace(/(oma_)[A-Za-z0-9_\-]{8,}/g, "$1[redacted]");
}

/**
 * Redact a value of any shape, recursively.
 *
 * Depth-limited so a deeply nested or cyclic object cannot hang the log path.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof entry === "string" && looksLikeCredential(entry)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redact(entry, depth + 1);
  }
  return out;
}

/** Render a redacted value as a single log line. */
export function redactToJson(value: unknown): string {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return "[unserializable]";
  }
}