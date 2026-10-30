# Support

## Report a problem

Open an issue on GitHub:

**https://github.com/bruj0/omni-monitor/issues**

Please include:

- your VS Code version (`Help` → `About`) and Omni Monitor version;
- the output of the **Omni Monitor** output channel (`View` → `Output`, then
  pick *Omni Monitor* from the dropdown). It records the polling history and
  the errors from the server;
- what you expected, and what happened instead.

## Before you report it

Most reports fall into three known categories, and each has a short answer
below. Check whether yours is one of them first.

### "The status bar says the server is unreachable"

The extension polls your server over HTTP. Confirm the server is running and
that the URL in `omniMonitor.baseUrl` is reachable from the machine running VS
Code. A trailing `/v1` is stripped for you, so both forms work.

### "The panel says the usage endpoint is not enabled"

The status bar reads a self-service endpoint that is gated per key by
`allowUsageCommand`, and it is off by default. Turn it on in the server's
API-key manager. Until then the extension says so rather than showing an
error.

### "The dashboard says I need an admin key"

The admin key is optional and only unlocks the dashboard. The status bar works
with an ordinary key. Run **Omni Monitor: Set Admin Key** and give it a key
with the `manage` or `admin` scope.

## Security issues

Do not open a public issue for a security problem. Report it privately through
GitHub's security advisory form for the repository, or by email to the
maintainer listed on the repository's GitHub profile.

Never paste a key into an issue, a log, or a screenshot. If a key leaked,
rotate it in the server's API-key manager first.

## Other editors

This extension targets VS Code and its forks. It is published to the VS Code
Marketplace and to Open VSX, so it also works on Cursor, Windsurf, VSCodium,
Theia, and code-server.
