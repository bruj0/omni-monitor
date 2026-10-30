/**
 * HTTP client for the self-service usage endpoint.
 *
 * Read-only by construction: this module exposes exactly one GET. The
 * self-service endpoint needs only an ordinary API key, which is why the
 * status bar does not require the admin key.
 */

import { parseUsageResponse, usageUrl, UsageUnsupportedError, type UsageView } from "../core/usage";

/** Distinguishes "server said no" from "server could not be reached". */
export type UsageResult =
  | { ok: true; view: UsageView }
  | { ok: false; reason: "unreachable" | "unauthorized" | "server-error" | "unsupported"; detail?: string };

const DEFAULT_TIMEOUT_MS = 6000;

export async function fetchUsage(
  baseUrl: string,
  key: string | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<UsageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(usageUrl(baseUrl), {
      method: "GET",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    });

    const contentType = res.headers.get("content-type") ?? "";

    if (res.status === 401 || res.status === 403) {
      // A structured refusal is data, not a transport failure: it means the
      // key is missing or lacks allowUsageCommand. Parse it so the panel can
      // explain which, rather than reporting a bare 403.
      try {
        const view = parseUsageResponse(contentType, await res.text());
        return { ok: true, view };
      } catch {
        return { ok: false, reason: "unauthorized", detail: `HTTP ${res.status}` };
      }
    }

    if (!res.ok) {
      return { ok: false, reason: "server-error", detail: `HTTP ${res.status}` };
    }

    try {
      return { ok: true, view: parseUsageResponse(contentType, await res.text()) };
    } catch (error) {
      if (error instanceof UsageUnsupportedError) {
        return { ok: false, reason: "unsupported" };
      }
      throw error;
    }
  } catch (error) {
    const name = (error as Error).name;
    if (name === "AbortError" || name === "TypeError") {
      return { ok: false, reason: "unreachable", detail: (error as Error).message };
    }
    return { ok: false, reason: "unreachable", detail: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}