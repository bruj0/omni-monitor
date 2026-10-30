/**
 * Types and shaping for OmniRoute's management analytics endpoint.
 *
 * Wire shapes verified 2026-10-16 against a live OmniRoute at
 * 10.0.0.77:20128 (`GET /api/usage/analytics?range=30d`). The envelope keys
 * match the server's own assembly in
 * `src/app/api/usage/analytics/route.ts`.
 */

/** The fixed set of ranges the endpoint accepts. Do not invent others. */
export const RANGES = ["1d", "7d", "30d", "90d", "ytd", "all"] as const;
export type Range = (typeof RANGES)[number];

export function isRange(value: string): value is Range {
  return (RANGES as readonly string[]).includes(value);
}

export interface AnalyticsSummary {
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  uniqueModels: number;
  uniqueApiKeys: number;
  successfulRequests: number;
  successRatePct: number;
  avgLatencyMs: number;
  totalCost: number;
  firstRequest?: string | null;
  lastRequest?: string | null;
}

export interface DailyTrendRow {
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

/** Rows in `byModel` and `byProvider` share these fields. */
export interface BreakdownRow {
  model?: string;
  provider: string;
  rawModel?: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  cost: number;
  /** Present on byProvider, and a STRING on the wire ("100.00"). */
  successRatePct?: number | string;
}

export interface ErrorBreakdownRow {
  errorType: string;
  count: number;
}

/**
 * One date of per-model token totals, from the envelope's `dailyByModel`.
 *
 * The wire shape is one object per date with a `date` key and one numeric key
 * per model:
 *
 *   { "date": "2026-10-29", "minimax-m3.1-flash": 505780767, ... }
 *
 * Verified 2026-10-30. The model keys match `byModel[].model` exactly, which
 * is what lets a per-provider trend be derived from this table.
 *
 * Only tokens are present — no requests and no cost. A filtered trend therefore
 * cannot carry a requests series; the chart omits that dataset rather than
 * inventing a value.
 */
export interface DailyModelRow {
  date: string;
  tokens: Record<string, number>;
}

export interface AnalyticsEnvelope {
  summary: AnalyticsSummary;
  dailyTrend: DailyTrendRow[];
  byModel: BreakdownRow[];
  byProvider: BreakdownRow[];
  dailyByModel: DailyModelRow[];
  errorBreakdown: ErrorBreakdownRow[];
  modelNames: string[];
  range: string;
}

/**
 * `dailyByModel` arrives as an array of flat objects. Split the date out and
 * coerce every other key to a number, dropping the ones that are not finite so
 * a shape change shows as a missing model rather than as NaN in a chart.
 */
function parseDailyByModel(raw: unknown): DailyModelRow[] {
  if (!Array.isArray(raw)) return [];

  const rows: DailyModelRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const date = typeof record.date === "string" ? record.date : null;
    if (date === null) continue;

    const tokens: Record<string, number> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "date") continue;
      const parsed = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(parsed)) tokens[key] = parsed;
    }
    rows.push({ date, tokens });
  }

  return rows;
}

/** Defensive read: the server may omit keys on older builds. */
export function parseAnalytics(raw: unknown): AnalyticsEnvelope {
  const o = (raw ?? {}) as Record<string, unknown>;
  const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const asNumber = (v: unknown, fallback = 0): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  const s = (o.summary ?? {}) as Record<string, unknown>;
  return {
    summary: {
      totalRequests: asNumber(s.totalRequests),
      promptTokens: asNumber(s.promptTokens),
      completionTokens: asNumber(s.completionTokens),
      totalTokens: asNumber(s.totalTokens),
      uniqueModels: asNumber(s.uniqueModels),
      uniqueApiKeys: asNumber(s.uniqueApiKeys),
      successfulRequests: asNumber(s.successfulRequests),
      successRatePct: asNumber(s.successRatePct),
      avgLatencyMs: asNumber(s.avgLatencyMs),
      totalCost: asNumber(s.totalCost),
      firstRequest: typeof s.firstRequest === "string" ? s.firstRequest : null,
      lastRequest: typeof s.lastRequest === "string" ? s.lastRequest : null,
    },
    dailyTrend: asArray<DailyTrendRow>(o.dailyTrend),
    byModel: asArray<BreakdownRow>(o.byModel),
    byProvider: asArray<BreakdownRow>(o.byProvider),
    dailyByModel: parseDailyByModel(o.dailyByModel),
    errorBreakdown: asArray<ErrorBreakdownRow>(o.errorBreakdown),
    modelNames: asArray<string>(o.modelNames),
    range: typeof o.range === "string" ? o.range : "unknown",
  };
}

/** `successRatePct` arrives as a string on byProvider. Coerce it. */
export function successRateOf(row: { successRatePct?: number | string }): number | null {
  const raw = row.successRatePct;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * One row of `/api/usage/request-logs`.
 *
 * That endpoint returns an array of PRE-FORMATTED strings, not objects:
 *   "2026-10-16T17:06:57.608Z | MiniMax-M3.1-Flash-Preview | MINIMAX | main | 167420 | 384 | 200"
 * Verified 2026-10-16. There is no structured request-log endpoint on this
 * server version, so the fields are recovered by splitting on the pipe. A row
 * that does not parse is kept with nulls rather than dropped, so the table
 * shows what the server sent.
 */
export interface RequestLogRow {
  raw: string;
  timestamp: string | null;
  model: string | null;
  provider: string | null;
  account: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  status: string | null;
}

export function parseRequestLog(line: string): RequestLogRow {
  const parts = line.split("|").map((p) => p.trim());
  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const parsed = Number.parseInt(v, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    raw: line,
    timestamp: parts[0] ?? null,
    model: parts[1] ?? null,
    provider: parts[2] ?? null,
    account: parts[3] ?? null,
    promptTokens: num(parts[4]),
    completionTokens: num(parts[5]),
    status: parts[6] ?? null,
  };
}

export function parseRequestLogs(body: unknown): RequestLogRow[] {
  if (!Array.isArray(body)) return [];
  return body.filter((v): v is string => typeof v === "string").map(parseRequestLog);
}

/**
 * Average per bucket over the displayed window.
 *
 * Takes a count rather than the trend rows because the trend has two shapes:
 * 24 hourly buckets for the 1d range, N daily rows otherwise. Rounds, so the
 * card never shows a fractional token.
 */
export function averagePerBucket(total: number, buckets: number): number {
  if (!Number.isFinite(buckets) || buckets <= 0) return 0;
  return Math.round(total / buckets);
}