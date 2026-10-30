/**
 * Hourly buckets for the 1d range.
 *
 * The analytics endpoint aggregates by calendar date, so `range=1d` returns a
 * rolling 24 hours split into at most two points (yesterday's tail and today).
 * Two points is not a trend, and a reader cannot see where the day's traffic
 * went. This module turns per-request rows into 24 hourly buckets instead.
 *
 * The rows come from `GET /api/usage/call-logs`, the only endpoint on this
 * server that carries a per-request timestamp AND the provider slug.
 * Verified 2026-10-30 on OmniRoute at 10.0.0.77:20128:
 *
 *   row keys -> timestamp, provider ("synthetic"), tokens: { in, out }, id
 *   coverage -> ~228 rows/hour, so 24 h of history is roughly 5,500 rows
 *
 * The analytics endpoint has no hourly mode, and `/api/usage/request-logs` is
 * hard-coded to the most recent 200 rows (about 40 minutes here), so neither
 * can drive this.
 *
 * Pure, with no `vscode` import, so the binning is testable without an editor.
 */

/** One request, reduced to what a bucket needs. */
export interface TrafficSample {
  timestamp: string;
  /** Connection slug, as `call-logs` reports it ("minimax", "synthetic"). */
  provider: string;
  totalTokens: number;
}

/** Per-provider totals inside one hour. */
export interface HourProviderTotals {
  requests: number;
  totalTokens: number;
}

/** One hour of traffic, with the per-provider split kept for filtering. */
export interface HourlyBucket {
  /**
   * Epoch milliseconds at the start of the hour, floored on the LOCAL clock.
   *
   * Local, not UTC: a reader wants "14:00" to mean their 14:00. On a whole-hour
   * offset like Europe/Amsterdam the two agree; on a half-hour offset they do
   * not, which is why the flooring goes through `setMinutes` rather than
   * integer division.
   */
  hourStart: number;
  requests: number;
  totalTokens: number;
  byProvider: Record<string, HourProviderTotals>;
}

export const HOUR_MS = 3_600_000;

/** Floor a timestamp to the start of its local hour. */
export function floorToLocalHour(ms: number): number {
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/**
 * Bin samples into the last `hours` hourly buckets, oldest first.
 *
 * The result always has exactly `hours` entries, including empty ones: a gap
 * hour must show as a dip to zero, not as a missing x value that makes the
 * line jump from 11:00 to 15:00.
 *
 * A sample outside the window is dropped rather than clamped into the first
 * bucket, because clamping would bill old traffic to the wrong hour. An
 * unparseable timestamp is dropped for the same reason.
 *
 * Note the window is `hours` wall-clock hours, not a fixed span: across a DST
 * change the day is 23 or 25 hours long and this still returns `hours` buckets.
 */
export function hourlyBuckets(
  samples: readonly TrafficSample[],
  now: number = Date.now(),
  hours = 24,
): HourlyBucket[] {
  const count = Math.max(1, Math.floor(hours));
  const end = floorToLocalHour(now) + HOUR_MS;
  const start = end - count * HOUR_MS;

  const buckets: HourlyBucket[] = [];
  for (let i = 0; i < count; i++) {
    buckets.push({ hourStart: start + i * HOUR_MS, requests: 0, totalTokens: 0, byProvider: {} });
  }

  for (const sample of samples) {
    const ms = Date.parse(sample?.timestamp ?? "");
    if (!Number.isFinite(ms)) continue;
    if (ms < start || ms >= end) continue;

    const index = Math.floor((floorToLocalHour(ms) - start) / HOUR_MS);
    const bucket = buckets[index];
    if (!bucket) continue;

    const tokens = Number(sample.totalTokens) || 0;
    bucket.requests += 1;
    bucket.totalTokens += tokens;

    const key = typeof sample.provider === "string" ? sample.provider : "";
    if (key === "") continue;

    const current = bucket.byProvider[key] ?? { requests: 0, totalTokens: 0 };
    current.requests += 1;
    current.totalTokens += tokens;
    bucket.byProvider[key] = current;
  }

  return buckets;
}

/**
 * The same buckets narrowed to one provider, or the totals when `provider` is
 * null. Lets the webview filter locally instead of asking the host to refetch.
 */
export function bucketsFor(
  buckets: readonly HourlyBucket[],
  provider: string | null,
): HourlyBucket[] {
  if (provider === null) return [...buckets];

  return buckets.map((bucket) => {
    const found = bucket.byProvider[provider];
    return {
      hourStart: bucket.hourStart,
      requests: found?.requests ?? 0,
      totalTokens: found?.totalTokens ?? 0,
      byProvider: found ? { [provider]: found } : {},
    };
  });
}
