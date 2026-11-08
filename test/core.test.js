const test = require("node:test");
const assert = require("node:assert/strict");

// core/ is compiled to dist/core by `npm run build`; tests load it from there.
const usage = require("../dist/core/usage.js");
const percent = require("../dist/core/percent.js");
const format = require("../dist/core/format.js");
const analytics = require("../dist/core/analytics.js");
const redactor = require("../dist/core/redactor.js");

test("toUsageView resolves the three states", () => {
  const disabled = usage.toUsageView({ allowed: false, error: { message: "no" } });
  assert.equal(disabled.kind, "disabled");
  assert.equal(disabled.message, "no");

  const ready = usage.toUsageView({ allowed: true, personal: null, provider: null, providers: [] });
  assert.equal(ready.kind, "ready");
  assert.deepEqual(ready.providers, []);

  const single = usage.toUsageView({
    allowed: true,
    personal: null,
    provider: { connectionId: "a", provider: "p" },
  });
  assert.equal(single.providers.length, 1, "falls back to provider[] when providers[] is absent");
});

test("parseUsageResponse throws UsageUnsupportedError on a text response", () => {
  assert.throws(
    () => usage.parseUsageResponse("text/plain; charset=utf-8", "Plan\nClaude"),
    usage.UsageUnsupportedError,
  );
  const view = usage.parseUsageResponse(
    "application/json",
    '{"allowed":true,"personal":null,"provider":null,"providers":[]}',
  );
  assert.equal(view.kind, "ready");
});

test("usageUrl strips /v1 and trailing slashes", () => {
  assert.equal(usage.usageUrl("http://h:20128/v1"), "http://h:20128/api/usage/om-usage?format=json");
  assert.equal(usage.usageUrl("http://h:20128/"), "http://h:20128/api/usage/om-usage?format=json");
});

test("percentLeft treats a null or zero limit as no data, not as zero left", () => {
  assert.equal(percent.percentLeft(5, 10), 50);
  assert.equal(percent.percentLeft(5, null), null);
  assert.equal(percent.percentLeft(5, 0), null);
  assert.equal(percent.percentLeft(20, 10), 0);
});

test("windowPercentLeft prefers the server field, then derives", () => {
  assert.equal(percent.windowPercentLeft({ remainingPercentage: 69, total: 100, remaining: 31 }), 69);
  assert.equal(percent.windowPercentLeft({ total: 100, remaining: 100 }), 100);
  assert.equal(percent.windowPercentLeft({ total: 100, used: 31 }), 69);
  assert.equal(percent.windowPercentLeft({ unlimited: true, total: 0, remaining: 21.69 }), null);
  assert.equal(percent.windowPercentLeft({}), null);
});

test("worstCaseRemaining picks the lowest, not the average", () => {
  const providers = [
    { connectionId: "a", provider: "codex", quotas: { session: { total: 100, remaining: 100 } } },
    { connectionId: "b", provider: "minimax", quotas: { weekly: { remainingPercentage: 69 } } },
    { connectionId: "c", provider: "deepseek", quotas: { credits: { unlimited: true } } },
  ];
  assert.equal(percent.worstCaseRemaining(providers), 69);
  assert.equal(percent.worstCaseRemaining([]), null);
});

test("quotaBar fills solid blocks for what is left", () => {
  assert.equal(format.quotaBar(100), "▬▬▬▬▬▬▬▬▬▬");
  assert.equal(format.quotaBar(0), "▭▭▭▭▭▭▭▭▭▭");
  // 47% of ten segments is 4.7, rounded to 5: the meter reads half-full for
  // near-half quota rather than snapping to a tenth.
  assert.equal(format.quotaBar(47), "▬▬▬▬▬▭▭▭▭▭");
  assert.equal(format.quotaBar(96), "▬▬▬▬▬▬▬▬▬▬");
  assert.equal(format.quotaBar(-5), "▭▭▭▭▭▭▭▭▭▭");
  assert.equal(format.quotaBar(140), "▬▬▬▬▬▬▬▬▬▬");
});

test("providerRead answers one provider's own worst window, or null", () => {
  const providers = [
    { connectionId: "a", provider: "codex", quotas: { session: { total: 100, remaining: 40 } } },
    {
      connectionId: "b",
      provider: "MiniMax",
      quotas: {
        weekly: { remainingPercentage: 69 },
        session: { total: 100, used: 80 },
      },
    },
  ];
  assert.deepEqual(percent.providerRead(providers, "minimax"), { name: "MiniMax", percent: 20 });
  // Matching is case-insensitive on purpose: the setting is typed by a reader
  // and the server varies its capitalisation.
  assert.deepEqual(percent.providerRead(providers, "CODEX"), { name: "codex", percent: 40 });
  assert.equal(percent.providerRead(providers, "deepseek"), null);
  assert.equal(percent.providerRead(providers, ""), null);
});

test("severityFor escalates on remaining, not used", () => {
  assert.equal(percent.severityFor(100), "ok");
  assert.equal(percent.severityFor(21), "ok");
  assert.equal(percent.severityFor(20), "warning");
  assert.equal(percent.severityFor(6), "warning");
  assert.equal(percent.severityFor(5), "critical");
  assert.equal(percent.severityFor(0), "critical");
  assert.equal(percent.severityFor(null), "ok");
});

