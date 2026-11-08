/**
 * The status bar item: quota remaining as a percentage.
 *
 * This is the feature the extension exists for. It reads the self-service
 * `om-usage` endpoint with an ordinary API key and never needs the admin key,
 * so it keeps working when no admin key is configured.
 */

import * as vscode from "vscode";
import { formatResetIn, formatUsd, formatUsedTotal, humanizeWindow, statusBarText } from "../core/format";
import {
  providerRead,
  severityFor,
  soonestReset,
  windowPercentLeft,
  worstCaseRemaining,
} from "../core/percent";
import type { Severity } from "../core/percent";
import type { UsageLimitStatus, UsageSnapshot } from "../core/usage";
import { apiKey, baseUrl, refreshSeconds, statusBarEnabled, statusBarProvider } from "./config";
import { fetchUsage } from "./client";

/** Every state the item can show, kept explicit so the renderer is total. */
export type StatusState =
  | { kind: "checking" }
  | { kind: "unreachable"; detail?: string }
  | { kind: "no-key" }
  | { kind: "unsupported" }
  | { kind: "disabled"; message?: string }
  | { kind: "empty" }
  | {
      kind: "ready";
      percentRemaining: number | null;
      severity: Severity;
      providers: UsageSnapshot[];
      personal: UsageLimitStatus | null;
      /** The selection the number was read from: `"worst"` or a provider name, lowercased. */
      selection: string;
      /** The provider's own name as the server spelt it, or null under `worst`. */
      selectedName: string | null;
    };

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private disposed = false;
  private state: StatusState = { kind: "checking" };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: { info: (m: string) => void },
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = "OmniRoute Quota";
    this.item.command = "omniMonitor.openDashboard";
    this.render();
  }

  start(): void {
    this.applyVisibility();
    this.schedule();
    void this.refresh();
  }

  /** Re-render from a snapshot without a network call. */
  setState(state: StatusState): void {
    if (this.disposed) return;
    this.state = state;
    this.render();
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    this.inFlight = true;
    try {
      const key = await apiKey(this.context);

      if (!key) {
        this.setState({ kind: "no-key" });
        return;
      }

      const result = await fetchUsage(baseUrl(), key);

      if (!result.ok) {
        this.setState(
          result.reason === "unsupported"
            ? { kind: "unsupported" }
            : { kind: "unreachable", detail: result.detail },
        );
        return;
      }

      const view = result.view;
      if (view.kind === "unsupported") {
        this.setState({ kind: "unsupported" });
        return;
      }
      if (view.kind === "disabled") {
        this.setState({ kind: "disabled", message: view.message });
        return;
      }

      // The number the bar reads: the selection's own provider, or the
      // worst window across every connection. A name nothing reports
      // answers null and shows the bare dot, never another provider's
      // number — the setting is the reader's choice, not a hint.
      const selection = statusBarProvider();
      const read = selection === "worst" ? null : providerRead(view.providers, selection);

      const percent =
        selection === "worst"
          ? worstCaseRemaining(view.providers)
          : (read?.percent ?? null);

      if (view.providers.length === 0 && !view.personal) {
        this.setState({ kind: "empty" });
        return;
      }

      this.setState({
        kind: "ready",
        percentRemaining: percent,
        severity: severityFor(percent),
        providers: view.providers,
        personal: view.personal,
        selection,
        selectedName: read?.name ?? null,
      });
    } catch (error) {
      this.log.info(`status bar refresh failed: ${(error as Error).message}`);
      this.setState({ kind: "unreachable", detail: (error as Error).message });
    } finally {
      this.inFlight = false;
    }
  }

  /** The current state, for the dashboard and for diagnostics. */
  current(): StatusState {
    return this.state;
  }

  restart(): void {
    this.applyVisibility();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(), refreshSeconds() * 1000);
  }

  private applyVisibility(): void {
    if (statusBarEnabled()) this.item.show();
    else this.item.hide();
  }

  private render(): void {
    const state = this.state;

    switch (state.kind) {
      case "checking":
        this.item.text = "$(sync~spin) OmniRoute";
        this.item.tooltip = "Checking OmniRoute quota...";
        this.item.color = undefined;
        this.item.backgroundColor = undefined;
        break;

      case "unreachable":
        this.item.text = "$(circle-outline) OmniRoute";
        this.item.tooltip = `OmniRoute is unreachable.${state.detail ? ` ${state.detail}` : ""}`;
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.item.color = undefined;
        break;

      case "no-key":
        this.item.text = "$(key) OmniRoute";
        this.item.tooltip = "No API key set. Run 'Omni Monitor: Set API Key'.";
        this.item.backgroundColor = undefined;
        this.item.color = undefined;
        break;

      case "unsupported":
        this.item.text = "$(circle-outline) OmniRoute";
        this.item.tooltip = "This OmniRoute predates the ?format=json usage endpoint.";
        this.item.backgroundColor = undefined;
        this.item.color = undefined;
        break;

      case "disabled":
        this.item.text = "$(circle-outline) OmniRoute";
        this.item.tooltip =
          `Usage reporting is not enabled for this API key.${state.message ? ` ${state.message}` : ""} ` +
          "Enable allowUsageCommand in OmniRoute's API-key manager.";
        this.item.backgroundColor = undefined;
        this.item.color = undefined;
        break;

      case "empty":
        this.item.text = "$(layers-dot) OmniRoute";
        this.item.tooltip = "No quota cached yet. It fills in after the first requests.";
        this.item.backgroundColor = undefined;
        this.item.color = undefined;
        break;

      case "ready": {
        // The name next to the number. Under a named provider, that
        // provider, as the server spelt it. Under `worst`, the provider
        // whose number is being shown — the single reporting one — so a
        // number without a subject does not read as the server's total.
        const label =
          state.selection === "worst"
            ? soleReportingName(state.providers)
            : state.selectedName;

        this.item.text = statusBarText({
          percentRemaining: state.percentRemaining,
          soleProviderName: label,
          reachable: true,
        });
        this.item.tooltip = buildTooltip(state);

        this.item.backgroundColor =
          state.severity === "ok"
            ? undefined
            : new vscode.ThemeColor(
                state.severity === "critical"
                  ? "statusBarItem.errorBackground"
                  : "statusBarItem.warningBackground",
              );
        this.item.color = undefined;
        break;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}

/** The name shown next to a number computed across every provider. */
function soleReportingName(providers: UsageSnapshot[]): string | null {
  const reporting = providers.filter((p) => worstCaseRemaining([p]) !== null);
  return reporting.length === 1 ? reporting[0].provider : null;
}

/**
 * Markdown tooltip: the bar's subject first, then each connection's windows
 * and reset, then the key's own spend.
 *
 * The subject line says what the number the bar shows came from, because
 * that is the first question a reader asks when the number changed while
 * the provider list did not.
 */
function buildTooltip(state: Extract<StatusState, { kind: "ready" }>): vscode.MarkdownString {
  const { providers, personal, percentRemaining: chosen, selection, selectedName } = state;

  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;

  const subject =
    selection === "worst"
      ? "worst across every connection"
      : selectedName || `${selection} (not reporting)`;
  md.appendMarkdown(
    `**OmniRoute quota**${chosen === null ? "" : ` - ${chosen}% remaining - ${subject}`}\n\n`,
  );
  if (selectedName === null && selection !== "worst") {
    md.appendMarkdown(`_No connection is named \`${selection}\`, so the bar shows no number._\n\n`);
  }

  if (providers.length === 0) {
    md.appendMarkdown("_No provider connections reporting._\n");
  }

  for (const provider of providers) {
    const label = provider.plan ? `${provider.provider} (${String(provider.plan)})` : provider.provider;
    md.appendMarkdown(`**${label}**\n\n`);

    const entries = Object.entries(provider.quotas ?? {});
    if (entries.length === 0) {
      md.appendMarkdown("_No cached quota._\n\n");
      continue;
    }

    for (const [key, window] of entries) {
      const pct = windowPercentLeft(window);
      const pctText = pct === null ? (window.unlimited ? "unlimited" : "-") : `${pct}%`;
      const usedText =
        typeof window.used === "number" && typeof window.total === "number"
          ? ` ${formatUsedTotal(window.used, window.total)}`
          : "";
      const reset = window.resetAt ? ` - resets in ${formatResetIn(window.resetAt)}` : "";
      md.appendMarkdown(`- ${humanizeWindow(key)}: **${pctText}**${usedText}${reset}\n`);
    }

    const soonest = soonestReset(provider);
    if (soonest) md.appendMarkdown(`\n_soonest reset ${formatResetIn(soonest)}_\n`);
    md.appendMarkdown("\n");
  }

  if (personal) {
    md.appendMarkdown("**This key**\n\n");
    md.appendMarkdown(`- daily: ${formatUsd(personal.dailySpentUsd)} spent`);
    md.appendMarkdown(personal.dailyLimitUsd === null ? " (no limit)\n" : ` of ${formatUsd(personal.dailyLimitUsd)}\n`);
    md.appendMarkdown(`- weekly: ${formatUsd(personal.weeklySpentUsd)} spent`);
    md.appendMarkdown(personal.weeklyLimitUsd === null ? " (no limit)\n" : ` of ${formatUsd(personal.weeklyLimitUsd)}\n`);
  }

  return md;
}