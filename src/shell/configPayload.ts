/**
 * The configuration the Config view shows and edits.
 *
 * The webview cannot read any of this itself: `vscode.workspace` is not
 * available inside a webview, and the two credentials live in the extension
 * host's SecretStorage. So the host assembles it, sends it, and applies the
 * edits the webview asks for.
 *
 * The schema comes from the extension's own manifest, read at runtime from
 * `context.extension.packageJSON`. That is the same source the Settings
 * editor renders from, so a form built from it cannot drift from the real
 * settings: a new setting in `package.json` appears in the form with no
 * code change, and the `enum`, `minimum` and `maximum` in the manifest
 * become the form's own validation.
 *
 * The two credential values are never part of the payload. The payload says
 * whether a key is set, and nothing else. The key itself never leaves the
 * keychain.
 */

import * as vscode from "vscode";
import { SECRET_ADMIN_KEY, SECRET_API_KEY } from "./config";

/** The configuration section, and the prefix every setting key shares. */
const SECTION = "omniMonitor";

/** The kind of control a setting gets, derived from the manifest's type. */
export type SettingControl = "boolean" | "number" | "string" | "enum";

/**
 * One setting, its schema, and its effective value.
 *
 * The schema fields are the subset the form needs. The manifest supports
 * more (`markdownDescription`, `pattern`, `editPresentation`, `order`),
 * and the form ignores what it does not use.
 */
export interface ConfigSetting {
  /** The short key, without the section prefix. */
  key: string;
  control: SettingControl;
  /** The effective value, as a JSON value rather than a string. */
  value: unknown;
  /** The default from the manifest, as a JSON value. */
  defaultValue: unknown;
  /** The allowed values, for an enum. */
  enumValues?: string[];
  /** The bounds, for a number. */
  minimum?: number;
  maximum?: number;
  /** The manifest's description, shown under the control. */
  description: string;
  /** Where the effective value came from: "default", "user", "workspace". */
  scope: string;
  /** True when the value has been changed away from the default. */
  modified: boolean;
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
  /** The scope the key needs. */
  scopeNeeded: string;
}

export interface ConfigPayload {
  settings: ConfigSetting[];
  apiKey: CredentialState;
  adminKey: CredentialState;
  /** Where new edits go: "user" or "workspace". */
  defaultTarget: "user" | "workspace";
  /** True when a workspace is open, so the workspace scope is selectable. */
  hasWorkspace: boolean;
}

/** The manifest shape this module reads. */
interface ManifestConfig {
  contributes?: {
    configuration?: {
      properties?: Record<
        string,
        {
          type?: string;
          default?: unknown;
          enum?: string[];
          minimum?: number;
          maximum?: number;
          description?: string;
          markdownDescription?: string;
        }
      >;
    };
  };
}

/**
 * A short, non-reversible hint for a secret.
 *
 * Four characters of the digest. It is enough to tell two keys apart and
 * to tell whether a key was rotated, and it cannot be turned back into
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

/** The control a setting's type gets. */
function controlOf(type: string | undefined, enumValues?: string[]): SettingControl {
  if (enumValues && enumValues.length > 0) return "enum";
  if (type === "boolean") return "boolean";
  if (type === "number") return "number";
  return "string";
}

/**
 * The settings, their schema, and their effective values.
 *
 * The descriptions come from the extension's own manifest, read at runtime.
 * The configuration API does not expose them, and a table of bare keys
 * without an explanation is not much of a settings screen.
 */
