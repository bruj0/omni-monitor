/**
 * Extension entry point.
 *
 * HARD BOUNDARY: this extension contributes NO languageModelChatProviders and
 * NO chat participants. It monitors OmniRoute usage; it never serves models.
 * Nothing it registers may appear in the Copilot model picker.
 */

import * as vscode from "vscode";
import { StatusBar } from "./shell/statusBar";
import { Alerts } from "./shell/alerts";
import { DashboardPanel, VIEW_ID } from "./shell/panel";
import { clearKeysCommand, setAdminKeyCommand, setApiKeyCommand } from "./shell/secrets";
import { openDashboard } from "./shell/embed";
import { onConfigChange } from "./shell/config";
import { worstCaseRemaining } from "./core/percent";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Omni Monitor", { log: true });
  context.subscriptions.push(log);
  log.info(`Omni Monitor activating`);

  const statusBar = new StatusBar(context, log);
  context.subscriptions.push(statusBar);

  const alerts = new Alerts(context);
  context.subscriptions.push(alerts);
  void alerts.load();

  const panel = new DashboardPanel(context, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // The Config view's provider dropdown lists the names the status bar
  // reported last, so a choice in the list is one the bar can read back.
  panel.setProviderSource(() => {
    const state = statusBar.current();
    return state.kind === "ready" ? state : undefined;
  });

  // Feed the alert evaluator from the status bar's own poll. The alert reads
  // a snapshot rather than making its own request, so there is exactly one
  // poll per interval regardless of how many consumers there are.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      void vscode.commands.executeCommand("setContext", "omniMonitor.themeChanged", true);
    }),
  );

  const refresh = async (): Promise<void> => {
    await statusBar.refresh();
    const state = statusBar.current();
    if (state.kind === "ready") {
      await alerts.evaluate(worstCaseRemaining(state.providers));
    }
  };

  context.subscriptions.push(
    onConfigChange(() => {
      log.info("Configuration changed");
      statusBar.restart();
      void refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("omniMonitor.setApiKey", async () => {
      await setApiKeyCommand(context);
      await refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("omniMonitor.setAdminKey", async () => {
      await setAdminKeyCommand(context);
      panel.revive();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("omniMonitor.clearKeys", () => clearKeysCommand(context)),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("omniMonitor.refresh", () => refresh()),
  );

  // Opens the dashboard view. The status bar item points here, because the
  // quota percentage is most useful next to the detail, not in a browser tab.
  context.subscriptions.push(
    vscode.commands.registerCommand("omniMonitor.openDashboard", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
  );

  // Separate command for the server's own dashboard, with the framing probe.
  context.subscriptions.push(
    vscode.commands.registerCommand("omniMonitor.openServerDashboard", () => openDashboard(log)),
  );

  statusBar.start();
  log.info("Omni Monitor active. No model provider is registered.");
}

export function deactivate(): void {
  // Disposables are registered on the context; VS Code handles teardown.
}
