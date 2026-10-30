/**
 * Dashboard webview: rendering and host messaging.
 *
 * Mirrors GCMP's `src/ui/usagesView/app.ts` split, where the host owns data
 * and this file owns rendering. Nothing here fetches: the webview asks, the
 * extension answers. That is what keeps the admin key in the extension host
 * rather than in the DOM.
 */

import { formatCount, formatResetIn, formatTokens, formatUsd } from "../core/format";
import { averagePerBucket } from "../core/analytics";
import { connectionUsage, providerDailyTokens, providerModels, providerSummary } from "../core/connections";
import type { ConnectionUsage } from "../core/connections";
import { bucketsFor, type HourlyBucket } from "../core/hourly";
import {
  classifyStatus,
  hasOlderPage,
  LOG_PAGE_SIZE,
  mergeLogPages,
  STATUS_FILTERS,
  type CallLogRow,
} from "../core/logs";
import type { ViewMode } from "../core/viewMode";
import { DEFAULT_VIEW_MODE, isViewMode } from "../core/viewMode";
import Chart from "chart.js/auto";
import { chartPalette, donutConfig, trendChartConfig } from "./components/charts";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };

const vscode = acquireVsCodeApi();

const RANGES = ["1d", "7d", "30d", "90d", "ytd", "all"];
const PAGE_SIZE = 20;

/** The three views, and the label each button carries. */
const VIEW_MODE_LABELS: { mode: ViewMode; label: string; hint: string }[] = [
  { mode: "providers", label: "Providers", hint: "Breakdown by configured connection" },
  { mode: "logs", label: "Logs", hint: "One row per request, as the server logged it" },
  { mode: "config", label: "Config", hint: "Settings, effective values, and where the keys live" },
];

interface State {
  loading: boolean;
  error: { kind: string; message: string } | null;
  requestId: number;
  range: string;
  viewMode: ViewMode;
  /**
   * Provider slug the Providers view is drilled into, or null for the list.
   *
   * Deliberately webview-only: unlike the view mode it is a transient
   * drill-down, not a preference, so it is not persisted and a reload starts
   * from the full list. The slug, not the connection id, because the models
   * join is on the slug.
   */
  selectedProvider: string | null;
  data: any | null;
  page: number;
  /** The Logs view's own state; see `LogsState`. */
  logs: LogsState;
  /** The Config view's own state; see `ConfigState`. */
  config: ConfigState;
}

/**
 * The Config view's state, fetched from the host on demand.
 *
 * The webview cannot read the configuration itself: `vscode.workspace` is
 * not available inside a webview, and the two credentials live in the
 * extension host's SecretStorage, which the webview has no access to at all.
 * The host sends the effective values and the schema; the key values are
 * never sent, only whether one is set.
 */
interface ConfigState {
  /** The settings, their schema, and their effective values. */
  settings: ConfigSetting[];
  /** Whether the API key is set, and where it lives. Never the key itself. */
  apiKey: CredentialState;
  /** Whether the admin key is set, and where it lives. */
  adminKey: CredentialState;
  /** Where edits go: "user" or "workspace". */
  target: "user" | "workspace";
  /** True when a workspace is open, so the workspace scope is selectable. */
  hasWorkspace: boolean;
  /** True while the host has not answered yet. */
  loading: boolean;
  /** The message from the last failed edit, keyed by setting or credential. */
  errors: Record<string, string>;
}

/**
 * One setting: its schema, its effective value, and where it came from.
 *
 * The schema comes from the extension's manifest, so the form's controls
 * and its validation come from the same source the Settings editor uses.
 */
interface ConfigSetting {
  key: string;
  control: "boolean" | "number" | "string" | "enum";
  value: unknown;
  defaultValue: unknown;
  enumValues?: string[];
  minimum?: number;
  maximum?: number;
  description: string;
  /** "default", "user", "workspace", or "workspace-folder". */
  scope: string;
  modified: boolean;
}

/**
 * One credential: whether it is set, and where it is stored.
 *
 * Never the value. The key itself is in the OS keychain and this struct has
 * no field to carry it.
 */
interface CredentialState {
  set: boolean;
  /** A short, non-reversible hint, so a reader can tell two keys apart. */
  hint: string;
  /** The scope the key needs. */
  scopeNeeded: string;
}

/**
 * The Logs view's state, fetched on demand rather than with the dashboard.
 *
 * The log table pages, searches and filters on its own schedule, so it is not
 * part of `DashboardPayload`. `requestId` is monotonic for the same reason as
 * the dashboard's: a fast typist can outrun the server, and the answer to an
 * older query must not overwrite a newer one.
 */
interface LogsState {
  rows: CallLogRow[];
  offset: number;
  status: string;
  search: string;
  loading: boolean;
  hasMore: boolean;
  requestId: number;
  appliedRequestId: number;
  error: string | null;
  /** Id of the row whose detail is open, or null. */
  expanded: string | null;
  /** Debounce handle for the search box. */
  searchTimer: number | null;
}

let state: State = {
  loading: true,
  error: null,
  requestId: 0,
  range: "30d",
  viewMode: DEFAULT_VIEW_MODE,
  selectedProvider: null,
  data: null,
  page: 0,
  config: {
    settings: [],
    apiKey: { set: false, hint: "", scopeNeeded: "" },
    adminKey: { set: false, hint: "", scopeNeeded: "" },
    target: "user",
    hasWorkspace: false,
    loading: false,
    errors: {},
  },
  logs: {
    rows: [],
    offset: 0,
    status: "",
    search: "",
    loading: false,
    hasMore: false,
    requestId: 0,
    appliedRequestId: 0,
    error: null,
    expanded: null,
    searchTimer: null,
  },
};

