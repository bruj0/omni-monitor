/**
 * Open OmniRoute's own dashboard, in a VS Code tab when the server allows it.
 *
 * The probe logic and the "why this usually fails" reasoning live in
 * core/frame.ts, which is pure and tested. This file is only the vscode-facing
 * half: run the probe, then either open the Simple Browser tab or explain why
 * it cannot and offer the external browser.
 *
 * Auth stays with the user. This module never calls /api/auth/login, never
 * reads the dashboard password, and never stores a session. When framing is
 * allowed, the user authenticates in the tab with the server's own login form.
 */

import * as vscode from "vscode";
import { rootUrl } from "./config";
import { isFramingAllowed } from "../core/frame";

export type FrameProbe =
  | { kind: "allowed" }
  | { kind: "blocked"; reason: string }
  | { kind: "unreachable"; detail?: string };

const BLOCKED_REASON =
  "This OmniRoute build does not allow the dashboard to be framed. It must be " +
  "rebuilt with DASHBOARD_ALLOW_EMBED=vscode, which the stock npm package and " +
  "Docker image are not.";

/**
 * Ask the server whether it allows framing.
 *
 * Follows the redirect, because the server answers 307 to /dashboard when
 * unauthenticated and the headers that matter are on the final response.
 */
export async function probeFraming(timeoutMs = 6000): Promise<FrameProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${rootUrl()}/dashboard`, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    if (isFramingAllowed(res.headers)) return { kind: "allowed" };
    return { kind: "blocked", reason: BLOCKED_REASON };
  } catch (error) {
    return { kind: "unreachable", detail: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open the dashboard, in a tab only when the server permits it.
 *
 * Never opens a tab that will render a refusal page.
 */
export async function openDashboard(log: { info: (m: string) => void }): Promise<void> {
  const url = `${rootUrl()}/dashboard`;

  const probe = await probeFraming();
  log.info(`dashboard frame probe: ${probe.kind}`);

  if (probe.kind === "unreachable") {
    void vscode.window.showErrorMessage(`OmniRoute is unreachable at ${rootUrl()}.`);
    return;
  }

  if (probe.kind === "blocked") {
    log.info(probe.reason);
    const open = "Open in browser";
    const choice = await vscode.window.showWarningMessage(
      "The OmniRoute dashboard cannot be embedded in a tab by this server build.",
      open,
    );
    if (choice === open) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
    return;
  }

  await vscode.commands.executeCommand("simpleBrowser.show", url);
}
