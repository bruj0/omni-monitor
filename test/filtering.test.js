const test = require("node:test");
const assert = require("node:assert/strict");

// core/ is compiled to dist/core by `npm run build`; tests load it from there.
const hourly = require("../dist/core/hourly.js");
const connections = require("../dist/core/connections.js");
const analytics = require("../dist/core/analytics.js");

// The shapes below were measured against the live server on 2026-10-30:
// `dailyByModel` keys match `byModel[].model`, and `call-logs` reports the
// provider as a lower-case slug with `tokens: {in, out}`.

test("hourlyBuckets returns exactly the requested window, oldest first", () => {
  const now = new Date("2026-10-30T14:37:00").getTime();
  const buckets = hourly.hourlyBuckets([], now, 24);

  assert.equal(buckets.length, 24);
  assert.deepEqual(
    buckets.map((b) => new Date(b.hourStart).getHours()).slice(-3),
    [12, 13, 14],
    "the last bucket is the current hour",
  );

  for (const bucket of buckets) {
    assert.equal(bucket.requests, 0);
    assert.equal(bucket.totalTokens, 0);
  }
});

test("hourlyBuckets fills empty hours instead of skipping them", () => {
  const now = new Date("2026-10-30T14:37:00").getTime();
  // Timestamps are derived from `now` so the assertions hold in any timezone:
  // the buckets are floored on the LOCAL clock, and a literal "…Z" string moves
  // to a different local hour outside UTC.
  const hoursAgo = (n) => new Date(now - n * 3_600_000).toISOString();

  const buckets = hourly.hourlyBuckets(
    [
      { timestamp: hoursAgo(0.5), provider: "minimax", totalTokens: 100 },
      { timestamp: hoursAgo(3), provider: "minimax", totalTokens: 50 },
    ],
    now,
    24,
  );

  assert.equal(buckets.length, 24, "a gap hour is a zero, not a missing x value");
  assert.equal(buckets[23].totalTokens, 100, "the current hour");
  assert.equal(buckets[20].totalTokens, 50, "three hours ago");
  assert.equal(buckets[10].requests, 0, "an hour with no traffic is still on the axis");
});

test("hourlyBuckets sums requests and tokens per hour and per provider", () => {
  const now = new Date("2026-10-30T14:37:00").getTime();
  const buckets = hourly.hourlyBuckets(
    [
      { timestamp: "2026-10-30T14:05:00", provider: "minimax", totalTokens: 100 },
      { timestamp: "2026-10-30T14:25:00", provider: "minimax", totalTokens: 40 },
      { timestamp: "2026-10-30T14:26:00", provider: "codex", totalTokens: 7 },
    ],
    now,
    24,
  );

  const current = buckets[buckets.length - 1];
  assert.equal(current.requests, 3);
  assert.equal(current.totalTokens, 147);
  assert.deepEqual(current.byProvider.minimax, { requests: 2, totalTokens: 140 });
  assert.deepEqual(current.byProvider.codex, { requests: 1, totalTokens: 7 });
});

test("hourlyBuckets drops samples outside the window rather than clamping them", () => {
  const now = new Date("2026-10-30T14:37:00").getTime();
  const buckets = hourly.hourlyBuckets(
    [
      // Two days old: outside a 24-hour window.
      { timestamp: "2026-10-28T09:00:00", provider: "minimax", totalTokens: 999 },
      { timestamp: "not a date", provider: "minimax", totalTokens: 5 },
    ],
    now,
    24,
  );

  assert.equal(
    buckets.reduce((sum, b) => sum + b.totalTokens, 0),
    0,
    "old traffic must not be billed to the first bucket",
  );
});

test("bucketsFor narrows to one provider and keeps the bucket count", () => {
  const now = new Date("2026-10-30T14:37:00").getTime();
  const buckets = hourly.hourlyBuckets(
    [
      { timestamp: "2026-10-30T14:05:00", provider: "minimax", totalTokens: 100 },
      { timestamp: "2026-10-30T14:06:00", provider: "codex", totalTokens: 7 },
    ],
    now,
    24,
  );

  const only = hourly.bucketsFor(buckets, "codex");
  assert.equal(only.length, 24, "the axis must not change shape when filtering");
  assert.equal(only[only.length - 1].totalTokens, 7);
  assert.equal(only[only.length - 1].requests, 1);
  assert.deepEqual(Object.keys(only[only.length - 1].byProvider), ["codex"]);

  assert.deepEqual(hourly.bucketsFor(buckets, null), buckets, "null means everything");
});