const charts: Record<string, any> = {};
const app = document.getElementById("app") as HTMLElement;

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  // The configuration answer carries its own id space too: it answers a
  // `loadConfig` request, not the dashboard's `load`, so it must not advance
  // the dashboard's requestId.
  if (msg.kind === "config") {
    state.config.settings = Array.isArray(msg.settings) ? msg.settings : [];
    state.config.apiKey = normalizeCredential(msg.apiKey);
    state.config.adminKey = normalizeCredential(msg.adminKey);
    state.config.target = msg.defaultTarget === "workspace" ? "workspace" : "user";
    state.config.hasWorkspace = msg.hasWorkspace === true;
    state.config.loading = false;
    render();
    return;
  }

  // The answer to an edit: a failure is shown next to the control that
  // failed, and a success clears the old message.
  if (msg.kind === "configResult") {
    const key = typeof msg.key === "string" ? msg.key : "";
    if (msg.ok === true) {
      delete state.config.errors[key];
    } else {
      state.config.errors[key] = typeof msg.message === "string" ? msg.message : "The change was not saved.";
    }
    render();
    return;
  }

  // A logs page carries its own id space: it answers a `loadLogs` request, not
  // the dashboard's `load`, so it must not advance the dashboard's requestId
  // (which would make the next dashboard answer look stale).
  if (msg.kind === "logsPage") {
    // Drop an answer to a query that has already been replaced: typing in the
    // search box can issue three requests in a second, and the slowest one
    // must not win.
    if (typeof msg.requestId === "number" && msg.requestId < state.logs.requestId) return;

    state.logs.appliedRequestId = msg.requestId;
    state.logs.rows = mergeLogPages([Array.isArray(msg.rows) ? (msg.rows as CallLogRow[]) : []]);
    state.logs.hasMore = hasOlderPage(state.logs.rows.length, LOG_PAGE_SIZE);
    state.logs.loading = false;
    state.logs.error = typeof msg.error === "string" ? msg.error : null;
    render();
    return;
  }

  // Drop out-of-order responses. Without this, switching ranges quickly can
  // render an older response last.
  if (typeof msg.requestId === "number") {
    if (msg.requestId < state.requestId) return;
    state.requestId = msg.requestId;
  }

  if (msg.kind) {
    state.error = { kind: msg.kind, message: msg.message ?? "" };
    state.loading = false;
    render();
    return;
  }

  if (msg.analytics) {
    state.data = msg;
    state.range = msg.range ?? state.range;
    state.viewMode = isViewMode(msg.viewMode) ? msg.viewMode : state.viewMode;
    state.page = typeof msg.page === "number" ? msg.page : 0;

    // A drill-down names a provider that must still exist. A removed
    // connection, or a quota fetch that failed and emptied the list, would
    // otherwise leave the detail view pointing at nothing. An empty list is
    // not evidence the provider is gone (that is a failed fetch), so it keeps
    // the selection and lets the detail render from the usage rows alone.
    if (state.selectedProvider && Array.isArray(msg.quota) && msg.quota.length > 0) {
      const stillThere = msg.quota.some((entry: any) => entry?.provider === state.selectedProvider);
      if (!stillThere) state.selectedProvider = null;
    }

    state.error = null;
    state.loading = false;
    render();

    // The Logs view can be the stored mode, in which case it is drawn by the
    // first payload and no click ever happened. Fetch its first page here, or
    // a restored Logs view sits empty until the reader presses Refresh.
    if (state.viewMode === "logs" && state.logs.appliedRequestId === 0 && !state.logs.loading) {
      loadLogs(0);
    }

    // Same for the Config view: its settings are not in the dashboard
    // payload, so a restored Config view has to ask for them. Without this
    // the view renders "No settings reported." on a restored session and on
    // every reload, because no click ever happened to trigger the fetch.
    if (state.viewMode === "config" && state.config.settings.length === 0 && !state.config.loading) {
      loadConfig();
    }
  }
});

// The search box is the only free-text control in the dashboard, so it gets
// its own listener: `click` cannot see typing, and a full re-render on every
// keystroke would steal focus.
app.addEventListener("input", (event) => {
  const input = (event.target as HTMLElement | null)?.closest("[data-role=logs-search]");
  if (!(input instanceof HTMLInputElement)) return;

  state.logs.search = input.value;
  if (state.logs.searchTimer !== null) clearTimeout(state.logs.searchTimer);
  state.logs.searchTimer = setTimeout(() => {
    state.logs.searchTimer = null;
    loadLogs(0);
  }, 300) as unknown as number;
});

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement | null)?.closest("[data-command]");
  if (!target) return;
  const command = target.getAttribute("data-command");

  if (command === "setRange") {
    vscode.postMessage({ command: "setRange", range: target.getAttribute("data-value") });
  } else if (command === "refresh") {
    // In the Logs view the header's Refresh reloads the current log page: the
    // dashboard payload it would otherwise request is not what is on screen.
    // The Config view refreshes the settings, for the same reason.
    if (state.viewMode === "logs") {
      loadLogs(state.logs.offset);
      return;
    }
    if (state.viewMode === "config") {
      loadConfig();
      return;
    }
    vscode.postMessage({ command: "refresh" });
  } else if (command === "page") {
    const delta = Number(target.getAttribute("data-value") ?? "0");
    if (state.viewMode === "logs") {
      loadLogs(Math.max(0, state.logs.offset + delta * LOG_PAGE_SIZE));
      return;
    }
    vscode.postMessage({ command: "setPage", page: Math.max(0, state.page + delta) });
  } else if (command === "setViewMode") {
    const mode = target.getAttribute("data-value");
    if (!isViewMode(mode)) return;
    // Draw the new mode straight away. The host answers with the same data,
    // so this is a re-render, not a refetch. The Logs and Config views are the
    // exceptions: their contents are not in the payload, so entering them
    // fetches from the host.
    state.viewMode = mode;
    render();
    vscode.postMessage({ command: "setViewMode", mode });
    // Always refetch on entering the Logs view: its rows are not in the
    // payload, so whatever is in state came from an earlier visit and may be
    // minutes old. The offset and filters are kept, so the reader returns to
    // the page they left.
    if (mode === "logs" && !state.logs.loading) loadLogs(state.logs.offset);
    // Same for the Config view: the settings can have changed since the last
    // visit, and the host is the only one that can read them.
    if (mode === "config") loadConfig();
  } else if (command === "selectProvider") {
    // Purely local for the aggregate views: the payload already holds every
    // provider's rows, so a filter is a re-render. The Logs view is the
    // exception — the server does that filtering, so it needs a new page.
    const provider = target.getAttribute("data-value") ?? "";
    state.selectedProvider = provider === "" ? null : provider;
    render();
    if (state.viewMode === "logs") loadLogs(0);
  } else if (command === "logsStatus") {
    state.logs.status = target.getAttribute("data-value") ?? "";
    loadLogs(0);
  } else if (command === "setConfigTarget") {
    // Where edits go. The scope is a property of the whole form, not of one
    // setting, so it is held in the state and sent with every edit.
    const scope = target.getAttribute("data-value");
    if (scope === "user" || scope === "workspace") {
      state.config.target = scope;
      render();
    }
  } else if (command === "saveSetting") {
    const key = target.getAttribute("data-value") ?? "";
    const control = document.querySelector(`[data-setting="${key}"]`);
    if (control) {
      vscode.postMessage({
        command: "updateSetting",
        key,
        value: readControlValue(control),
        target: state.config.target,
      });
    }
  } else if (command === "saveCredential") {
    const which = target.getAttribute("data-value") ?? "";
    const input = document.querySelector(`[data-credential-input="${which}"]`);
    if (input instanceof HTMLInputElement) {
      vscode.postMessage({
        command: "setCredential",
        which,
        value: input.value,
      });
    }
  } else if (command === "clearCredential") {
    const which = target.getAttribute("data-value") ?? "";
    vscode.postMessage({ command: "clearCredential", which });
  } else if (command === "openSettings") {
    vscode.postMessage({ command: "openSettings" });
  } else if (command === "logsRow") {
    const id = target.getAttribute("data-value") ?? "";
    state.logs.expanded = state.logs.expanded === id ? null : id;
    render();
  }
});

/**
 * Ask the host for one page of the request log.
 *
 * Always replaces the page: the server's in-flight rows are re-sent with every
 * page, so appending would duplicate them. `offset` is the only thing that
 * survives a page change, and it is bounded below at zero here rather than on
 * the host, because the host treats a negative offset as "no offset".
 */
function loadLogs(offset: number): void {
  state.logs.offset = Math.max(0, Math.floor(offset) || 0);
  state.logs.requestId += 1;
  state.logs.loading = true;
  state.logs.expanded = null;
  render();

  vscode.postMessage({
    command: "loadLogs",
    requestId: state.logs.requestId,
    offset: state.logs.offset,
    status: state.logs.status,
    search: state.logs.search,
    provider: state.selectedProvider,
  });
}

