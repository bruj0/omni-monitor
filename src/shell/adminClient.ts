/**
 * HTTP client for OmniRoute's management API. READS ONLY.
 *
 * This module deliberately exposes no POST, PATCH or DELETE. The admin scope
 * would permit writes; the extension does not use that permission, and a
 * single-purpose module is the cheapest way to keep that true.
 *
 * Every call logs a redacted line through the OutputChannel. See
 * docs/IMPLEMENTATION.md for why the admin key is optional and how the
 * privilege split is kept honest.
 */

import { parseAnalytics, parseRequestLogs, type AnalyticsEnvelope, type RequestLogRow } from "../core/analytics";
import type { TrafficSample } from "../core/hourly";
import { logsQueryString, parseCallLogRows, type CallLogRow, type LogQuery } from "../core/logs";
import { rootUrl } from "./config";
import { redactToJson } from "../core/redactor";

const DEFAULT_TIMEOUT_MS = 12000;

export interface QuotaProviderEntry {
  name: string;
  provider: string;
  connectionId: string;
  quotaUsed: number;
  quotaTotal: number | null;
  percentRemaining: number;
  resetAt: string | null;
  tokenStatus: string;
}

export class ManagementAuthError extends Error {}
export class ManagementUnreachableError extends Error {}

async function getJson(
  path: string,
  key: string,
  log: { info: (m: string) => void },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${rootUrl()}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });

    log.info(`GET ${path} -> ${res.status}`);

    if (res.status === 401 || res.status === 403) {
      throw new ManagementAuthError(`management auth rejected on ${path} (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} on ${path}`);
    }
    return await res.json();
  } catch (error) {
    if (error instanceof ManagementAuthError) throw error;
    if ((error as Error).name === "AbortError" || (error as Error).name === "TypeError") {
      throw new ManagementUnreachableError((error as Error).message);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Analytics for the dashboard. The single richest call: one request populates
 * the summary cards, the trend chart, the provider and model rankings, and the
 * error breakdown.
 */
export async function fetchAnalytics(
  range: string,
  key: string,
  log: { info: (m: string) => void },
): Promise<AnalyticsEnvelope> {
  const body = await getJson(`/api/usage/analytics?range=${encodeURIComponent(range)}`, key, log);
  const parsed = parseAnalytics(body);
  log.info(
    `analytics range=${parsed.range} requests=${parsed.summary.totalRequests} ` +
      `providers=${parsed.byProvider.length} models=${parsed.byModel.length} ` +
      redactToJson({ range: parsed.range }),
  );
  return parsed;
}

/** Per-connection quota, used by the quota list and the status bar tooltip. */
export async function fetchQuota(
  key: string,
  log: { info: (m: string) => void },
): Promise<QuotaProviderEntry[]> {
  const body = await getJson("/api/usage/quota", key, log);
  const providers = (body as { providers?: unknown })?.providers;
  return Array.isArray(providers) ? (providers as QuotaProviderEntry[]) : [];
}

/**
 * Recent request log rows.
 *
 * The endpoint returns pre-formatted pipe-delimited strings, not objects. See
 * the parser note in core/analytics.ts.
 */
export async function fetchRequestLogs(
  key: string,
  log: { info: (m: string) => void },
): Promise<RequestLogRow[]> {
  const body = await getJson("/api/usage/request-logs", key, log);
  const rows = parseRequestLogs(body);
  log.info(`request-logs rows=${rows.length}`);
  return rows;
}

/** Rows requested per page of `call-logs`. */
const CALL_LOG_PAGE = 6000;
/** Hard stop on paging, so a traffic spike cannot make one refresh unbounded. */
const CALL_LOG_MAX_PAGES = 3;

/**
 * Per-request rows for the last 24 hours, used only by the 1d hourly chart.
 *
 * `call-logs` is the only endpoint on this server with a per-request timestamp
 * AND the provider slug. It has no time-window parameter, so the window comes
 * from paging backwards until the oldest row is older than `sinceMs`. Measured
 * 2026-10-30: ~228 rows/hour, so one 6,000-row page covers about 26 hours and
 * a second page is the exception.
 *
 * Paging overlaps — a page requested with `offset` can include rows already
 * seen at the top of the list — so rows are deduplicated by `id`. The page cap
 * is a bound, not an expectation: hitting it leaves the earliest hours empty,
 * which reads as a quiet night rather than as a wrong number, and the log line
 * says so.
 *
 * A failure here must not fail the dashboard, so the caller catches it and the
 * payload carries no hourly series.
 */
export async function fetchCallLogSamples(
  key: string,
  sinceMs: number,
  log: { info: (m: string) => void },
): Promise<TrafficSample[]> {
  const seen = new Set<string>();
  const samples: TrafficSample[] = [];
  let offset = 0;
  let pages = 0;

  while (pages < CALL_LOG_MAX_PAGES) {
    const body = await getJson(
      `/api/usage/call-logs?limit=${CALL_LOG_PAGE}&offset=${offset}`,
      key,
      log,
    );
    const rows = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
    pages += 1;

    let oldest = Number.POSITIVE_INFINITY;
    let added = 0;

    for (const row of rows) {
      const id = typeof row?.id === "string" ? row.id : null;
      if (id !== null && seen.has(id)) continue;
      if (id !== null) seen.add(id);

      const timestamp = typeof row?.timestamp === "string" ? row.timestamp : null;
      if (timestamp === null) continue;

      // A row still in flight has no tokens yet; it is still a request, so the
      // count is kept and the token total contributes zero.
      const tokens = (row?.tokens ?? {}) as { in?: unknown; out?: unknown };
      const totalTokens = (Number(tokens.in) || 0) + (Number(tokens.out) || 0);

      samples.push({
        timestamp,
        provider: typeof row?.provider === "string" ? row.provider : "",
        totalTokens,
      });
      added += 1;

      const ms = Date.parse(timestamp);
      if (Number.isFinite(ms) && ms < oldest) oldest = ms;
    }

    // Stop when the window is covered, when the page was empty, or when a page
    // added nothing new — that last case means the server is repeating itself
    // and another request would not extend the window.
    if (added === 0 || oldest <= sinceMs) break;
    offset += rows.length;
  }

  log.info(
    `call-logs pages=${pages} rows=${samples.length} ` +
      `windowMs=${samples.length > 0 ? Date.now() - sinceMs : 0}`,
  );
  return samples;
}

/**
 * One page of the request log, for the dashboard's logs view.
 *
 * Unlike `fetchCallLogSamples`, which reduces rows to hourly samples, this
 * returns the rows themselves: the log view is read per request. See
 * `core/logs.ts` for the three server behaviours that shape the query — a
 * `limit` that bounds only the database page, a merged set of in-flight rows
 * repeated on every page, and a `filters` endpoint this build does not serve.
 */
export async function fetchCallLogPage(
  query: LogQuery,
  key: string,
  log: { info: (m: string) => void },
): Promise<CallLogRow[]> {
  const body = await getJson(`/api/usage/call-logs?${logsQueryString(query)}`, key, log);
  const rows = parseCallLogRows(body);
  log.info(
    `call-logs offset=${query.offset} status=${query.status || "all"} ` +
      `search=${query.search ? "yes" : "no"} provider=${query.provider ?? "all"} rows=${rows.length}`,
  );
  return rows;
}