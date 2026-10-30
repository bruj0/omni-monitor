const test = require("node:test");
const assert = require("node:assert/strict");

// core/ is compiled to dist/core by `npm run build`; tests load it from there.
const viewMode = require("../dist/core/viewMode.js");
const connections = require("../dist/core/connections.js");

test("isViewMode accepts the three modes and nothing else", () => {
  assert.equal(viewMode.isViewMode("totals"), true);
  assert.equal(viewMode.isViewMode("providers"), true);
  assert.equal(viewMode.isViewMode("logs"), true);
  assert.deepEqual([...viewMode.VIEW_MODES], ["totals", "providers", "logs"]);

  for (const value of ["Totals", "provider", "log", "", null, undefined, 0, {}, []]) {
    assert.equal(viewMode.isViewMode(value), false, `${JSON.stringify(value)} is not a mode`);
  }
});

test("DEFAULT_VIEW_MODE is a real mode", () => {
  assert.equal(viewMode.isViewMode(viewMode.DEFAULT_VIEW_MODE), true);
  assert.equal(viewMode.DEFAULT_VIEW_MODE, "totals");
});

// The join these tests pin was measured against the live server on 2026-10-30.
// quota.provider and byModel[].provider are connection slugs; byProvider[]
// carries display names instead, which is why it is not used.
test("groupByProvider sums every model row of one provider", () => {
  const totals = connections.groupByProvider([
    { provider: "minimax", requests: 100, totalTokens: 1000, cost: 0 },
    { provider: "minimax", requests: 50, totalTokens: 500, cost: 0.5 },
    { provider: "codex", requests: 7, totalTokens: 70, cost: 1.25 },
  ]);

  assert.deepEqual(totals.get("minimax"), { requests: 150, totalTokens: 1500, cost: 0.5 });
  assert.deepEqual(totals.get("codex"), { requests: 7, totalTokens: 70, cost: 1.25 });
  assert.equal(totals.size, 2);
});

test("groupByProvider survives a row with no provider", () => {
  const totals = connections.groupByProvider([
    { provider: undefined, requests: 5, totalTokens: 5, cost: 0 },
    { provider: "minimax", requests: 1, totalTokens: 1, cost: 0 },
  ]);

  assert.equal(totals.size, 1, "an unowned row is not attributed to any connection");
  assert.equal(totals.get("minimax").requests, 1);
});

test("connectionUsage keeps quota order and marks an unused connection idle", () => {
  const rows = connections.connectionUsage(
    [
      { name: "main", provider: "minimax", connectionId: "c1", percentRemaining: 100, resetAt: null },
      { name: "work", provider: "codex", connectionId: "c2", percentRemaining: 42.5, resetAt: "2026-11-01T00:00:00Z" },
    ],
    [
      { provider: "codex", requests: 3, totalTokens: 300, cost: 2 },
      { provider: "minimax", requests: 9, totalTokens: 900, cost: 0 },
    ],
  );

  assert.deepEqual(
    rows.map((r) => r.provider),
    ["minimax", "codex"],
    "order follows quota, not usage, so switching range does not reorder the table",
  );
  assert.equal(rows[0].requests, 9);
  assert.equal(rows[1].cost, 2);
  assert.equal(rows[1].resetAt, "2026-11-01T00:00:00Z");
  assert.equal(rows.some((r) => r.idle), false);
});

test("connectionUsage reports a configured connection with no traffic as idle, not absent", () => {
  const rows = connections.connectionUsage(
    [{ name: "main", provider: "deepseek", connectionId: "c3", percentRemaining: 100, resetAt: null }],
    [{ provider: "minimax", requests: 9, totalTokens: 900, cost: 0 }],
  );

  assert.equal(rows.length, 1, "a configured connection is never dropped for being unused");
  assert.equal(rows[0].idle, true);
  assert.equal(rows[0].requests, 0);
});

test("connectionUsage tolerates a null quota entry and an empty range", () => {
  assert.deepEqual(connections.connectionUsage([], []), []);

  const rows = connections.connectionUsage([{ name: "x", provider: "p", connectionId: "c" }], []);
  assert.equal(rows[0].percentRemaining, 0, "a missing percentage is zero, not NaN");
  assert.equal(rows[0].resetAt, null);
  assert.equal(rows[0].idle, true);
});

// The Providers view drills into one connection. The filter is exact on the
// provider slug, which is the same key `groupByProvider` uses.
test("providerModels returns only the requested provider's models", () => {
  const rows = connections.providerModels(
    [
      { provider: "minimax", rawModel: "MiniMax-M3", requests: 10, totalTokens: 100, cost: 0 },
      { provider: "codex", rawModel: "gpt-5", requests: 4, totalTokens: 40, cost: 1 },
      { provider: "minimax", rawModel: "MiniMax-M2", requests: 30, totalTokens: 300, cost: 0 },
    ],
    "minimax",
  );

  assert.deepEqual(
    rows.map((r) => r.model),
    ["MiniMax-M2", "MiniMax-M3"],
    "busiest model first, so the drill-down leads with the answer",
  );
  assert.equal(rows[0].requests, 30);
});

test("providerModels sums repeat rows for the same model", () => {
  const rows = connections.providerModels(
    [
      { provider: "codex", rawModel: "gpt-5", requests: 2, totalTokens: 20, cost: 0.5 },
      { provider: "codex", rawModel: "gpt-5", requests: 3, totalTokens: 30, cost: 0.25 },
    ],
    "codex",
  );

  assert.equal(rows.length, 1, "one row per model, not one per wire row");
  assert.deepEqual(rows[0], { model: "gpt-5", requests: 5, totalTokens: 50, cost: 0.75 });
});

test("providerModels falls back to the provider slug when a row has no label", () => {
  const rows = connections.providerModels(
    [{ provider: "synthetic", requests: 1, totalTokens: 10, cost: 0 }],
    "synthetic",
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "synthetic", "a blank model cell would read as a render bug");
});

test("providerModels returns nothing for a provider with no traffic", () => {
  assert.deepEqual(connections.providerModels([], "minimax"), []);
  assert.deepEqual(
    connections.providerModels(
      [{ provider: "codex", rawModel: "gpt-5", requests: 1, totalTokens: 1, cost: 0 }],
      "minimax",
    ),
    [],
    "an idle connection renders its own empty state, not another provider's models",
  );
});

test("providerModels breaks a request tie by model name", () => {
  const rows = connections.providerModels(
    [
      { provider: "p", rawModel: "b-model", requests: 5, totalTokens: 1, cost: 0 },
      { provider: "p", rawModel: "a-model", requests: 5, totalTokens: 1, cost: 0 },
    ],
    "p",
  );

  assert.deepEqual(rows.map((r) => r.model), ["a-model", "b-model"], "a tie must not shuffle");
});