function render(): void {
  app.textContent = "";
  app.appendChild(renderHeader());

  // The Config view replaces the body before the loading and error branches.
  // It is about the extension, not about the server, so it does not depend on
  // a dashboard payload and it must still be readable when the server is down.
  if (state.viewMode === "config") {
    app.appendChild(renderConfigView());
    return;
  }

  if (state.loading) {
    app.appendChild(renderLoading());
    return;
  }
  if (state.error) {
    app.appendChild(renderError(state.error));
    return;
  }
  if (!state.data) {
    app.appendChild(renderEmpty("No data loaded."));
    return;
  }

  const analytics = state.data.analytics;
  const byModel: any[] = analytics?.byModel ?? [];
  const quota: any[] = state.data.quota ?? [];

  // The provider bar sits above everything and filters every section, so it is
  // rendered before any of them reads `state.selectedProvider`.
  if (quota.length > 0) app.appendChild(renderProviderBar(quota));

  // The Logs view replaces the body. Cards, charts and the range sidebar all
  // answer questions about aggregates; none of them answers a question about
  // one request, and the log table needs the full width.
  if (state.viewMode === "logs") {
    app.appendChild(renderLogsView());
    return;
  }

  app.appendChild(renderCards(analytics));

  // The per-connection breakdown: the same quota state plus usage, narrowed
  // to the selected provider when there is one.
  app.appendChild(renderConnections(quota, byModel));

  const container = document.createElement("div");
  container.className = "container";

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.appendChild(renderRangeList());

  const content = document.createElement("main");
  content.className = "content";
  content.appendChild(renderTrend(analytics));
  content.appendChild(renderRank(analytics));

  const logs = filterLogsByProvider(state.data.logs ?? [], state.selectedProvider);
  content.appendChild(renderLogs(logs, logs.length, state.page));

  container.appendChild(sidebar);
  container.appendChild(content);
  app.appendChild(container);
}

/**
 * The rows for one provider, or all of them.
 *
 * `provider` is the connection slug, which is the same key the models join
 * uses, so filtering is exact.
 */
function filterByProvider<T extends { provider?: string }>(rows: readonly T[], provider: string | null): T[] {
  if (provider === null) return [...rows];
  return rows.filter((row) => row?.provider === provider);
}

/**
 * Request-log rows for one provider.
 *
 * The log endpoint reports the provider as an upper-cased slug ("SYNTHETIC")
 * while `quota` and `byModel` use lower case, so the comparison is
 * case-insensitive. Verified 2026-10-30.
 */
function filterLogsByProvider(rows: readonly any[], provider: string | null): any[] {
  if (provider === null) return [...rows];
  const wanted = provider.toLowerCase();
  return rows.filter((row) => String(row?.provider ?? "").toLowerCase() === wanted);
}

function renderHeader(): HTMLElement {
  const header = document.createElement("header");
  header.className = "header";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "OmniRoute usage";

  const subtitle = document.createElement("div");
  subtitle.className = "subtitle";
  subtitle.textContent = state.data?.generatedAt
    ? `updated ${new Date(state.data.generatedAt).toLocaleTimeString()}`
    : "";

  const refresh = document.createElement("button");
  refresh.className = "button";
  refresh.setAttribute("data-command", "refresh");
  refresh.textContent = "Refresh";

  header.appendChild(title);
  header.appendChild(subtitle);
  header.appendChild(renderViewModeToggle());
  header.appendChild(refresh);
  return header;
}

/**
 * The two-view selector.
 *
 * A pair of buttons rather than a dropdown: there are exactly two modes,
 * and both are worth naming. The active one is marked with `aria-pressed`,
 * which is what the CDP check reads.
 */
function renderViewModeToggle(): HTMLElement {
  const group = document.createElement("div");
  group.className = "view-toggle";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Dashboard view");

  for (const { mode, label, hint } of VIEW_MODE_LABELS) {
    const button = document.createElement("button");
    button.className = "view-toggle-button" + (mode === state.viewMode ? " active" : "");
    button.setAttribute("data-command", "setViewMode");
    button.setAttribute("data-value", mode);
    button.setAttribute("aria-pressed", mode === state.viewMode ? "true" : "false");
    button.title = hint;
    button.textContent = label;
    group.appendChild(button);
  }

  return group;
}

function renderRangeList(): HTMLElement {
  const list = document.createElement("nav");
  list.className = "date-list";

  for (const range of RANGES) {
    const item = document.createElement("button");
    item.className = "date-item" + (range === state.range ? " active" : "");
    item.setAttribute("data-command", "setRange");
    item.setAttribute("data-value", range);
    item.textContent = range;
    list.appendChild(item);
  }
  return list;
}

function renderCards(analytics: any): HTMLElement {
  const row = document.createElement("div");
  row.className = "summary-cards";

  const provider = state.selectedProvider;
  const trend = trendPoints(analytics);
  // Unfiltered reads `summary` verbatim. Filtered has to be derived, because
  // `summary` has no provider dimension; see providerSummary() for the
  // measured difference between the two.
  const s = provider === null ? (analytics?.summary ?? {}) : providerSummary(analytics?.byModel ?? [], provider);

  const days = analytics?.dailyTrend?.length ?? 0;
  const tokens = Number(s.totalTokens ?? 0);
  const models = Number(s.uniqueModels ?? 0);
  const hourly = isHourly();

  row.appendChild(
    card(
      "Total Cost",
      formatUsd(Number(s.totalCost ?? 0)),
      hourly ? trend.length + " hours" : days + " day" + (days === 1 ? "" : "s"),
    ),
  );
  row.appendChild(
    card("Total Tokens", formatTokens(tokens), formatCount(models) + " model" + (models === 1 ? "" : "s")),
  );
  row.appendChild(
    card("Total Requests", formatCount(Number(s.totalRequests ?? 0)), "success " + Number(s.successRatePct ?? 0).toFixed(1) + "%"),
  );
  row.appendChild(
    card(
      hourly ? "Hourly Avg" : "Daily Avg",
      formatTokens(averagePerBucket(tokens, trend.length)),
      hourly ? "tokens per hour" : "tokens per day",
    ),
  );
  return row;
}

/** One point of the trend chart, whichever range and filter produced it. */
interface TrendPoint {
  label: string;
  requests?: number;
  totalTokens: number;
}

/**
 * True when the dashboard is showing the hourly series.
 *
 * Only the 1d range has one: the analytics endpoint aggregates by date, so a
 * rolling 24 hours arrives as at most two points. The host fetches per-request
 * rows and bins them, and sends 24 buckets.
 */
function isHourly(): boolean {
  const hourly = state.data?.hourly;
  return state.range === "1d" && Array.isArray(hourly) && hourly.length > 0;
}

/**
 * The points the trend chart draws, filtered to the selected provider.
 *
 * Four sources, because neither endpoint can answer every case:
 *
 *   unfiltered + hourly -> the host's buckets
 *   unfiltered + daily  -> `dailyTrend`, which carries requests AND tokens
 *   filtered   + hourly -> the same buckets, narrowed per provider
 *   filtered   + daily  -> `dailyByModel`, tokens only
 *
 * The last case has no requests series: the server publishes per-provider
 * per-date request counts on a different endpoint, and this one does not. The
 * chart omits that dataset rather than plotting a guess.
 */
