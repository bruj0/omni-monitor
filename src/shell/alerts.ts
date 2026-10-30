/**
 * Threshold alerts.
 *
 * Fires once per crossing, not once per poll. The "already notified" state is
 * persisted in the extension's globalState so a window reload does not re-arm
 * an alert the user has already seen.
 */

import * as vscode from "vscode";
import { alertsEnabled, critAtPercent, warnAtPercent } from "./config";

const KEY = "omniMonitor.alertState";

interface AlertState {
  warnFired: boolean;
  critFired: boolean;
  lastPercent: number | null;
}

const EMPTY: AlertState = { warnFired: false, critFired: false, lastPercent: null };

export class Alerts implements vscode.Disposable {
  private state: AlertState = EMPTY;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async load(): Promise<void> {
    this.state = { ...EMPTY, ...this.context.globalState.get<AlertState>(KEY) };
  }

  private async persist(): Promise<void> {
    await this.context.globalState.update(KEY, this.state);
  }

  /**
   * Evaluate the percentage USED, which is what the thresholds are expressed
   * in. Re-arms when usage drops back below the threshold, so the alert fires
   * again on the next approach rather than staying silent forever.
   */
  async evaluate(percentRemaining: number | null): Promise<void> {
    if (!alertsEnabled() || percentRemaining === null) return;

    const used = 100 - percentRemaining;
    const warnAt = warnAtPercent();
    const critAt = critAtPercent();

    if (used >= critAt && !this.state.critFired) {
      this.state.critFired = true;
      this.state.warnFired = true;
      await this.persist();
      void vscode.window.showErrorMessage(
        `OmniRoute quota critical: only ${percentRemaining}% remaining.`,
      );
      return;
    }

    if (used >= warnAt && !this.state.warnFired) {
      this.state.warnFired = true;
      await this.persist();
      void vscode.window.showWarningMessage(
        `OmniRoute quota low: ${percentRemaining}% remaining.`,
      );
      return;
    }

    // Re-arm once usage has fallen back under the warn threshold.
    if (used < warnAt && (this.state.warnFired || this.state.critFired)) {
      this.state = { warnFired: false, critFired: false, lastPercent: percentRemaining };
      await this.persist();
    }

    this.state.lastPercent = percentRemaining;
  }

  dispose(): void {
    this.state = EMPTY;
  }
}