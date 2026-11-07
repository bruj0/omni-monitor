# Changelog

All notable changes to the Omni Monitor extension are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-11-07

### Changed

- The extension describes itself as a **monitor** rather than a "read-only"
  monitor, in the Marketplace description, the README, the privacy policy,
  and the admin-key prompt. It still only reads; nothing about the
  behaviour changed, and the extension still registers no model provider.
- The README states that the extension is third-party and not affiliated
  with or endorsed by the OmniRoute project.
- The README states the pricing model: free, MIT licensed, no account, no
  subscription, no telemetry.

### Fixed

- The public README no longer names a private network address as its
  configuration example, and the source comments no longer name the
  machine the wire shapes were measured on.

## [0.1.0] — 2026-10-30

First release.

### Added

- Status bar item showing the lowest remaining quota percentage across every
  provider connection, with a warning at 20% remaining and a critical state at
  5%. Hovering shows per-connection windows, reset countdowns, and the key's own
  daily and weekly spend.
- Activity Bar dashboard with four summary cards (cost, tokens, requests with
  success rate, daily average), a daily trend chart, a top-models donut with a
  breakdown table, quota by connection, and a paged request log.
- Two credential commands that store an API key and an admin key in the OS
  keychain. The admin key is optional and only unlocks the dashboard.
- Server URL setting, poll interval, alert thresholds, and a default date range.
- Automatic alerts when a connection crosses the warning or critical threshold.
- A command that probes whether the upstream dashboard allows framing, and
  opens it in a tab when it does.

### Notes

- The extension only monitors. It registers no model provider and contributes
  nothing to the Copilot model picker.
- The API key and admin key are stored in the OS keychain, never in
  `settings.json` and never on a command line.