function trendPoints(analytics: any): TrendPoint[] {
  const provider = state.selectedProvider;

  if (isHourly()) {
    return bucketsFor(state.data.hourly as HourlyBucket[], provider).map((bucket) => ({
      label: hourLabel(bucket.hourStart),
      requests: bucket.requests,
      totalTokens: bucket.totalTokens,
    }));
  }

  if (provider === null) {
    return (analytics?.dailyTrend ?? []).map((row: any) => ({
      label: String(row?.date ?? "").slice(5),
      requests: Number(row?.requests) || 0,
      totalTokens: Number(row?.totalTokens) || 0,
    }));
  }

  return providerDailyTokens(analytics?.byModel ?? [], analytics?.dailyByModel ?? [], provider).map((row) => ({
    label: row.date.slice(5),
    totalTokens: row.totalTokens,
  }));
}

/** "09:00" from an hour start. Built by hand so the label does not follow the
 * system locale: a 24-bucket axis needs one short, fixed shape. */
function hourLabel(hourStart: number): string {
  return String(new Date(hourStart).getHours()).padStart(2, "0") + ":00";
}

function card(title: string, value: string, detail: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "card";

  const t = document.createElement("div");
  t.className = "card-title";
  t.textContent = title;

  const v = document.createElement("div");
  v.className = "card-value";
  v.textContent = value;

  const d = document.createElement("div");
  d.className = "card-detail";
  d.textContent = detail;

  el.appendChild(t);
  el.appendChild(v);
  el.appendChild(d);
  return el;
}

/**
 * The providers view: every connection, or the one the bar selected.
 *
 * `connections.ts` owns the join and the rule for an idle provider; this
 * function only formats. An idle connection renders "-" rather than "0",
 * because "configured, no traffic in this range" is not the same fact as
 * "used, and the count is zero".
 *
 * The provider choice itself lives in the bar at the top of the dashboard,
 * because it filters every section, not just this one. With a provider
 * selected this section shows that connection's stats and the models behind
 * them; with none it shows the full table.
 */
function renderConnections(quota: any[], byModel: any[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "chart-section";

  const title = document.createElement("h3");
  title.className = "chart-section-title";
  title.textContent = "Configured providers";
  section.appendChild(title);

  const rows = connectionUsage(quota ?? [], byModel ?? []);
  if (rows.length === 0) {
    section.appendChild(renderEmpty("No connections configured."));
    return section;
  }

  const selected = rows.find((row) => row.provider === state.selectedProvider) ?? null;

  if (selected) {
    section.appendChild(renderProviderDetail(selected, byModel ?? []));

    const back = document.createElement("div");
    back.className = "section-note";
    back.textContent =
      "Showing " + connectionLabel(selected) +
      " only. Every section above follows the provider selected at the top. " +
      "Usage covers the selected range; quota is the current state.";
    section.appendChild(back);
    return section;
  }

  section.appendChild(renderConnectionTable(rows));

  const note = document.createElement("div");
  note.className = "section-note";
  note.textContent =
    rows.length + " connection" + (rows.length === 1 ? "" : "s") +
    " configured in OmniRoute. Pick a provider at the top to narrow the whole dashboard. " +
    "Usage covers the selected range; quota is the current state.";
  section.appendChild(note);

  return section;
}

/**
 * The dashboard-wide provider filter, directly under the header.
 *
 * One chip per connection plus "All N". The label is the provider SLUG, not the
 * connection name: OmniRoute lets three connections share a name — this server
 * has three called "main" — so a name-labelled row is four buttons a reader
 * cannot tell apart (measured 2026-10-30). The slug is unique, it is the
 * models join key, and it is what `data-value` carries. The friendly name
 * appears in the table's Connection column, in each chip's tooltip, and in the
 * Providers section's close-out note.
 *
 * The bar filters every section — cards, trend, models and request log — not
 * just the section that lists connections, which is why it is not scoped to a
 * section.
 */
function renderProviderBar(quota: any[]): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "provider-bar";

  const label = document.createElement("span");
  label.className = "provider-bar-label";
  label.textContent = "Provider";
  bar.appendChild(label);

  const group = document.createElement("div");
  group.className = "provider-selector";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Provider");
  group.appendChild(providerChip(null, "All " + quota.length, state.selectedProvider === null));

  for (const entry of quota) {
    const slug = String(entry?.provider ?? "");
    if (slug === "") continue;
    const chip = providerChip(slug, slug, state.selectedProvider === slug);
    if (entry?.name && entry.name !== slug) chip.title = entry.name + " (" + slug + ")";
    group.appendChild(chip);
  }

  bar.appendChild(group);
  return bar;
}

function providerChip(provider: string | null, label: string, active: boolean): HTMLElement {
  const button = document.createElement("button");
  button.className = "provider-chip" + (active ? " active" : "");
  button.setAttribute("data-command", "selectProvider");
  button.setAttribute("data-value", provider ?? "");
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.textContent = label;
  return button;
}

/** "main (minimax)" when the two differ, otherwise just the slug. */
function connectionLabel(row: ConnectionUsage): string {
  if (row.name && row.name !== row.provider) return row.name + " (" + row.provider + ")";
  return row.provider || row.name || "-";
}

