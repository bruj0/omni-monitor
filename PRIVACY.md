# Privacy

Omni Monitor is a local, read-only monitor for an API gateway you run
yourself. It sends nothing to the extension publisher.

## What the extension collects

**Nothing.** There is no telemetry, no analytics, no crash reporting, no
usage tracking, and no error reporting service. The extension makes no
request to any endpoint other than the server you configure.

## What the extension stores

Two credentials, both in the VS Code SecretStorage, which is the operating
system's credential store:

| Credential | Scope | Used for |
|---|---|---|
| API key | ordinary key, needs `allowUsageCommand` | the status bar quota |
| Admin key | `manage` or `admin` | the dashboard |

Both are set by an explicit command, never in `settings.json`, never in
`argv`, and never in a log file. The admin key is optional: without it the
status bar works and the dashboard shows a setup prompt.

The **Omni Monitor: Clear Stored Keys** command deletes both.

## What the extension transmits

Requests go to the base URL you set in `omniMonitor.baseUrl`, and nowhere
else:

- a quota request carrying your API key;
- management requests carrying your admin key, when you have set one.

If your server is on `http://localhost:20128`, the request never leaves your
machine. If you point it at a remote server, the request travels to that
server over the network, using whatever transport that server provides —
the extension does not upgrade the connection to TLS and does not add
encryption of its own. Use `https://` if your server supports it.

## What the extension does not do

- It does not read your files, your editor contents, your clipboard, or your
  shell history.
- It does not install or launch any executable code.
- It does not register a model provider, and it contributes nothing to the
  Copilot model picker. It cannot send a prompt to a model, because it has no
  model provider to send it with.
- It does not modify any VS Code setting on your behalf.

## Request log data

The dashboard's request log shows the requests your own server recorded,
including the model, the token count, the status, and the cost. That data
comes from your server, not from the extension publisher. The extension
displays it and does not store a copy.

## Contact

For a privacy question, open an issue on
https://github.com/bruj0/omni-monitor/issues — but never include a key.
