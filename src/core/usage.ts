/**
 * Types and parsing for OmniRoute's self-service usage endpoint.
 *
 * Wire shapes verified 2026-10-16 against a live OmniRoute at
 * 10.0.0.77:20128. Keep these aligned with
 * `src/lib/usage/internalUsageCommand.ts` in the OmniRoute repo.
 */

/** One quota window on a provider connection, e.g. `session`, `weekly (7d)`. */
export interface UsageQuotaWindow {
  used?: number;
  total?: number;
  remaining?: number;
  /**
   * Server-supplied remaining percentage. Absent on window shapes that omit it
   * (the `codex` connection returns `used`/`total`/`remaining` only), so
   * derive it rather than relying on this being present.
   */
  remainingPercentage?: number;
  resetAt?: string | null;
  /** Credits-style windows carry `unlimited: true`; no percentage is meaningful. */
  unlimited?: boolean;
  windowSeconds?: number;
  currency?: string;
  grantedBalance?: number;
  toppedUpBalance?: number;
}

export interface UsageSnapshot {
  connectionId: string;
  provider: string;
  plan?: unknown;
  quotas?: Record<string, UsageQuotaWindow>;
}

/** Per-key spend against its own limits. Null when the key opted out. */
export interface UsageLimitStatus {
  enabled: boolean;
  dailyLimitUsd: number | null;
  weeklyLimitUsd: number | null;
  dailySpentUsd: number;
  weeklySpentUsd: number;
  dailyResetAtIso: string;
  weeklyResetAtIso: string | null;
  dailyExceeded: boolean;
  weeklyExceeded: boolean;
}

/**
 * Discriminated union so a caller can never read a data field off a refusal.
 * `allowed: false` carries only an error; `allowed: true` carries the data.
 */
export type UsageResponse =
  | { allowed: false; error?: { message?: string } }
  | {
      allowed: true;
      personal: UsageLimitStatus | null;
      provider: UsageSnapshot | null;
      /** Every connection's snapshot. Absent on servers that predate #11191. */
      providers?: UsageSnapshot[];
    };

/**
 * The three states the panel and status bar render. `unsupported` means the
 * server answered text instead of JSON, i.e. it predates `?format=json`.
 */
export type UsageView =
  | { kind: "unsupported" }
  | { kind: "disabled"; message?: string }
  | { kind: "ready"; personal: UsageLimitStatus | null; providers: UsageSnapshot[] };

export function toUsageView(body: UsageResponse): UsageView {
  if (body.allowed === false) {
    return { kind: "disabled", message: body.error?.message };
  }
  const providers = Array.isArray(body.providers)
    ? body.providers
    : body.provider
      ? [body.provider]
      : [];
  return { kind: "ready", personal: body.personal ?? null, providers };
}

/**
 * The usage endpoint answered with something other than JSON.
 *
 * Thrown by `parseUsageResponse` when the content type is not JSON, so the
 * caller hides the section instead of surfacing a parse failure.
 */
export class UsageUnsupportedError extends Error {}

export function parseUsageResponse(contentType: string, raw: string): UsageView {
  if (!contentType.includes("application/json")) {
    throw new UsageUnsupportedError("server predates ?format=json");
  }
  return toUsageView(JSON.parse(raw) as UsageResponse);
}

/**
 * `/api/usage/om-usage` is authenticated with an ordinary API key, but the
 * server root may be configured with a `/v1` suffix. Strip it so the API path
 * resolves, and drop trailing slashes.
 */
export function serverRootUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function usageUrl(baseUrl: string): string {
  return `${serverRootUrl(baseUrl)}/api/usage/om-usage?format=json`;
}