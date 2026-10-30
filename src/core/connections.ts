/**
 * Per-connection usage: the join behind the dashboard's providers view.
 *
 * Two endpoints describe the same connections from different angles, and they
 * do not agree on how a provider is named:
 *
 *   GET /api/usage/quota   -> `provider` is the connection slug ("minimax")
 *   GET /api/usage/analytics -> `byModel[].provider` is that same slug
 *                             -> `byProvider[].provider` is a DISPLAY name
 *                                ("Minimax Coding", "OpenAI Codex")
 *
 * So the exact join is `quota.provider` == `byModel[].provider`, and the
 * per-connection totals come from grouping `byModel` rows. `byProvider` is
 * unmatched on purpose: its eight rows include four near-empty
 * `openai-compatible-*` entries that no connection owns, and matching a slug
 * like "codex" against "OpenAI Codex" needs fuzzy work that would eventually
 * attribute one provider's spend to another.
 *
 * Verified against the live server on 2026-10-30:
 *   quota providers  -> minimax, codex, deepseek, synthetic
 *   byModel slugs    -> minimax, synthetic, codex, deepseek,
 *                       cloudflare-playground, opencode
 *   byProvider names -> Minimax Coding, Synthetic, OpenAI Codex, DeepSeek,
 *                       openai-compatible-<uuid>, anthropic-compatible-<uuid>,
 *                       Cloudflare AI Playground, OpenCode Free
 *
 * Pure, with no `vscode` import, so the arithmetic is testable without an
 * editor.
 */

import type { DailyModelRow } from "./analytics";
import { successRateOf } from "./analytics";

/** The fields a quota entry must carry for this module. */
export interface ConnectionQuota {
  name: string;
  provider: string;
  connectionId: string;
  percentRemaining: number;
  resetAt: string | null;
}

/** The fields a `byModel` row must carry for this module. */
export interface ModelUsageRow {
  provider: string;
  /** Display label. `rawModel` is preferred when both are present. */
  model?: string;
  rawModel?: string;
  requests: number;
  totalTokens: number;
  cost: number;
  /** Present on `byModel`, and a STRING on the wire ("99.44"). */
  successRatePct?: number | string;
}

/** One connection, with its quota state and its usage in the selected range. */
export interface ConnectionUsage extends ConnectionQuota {
  requests: number;
  totalTokens: number;
  cost: number;
  /**
   * True when no model in the range reported traffic for this provider.
   *
   * Kept separate from `requests === 0` because "configured but unused in this
   * range" and "used, and the count rounds to nothing" are different facts, and
   * the view renders them differently ("-" versus "0").
   */
  idle: boolean;
}

/** Per-provider sums, keyed by the connection slug. */
export interface ProviderTotals {
  requests: number;
  totalTokens: number;
  cost: number;
}

/**
 * Sum `byModel` rows by their provider slug.
 *
 * A provider with several models produces one entry here; a provider that
 * reported no traffic produces none, which is what `connectionUsage` reads as
 * `idle`. `cost` accumulates as a float, so callers format it rather than
 * compare it.
 */
export function groupByProvider(rows: readonly ModelUsageRow[]): Map<string, ProviderTotals> {
  const totals = new Map<string, ProviderTotals>();

  for (const row of rows) {
    const key = typeof row.provider === "string" ? row.provider : "";
    if (key === "") continue;

    const current = totals.get(key) ?? { requests: 0, totalTokens: 0, cost: 0 };
    current.requests += Number(row.requests) || 0;
    current.totalTokens += Number(row.totalTokens) || 0;
    current.cost += Number(row.cost) || 0;
    totals.set(key, current);
  }

  return totals;
}

/**
 * Join the configured connections to their usage in the selected range.
 *
 * The order follows `quota`, not the usage: the connection list is stable
 * across range changes, so a reader who learned where `codex` sits does not
 * have to find it again after switching from 1d to 30d. Sorting by spend would
 * reorder the table on every refresh.
 *
 * A connection whose provider never appears in `byModel` keeps a zero row and
 * `idle: true` rather than being dropped. Dropping it would make a configured
 * connection look unconfigured, which is the opposite of what the view is for.
 *
 * `provider` is the join key, so it is also the identity a drill-down selects
 * on. Two connections sharing one provider slug would therefore resolve to the
 * same detail; the live server issues one slug per connection.
 */
export function connectionUsage(
  quota: readonly ConnectionQuota[],
  rows: readonly ModelUsageRow[],
): ConnectionUsage[] {
  const totals = groupByProvider(rows);

  return quota.map((entry) => {
    const found = totals.get(entry.provider);
    return {
      name: entry.name ?? "",
      provider: entry.provider ?? "",
      connectionId: entry.connectionId ?? "",
      percentRemaining: Number(entry.percentRemaining) || 0,
      resetAt: entry.resetAt ?? null,
      requests: found?.requests ?? 0,
      totalTokens: found?.totalTokens ?? 0,
      cost: found?.cost ?? 0,
      idle: found === undefined,
    };
  });
}