/** The all-connections table. The connection name drills into that provider. */
function renderConnectionTable(rows: ConnectionUsage[]): HTMLElement {
  const table = document.createElement("table");
  table.className = "quota-table connection-table";
  table.appendChild(headRow(["Connection", "Provider", "Requests", "Tokens", "Cost", "Remaining"]));

  const body = document.createElement("tbody");
  for (const row of rows) {
    const dashIfIdle = (text: string) => (row.idle ? "-" : text);
    const tr = document.createElement("tr");
    if (row.idle) tr.className = "connection-idle";

    // The name cell is a button, not a click handler on the row: a <tr> cannot
    // be reached by keyboard, and drilling in is a real action.
    const nameCell = document.createElement("td");
    const link = document.createElement("button");
    link.className = "connection-name-button";
    link.setAttribute("data-command", "selectProvider");
    link.setAttribute("data-value", row.provider);
    link.title = "Show " + connectionLabel(row) + " only";
    link.textContent = row.name || String(row.connectionId).slice(0, 8) || "-";
    nameCell.appendChild(link);
    tr.appendChild(nameCell);

    for (const value of [
      row.provider || "-",
      dashIfIdle(formatCount(row.requests)),
      dashIfIdle(formatTokens(row.totalTokens)),
      dashIfIdle(formatUsd(row.cost)),
      Math.round(row.percentRemaining) + "%",
    ]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

/** One provider: its quota state, its totals, and the models behind them. */
function renderProviderDetail(connection: ConnectionUsage, byModel: any[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "provider-detail";

  const models = providerModels(byModel ?? [], connection.provider);
  const dashIfIdle = (text: string) => (connection.idle ? "-" : text);

  const stats = document.createElement("div");
  stats.className = "detail-stats";
  stats.appendChild(detailStat("Remaining", Math.round(connection.percentRemaining) + "%"));
  stats.appendChild(
    detailStat("Reset", connection.resetAt ? formatResetIn(connection.resetAt) : "-"),
  );
  stats.appendChild(detailStat("Requests", dashIfIdle(formatCount(connection.requests))));
  stats.appendChild(detailStat("Tokens", dashIfIdle(formatTokens(connection.totalTokens))));
  stats.appendChild(detailStat("Cost", dashIfIdle(formatUsd(connection.cost))));
  wrap.appendChild(stats);

  const heading = document.createElement("h4");
  heading.className = "detail-heading";
  heading.textContent = "Models in this range";
  wrap.appendChild(heading);

  if (models.length === 0) {
    wrap.appendChild(renderEmpty("No traffic from this provider in the selected range."));
    return wrap;
  }

  const table = document.createElement("table");
  // NOT .connection-table: that class means "the all-connections table" in the
  // CDP contract, and sharing it made the row count read 24 on a drilled-in
  // view that had zero connection rows.
  table.className = "quota-table provider-model-table";
  table.appendChild(headRow(["Model", "Requests", "Tokens", "Cost"]));

  const body = document.createElement("tbody");
  for (const row of models) {
    const tr = document.createElement("tr");
    for (const value of [
      row.model,
      formatCount(row.requests),
      formatTokens(row.totalTokens),
      formatUsd(row.cost),
    ]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);

  return wrap;
}

function detailStat(label: string, value: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "detail-stat";

  const l = document.createElement("div");
  l.className = "detail-stat-label";
  l.textContent = label;

  const v = document.createElement("div");
  v.className = "detail-stat-value";
  v.textContent = value;

  el.appendChild(l);
  el.appendChild(v);
  return el;
}

function renderTrend(analytics: any): HTMLElement {
  const section = document.createElement("section");
  section.className = "chart-section";

  const hourly = isHourly();

  const title = document.createElement("h3");
  title.className = "chart-section-title";
  title.textContent = hourly ? "Hourly trend (last 24 hours)" : "Daily trend";
  section.appendChild(title);

  const points = trendPoints(analytics);
  if (points.length === 0) {
    section.appendChild(renderEmpty(hourly ? "No traffic in the last 24 hours." : "No daily data in this range."));
    return section;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "chart-wrapper";
  const canvas = document.createElement("canvas");
  wrapper.appendChild(canvas);
  section.appendChild(wrapper);

  queueChart("trend", canvas, trendChartConfig(points, chartPalette()));

  // Say why one series is missing rather than letting a one-line chart look
  // like a rendering fault.
  if (state.selectedProvider !== null && !hourly) {
    const note = document.createElement("div");
    note.className = "section-note";
    note.textContent =
      "Tokens only: this endpoint publishes no per-provider request counts by date. " +
      "Select 1d for hourly requests and tokens.";
    section.appendChild(note);
  }

  return section;
}

function renderRank(analytics: any): HTMLElement {
  const section = document.createElement("section");
  section.className = "chart-section";

  const title = document.createElement("h3");
  title.className = "chart-section-title";
  title.textContent = "Top models by requests";
  section.appendChild(title);

  const models = filterByProvider(analytics?.byModel ?? [], state.selectedProvider).slice(0, 10);
  if (models.length === 0) {
    section.appendChild(renderEmpty("No model data."));
    return section;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "chart-wrapper chart-wrapper-short";
  const canvas = document.createElement("canvas");
  wrapper.appendChild(canvas);
  section.appendChild(wrapper);

  const ranked = models.map((row: any) => ({
    model: row.rawModel ?? row.model ?? row.provider,
    requests: row.requests,
  }));
  queueChart("models", canvas, donutConfig(ranked, "model", "requests", chartPalette(), "requests"));

  section.appendChild(renderBreakdownTable(models));
  return section;
}

function renderBreakdownTable(rows: any[]): HTMLElement {
  const table = document.createElement("table");
  table.className = "donut-table";
  table.appendChild(headRow(["Model", "Requests", "Tokens", "Cost"]));

  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const value of [
      row.rawModel ?? row.model ?? row.provider,
      formatCount(row.requests),
      formatTokens(row.totalTokens),
      formatUsd(row.cost),
    ]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

/**
 * Why a filtered request log can look empty.
 *
 * `/api/usage/request-logs` is hard-coded to `getRecentLogs(200)` on the
 * server, about 40 minutes at the measured rate, and `call-logs` is what backs
 * the hourly chart instead. So a provider whose traffic is older than the
 * window legitimately shows nothing, while the cards and charts — which come
 * from the range-wide analytics endpoint — stay populated.
 */
function logWindowNote(): HTMLElement {
  const note = document.createElement("div");
  note.className = "section-note";
  note.textContent =
    "The server returns only its 200 most recent requests, so a provider whose traffic is " +
    "older than that window shows little or nothing here. The cards and charts cover the " +
    "whole selected range.";
  return note;
}

/**
 * The Logs view: the request log, one row per request.
 *
 * Mirrors the table at `<server>/dashboard/logs`, which reads the same
 * `GET /api/usage/call-logs`. What it keeps: the status chip filter, the
 * search box, the per-row detail, and paging. What it drops, because a sidebar
 * 400 px wide cannot hold them: the sixteen toggleable columns, click-to-sort,
 * the refresh-interval control, the CSV/JSON export, the clean-history action
 * and the modal detail.
 *
 * The rows are not in `DashboardPayload`. This view pages and searches on its
 * own schedule, so it sends `loadLogs` and receives a `logsPage` answer.
 */
function renderLogsView(): HTMLElement {
  const section = document.createElement("section");
  section.className = "chart-section logs-section";

  const title = document.createElement("h3");
  title.className = "chart-section-title";
  title.textContent = "Request log";
  section.appendChild(title);

  section.appendChild(renderLogsToolbar());

  const logs = state.logs;
  if (logs.error !== null) {
    section.appendChild(renderEmpty(logs.error));
    return section;
  }
  if (logs.loading && logs.rows.length === 0) {
    section.appendChild(renderEmpty("Loading the request log..."));
    return section;
  }
  if (logs.rows.length === 0) {
    section.appendChild(
      renderEmpty(
        logs.appliedRequestId === 0 ? "Loading the request log..." : "No requests match this filter.",
      ),
    );
    return section;
  }

  section.appendChild(renderCallLogTable(logs.rows));
  section.appendChild(renderLogsPager());

  const note = document.createElement("div");
  note.className = "section-note";
  note.textContent =
    logs.rows.length + " row" + (logs.rows.length === 1 ? "" : "s") +
    ", newest first. The server merges requests still in flight into every page, so a row may " +
    "repeat after paging; identical ids are shown once.";
  section.appendChild(note);

  return section;
}

/** Status chips and the search box. */
function renderLogsToolbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "logs-toolbar";

  const chips = document.createElement("div");
  chips.className = "logs-filters";
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Log status");

  for (const { value, label } of STATUS_FILTERS) {
    const button = document.createElement("button");
    const active = state.logs.status === value;
    button.className = "log-chip" + (active ? " active" : "");
    button.setAttribute("data-command", "logsStatus");
    button.setAttribute("data-value", value);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.textContent = label;
    chips.appendChild(button);
  }
  bar.appendChild(chips);

  const search = document.createElement("input");
  search.className = "logs-search";
  search.setAttribute("data-role", "logs-search");
  search.setAttribute("type", "search");
  search.setAttribute("aria-label", "Search the request log");
  search.placeholder = "Search model, provider, status...";
  // The value is a property, not markup: re-rendering must not lose what the
  // reader typed while a page was in flight.
  search.value = state.logs.search;
  bar.appendChild(search);

  return bar;
}

/** One row per request, plus an inline detail row for the open one. */
function renderCallLogTable(rows: CallLogRow[]): HTMLElement {
  const table = document.createElement("table");
  table.className = "quota-table call-log-table";
  table.appendChild(headRow(["Time", "Status", "Provider", "Model", "Tokens", "Took"]));

  const body = document.createElement("tbody");
  for (const row of rows) {
    const kind = classifyStatus(row.status, row.error);
    const expanded = state.logs.expanded === row.id;

    const tr = document.createElement("tr");
    tr.className = "call-log-row status-" + kind + (expanded ? " expanded" : "");

    // The time cell is the button, not the row: a <tr> cannot be focused or
    // activated from the keyboard, and the detail is a real action.
    const timeCell = document.createElement("td");
    const toggle = document.createElement("button");
    toggle.className = "log-time-button";
    toggle.setAttribute("data-command", "logsRow");
    toggle.setAttribute("data-value", row.id);
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.title = expanded ? "Hide the detail" : "Show the detail";
    toggle.textContent = row.timestamp ? new Date(row.timestamp).toLocaleTimeString() : "-";
    timeCell.appendChild(toggle);
    tr.appendChild(timeCell);

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "log-status log-status-" + kind;
    badge.textContent = kind === "pending" ? "..." : String(row.status || "-");
    statusCell.appendChild(badge);
    tr.appendChild(statusCell);

    for (const value of [
      row.providerDisplay || row.provider || "-",
      row.requestedModel || row.model || "-",
      formatTokens(row.promptTokens) + " → " + formatTokens(row.completionTokens),
      formatDuration(row.duration),
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }

    body.appendChild(tr);

    if (expanded) {
      const detail = document.createElement("tr");
      detail.className = "call-log-detail-row";
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.appendChild(renderCallLogDetail(row));
      detail.appendChild(cell);
      body.appendChild(detail);
    }
  }

  table.appendChild(body);
  return table;
}

/** Everything the row does not have space for. */
function renderCallLogDetail(row: CallLogRow): HTMLElement {
  const list = document.createElement("dl");
  list.className = "log-detail";

  const items: [string, string][] = [
    ["Model", row.model || "-"],
    ["Requested", row.requestedModel || "-"],
    ["Account", row.account || "-"],
    ["API key", row.apiKeyName || "-"],
    ["Path", (row.method ? row.method + " " : "") + (row.path || "-")],
    ["Cache", row.cacheSource || "-"],
    ["Combo", row.comboName || "-"],
    ["Added wait", row.addedWaitMs === null ? "-" : formatDuration(row.addedWaitMs)],
    ["Correlation", row.correlationId || "-"],
    ["Error", row.error || "-"],
  ];

  for (const [label, value] of items) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.appendChild(dt);
    list.appendChild(dd);
  }

  return list;
}

/** Newer / older, with the page number. The server exposes no total. */
function renderLogsPager(): HTMLElement {
  const pager = document.createElement("div");
  pager.className = "pager";

  const prev = document.createElement("button");
  prev.className = "button";
  prev.setAttribute("data-command", "page");
  prev.setAttribute("data-value", "-1");
  prev.textContent = "Newer";
  prev.disabled = state.logs.offset === 0;

  const label = document.createElement("span");
  label.className = "pager-label";
  label.textContent = "Page " + (Math.floor(state.logs.offset / LOG_PAGE_SIZE) + 1);

  const next = document.createElement("button");
  next.className = "button";
  next.setAttribute("data-command", "page");
  next.setAttribute("data-value", "1");
  next.textContent = "Older";
  next.disabled = !state.logs.hasMore;

  pager.appendChild(prev);
  pager.appendChild(label);
  pager.appendChild(next);
  return pager;
}

/** "820ms" / "8.2s". A log row's duration is a wall-clock measurement. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
}

function renderLogs(logs: any[], total: number, page: number): HTMLElement {  const section = document.createElement("section");
  section.className = "chart-section";

  const title = document.createElement("h3");
  title.className = "chart-section-title";
  title.textContent = "Recent requests (" + formatCount(total) + ")";
  section.appendChild(title);

  if (logs.length === 0) {
    section.appendChild(renderEmpty("No request log rows."));
    if (state.selectedProvider !== null) {
      section.appendChild(logWindowNote());
    }
    return section;
  }

  const rows = logs.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const table = document.createElement("table");
  table.className = "records-table";
  table.appendChild(headRow(["Time", "Model", "Provider", "Prompt", "Completion", "Status"]));

  const body = document.createElement("tbody");
  for (const row of rows) {
    const time = row.timestamp ? new Date(row.timestamp).toLocaleTimeString() : "-";
    const tr = document.createElement("tr");
    for (const value of [time, row.model, row.provider, formatTokens(row.promptTokens), formatTokens(row.completionTokens), row.status]) {
      const td = document.createElement("td");
      td.textContent = value ?? "-";
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  section.appendChild(table);

  // The log endpoint is hard-coded to the most recent 200 rows, so filtering
  // it by provider can show almost nothing even when that provider has traffic
  // in the range. Without this line the empty table reads as a bug.
  if (state.selectedProvider !== null) section.appendChild(logWindowNote());

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages > 1) {
    const pager = document.createElement("div");
    pager.className = "pager";

    const prev = document.createElement("button");
    prev.className = "button";
    prev.setAttribute("data-command", "page");
    prev.setAttribute("data-value", "-1");
    prev.textContent = "Previous";
    prev.disabled = page === 0;

    const label = document.createElement("span");
    label.className = "pager-label";
    label.textContent = "Page " + (page + 1) + " of " + pages;

    const next = document.createElement("button");
    next.className = "button";
    next.setAttribute("data-command", "page");
    next.setAttribute("data-value", "1");
    next.textContent = "Next";
    next.disabled = page >= pages - 1;

    pager.appendChild(prev);
    pager.appendChild(label);
    pager.appendChild(next);
    section.appendChild(pager);
  }
  return section;
}

function headRow(labels: string[]): HTMLElement {
  const head = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const label of labels) {
    const th = document.createElement("th");
    th.textContent = label;
    tr.appendChild(th);
  }
  head.appendChild(tr);
  return head;
}

/**
 * Read the value out of a control.
 *
 * A number box reports text, not a number, so an empty box and a box
 * holding "abc" both have to become something the host can reject. An
 * empty box becomes `undefined`, which the host treats as "not a number"
 * and answers with a message; the reader sees why instead of the value
 * silently becoming `NaN`.
 */
function readControlValue(control: Element): unknown {
  if (control instanceof HTMLInputElement) {
    if (control.type === "checkbox") return control.checked;
    if (control.type === "number") {
      const raw = control.value.trim();
      if (raw === "") return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : raw;
    }
    return control.value;
  }
  if (control instanceof HTMLSelectElement) return control.value;
  return undefined;
}

/**
 * The Config view: every setting, its effective value, and where the two
 * credentials live.
 *
 * The webview cannot read any of this itself. `vscode.workspace` is not
 * available in a webview, and the credentials are in the extension host's
 * SecretStorage, which the webview has no access to at all. So the host sends
 * the effective values and the *fact* that a key is set, never the key.
 *
 * The view replaces the body, like the Logs view does, because it is about
 * the extension rather than about the server. It also renders before the
 * loading and error branches, so it stays readable when the server is down.
 */
function renderConfigView(): HTMLElement {
  const section = document.createElement("section");
  section.className = "chart-section config-section";

  const title = document.createElement("h3");
  title.className = "chart-section-title";
  title.textContent = "Configuration";
  section.appendChild(title);

  if (state.config.loading && state.config.settings.length === 0) {
    section.appendChild(renderEmpty("Loading the configuration..."));
    return section;
  }

  section.appendChild(renderConfigScopePicker());
  section.appendChild(renderConfigSettings(state.config.settings));
  section.appendChild(renderConfigCredentials());
  section.appendChild(renderConfigFooter());
  return section;
}

/**
 * Where an edit goes: the user's settings, or this workspace's.
 *
 * The same choice the Settings editor offers, because it is the same
 * decision. "Workspace" is only offered when a workspace is open: a
 * workspace-scoped setting cannot be saved without one, and offering a
 * choice that fails is worse than not offering it.
 */
function renderConfigScopePicker(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "config-scope";

  const label = document.createElement("span");
  label.className = "config-scope-label";
  label.textContent = "Save changes to";
  bar.appendChild(label);

  const group = document.createElement("div");
  // NOT .provider-selector: the CDP check asserts that the provider group's
  // label is "Provider", and a second group with that class made the claim
  // fail in the Config view. One class, one group.
  group.className = "config-scope-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Configuration scope");

  const scopes: { id: "user" | "workspace"; label: string }[] = [
    { id: "user", label: "User" },
  ];
  if (state.config.hasWorkspace) {
    scopes.push({ id: "workspace", label: "Workspace" });
  }

  for (const scope of scopes) {
    const button = document.createElement("button");
    button.className = "provider-chip" + (state.config.target === scope.id ? " active" : "");
    button.setAttribute("data-command", "setConfigTarget");
    button.setAttribute("data-value", scope.id);
    button.setAttribute("aria-pressed", state.config.target === scope.id ? "true" : "false");
    button.textContent = scope.label;
    group.appendChild(button);
  }

  bar.appendChild(group);
  return bar;
}

/**
 * The settings form.
 *
 * One row per setting, with the control the manifest's schema asks for:
 * a checkbox for a boolean, a number box with the manifest's bounds, a
 * dropdown for an enum, a text box otherwise.
 *
 * The schema is the same source the Settings editor renders from, so a
 * setting added to `package.json` appears here with no code change, and
 * the enum and bounds are the form's own validation.
 */
function renderConfigSettings(settings: ConfigSetting[]): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "config-block";

  const heading = document.createElement("h4");
  heading.className = "detail-heading";
  heading.textContent = "Settings";
  wrapper.appendChild(heading);

  if (settings.length === 0) {
    wrapper.appendChild(renderEmpty("No settings reported."));
    return wrapper;
  }

  const form = document.createElement("div");
  form.className = "config-form";

  for (const setting of settings) {
    form.appendChild(renderConfigField(setting));
  }

  wrapper.appendChild(form);
  return wrapper;
}

/**
 * One setting, laid out as a single row:
 * `[name] [control] [description] [save]`.
 *
 * A block layout stretched every input to the panel's full width, which made
 * a number box and a two-word dropdown look identical and pushed the Save
 * button off the reader's eye line. The row keeps the control near the name
 * it belongs to and puts the action where the reading order ends. The row's
 * fourth column is fixed, so every Save button lines up down the form.
 *
 * The scope and any error span the whole row: they are about the setting, not
 * about one column of it.
 */
function renderConfigField(setting: ConfigSetting): HTMLElement {
  const field = document.createElement("div");
  field.className = "config-field";
  // The FIELD carries `data-setting-field` and the CONTROL carries
  // `data-setting`. They were the same attribute, and a lookup for the
  // control matched the wrapper instead: the value came back undefined and
  // the host rejected it as "not a number". One attribute, one element.
  field.setAttribute("data-setting-field", setting.key);

  const label = document.createElement("label");
  label.className = "config-label";
  label.setAttribute("for", `config-${setting.key}`);
  label.textContent = setting.key;
  if (setting.modified) {
    const badge = document.createElement("span");
    badge.className = "config-modified";
    badge.textContent = "modified";
    badge.title = `Changed from the default (${String(setting.defaultValue)})`;
    label.appendChild(badge);
  }
  field.appendChild(label);

  field.appendChild(renderConfigControl(setting));

  // The description sits between the control and the Save button, so a
  // reader sees what the setting does next to the box they are changing.
  const description = document.createElement("div");
  description.className = "config-description";
  description.textContent = setting.description;
  description.title = setting.description;
  field.appendChild(description);

  const actions = document.createElement("div");
  actions.className = "config-actions";
  actions.appendChild(configSaveButton(setting.key, "Save"));
  field.appendChild(actions);

  const scope = document.createElement("span");
  scope.className = "config-scope-of";
  scope.textContent = `source: ${setting.scope}`;
  field.appendChild(scope);

  const error = state.config.errors[setting.key];
  if (error) {
    const message = document.createElement("div");
    message.className = "config-error";
    message.setAttribute("role", "alert");
    message.textContent = error;
    field.appendChild(message);
  }

  return field;
}

/**
 * The control for one setting, as a bare element.
 *
 * It returns the input itself, not a wrapper: the row in `renderConfigField`
 * owns the layout and the Save button, and a control that brought its own
 * wrapper and its own button put two Save buttons in every row.
 *
 * A boolean is a checkbox that applies on change. The others are inputs that
 * wait for the row's Save button, because a text box that writes on every
 * keystroke would fight the reader: the value goes into the settings file as
 * they type, and there is no way to back out of a half-typed value.
 */
function renderConfigControl(setting: ConfigSetting): HTMLElement {
  const id = `config-${setting.key}`;

  if (setting.control === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = setting.value === true;
    input.setAttribute("data-setting", setting.key);
    input.setAttribute("data-control", "boolean");
    input.addEventListener("change", () => {
      vscode.postMessage({
        command: "updateSetting",
        key: setting.key,
        value: input.checked,
        target: state.config.target,
      });
    });
    return input;
  }

  if (setting.control === "enum" && setting.enumValues) {
    const select = document.createElement("select");
    select.id = id;
    select.setAttribute("data-setting", setting.key);
    select.setAttribute("data-control", "enum");
    for (const option of setting.enumValues) {
      const element = document.createElement("option");
      element.value = option;
      element.textContent = option;
      if (option === String(setting.value)) element.selected = true;
      select.appendChild(element);
    }

    // The stored value may not be one of the options — most often the
    // manifest's default, which the payload's list deliberately omits.
    // A select whose value matches nothing displays blank, which reads as a
    // broken form. One synthetic row carries the stored value as the state,
    // and is disabled so it cannot be re-chosen: it describes, it does not
    // offer.
    const text = String(setting.value);
    if (!setting.enumValues.includes(text)) {
      const state = document.createElement("option");
      state.value = text;
      state.textContent = `nothing chosen (${text})`;
      state.selected = true;
      state.disabled = true;
      select.insertBefore(state, select.firstChild);
    }
    return select;
  }

  const box = document.createElement("input");
  box.type = setting.control === "number" ? "number" : "text";
  box.id = id;
  box.setAttribute("data-setting", setting.key);
  box.setAttribute("data-control", setting.control);
  if (setting.control === "number") {
    if (setting.minimum !== undefined) box.min = String(setting.minimum);
    if (setting.maximum !== undefined) box.max = String(setting.maximum);
  }
  box.value = String(setting.value ?? "");
  return box;
}

/**
 * The Save button for one setting.
 *
 * The value is read from the control at the moment of the click, so the
 * message carries what the reader typed, not what was last rendered.
 */
function configSaveButton(key: string, label: string): HTMLElement {
  const button = document.createElement("button");
  button.className = "button config-save";
  button.setAttribute("data-command", "saveSetting");
  button.setAttribute("data-value", key);
  button.textContent = label;
  return button;
}

/**
 * The credentials block: the notice, and a form to set or clear each key.
 *
 * The notice is the point of this block. A reader who opens a settings
 * screen expects to see their key, and the honest answer is that they
 * cannot: the key is in the OS keychain, and the extension never puts it
 * anywhere the user can read it back. Saying that plainly is better than
 * showing an empty field that looks like a mistake.
 */
function renderConfigCredentials(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "config-block";

  const heading = document.createElement("h4");
  heading.className = "detail-heading";
  heading.textContent = "Credentials";
  wrapper.appendChild(heading);

  const notice = document.createElement("div");
  notice.className = "config-notice";
  notice.setAttribute("role", "note");
  notice.textContent =
    "Your API key and admin key are never saved in clear text. They are stored " +
    "in the operating system's secret store (the OS keychain), not in " +
    "settings.json and not on disk in this extension's folder. The extension " +
    "reads them from there at request time, and it never sends them anywhere " +
    "except to your own server. You cannot read a key back from here, by " +
    "design.";
  wrapper.appendChild(notice);

  for (const credential of [
    { which: "apiKey" as const, name: "API key", state: state.config.apiKey },
    { which: "adminKey" as const, name: "Admin key", state: state.config.adminKey },
  ]) {
    wrapper.appendChild(renderConfigCredentialField(credential.which, credential.name, credential.state));
  }

  return wrapper;
}

/** One credential: its status, a box to paste a key into, and a clear button. */
function renderConfigCredentialField(
  which: "apiKey" | "adminKey",
  name: string,
  credential: CredentialState,
): HTMLElement {
  const field = document.createElement("div");
  field.className = "config-field";
  field.setAttribute("data-credential-field", which);

  const label = document.createElement("label");
  label.className = "config-label";
  label.setAttribute("for", `credential-${which}`);
  label.textContent = name;

  const status = document.createElement("span");
  status.className = credential.set ? "config-set" : "config-unset";
  status.textContent = credential.set ? `set (${credential.hint})` : "not set";
  label.appendChild(status);

  field.appendChild(label);

  const input = document.createElement("input");
  input.type = "password";
  input.id = `credential-${which}`;
  input.placeholder = "Paste a key, then save";
  input.autocomplete = "off";
  input.setAttribute("data-credential-input", which);
  field.appendChild(input);

  const description = document.createElement("div");
  description.className = "config-description";
  description.textContent = credential.scopeNeeded;
  description.title = credential.scopeNeeded;
  field.appendChild(description);

  // Save and Clear share the actions column, so the two credential rows line
  // up with the settings rows above them.
  const actions = document.createElement("div");
  actions.className = "config-actions";

  const save = document.createElement("button");
  save.className = "button config-save";
  save.setAttribute("data-command", "saveCredential");
  save.setAttribute("data-value", which);
  save.textContent = "Save";
  actions.appendChild(save);

  if (credential.set) {
    const clear = document.createElement("button");
    clear.className = "button config-save";
    clear.setAttribute("data-command", "clearCredential");
    clear.setAttribute("data-value", which);
    clear.textContent = "Clear";
    actions.appendChild(clear);
  }

  field.appendChild(actions);

  const error = state.config.errors[which];
  if (error) {
    const message = document.createElement("div");
    message.className = "config-error";
    message.setAttribute("role", "alert");
    message.textContent = error;
    field.appendChild(message);
  }

  return field;
}

/**
 * The footer: a link to VS Code's own Settings editor.
 *
 * The Settings editor is the authoritative one. It knows about scopes,
 * language overrides, and every key the extension might add later. The
 * form here is the fast path; this is the escape hatch.
 */
function renderConfigFooter(): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "config-footer";

  const link = document.createElement("button");
  link.className = "button";
  link.setAttribute("data-command", "openSettings");
  link.textContent = "Open in Settings editor";
  footer.appendChild(link);

  const note = document.createElement("div");
  note.className = "section-note";
  note.textContent =
    "The Settings editor is the authoritative view. It shows every setting, " +
    "including any added after this release, and it handles scopes and " +
    "language overrides.";
  footer.appendChild(note);

  return footer;
}

/**
 * Ask the host for the configuration.
 *
 * The host is the only one that can read the settings and the SecretStorage,
 * so this is a request rather than a local read.
 */
function loadConfig(): void {
  state.config.loading = true;
  render();
  vscode.postMessage({ command: "loadConfig" });
}

/**
 * Normalize a credential answer.
 *
 * The host sends `{ set, hint, scopeNeeded }`. Anything else is treated
 * as "not set", because a malformed answer must not be read as a key
 * being present.
 */
function normalizeCredential(value: unknown): CredentialState {
  if (!value || typeof value !== "object") {
    return { set: false, hint: "", scopeNeeded: "" };
  }
  const raw = value as { set?: unknown; hint?: unknown; scopeNeeded?: unknown };
  return {
    set: raw.set === true,
    hint: typeof raw.hint === "string" ? raw.hint : "",
    scopeNeeded: typeof raw.scopeNeeded === "string" ? raw.scopeNeeded : "",
  };
}

function renderLoading(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "loading-overlay";

  const content = document.createElement("div");
  content.className = "loading-content";

  const spinner = document.createElement("div");
  spinner.className = "loading-spinner";

  const text = document.createElement("div");
  text.className = "loading-text";
  text.textContent = "Loading usage...";

  content.appendChild(spinner);
  content.appendChild(text);
  overlay.appendChild(content);
  return overlay;
}

function renderError(error: { kind: string; message: string }): HTMLElement {
  const box = document.createElement("div");
  box.className = "empty-message error-message";

  const heading = document.createElement("div");
  heading.className = "empty-title";
  const detail = document.createElement("div");

  if (error.kind === "no-admin-key") {
    heading.textContent = "Admin key required";
    detail.textContent =
      "The dashboard reads OmniRoute's management API, which needs a key with the manage or admin scope. " +
      "Run 'Omni Monitor: Set Admin Key'. The status bar quota works without it.";
  } else if (error.kind === "auth") {
    heading.textContent = "Admin key rejected";
    detail.textContent = "The key was refused. Check it has the manage or admin scope.";
  } else {
    heading.textContent = "OmniRoute unreachable";
    detail.textContent = error.message || "The server did not answer.";
  }

  const retry = document.createElement("button");
  retry.className = "button";
  retry.setAttribute("data-command", "refresh");
  retry.textContent = "Retry";

  box.appendChild(heading);
  box.appendChild(detail);
  box.appendChild(retry);
  return box;
}

function renderEmpty(message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty-message";
  el.textContent = message;
  return el;
}

/**
 * Charts are created after layout so the canvas has a non-zero size. A chart
 * created while the panel is collapsed renders at zero height and stays broken
 * after it expands, which is why the canvas sits inside .chart-wrapper with a
 * fixed-height parent.
 */
function queueChart(id: string, canvas: HTMLCanvasElement, config: any): void {
  requestAnimationFrame(() => {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(canvas, config);
  });
}

vscode.postMessage({ command: "ready" });
