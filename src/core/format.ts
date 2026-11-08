/**
 * Display formatting. Pure, no `vscode` import.
 *
 * `formatResetIn` mirrors the server's own wording (see `formatResetIn` in
 * OmniRoute's `src/lib/usage/internalUsageCommand.ts`) so the panel reads like
 * the terminal command.
 */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return USD.format(value);
}

/** Compact token counts: 1234 -> "1.2k", 1234567 -> "1.2M". */
export function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1000000000) return `${(value / 1000000000).toFixed(1)}B`;
  if (abs >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US");
}

/** "2d 4h" / "3h 12m" / "unknown" / "now" - no leading verb, for table cells. */
export function formatResetIn(resetAtIso: string | null | undefined, now = Date.now()): string {
  if (!resetAtIso) return "unknown";
  const ms = Date.parse(resetAtIso);
  if (!Number.isFinite(ms)) return "unknown";
  const diff = ms - now;
  if (diff <= 0) return "now";
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Title-case a window key such as "session (5h)" -> "Session (5h)". */
export function humanizeWindow(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * The used/total pair a quota window reports, as "8/100".
 *
 * The server sends floats that binary rounding makes ugly: a window of
 * `used: 20.4` arrives as `20.400000000000002`, and printing that raw puts
 * seventeen digits in a tooltip. So the used amount is rounded to at most
 * two decimals, and a whole number loses its trailing zeros.
 *
 * A non-finite value yields "-" rather than "NaN", because the server can
 * send a null where a number is expected and the tooltip must not lie.
 */
export function formatUsedTotal(used: number, total: number): string {
  const clean = (value: number): string => {
    if (!Number.isFinite(value)) return "-";
    // toFixed, then strip the trailing zeros it pads. It rounds on the exact
    // decimal value of the double, so 20.4 stays 20.4 and 26.4 stays 26.4.
    return value.toFixed(2).replace(/\.?0+$/, "");
  };
  return `${clean(used)}/${clean(total)}`;
}

/**
 * The bar glyphs for the status bar.
 *
 * Ten segments: a solid rectangle for the percent remaining, an outlined one
 * for what is spent. Adjacent glyphs join, so the meter renders as one
 * continuous bar — solid on the left, outlined on the right — rather than as
 * separate characters.
 *
 * The pair was chosen against the live bar, three times. `░` renders as a dot
 * grid, `▰` renders striped in the status bar's font, and the `●`/`○` discs
 * read as detached beads rather than as a bar — rejected by the reader they
 * were built for. `▬`/`▭` is the only pair tried whose filled and empty
 * halves are unmistakable AND join into one shape.
 *
 * Pure text on purpose. A status bar item cannot colour one glyph, so the
 * fill is what carries the *amount* and the item's own background colour
 * (set from the severity, in `shell/statusBar.ts`) carries the *level*.
 */
export function quotaBar(percentRemaining: number, segments = 10): string {
  const clamped = Math.max(0, Math.min(100, percentRemaining));
  const filled = Math.round((clamped / 100) * segments);
  return "▬".repeat(filled) + "▭".repeat(segments - filled);
}

/**
 * Status bar text.
 *
 * An icon, the quota bar for the selected provider, and the same number as
 * text — the bar is the shape, the number is the fact. The provider name is
 * appended only when a name is supplied: with the `worst` selection the
 * number is already the worst case and naming one provider would suggest
 * the bar read only that one.
 */
export function statusBarText(options: {
  percentRemaining: number | null;
  soleProviderName?: string | null;
  reachable: boolean;
}): string {
  if (!options.reachable) return "$(circle-outline) OmniRoute";
  if (options.percentRemaining === null) return "$(layers-dot) OmniRoute";
  const suffix = options.soleProviderName ? ` ${options.soleProviderName}` : "";
  return `$(layers) ${quotaBar(options.percentRemaining)} ${options.percentRemaining}%${suffix}`;
}