test("soonestReset picks the earliest reset across windows", () => {
  const s = {
    connectionId: "a",
    provider: "p",
    quotas: {
      weekly: { resetAt: "2026-10-22T14:41:29.000Z" },
      session: { resetAt: "2026-10-16T21:00:58.000Z" },
      none: {},
    },
  };
  assert.equal(percent.soonestReset(s), "2026-10-16T21:00:58.000Z");
});

test("formatResetIn reads like the server's terminal output", () => {
  const now = Date.parse("2026-10-16T12:00:00.000Z");
  assert.equal(format.formatResetIn("2026-10-16T21:00:58.000Z", now), "9h 0m");
  assert.equal(format.formatResetIn("2026-10-16T11:00:00.000Z", now), "now");
  assert.equal(format.formatResetIn(null, now), "unknown");
  assert.equal(format.formatResetIn("not-a-date", now), "unknown");
});

test("formatUsedTotal hides the binary rounding noise", () => {
  assert.equal(format.formatUsedTotal(8, 100), "8/100");
  // The server sends 20.4 as 20.400000000000002. Printing it raw put
  // seventeen digits in the tooltip.
  assert.equal(format.formatUsedTotal(20.400000000000002, 30), "20.4/30");
  assert.equal(format.formatUsedTotal(26.4, 60), "26.4/60");
  assert.equal(format.formatUsedTotal(0, 12), "0/12");
  // 1.005 is stored as 1.00499999999999989, so it rounds down to 1. The
  // point is that no seventeen-digit tail survives, not which way a value
  // that sits exactly on a rounding boundary falls.
  assert.equal(format.formatUsedTotal(1.005, 100), "1/100");
  // A third decimal is dropped, not carried.
  assert.equal(format.formatUsedTotal(1.239, 100), "1.24/100");
  // A non-finite value must not print as NaN.
  assert.equal(format.formatUsedTotal(NaN, 30), "-/30");
  assert.equal(format.formatUsedTotal(20, Infinity), "20/-");
});

test("formatTokens compacts and formatUsd handles null", () => {
  assert.equal(format.formatTokens(1234), "1.2k");
  assert.equal(format.formatTokens(1234567), "1.2M");
  assert.equal(format.formatTokens(null), "-");
  assert.equal(format.formatUsd(null), "-");
  assert.match(format.formatUsd(1.5), /1\.50/);
});

test("statusBarText draws the bar with the number in it", () => {
  assert.equal(
    format.statusBarText({ percentRemaining: 23, soleProviderName: "minimax", reachable: true }),
    "$(layers) ▬▬▭▭▭▭▭▭▭▭ 23% minimax",
  );
  assert.equal(
    format.statusBarText({ percentRemaining: 23, reachable: true }),
    "$(layers) ▬▬▭▭▭▭▭▭▭▭ 23%",
  );
  assert.equal(
    format.statusBarText({ percentRemaining: null, reachable: true }),
    "$(layers-dot) OmniRoute",
  );
  assert.equal(
    format.statusBarText({ percentRemaining: 23, reachable: false }),
    "$(circle-outline) OmniRoute",
  );
});

test("parseAnalytics survives a missing summary", () => {
  const parsed = analytics.parseAnalytics({});
  assert.equal(parsed.summary.totalRequests, 0);
  assert.deepEqual(parsed.dailyTrend, []);
});

test("successRateOf coerces the string the server sends", () => {
  assert.equal(analytics.successRateOf({ provider: "p", successRatePct: "100.00" }), 100);
  assert.equal(analytics.successRateOf({ provider: "p", successRatePct: 97.1 }), 97.1);
  assert.equal(analytics.successRateOf({ provider: "p" }), null);
});

test("parseRequestLog splits the pipe-delimited wire format", () => {
  const row = analytics.parseRequestLog(
    "2026-10-16T17:06:57.608Z | MiniMax-M3.1-Flash-Preview | MINIMAX | main | 167420 | 384 | 200",
  );
  assert.equal(row.provider, "MINIMAX");
  assert.equal(row.promptTokens, 167420);
  assert.equal(row.completionTokens, 384);
  assert.equal(row.status, "200");
});

test("parseRequestLogs keeps an unparseable row rather than dropping it", () => {
  const rows = analytics.parseRequestLogs(["garbage", "a|b|c|d|1|2|200"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, null);
  assert.equal(rows[0].raw, "garbage");
});

test("isRange rejects values the endpoint would refuse", () => {
  assert.equal(analytics.isRange("30d"), true);
  assert.equal(analytics.isRange("14d"), false);
});

test("redaction strips credentials from strings, keys and values", () => {
  assert.equal(
    redactor.redactString("Authorization: Bearer abc123def456ghi"),
    "Authorization: Bearer [redacted]",
  );
  assert.equal(redactor.redactString("sk-0123456789abcdef"), "sk-[redacted]");
  assert.equal(redactor.redactString("oma_0123456789abcdef"), "oma_[redacted]");

  const out = redactor.redact({ apiKey: "short", authorization: "x", note: "fine", tokenish: "T".repeat(40) });
  assert.equal(out.apiKey, "[redacted]");
  assert.equal(out.authorization, "[redacted]");
  assert.equal(out.note, "fine");
  assert.equal(out.tokenish, "[redacted]");
});

test("redaction recurses and is depth bounded", () => {
  const nested = { a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } };
  const out = redactor.redact(nested);
  assert.ok(JSON.stringify(out).includes("[truncated]"));
});