export function readSettings(context: vscode.ExtensionContext): ConfigSetting[] {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const manifest = context.extension?.packageJSON as ManifestConfig | undefined;
  const described = manifest?.contributes?.configuration?.properties ?? {};

  const settings: ConfigSetting[] = [];

  for (const [key, schema] of Object.entries(described)) {
    const short = key.startsWith(SECTION + ".") ? key.slice(SECTION.length + 1) : key;
    const info = configuration.inspect<unknown>(short);
    if (!info) continue;

    const effective =
      info.workspaceFolderValue ??
      info.workspaceValue ??
      info.globalValue ??
      info.defaultValue;

    settings.push({
      key: short,
      control: controlOf(schema.type, schema.enum),
      value: effective,
      defaultValue: schema.default,
      enumValues: schema.enum,
      minimum: schema.minimum,
      maximum: schema.maximum,
      description: schema.markdownDescription ?? schema.description ?? "",
      scope: scopeOf(info),
      modified: effective !== schema.default,
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
    apiKey: {
      set: Boolean(api),
      hint: hint(api),
      scopeNeeded: "ordinary key with allowUsageCommand",
    },
    adminKey: {
      set: Boolean(admin),
      hint: hint(admin),
      scopeNeeded: "manage or admin (optional)",
    },
  };
}

/** The whole payload, in one call. */
export async function readConfigPayload(
  context: vscode.ExtensionContext,
): Promise<ConfigPayload> {
  const credentials = await readCredentials(context);
  const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length);
  return {
    settings: readSettings(context),
    apiKey: credentials.apiKey,
    adminKey: credentials.adminKey,
    // A workspace-scoped edit is the more useful default when a workspace is
    // open: it is what the Settings editor does for a resource-scoped
    // setting, and it is what a reader expects when the panel is open over
    // a project.
    defaultTarget: hasWorkspace ? "workspace" : "user",
    hasWorkspace,
  };
}

/**
 * The result of an edit, in the shape the webview expects.
 *
 * A failure is reported, never thrown at the webview: the form shows the
 * message next to the control that failed.
 */
export interface UpdateResult {
  ok: boolean;
  key: string;
  message?: string;
}

/**
 * Apply one setting edit.
 *
 * The value is validated against the manifest's schema before it is
 * written, because the webview is not a trusted caller: a value that
 * violates the manifest's own `enum` or bounds must not reach the
 * settings file.
 */
export async function updateSetting(
  context: vscode.ExtensionContext,
  key: string,
  value: unknown,
  target: "user" | "workspace",
): Promise<UpdateResult> {
  const manifest = context.extension?.packageJSON as ManifestConfig | undefined;
  const schema = manifest?.contributes?.configuration?.properties?.[`${SECTION}.${key}`];

  if (!schema) {
    return { ok: false, key, message: `Unknown setting: ${key}` };
  }

  const problem = validate(value, schema);
  if (problem) {
    return { ok: false, key, message: problem };
  }

  const configuration = vscode.workspace.getConfiguration(SECTION);
  const configurationTarget =
    target === "workspace"
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

  // The value is coerced to the schema's type before it is written, so the
  // settings file holds a number and not the text of one.
  const coerced = coerce(value, schema);

  try {
    await configuration.update(key, coerced, configurationTarget);
    return { ok: true, key };
  } catch (error) {
    // Writing to the workspace scope fails when no workspace is open, and
    // the message from VS Code does not say which scope was at fault. Say it.
    const detail = (error as Error).message;
    const explanation =
      target === "workspace" && !vscode.workspace.workspaceFolders?.length
        ? "There is no workspace open, so a workspace-scoped setting cannot be saved. Use the User scope instead."
        : detail;
    return { ok: false, key, message: explanation };
  }
}

/**
 * Coerce a value to the schema's type.
 *
 * The webview is not a trusted caller, and a number box reports text. The
 * value is validated first, so this only ever converts between a number
 * and its text.
 */
function coerce(
  value: unknown,
  schema: { type?: string; enum?: string[] },
): unknown {
  if (schema.type === "number" && typeof value === "string") {
    return Number(value);
  }
  return value;
}

/**
 * Check a value against the manifest's schema.
 *
 * The same checks the Settings editor makes, so a value accepted here is
 * a value the Settings editor would also accept.
 */
function validate(
  value: unknown,
  schema: {
    type?: string;
    enum?: string[];
    minimum?: number;
    maximum?: number;
  },
): string | null {
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") return "This setting is a yes-or-no choice.";
    return null;
  }

  if (schema.type === "number") {
    // A number box reports text, so a numeric string is accepted and
    // coerced. Anything else is rejected rather than silently becoming
    // NaN in the settings file.
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
          ? Number(value)
          : null;

    if (numeric === null) return "This setting takes a number.";
    if (schema.minimum !== undefined && numeric < schema.minimum) {
      return `The minimum is ${schema.minimum}.`;
    }
    if (schema.maximum !== undefined && numeric > schema.maximum) {
      return `The maximum is ${schema.maximum}.`;
    }
    return null;
  }

  if (typeof value !== "string") return "This setting takes text.";

  if (schema.enum && !schema.enum.includes(value)) {
    return `Choose one of: ${schema.enum.join(", ")}.`;
  }

  return null;
}

/**
 * Reset a setting to its default.
 *
 * `update` with `undefined` removes the value, which is how the Settings
 * editor's "Reset Setting" works.
 */
export async function resetSetting(
  context: vscode.ExtensionContext,
  key: string,
  target: "user" | "workspace",
): Promise<UpdateResult> {
  const manifest = context.extension?.packageJSON as ManifestConfig | undefined;
  if (!manifest?.contributes?.configuration?.properties?.[`${SECTION}.${key}`]) {
    return { ok: false, key, message: `Unknown setting: ${key}` };
  }

  const configuration = vscode.workspace.getConfiguration(SECTION);
  const configurationTarget =
    target === "workspace"
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

  try {
    await configuration.update(key, undefined, configurationTarget);
    return { ok: true, key };
  } catch (error) {
    return { ok: false, key, message: (error as Error).message };
  }
}

/**
 * Store a credential.
 *
 * The value arrives from the webview, so it is trimmed and checked for
 * emptiness, but it is never logged and never sent back.
 */
export async function setCredential(
  context: vscode.ExtensionContext,
  which: "apiKey" | "adminKey",
  value: string,
): Promise<UpdateResult> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, key: which, message: "Empty key, nothing stored." };
  }

  const key = which === "apiKey" ? SECRET_API_KEY : SECRET_ADMIN_KEY;
  await context.secrets.store(key, trimmed);
  return { ok: true, key: which };
}

/** Remove a credential. */
export async function clearCredential(
  context: vscode.ExtensionContext,
  which: "apiKey" | "adminKey",
): Promise<UpdateResult> {
  const key = which === "apiKey" ? SECRET_API_KEY : SECRET_ADMIN_KEY;
  await context.secrets.delete(key);
  return { ok: true, key: which };
}