/** One model: `bool` for a single-provider row, the totals otherwise. */
export interface ProviderModelUsage {
  model: string;
  requests: number;
  totalTokens: number;
  cost: number;
}

/** The four summary cards, computable for one provider or for everything. */
export interface ProviderSummary {
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  uniqueModels: number;
  /**
   * Request-weighted success rate, or 0 when there were no requests.
   *
   * Weighted, not averaged: a model with 3 requests at 0 % must not drag the
   * rate down as hard as one with 3,000. `byModel` carries `successRatePct` per
   * model but no success count, so the weighting is the only honest aggregate.
   */
  successRatePct: number;
}

/**
 * Aggregate one provider's usage, or everything when `provider` is null.
 *
 * Derived from `byModel` rather than from `summary` because `summary` has no
 * provider dimension. The two agree on the ranges measured 2026-10-30 for 1d
 * and 7d; `30d` differed by 26 requests out of 41,247 (0.06 %), so an
 * unfiltered dashboard keeps using `summary` verbatim and this is only used
 * once a provider is selected.
 */
export function providerSummary(
  rows: readonly ModelUsageRow[],
  provider: string | null,
): ProviderSummary {
  let totalRequests = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let uniqueModels = 0;
  let weightedSuccess = 0;
  let rateWeight = 0;

  for (const row of rows) {
    if (provider !== null && row.provider !== provider) continue;

    const requests = Number(row.requests) || 0;
    totalRequests += requests;
    totalTokens += Number(row.totalTokens) || 0;
    totalCost += Number(row.cost) || 0;
    uniqueModels += 1;

    const pct = successRateOf(row);
    if (pct !== null && requests > 0) {
      weightedSuccess += pct * requests;
      rateWeight += requests;
    }
  }

  return {
    totalRequests,
    totalTokens,
    totalCost,
    uniqueModels,
    successRatePct: rateWeight > 0 ? weightedSuccess / rateWeight : 0,
  };
}

/**
 * Tokens per date for one provider, or for every provider when null.
 *
 * Reads `dailyByModel`, which is the only per-date table that can be split by
 * provider: its model keys match `byModel[].model`, and `byModel[].provider`
 * says who served each model. A model that appears in `dailyByModel` but not in
 * `byModel` is dropped — attributing it would mean guessing an owner.
 *
 * Tokens only. The endpoint publishes no per-provider per-date request counts,
 * so `requests` is absent rather than zero.
 */
export function providerDailyTokens(
  byModel: readonly ModelUsageRow[],
  dailyByModel: readonly DailyModelRow[],
  provider: string | null,
): { date: string; totalTokens: number }[] {
  const owners = new Map<string, string>();
  for (const row of byModel) {
    const name = typeof row.model === "string" ? row.model : undefined;
    if (name && typeof row.provider === "string") owners.set(name, row.provider);
  }

  const out: { date: string; totalTokens: number }[] = [];
  for (const day of dailyByModel) {
    let total = 0;
    for (const [model, tokens] of Object.entries(day.tokens ?? {})) {
      const owner = owners.get(model);
      if (owner === undefined) continue;
      if (provider !== null && owner !== provider) continue;
      total += Number(tokens) || 0;
    }
    out.push({ date: day.date, totalTokens: total });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The models one provider served in the selected range, busiest first.
 *
 * Filtering is exact on the provider slug — no fuzzy display-name matching,
 * for the reason in the module comment. A model label comes from `rawModel`,
 * then `model`, then the provider slug: a blank first column reads as a
 * rendering bug, and grouping every unlabelled row under one visible name is
 * better than grouping them under "".
 *
 * Order is requests descending, then label, so a tie does not shuffle between
 * refreshes. An unknown provider returns an empty array rather than throwing;
 * the caller renders that as "no traffic in this range".
 */
export function providerModels(
  rows: readonly ModelUsageRow[],
  provider: string,
): ProviderModelUsage[] {
  const totals = new Map<string, ProviderModelUsage>();

  for (const row of rows) {
    if (row.provider !== provider) continue;

    const label =
      (typeof row.rawModel === "string" && row.rawModel !== "" ? row.rawModel : undefined) ??
      (typeof row.model === "string" && row.model !== "" ? row.model : undefined) ??
      provider;

    const current = totals.get(label) ?? { model: label, requests: 0, totalTokens: 0, cost: 0 };
    current.requests += Number(row.requests) || 0;
    current.totalTokens += Number(row.totalTokens) || 0;
    current.cost += Number(row.cost) || 0;
    totals.set(label, current);
  }

  return [...totals.values()].sort(
    (a, b) => b.requests - a.requests || a.model.localeCompare(b.model),
  );
}
