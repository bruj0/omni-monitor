/**
 * Settings and SecretStorage access.
 *
 * Two credentials, both in the OS keychain, neither ever in settings.json:
 *   - the API key, used by the status bar via the self-service endpoint
 *   - the admin key, optional, used only by the dashboard
 *
 * Both are read at CALL TIME, not cached at activate(), so rotating a key
 * takes effect without reloading the window.
 */

import * as vscode from "vscode";
import { serverRootUrl } from "../core/usage";

export const SECRET_API_KEY = "omniMonitor.apiKey";
export const SECRET_ADMIN_KEY = "omniMonitor.adminKey";

const SECTION = "omniMonitor";

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function baseUrl(): string {
  return cfg().get<string>("baseUrl", "http://localhost:20128");
}

export function rootUrl(): string {
  return serverRootUrl(baseUrl());
}

export function refreshSeconds(): number {
  const raw = cfg().get<number>("refreshSeconds", 60);
  return Math.max(15, Number.isFinite(raw) ? raw : 60);
}

export function statusBarEnabled(): boolean {
  return cfg().get<boolean>("statusBar", true);
}

export function statusBarMode(): "worst" | "sum" {
  return cfg().get<"worst" | "sum">("statusBarMode", "worst");
}

export function alertsEnabled(): boolean {
  return cfg().get<boolean>("alerts", true);
}

export function warnAtPercent(): number {
  return cfg().get<number>("warnAtPercent", 80);
}

export function critAtPercent(): number {
  return cfg().get<number>("critAtPercent", 95);
}

export function defaultRange(): string {
  return cfg().get<string>("defaultRange", "30d");
}

export function dashboardOpen(): "external" | "editor" {
  return cfg().get<"external" | "editor">("dashboardOpen", "external");
}

/**
 * The key for the self-service endpoint, or undefined when unset.
 *
 * Absent is a normal state: the status bar then reports "no key set" rather
 * than failing.
 */
export async function apiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const value = await context.secrets.get(SECRET_API_KEY);
  return value && value.length > 0 ? value : undefined;
}

/** The admin key for the management API, or undefined when unset. */
export async function adminKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const value = await context.secrets.get(SECRET_ADMIN_KEY);
  return value && value.length > 0 ? value : undefined;
}

/** Fire when any omniMonitor setting changes, so callers can re-read. */
export function onConfigChange(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) listener();
  });
}