test("providerSummary aggregates one model row per provider", () => {
  const rows = [
    { provider: "minimax", model: "a", requests: 100, totalTokens: 1000, cost: 0, successRatePct: "99.0" },
    { provider: "minimax", model: "b", requests: 300, totalTokens: 3000, cost: 2, successRatePct: "97.0" },
    { provider: "codex", model: "c", requests: 9, totalTokens: 90, cost: 5, successRatePct: "50.0" },
  ];

  const summary = connections.providerSummary(rows, "minimax");
  assert.equal(summary.totalRequests, 400);
  assert.equal(summary.totalTokens, 4000);
  assert.equal(summary.totalCost, 2);
  assert.equal(summary.uniqueModels, 2);
  assert.equal(summary.successRatePct, 97.5, "success is weighted by requests, not averaged");
});

test("providerSummary with no rows is zero, not NaN", () => {
  const summary = connections.providerSummary([], "minimax");
  assert.deepEqual(summary, {
    totalRequests: 0,
    totalTokens: 0,
    totalCost: 0,
    uniqueModels: 0,
    successRatePct: 0,
  });
});

test("providerSummary counts every provider when the filter is null", () => {
  const summary = connections.providerSummary(
    [
      { provider: "minimax", requests: 1, totalTokens: 10, cost: 0 },
      { provider: "codex", requests: 2, totalTokens: 20, cost: 0 },
    ],
    null,
  );

  assert.equal(summary.totalRequests, 3, "null means the whole dashboard, not nothing");
  assert.equal(summary.uniqueModels, 2);
});

test("providerDailyTokens attributes each model to its provider", () => {
  const byModel = [
    { provider: "minimax", model: "minimax-m3.1-flash", requests: 1, totalTokens: 1, cost: 0 },
    { provider: "synthetic", model: "deepseek-v4.1-flash-1017", requests: 1, totalTokens: 1, cost: 0 },
  ];
  const dailyByModel = [
    { date: "2026-10-29", tokens: { "minimax-m3.1-flash": 500, "deepseek-v4.1-flash-1017": 50 } },
    { date: "2026-10-30", tokens: { "minimax-m3.1-flash": 700, "deepseek-v4.1-flash-1017": 90 } },
  ];

  assert.deepEqual(connections.providerDailyTokens(byModel, dailyByModel, "minimax"), [
    { date: "2026-10-29", totalTokens: 500 },
    { date: "2026-10-30", totalTokens: 700 },
  ]);

  assert.deepEqual(connections.providerDailyTokens(byModel, dailyByModel, null), [
    { date: "2026-10-29", totalTokens: 550 },
    { date: "2026-10-30", totalTokens: 790 },
  ]);
});

test("providerDailyTokens drops a model the provider index does not know", () => {
  const rows = connections.providerDailyTokens(
    [],
    [{ date: "2026-10-30", tokens: { mystery: 1234 } }],
    null,
  );

  assert.deepEqual(rows, [{ date: "2026-10-30", totalTokens: 0 }], "no owner, no attribution");
});

test("averagePerBucket divides by the buckets actually drawn", () => {
  assert.equal(analytics.averagePerBucket(2400, 24), 100);
  assert.equal(analytics.averagePerBucket(2400, 0), 0, "an empty window is zero, not Infinity");
  assert.equal(analytics.averagePerBucket(7, 2), 4, "rounded");
});

test("parseAnalytics splits dailyByModel into date plus numeric model keys", () => {
  const parsed = analytics.parseAnalytics({
    dailyByModel: [
      { date: "2026-10-30", "minimax-m3.1-flash": 100, "gpt-6-sol": "50", junk: "nope" },
      { "minimax-m3.1-flash": 1 },
    ],
  });

  assert.deepEqual(parsed.dailyByModel, [
    { date: "2026-10-30", tokens: { "minimax-m3.1-flash": 100, "gpt-6-sol": 50 } },
  ], "an entry with no date is dropped, and a non-numeric value is not NaN");
});
