/**
 * The dashboard's views over the same server.
 *
 * Pure, with no `vscode` import, so the mode can be tested without an
 * editor. See docs/IMPLEMENTATION.md: `core/` must never import vscode.
 */

/**
 * Which view the dashboard shows.
 *
 * - `providers` — the summary cards, the trend chart, the model donut, the
 *   records table, and a breakdown of the connections configured in
 *   OmniRoute, each with its quota state.
 * - `logs` — the request log, one row per request, mirroring the server's own
 *   `<server>/dashboard/logs` table. It replaces the body rather than adding
 *   a section, because a log is read row by row and none of the aggregate
 *   sections answer a question about one request.
 * - `config` — the configuration: every setting, its effective value, and
 *   where the two credentials live. It replaces the body like the Logs view
 *   does, because it is about the extension rather than about the server.
 *
 * There was a third view, `totals`, which was the aggregate view without the
 * per-connection breakdown. It was removed on 2026-10-30: the Providers view
 * already carried everything it had, plus the connection table, so the two
 * differed by one section and the smaller one earned nothing.
 */
export const VIEW_MODES = ["providers", "logs", "config"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "string" && (VIEW_MODES as readonly string[]).includes(value);
}

/** The mode the dashboard opens in when nothing is stored. */
export const DEFAULT_VIEW_MODE: ViewMode = "providers";
