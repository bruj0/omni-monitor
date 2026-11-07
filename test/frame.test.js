const test = require("node:test");
const assert = require("node:assert/strict");
const frame = require("../dist/core/frame.js");

const headers = (map) => ({ get: (name) => (name in map ? map[name] : null) });

test("live OmniRoute headers are measured as blocked", () => {
  // Values captured from a live OmniRoute on 2026-10-16.
  const h = headers({
    "x-frame-options": "DENY",
    "content-security-policy":
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; script-src 'self'",
  });
  assert.equal(frame.isFramingAllowed(h), false);
});

test("X-Frame-Options SAMEORIGIN also blocks a webview", () => {
  assert.equal(frame.isFramingAllowed(headers({ "x-frame-options": "SAMEORIGIN" })), false);
});

test("vscode-webview in frame-ancestors allows embedding", () => {
  const h = headers({ "content-security-policy": "frame-ancestors 'self' vscode-webview:" });
  assert.equal(frame.isFramingAllowed(h), true);
});

test("frame-ancestors * allows embedding", () => {
  assert.equal(frame.isFramingAllowed(headers({ "content-security-policy": "frame-ancestors *" })), true);
});

test("no CSP frame-ancestors directive is not blocked by CSP", () => {
  assert.equal(frame.isFramingAllowed(headers({ "content-security-policy": "default-src 'self'" })), true);
});

test("frame-ancestors 'none' blocks even with no XFO", () => {
  assert.equal(frame.isFramingAllowed(headers({ "content-security-policy": "frame-ancestors 'none'" })), false);
});

test("frameAncestorsOf returns null when the directive is absent", () => {
  assert.equal(frame.frameAncestorsOf("default-src 'self'; object-src 'none'"), null);
  assert.equal(frame.frameAncestorsOf("frame-ancestors 'self' vscode-webview:"), "'self' vscode-webview:");
});
