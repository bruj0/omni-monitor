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
 * Status bar text.
 *
 * Shows the worst-case remaining percentage. When exactly one connection
 * reports a percentage, append its provider name so the number has a subject;
 * with several, the number alone is already ambiguous enough.
 */
export function statusBarText(options: {
  percentRemaining: number | null;
  soleProviderName?: string | null;
  reachable: boolean;
}): string {
  if (!options.reachable) return "$(circle-outline) OmniRoute";
  if (options.percentRemaining === null) return "$(layers-dot) OmniRoute";
  const suffix = options.soleProviderName ? ` ${options.soleProviderName}` : "";
  return `$(layers) OmniRoute ${options.percentRemaining}%${suffix}`;
}