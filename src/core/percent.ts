/**
 * Percentage and threshold arithmetic.
 *
 * Pure functions with no `vscode` import, so the numbers can be tested
 * without a VS Code host. See docs/IMPLEMENTATION.md: `core/` must never
 * import vscode.
 */

import type { UsageSnapshot, UsageQuotaWindow } from "./usage";

/**
 * Percent of a limit still available, or null when no meaningful limit exists.
 *
 * Returns null rather than 0 for an unlimited window: "no data" and
 * "nothing left" are different states and the UI must not conflate them.
 */
export function percentLeft(spent: number, limit: number | null): number | null {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - spent / limit) * 100)));
}

/**
 * Percent remaining for one quota window.
 *
 * Prefers the server's `remainingPercentage` when present, then derives from
 * `remaining`/`total`, then from `used`/`total`. The order matters: the
 * `codex` connection returns only the latter two, while the `minimax` one
 * returns `remainingPercentage` directly.
 *
 * NOTE on semantics (#15530): the JSON endpoint exposes RAW upstream
 * snapshots, while the terminal `@@om-usage` text output renders
 * cutoff-adjusted percentages via `effectiveRemainingPercent`, where a
 * configured cutoff reserve reads as 0%. The two legitimately disagree. This
 * function implements the raw JSON reading. Do not add the cutoff logic here.
 */
export function windowPercentLeft(window: UsageQuotaWindow): number | null {
  if (window.unlimited === true) return null;

  if (
    typeof window.remainingPercentage === "number" &&
    Number.isFinite(window.remainingPercentage)
  ) {
    return Math.max(0, Math.min(100, Math.round(window.remainingPercentage)));
  }

  if (typeof window.total === "number" && window.total > 0 && typeof window.remaining === "number") {
    return Math.max(0, Math.min(100, Math.round((window.remaining / window.total) * 100)));
  }

  if (typeof window.total === "number" && window.total > 0 && typeof window.used === "number") {
    return Math.max(
      0,
      Math.min(100, Math.round(((window.total - window.used) / window.total) * 100)),
    );
  }

  return null;
}

/** The soonest reset across a snapshot's windows, or null when none resets. */
export function soonestReset(snapshot: UsageSnapshot): string | null {
  let soonest: number | null = null;
  for (const window of Object.values(snapshot.quotas ?? {})) {
    if (!window.resetAt) continue;
    const at = Date.parse(window.resetAt);
    if (!Number.isFinite(at)) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest === null ? null : new Date(soonest).toISOString();
}

/**
 * The lowest remaining percentage across every connection and window.
 *
 * This is the number the status bar shows: the worst case is the one that
 * matters, and averaging would hide a connection about to run out. Returns
 * null when no connection reports a meaningful percentage.
 */
export function worstCaseRemaining(providers: UsageSnapshot[]): number | null {
  let worst: number | null = null;
  for (const provider of providers) {
    for (const window of Object.values(provider.quotas ?? {})) {
      const pct = windowPercentLeft(window);
      if (pct === null) continue;
      if (worst === null || pct < worst) worst = pct;
    }
  }
  return worst;
}

/**
 * One named provider's read, or null.
 *
 * The provider is matched case-insensitively — the setting is typed by a
 * reader and the server varies its capitalisation — and the percent is that
 * provider's own worst window, so one slow window inside the provider still
 * shows.
 *
 * Returns `null` for a name nothing reports, on purpose: the status bar's
 * fallback for `null` is a bare icon, and a number that silently means
 * "some other provider" would make the bar lie.
 */
export interface ProviderRead {
  /** The provider's own name as the server reported it. */
  name: string;
  percent: number | null;
}

export function providerRead(
  providers: UsageSnapshot[],
  name: string,
): ProviderRead | null {
  const target = name.trim().toLowerCase();
  if (target === "") return null;
  const provider = providers.find(
    (p) => p.provider.trim().toLowerCase() === target,
  );
  if (!provider) return null;
  return { name: provider.provider, percent: worstCaseRemaining([provider]) };
}

export type Severity = "ok" | "warning" | "critical";

/**
 * Severity from the percentage REMAINING, not used.
 *
 * A full bar is the happy case, so low remaining is what escalates. Thresholds
 * are on remaining: warn at or below 20, critical at or below 5.
 */
export function severityFor(percentRemaining: number | null): Severity {
  if (percentRemaining === null) return "ok";
  if (percentRemaining <= 5) return "critical";
  if (percentRemaining <= 20) return "warning";
  return "ok";
}