/**
 * Credential commands.
 *
 * Keys are typed into an input box and stored in the OS keychain. They are
 * never written to settings.json and never passed as a command-line argument,
 * because argv is visible in `ps`.
 */

import * as vscode from "vscode";
import { SECRET_ADMIN_KEY, SECRET_API_KEY } from "./config";

async function promptForKey(prompt: string, placeHolder: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: prompt,
    prompt: placeHolder,
    password: true,
    ignoreFocusOut: true,
    placeHolder: "Paste the key, then press Enter",
  });
}

export async function setApiKeyCommand(context: vscode.ExtensionContext): Promise<void> {
  const value = await promptForKey(
    "Omni Monitor: Set API Key",
    "Used for the status bar quota. It needs allowUsageCommand enabled in OmniRoute.",
  );
  if (value === undefined) return;

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    void vscode.window.showWarningMessage("Empty key, nothing stored.");
    return;
  }

  await context.secrets.store(SECRET_API_KEY, trimmed);
  void vscode.window.showInformationMessage("API key stored in the OS keychain.");
}

export async function setAdminKeyCommand(context: vscode.ExtensionContext): Promise<void> {
  const value = await promptForKey(
    "Omni Monitor: Set Admin Key",
    "Optional. Used read-only by the dashboard. It needs the manage or admin scope.",
  );
  if (value === undefined) return;

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    void vscode.window.showWarningMessage("Empty key, nothing stored.");
    return;
  }

  await context.secrets.store(SECRET_ADMIN_KEY, trimmed);
  void vscode.window.showInformationMessage("Admin key stored in the OS keychain.");
}

export async function clearKeysCommand(context: vscode.ExtensionContext): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Remove both the API key and the admin key from the OS keychain?",
    { modal: true },
    "Remove",
  );
  if (choice !== "Remove") return;

  await context.secrets.delete(SECRET_API_KEY);
  await context.secrets.delete(SECRET_ADMIN_KEY);
  void vscode.window.showInformationMessage("Keys removed.");
}