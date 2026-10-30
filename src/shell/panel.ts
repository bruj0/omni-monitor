/**
 * Dashboard panel: host side.
 *
 * Mirrors GCMP's `src/ui/usagesView/index.ts` structure deliberately. Three
 * anti-race patterns are ported verbatim because they are easy to get wrong:
 *
 *   1. MONOTONIC requestId. Every response carries the id of the request that
 *      caused it, and the webview drops any response whose id is older than
 *      the last one it applied. Without this, switching ranges quickly renders
 *      the first response to arrive last.
 *   2. ONE IN-FLIGHT PLUS ONE PENDING. Bursts collapse into a single fetch
 *      with at most one queued behind it, never a pile of parallel calls.
 *   3. DEBOUNCED SMART REFRESH. A short timer merges refresh requests that
 *      arrive close together.
 */

import * as vscode from "vscode";
import { defaultRange, rootUrl } from "./config";
import {
  fetchAnalytics,
  fetchCallLogPage,
  fetchCallLogSamples,
  fetchQuota,
  fetchRequestLogs,
  ManagementAuthError,
} from "./adminClient";
import { adminKey } from "./config";
import {
  clearCredential,
  readConfigPayload,
  resetSetting,
  setCredential,
  updateSetting,
} from "./configPayload";
import type { ConfigSetting, CredentialState } from "./configPayload";
import type { AnalyticsEnvelope, Range, RequestLogRow } from "../core/analytics";
import { isRange } from "../core/analytics";
import { hourlyBuckets, type HourlyBucket } from "../core/hourly";
import { DEFAULT_LOG_QUERY, type CallLogRow, type LogQuery } from "../core/logs";
import type { ViewMode } from "../core/viewMode";
import { DEFAULT_VIEW_MODE, isViewMode } from "../core/viewMode";
import type { QuotaProviderEntry } from "./adminClient";

export const VIEW_ID = "omniMonitor.dashboard";

/** Rows per records page, matching GCMP's PAGE_SIZE. */
export const PAGE_SIZE = 20;

export interface DashboardPayload {
  requestId: number;
  range: Range;
  /** Which view the dashboard is in. The webview renders from this. */
  viewMode: ViewMode;
  analytics: AnalyticsEnvelope | null;
  quota: QuotaProviderEntry[];
  logs: RequestLogRow[];
  logTotal: number;
  page: number;
  /**
   * 24 hourly buckets, for `range === "1d"` only, else null.
   *
   * Computed in the host from per-request rows rather than shipped raw: the
   * source is ~6,000 rows and ~7 MB, while 24 buckets are a few kilobytes.
   * Each bucket keeps its per-provider split so the webview can filter by
   * provider without a refetch.
   */
  hourly: HourlyBucket[] | null;
  generatedAt: string;
}

export type HostErrorKind = "no-admin-key" | "auth" | "unreachable" | "server";

export interface HostError {
  requestId: number;
  kind: HostErrorKind;
  message: string;
}

/**
 * The answer to a `loadConfig` message: the settings and the credential
 * states.
 *
 * A separate message shape, like the logs page, because the Config view
 * answers on its own schedule and does not depend on a dashboard payload. The
 * credential values are not part of it: only whether a key is set.
 */
export interface ConfigMessage {
  kind: "config";
  settings: ConfigSetting[];
  apiKey: CredentialState;
  adminKey: CredentialState;
  defaultTarget: "user" | "workspace";
  hasWorkspace: boolean;
}

/**
 * The answer to an edit: whether it worked, and why not if it did not.
 *
 * Sent before the refreshed payload, so the form can show the message next
 * to the control that failed.
 */
export interface ConfigResultMessage {
  kind: "configResult";
  ok: boolean;
  key: string;
  message?: string;
}

/**
 * One page of the request log, answering a `loadLogs` message.
 *
 * Deliberately not part of `DashboardPayload`: the log view pages, searches
 * and filters on its own schedule, and folding it into the dashboard load
 * would make every range change refetch a table nobody is looking at.
 */
export interface LogsPageMessage {
  kind: "logsPage";
  /** Echoed from the request so the webview can drop an older answer. */
  requestId: number;
  offset: number;
  rows: CallLogRow[];
  /**
   * Why the page is empty, or null when it succeeded.
   *
   * Carried here rather than as a `HostError` on purpose: a failed log fetch
   * must not put the dashboard into its error state, because that would
   * replace the header and the view toggle — the controls the reader needs to
   * leave the Logs view.
   */
  error: string | null;
}

/** The key the dashboard's view mode is stored under. */
const VIEW_MODE_KEY = "omniMonitor.viewMode";

