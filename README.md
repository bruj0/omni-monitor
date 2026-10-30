# Omni Monitor — API Quota Dashboard

A read-only VS Code monitor for [OmniRoute](https://github.com/diegosouzapw/OmniRoute):
quota remaining as a percentage in the status bar, plus a usage dashboard.

**It does not serve models.** No `languageModelChatProviders`, no chat
participants, nothing in the Copilot model picker. If you use GCMP or
OmniCopilot to serve models, this coexists with it and touches nothing about
how models are routed.

## What it shows

**Status bar** — a bar of the quota remaining, solid on the left for what is
left and outlined for what is spent, with the same number as text. With no
provider chosen it reads the smallest remaining percentage across every
connection; otherwise one provider, chosen from the dashboard's Settings page:

```
$(layers) ▬▬▬▬▬▬▬▭▭▭ 68%
```

Warns at 20% remaining, critical at 5%; the item's background turns yellow,
then red. Hover for the reading the bar made, per-connection windows, reset
countdowns, and your key's own daily and weekly spend.

**Dashboard** — an Activity Bar panel mirroring GCMP's `usagesView`:

- four summary cards: cost, tokens, requests with success rate, daily average
- daily trend chart
- top models donut plus a breakdown table
- quota by connection
- recent requests, paged at 20

All colours are VS Code theme variables, so it follows your theme.

## Install

From the VS Code Marketplace, search for **Omni Monitor — API Quota Dashboard**,
or run:

```bash
code --install-extension bruj0.omni-monitor
```

The extension also publishes to Open VSX, so it works on Cursor, Windsurf,
VSCodium, Theia, and code-server.

## Configure

Two keys, both stored in the OS keychain. Neither ever goes in
`settings.json` or on a command line.

| Command | Purpose | Scope needed |
|---|---|---|
| `Omni Monitor: Set API Key` | status bar quota | ordinary key with `allowUsageCommand` |
| `Omni Monitor: Set Admin Key` | dashboard only | `manage` or `admin` |

The admin key is **optional**. Without it the status bar works and the
dashboard shows a setup prompt.

Then point it at your server:

```json
{ "omniMonitor.baseUrl": "http://10.0.0.77:20128" }
```

A trailing `/v1` is stripped for you.

### Enabling usage on your key

The status bar reads the self-service `om-usage` endpoint, which is gated per
key by `allowUsageCommand` and is **off by default**. Turn it on in OmniRoute's
API-key manager. Until then the panel says so instead of showing an error.

## Embedding OmniRoute's own dashboard does not work

There is a command for it, and against a stock OmniRoute build it always falls
back to your browser. Two independent blockers, both measured against a live
server on 2026-10-16:

1. **Framing.** The server sends `X-Frame-Options: DENY` and
   `frame-ancestors 'none'`. Relaxing them requires a **build-time** flag,
   `DASHBOARD_ALLOW_EMBED=vscode`, which Next bakes into the route manifest.
   Setting it on a running install does nothing, and the stock npm package and
   Docker image are not built with it.
2. **Session.** `auth_token` is `httpOnly` and `sameSite: "lax"`, so it never
   reaches a `vscode-webview:` iframe. Moving it would mean holding the
   dashboard password, which this extension never does.

The second blocker stands even if the first is removed. The extension probes
before opening a tab, because VS Code's `simpleBrowser.show` succeeds even when
framing is blocked and would leave you looking at a refused-to-connect page.

Your own dashboard works without any of this, because it reads the management
API directly.

## Settings

| Setting | Default |
|---|---|
| `omniMonitor.baseUrl` | `http://localhost:20128` |
| `omniMonitor.refreshSeconds` | `60` |
| `omniMonitor.statusBar` | `true` |
| `omniMonitor.alerts` | `true` |
| `omniMonitor.warnAtPercent` | `80` (percent used) |
| `omniMonitor.critAtPercent` | `95` (percent used) |
| `omniMonitor.defaultRange` | `30d` |

## Privacy

The extension sends nothing to the publisher. There is no telemetry and no
crash reporting. Your keys live in the OS keychain, and every request goes to
the server you configure. See [PRIVACY.md](./PRIVACY.md).

## Support

Open an issue on
[GitHub](https://github.com/bruj0/omni-monitor/issues). See
[SUPPORT.md](./SUPPORT.md) for what to include, and for the three known
issues that account for most reports.

## Building from source

```bash
npm install
npm run build       # tsc (type-check + host) + esbuild bundle
npm test            # tests over src/core/
npm run typecheck
npx vsce package    # -> omni-monitor-0.1.0.vsix
```

The extension host must be CommonJS, which VS Code requires, while a webview
bundle must be an IIFE with chart.js inlined. Both build steps are required;
running only `tsc -p ./` leaves the dashboard missing at runtime with no
error.

`src/core/` must never import `vscode`. That is what makes the percentage
arithmetic and the wire parsers testable without an editor.

## License

MIT. See [LICENSE](./LICENSE).

## Credits

Framing probe adapted from
[OmniCopilot](https://github.com/diegosouzapw/OmniCopilot) (MIT). Dashboard
layout and interaction patterns read from
[GCMP](https://github.com/vicanent/gcmp)'s `usagesView` and `multiDayView`.