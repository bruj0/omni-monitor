/**
 * The dashboard's request log view.
 *
 * Mirrors the table at `<server>/dashboard/logs`, which is built from
 * `GET /api/usage/call-logs`. That endpoint is the only one on this server
 * that returns one object per request with the correlation id, the token
 * counts, the duration and the status, so it is the only possible source.
 *
 * Verified 2026-10-30 against OmniRoute at 10.0.0.77:20128:
 *
 *   row keys -> id, timestamp, provider, providerDisplay, model,
 *               requestedModel, account, apiKeyName, apiKeyId, status,
 *               duration, tokens: { in, out }, path, method, active, error,
 *               cacheSource, comboName, correlationId, connectionId,
 *               addedWaitMs, addedWaitCause, sourceFormat, targetFormat
 *
 * Three server behaviours shape this module:
 *
 *   1. `limit` bounds the DATABASE page only. Rows for requests still in
 *      flight are merged in on top and repeated on every page — a `limit=5`
 *      request returned 25 rows. Anything that pages therefore dedupes by
 *      `id`.
 *   2. `status=ok` means 2xx and `status=error` means 4xx/5xx *or* a recorded
 *      error summary. A row with `status: 0` and `active: true` is neither,
 *      which is why `classifyStatus` has a third answer.
 *   3. `/api/usage/call-logs/filters` — the endpoint the OmniRoute page uses
 *      for its dropdowns — answers `{"error":"Log not found"}` on this build,
 *      because the request is routed to the `[id]` handler. The filter values
 *      are therefore not offered; the status chips and the search box are.
 *
 * Pure, with no `vscode` import, so paging and parsing are testable without an
 * editor.
 */

/** One request, as the log table shows it. */
export interface CallLogRow {
  id: string;
  timestamp: string;
  provider: string;
  /** Node/connexion label when the server supplies one, else "". */
  providerDisplay: string;
  model: string;
  requestedModel: string;
  account: string;
  apiKeyName: string;
  status: number;
  /** Milliseconds, as the server measured them. */
  duration: number;
  promptTokens: number;
  completionTokens: number;
  path: string;
  method: string;
  /** True while the request is still in flight. */
  active: boolean;
  error: string;
  cacheSource: string;
  comboName: string;
  correlationId: string;
  addedWaitMs: number | null;
}

/** How a row is classified for the status chip and the status cell. */
export type StatusKind = "ok" | "error" | "pending" | "other";

/**
 * Classify a row the way the server's own filters do.
 *
 * `error` also covers a row that recorded an error summary with a 2xx status,
 * because the server's `status=error` filter matches that case. `pending`
 * covers the in-flight rows the server merges in, which carry status 0.
 */
export function classifyStatus(status: number, error: string): StatusKind {
  if (error !== "") return "error";
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400) return "error";
  if (status === 0) return "pending";
  return "other";
}

/** The chips above the table. `""` means no status filter. */
export const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "ok", label: "OK" },
  { value: "error", label: "Errors" },
];

/** Rows requested per page. Matches the OmniRoute page's own PAGE_SIZE. */
export const LOG_PAGE_SIZE = 50;

/** Everything the log view lets the reader narrow. */
export interface LogQuery {
  offset: number;
  limit: number;
  /** `""` for every status, else the server's own `ok` / `error` values. */
  status: string;
  search: string;
  /** Connection slug, from the dashboard's provider bar. `null` for all. */
  provider: string | null;
}

export const DEFAULT_LOG_QUERY: LogQuery = {
  offset: 0,
  limit: LOG_PAGE_SIZE,
  status: "",
  search: "",
  provider: null,
};

/**
 * Build the query string for `call-logs`.
 *
 * Only the parameters the server actually honours are sent. `offset` is sent
 * only when non-zero so the first page's URL stays the plain one, which makes
 * the host's log line readable.
 */
export function logsQueryString(query: LogQuery): string {
  const params = new URLSearchParams();
  params.set("limit", String(Math.max(1, Math.floor(query.limit) || LOG_PAGE_SIZE)));

  if (query.offset > 0) params.set("offset", String(Math.floor(query.offset)));
  if (query.status === "ok" || query.status === "error") params.set("status", query.status);
  if (query.search.trim() !== "") params.set("search", query.search.trim());
  if (query.provider) params.set("provider", query.provider);

  return params.toString();
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Normalise the wire rows.
 *
 * A row without an `id` is dropped: `id` is the dedupe key, and a row that
 * cannot be deduped would appear twice on paged reads. Every other field
 * degrades to a neutral value, so a shape change shows as a blank cell rather
 * than as `undefined` printed into the DOM.
 */
export function parseCallLogRows(raw: unknown): CallLogRow[] {
  if (!Array.isArray(raw)) return [];

  const rows: CallLogRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = asString(row.id);
    if (id === "") continue;

    const tokens = (row.tokens ?? {}) as { in?: unknown; out?: unknown };
    const addedWait = row.addedWaitMs;

    rows.push({
      id,
      timestamp: asString(row.timestamp),
      provider: asString(row.provider),
      providerDisplay: asString(row.providerDisplay),
      model: asString(row.model),
      requestedModel: asString(row.requestedModel),
      account: asString(row.account),
      apiKeyName: asString(row.apiKeyName),
      status: asNumber(row.status),
      duration: asNumber(row.duration),
      promptTokens: asNumber(tokens.in),
      completionTokens: asNumber(tokens.out),
      path: asString(row.path),
      method: asString(row.method),
      active: row.active === true,
      error: asString(row.error),
      cacheSource: asString(row.cacheSource),
      comboName: asString(row.comboName),
      correlationId: asString(row.correlationId),
      addedWaitMs: addedWait === null || addedWait === undefined ? null : asNumber(addedWait),
    });
  }

  return rows;
}

/**
 * Merge pages without repeating a row.
 *
 * The server repeats its in-flight rows on every page, so a naive append
 * duplicates them. Later pages win on conflict: an in-flight row that has
 * since completed carries its status in the newer copy.
 *
 * Order is timestamp descending, which is the order the server returns and
 * the order a reader expects for a log.
 */
export function mergeLogPages(pages: readonly CallLogRow[][]): CallLogRow[] {
  const byId = new Map<string, CallLogRow>();

  for (const page of pages) {
    for (const row of page) byId.set(row.id, row);
  }

  return [...byId.values()].sort((a, b) => {
    const at = Date.parse(a.timestamp);
    const bt = Date.parse(b.timestamp);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * Whether another page may exist.
 *
 * The server returns `limit` database rows plus whatever is in flight, so a
 * full page is the only signal available. A short page means the end of the
 * table, and one extra request would prove nothing.
 */
export function hasOlderPage(rowCount: number, limit: number): boolean {
  return rowCount > 0 && rowCount >= limit;
}