export class DashboardPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private requestId = 0;
  private inFlight = false;
  private pending = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private range: Range;
  private page = 0;
  private viewMode: ViewMode;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: { info: (m: string) => void },
  ) {
    const configured = defaultRange();
    this.range = isRange(configured) ? configured : "30d";
    this.viewMode = this.readViewMode();
  }

  /**
   * The stored view mode, or the default.
   *
   * Read once at construction. The stored value may be missing or may name a
   * mode this version no longer has, so it is validated rather than trusted.
   */
  private readViewMode(): ViewMode {
    const stored = this.context.globalState.get<ViewMode>(VIEW_MODE_KEY);
    return isViewMode(stored) ? stored : DEFAULT_VIEW_MODE;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };

    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(
      (msg: {
        command?: string;
        range?: string;
        page?: number;
        mode?: string;
        offset?: number;
        status?: string;
        search?: string;
        provider?: string | null;
        key?: string;
        value?: unknown;
        target?: string;
        which?: string;
      }) => {
        switch (msg?.command) {
          case "ready":
            void this.load();
            return;
          case "refresh":
            this.scheduleRefresh();
            return;
          case "setRange":
            if (typeof msg.range === "string" && isRange(msg.range)) {
              this.range = msg.range;
              this.page = 0;
              void this.load();
            }
            return;
          case "setPage":
            if (typeof msg.page === "number" && msg.page >= 0) {
              this.page = msg.page;
              void this.load();
            }
            return;
          case "setViewMode":
            if (isViewMode(msg.mode)) {
              this.viewMode = msg.mode;
              void this.context.globalState.update(VIEW_MODE_KEY, msg.mode);
              // The mode changes what is drawn, not what is fetched. The
              // webview has already re-rendered from the payload in hand, and
              // the payload carries the mode for the next fresh render, so
              // there is nothing to reload here. Fetching would add a request
              // and a loading flash for data that did not change.
            }
            return;
          case "loadLogs":
            void this.loadLogs(msg);
            return;
          case "loadConfig":
            void this.loadConfig();
            return;
          case "updateSetting":
            void this.applySetting(msg);
            return;
          case "resetSetting":
            void this.resetSetting(msg);
            return;
          case "setCredential":
            void this.applyCredential(msg);
            return;
          case "clearCredential":
            void this.removeCredential(msg);
            return;
          case "openSettings":
            // Open VS Code's own Settings editor, filtered to this
            // extension. It is the authoritative editor: it knows about
            // scopes, language overrides and every keybinding-style detail
            // this form does not.
            void vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "@ext:omniMonitor.omni-monitor",
            );
            return;
        }
      },
    );
  }

  /**
   * Answer the Config view with the settings and the credential states.
   *
   * The webview cannot read either of these itself, so the host sends them.
   * The credential values are not part of the answer: only whether a key is
   * set, and a short hint that tells two keys apart.
   */
  private async loadConfig(): Promise<void> {
    const payload = await readConfigPayload(this.context);
    this.post({ kind: "config", ...payload });
  }

  /** The scope an edit asks for, defaulting to the user's settings. */
  private editTarget(msg: { target?: string }): "user" | "workspace" {
    return msg.target === "workspace" ? "workspace" : "user";
  }

  /**
   * Apply one setting edit and answer with the result.
   *
   * The answer is sent back before the payload is re-sent, so the form can
   * show the failure next to the control that failed. On success the
   * payload follows, so the form shows the new value and its new scope.
   */
  private async applySetting(msg: { key?: string; value?: unknown; target?: string }): Promise<void> {
    if (typeof msg.key !== "string") return;
    const result = await updateSetting(
      this.context,
      msg.key,
      msg.value,
      this.editTarget(msg),
    );
    this.post({ kind: "configResult", ...result });
    if (result.ok) await this.loadConfig();
  }

  /** Reset one setting to its default. */
  private async resetSetting(msg: { key?: string; target?: string }): Promise<void> {
    if (typeof msg.key !== "string") return;
    const result = await resetSetting(this.context, msg.key, this.editTarget(msg));
    this.post({ kind: "configResult", ...result });
    if (result.ok) await this.loadConfig();
  }

  /**
   * Store a credential the form collected.
   *
   * The value is never echoed back: the payload that follows says only
   * whether a key is set.
   */
  private async applyCredential(msg: { which?: string; value?: unknown }): Promise<void> {
    if (msg.which !== "apiKey" && msg.which !== "adminKey") return;
    if (typeof msg.value !== "string") return;
    const result = await setCredential(this.context, msg.which, msg.value);
    this.post({ kind: "configResult", ...result });
    if (result.ok) await this.loadConfig();
  }

  /** Remove a credential. */
  private async removeCredential(msg: { which?: string }): Promise<void> {
    if (msg.which !== "apiKey" && msg.which !== "adminKey") return;
    const result = await clearCredential(this.context, msg.which);
    this.post({ kind: "configResult", ...result });
    if (result.ok) await this.loadConfig();
  }

  /** Visible again after being collapsed; refresh so the data is not stale. */
  revive(): void {
    if (this.view?.visible) this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.load();
    }, 250);
  }

  /** One in-flight load, plus at most one queued behind it. */
  async load(): Promise<void> {
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.inFlight = true;
    const id = ++this.requestId;

    try {
      const key = await adminKey(this.context);

      if (!key) {
        this.post({
          requestId: id,
          kind: "no-admin-key",
          message:
            "No admin key set. The dashboard needs a key with the manage or admin scope. " +
            "Run 'Omni Monitor: Set Admin Key'. The status bar works without it.",
        } satisfies HostError);
        return;
      }

      const [analytics, quota, logs, hourly] = await Promise.all([
        fetchAnalytics(this.range, key, this.log).catch((e) => {
          throw e;
        }),
        fetchQuota(key, this.log).catch(() => [] as QuotaProviderEntry[]),
        fetchRequestLogs(key, this.log).catch(() => [] as RequestLogRow[]),
        this.hourlyTrend(key),
      ]);

      this.post({
        requestId: id,
        range: this.range,
        viewMode: this.viewMode,
        analytics,
        quota,
        logs,
        logTotal: logs.length,
        page: this.page,
        hourly,
        generatedAt: new Date().toISOString(),
      } satisfies DashboardPayload);
    } catch (error) {
      const kind: HostErrorKind =
        error instanceof ManagementAuthError ? "auth" : "unreachable";
      this.post({
        requestId: id,
        kind,
        message: (error as Error).message,
      } satisfies HostError);
      this.log.info(`dashboard load failed (${kind}): ${(error as Error).message}`);
    } finally {
      this.inFlight = false;
      if (this.pending) {
        this.pending = false;
        void this.load();
      }
    }
  }

  /**
   * Fetch one page of the request log for the logs view.
   *
   * The query comes from the webview, because the webview owns the log
   * view's offset, status chip, search text and the dashboard-wide provider
   * filter. Nothing about it is stored here: a reload starts from the default
   * page, which is the honest state after a window reload.
   *
   * A failure answers with an empty page rather than a `HostError`, so the log
   * view can show its own message and keep the filter controls usable. The
   * admin-key case is the exception — there is nothing to page through.
   */
  private async loadLogs(msg: {
    requestId?: number;
    offset?: number;
    status?: string;
    search?: string;
    provider?: string | null;
  }): Promise<void> {
    const requestId = typeof msg.requestId === "number" ? msg.requestId : 0;
    const query: LogQuery = {
      ...DEFAULT_LOG_QUERY,
      offset: typeof msg.offset === "number" && msg.offset > 0 ? Math.floor(msg.offset) : 0,
      status: msg.status === "ok" || msg.status === "error" ? msg.status : "",
      search: typeof msg.search === "string" ? msg.search : "",
      provider: typeof msg.provider === "string" && msg.provider !== "" ? msg.provider : null,
    };

    try {
      const key = await adminKey(this.context);
      if (!key) {
        void this.view?.webview.postMessage({
          kind: "logsPage",
          requestId,
          offset: query.offset,
          rows: [],
          error:
            "No admin key set. The log view needs a key with the manage or admin scope. " +
            "Run 'Omni Monitor: Set Admin Key'.",
        } satisfies LogsPageMessage);
        return;
      }

      const rows = await fetchCallLogPage(query, key, this.log);
      void this.view?.webview.postMessage({
        kind: "logsPage",
        requestId,
        offset: query.offset,
        rows,
        error: null,
      } satisfies LogsPageMessage);
    } catch (error) {
      const kind: HostErrorKind = error instanceof ManagementAuthError ? "auth" : "unreachable";
      const message =
        kind === "auth"
          ? "The admin key was refused. Check it has the manage or admin scope."
          : (error as Error).message;
      void this.view?.webview.postMessage({
        kind: "logsPage",
        requestId,
        offset: query.offset,
        rows: [],
        error: message,
      } satisfies LogsPageMessage);
      this.log.info(`logs page failed (${kind}): ${(error as Error).message}`);
    }
  }

  private post(
    message: DashboardPayload | HostError | ConfigMessage | ConfigResultMessage,
  ): void {
    void this.view?.webview.postMessage(message);
  }

  /**
   * The 1d hourly series, or null for every other range.
   *
   * Only `1d` needs it: the analytics endpoint aggregates by date, so a rolling
   * 24 hours arrives as two points. A failure here is swallowed on purpose —
   * the dashboard is still correct without the hourly chart, and an hourly
   * fetch that fails must not take the whole panel down with it.
   */
  private async hourlyTrend(key: string): Promise<HourlyBucket[] | null> {
    if (this.range !== "1d") return null;

    const now = Date.now();
    const since = now - 24 * 3_600_000;

    try {
      const samples = await fetchCallLogSamples(key, since, this.log);
      return hourlyBuckets(samples, now, 24);
    } catch (error) {
      this.log.info(`hourly trend unavailable: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Webview shell.
   *
   * The CSP allows only the packaged script and style. No remote origin is
   * permitted: nothing from OmniRoute renders inside this webview, it is
   * fetched through the extension host.
   */
  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "dashboard.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "dashboard.css"),
    );
    const nonce = makeNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>OmniRoute usage</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.view = undefined;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** Exposed for the open command. */
export function dashboardUrl(): string {
  return `${rootUrl()}/dashboard`;
}