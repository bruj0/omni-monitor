/**
 * The dashboard's views over the same server.
 *
 * Pure, with no `vscode` import, so the mode can be tested without an
 * editor. See docs/IMPLEMENTATION.md: `core/` must never import vscode.
 */

/**
 * Which view the dashboard shows.
 *
 * - `totals` — the summary cards, the trend chart, the model donut and the
 *   records table. The aggregate view of everything that happened.
 * - `providers` — the same aggregate view plus a breakdown of the
 *   connections configured in OmniRoute, each with its quota state.
 * - `logs` — the request log, one row per request, mirroring the server's own
 *   `<server>/dashboard/logs` table. It replaces the body rather than adding
 *   a section, because a log is read row by row and none of the aggregate
 *   sections answer a question about one request.
 *
 * Totals and Providers differ only in the provider section. Everything else
 * is shared, because a mode that changed everything would be two dashboards
 * rather than two views of one.
 */
export const VIEW_MODES = ["totals", "providers", "logs"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "string" && (VIEW_MODES as readonly string[]).includes(value);
}

/** The mode the dashboard opens in when nothing is stored. */
export const DEFAULT_VIEW_MODE: ViewMode = "totals";
