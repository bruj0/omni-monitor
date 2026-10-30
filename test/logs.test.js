const test = require("node:test");
const assert = require("node:assert/strict");

// core/ is compiled to dist/core by `npm run build`; tests load it from there.
const logs = require("../dist/core/logs.js");

// The wire shape below was measured against the live server on 2026-10-30:
// `call-logs` returns objects with `tokens: {in, out}`, a provider slug, and an
// `active` flag for requests still in flight.

const row = (over = {}) => ({
  id: "1793367387299-61522e",
  timestamp: "2026-10-30T13:36:27.299Z",
  provider: "synthetic",
  providerDisplay: null,
  model: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
  requestedModel: null,
  account: "main",
  apiKeyName: null,
  status: 200,
  duration: 1921,
  tokens: { in: 165038, out: 360 },
  path: "/v1/chat/completions",
  method: "POST",
  active: false,
  error: null,
  cacheSource: null,
  comboName: null,
  correlationId: "6f2c3169-7414-4398-b810-1f12f7dadbde",
  addedWaitMs: null,
  ...over,
});

test("parseCallLogRows reads the wire shape into one flat row", () => {
  const rows = logs.parseCallLogRows([row()]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].promptTokens, 165038, "tokens.in becomes promptTokens");
  assert.equal(rows[0].completionTokens, 360);
  assert.equal(rows[0].provider, "synthetic");
  assert.equal(rows[0].duration, 1921);
  assert.equal(rows[0].active, false);
});

test("parseCallLogRows drops a row with no id", () => {
  const rows = logs.parseCallLogRows([row({ id: "" }), row({ id: "keep" })]);
  assert.deepEqual(rows.map((r) => r.id), ["keep"], "id is the dedupe key and cannot be invented");
});

test("parseCallLogRows degrades a missing field to a neutral value, not to undefined", () => {
  const rows = logs.parseCallLogRows([
    { id: "x", timestamp: "2026-10-30T10:00:00Z", tokens: null, addedWaitMs: null },
  ]);

  assert.equal(rows[0].provider, "");
  assert.equal(rows[0].promptTokens, 0);
  assert.equal(rows[0].status, 0);
  assert.equal(rows[0].addedWaitMs, null, "a null wait stays null; zero would mean 'no wait'");
});

test("parseCallLogRows tolerates anything that is not an array", () => {
  assert.deepEqual(logs.parseCallLogRows(null), []);
  assert.deepEqual(logs.parseCallLogRows({ error: "Log not found" }), []);
});

test("classifyStatus matches the server's own filter semantics", () => {
  assert.equal(logs.classifyStatus(200, ""), "ok");
  assert.equal(logs.classifyStatus(502, ""), "error");
  assert.equal(logs.classifyStatus(0, ""), "pending", "an in-flight row carries status 0");
  assert.equal(logs.classifyStatus(200, "upstream reset"), "error", "an error summary wins");
  assert.equal(logs.classifyStatus(302, ""), "other");
});

test("logsQueryString sends only the parameters the server honours", () => {
  assert.equal(
    logs.logsQueryString({ ...logs.DEFAULT_LOG_QUERY }),
    "limit=50",
    "a default query carries no empty filters",
  );

  const query = logs.logsQueryString({
    offset: 100,
    limit: 50,
    status: "error",
    search: " minimax ",
    provider: "codex",
  });
  const params = new URLSearchParams(query);

  assert.equal(params.get("offset"), "100");
  assert.equal(params.get("status"), "error");
  assert.equal(params.get("search"), "minimax", "trimmed");
  assert.equal(params.get("provider"), "codex");
});

test("logsQueryString never sends an unknown status", () => {
  const params = new URLSearchParams(
    logs.logsQueryString({ ...logs.DEFAULT_LOG_QUERY, status: "pending" }),
  );
  assert.equal(params.get("status"), null, "the server only knows ok and error");
});

test("mergeLogPages dedupes by id and keeps the newest timestamp first", () => {
  const merged = logs.mergeLogPages([
    [row({ id: "a", timestamp: "2026-10-30T10:00:00Z", status: 0 })],
    [
      row({ id: "a", timestamp: "2026-10-30T10:00:00Z", status: 200 }),
      row({ id: "b", timestamp: "2026-10-30T11:00:00Z" }),
    ],
  ]);

  assert.deepEqual(merged.map((r) => r.id), ["b", "a"]);
  assert.equal(merged[1].status, 200, "the later copy wins, so a finished row stops saying pending");
});

test("hasOlderPage treats a full page as 'there may be more'", () => {
  assert.equal(logs.hasOlderPage(50, 50), true);
  assert.equal(logs.hasOlderPage(49, 50), false);
  assert.equal(logs.hasOlderPage(0, 50), false);
});
