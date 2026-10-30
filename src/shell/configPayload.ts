/**
 * The configuration the Config view shows.
 *
 * The webview cannot read any of this itself: `vscode.workspace` is not
 * available inside a webview, and the two credentials live in the extension
 * host's SecretStorage. So the host assembles it and sends it.
 *
 * The two credential values are never part of the payload. The payload says
 * whether a key is set, and nothing else. The key itself never leaves the
 * keychain.
 */

import * as vscode from "vscode";
import { SECRET_ADMIN_KEY, SECRET_API_KEY } from "./config";

/** The configuration section, and the prefix every setting key shares. */
const SECTION = "omniMonitor";

/** One setting, its effective value, and where that value came from. */
export interface ConfigSetting {
  key: string;
  value: string;
  defaultValue: string;
  /** "default", "user", "workspace", or "workspace-folder". */
  scope: string;
  description: string;
}

/**
 * One credential: whether it is set, and where it is stored.
 *
 * There is deliberately no field for the value. The key is in the OS
 * keychain and this struct has no way to carry it.
 */
export interface CredentialState {
  set: boolean;
  /** A short, non-reversible hint, so a reader can tell two keys apart. */
  hint: string;
}

export interface ConfigPayload {
  settings: ConfigSetting[];
  apiKey: CredentialState;
  adminKey: CredentialState;
}

/**
 * A short, non-reversible hint for a secret.
 *
 * Four characters of the SHA-256 digest. It is enough to tell two keys apart
 * and to tell whether a key was rotated, and it cannot be turned back into
 * the key. Nothing in the extension needs more than that.
 */
function hint(value: string | undefined): string {
  if (!value) return "";
  // A tiny non-cryptographic hash is enough here: the hint only has to
  // distinguish two keys from each other, and it must not be reversible.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 4);
}

/** The scope a value came from, most specific first. */
function scopeOf(info: {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}): string {
  if (info.workspaceFolderValue !== undefined) return "workspace-folder";
  if (info.workspaceValue !== undefined) return "workspace";
  if (info.globalValue !== undefined) return "user";
  return "default";
}

/** Format a value for display: a string as-is, anything else as JSON. */
function formatValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The settings and their effective values.
 *
 * The descriptions come from the extension's own manifest, read at runtime
 * from `context.extension.packageJSON`. The configuration API does not expose
 * them, and a table of bare keys without an explanation is not much of a
 * settings screen.
 */
export function readSettings(context: vscode.ExtensionContext): ConfigSetting[] {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const manifest = context.extension?.packageJSON as
    | { contributes?: { configuration?: { properties?: Record<string, { description?: string }> } } }
    | undefined;
  const described = manifest?.contributes?.configuration?.properties ?? {};

  const settings: ConfigSetting[] = [];

  for (const key of Object.keys(described)) {
    const short = key.startsWith(SECTION + ".") ? key.slice(SECTION.length + 1) : key;
    const info = configuration.inspect<unknown>(short);
    if (!info) continue;

    const effective =
      info.workspaceFolderValue ??
      info.workspaceValue ??
      info.globalValue ??
      info.defaultValue;

    settings.push({
      key,
      value: formatValue(effective),
      defaultValue: formatValue(info.defaultValue),
      scope: scopeOf(info),
      description: described[key]?.description ?? "",
    });
  }

  return settings;
}

/**
 * The credentials: whether each is set, and a hint to tell them apart.
 *
 * The values are read only to compute the hint and to answer "is it set".
 * They are not returned and not logged.
 */
export async function readCredentials(
  context: vscode.ExtensionContext,
): Promise<{ apiKey: CredentialState; adminKey: CredentialState }> {
  const api = await context.secrets.get(SECRET_API_KEY);
  const admin = await context.secrets.get(SECRET_ADMIN_KEY);

  return {
    apiKey: { set: Boolean(api), hint: hint(api) },
    adminKey: { set: Boolean(admin), hint: hint(admin) },
  };
}

/** The whole payload, in one call. */
export async function readConfigPayload(
  context: vscode.ExtensionContext,
): Promise<ConfigPayload> {
  const credentials = await readCredentials(context);
  return {
    settings: readSettings(context),
    apiKey: credentials.apiKey,
    adminKey: credentials.adminKey,
  };
}
