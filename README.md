# pi-verbosity-control

Apply per-model OpenAI `text.verbosity` overrides and cycle the current model's setting from the keyboard.

## Install

Requires Node.js 24 or newer. Install this maintained fork from Git:

```bash
pi install git:github.com/fitchmultz/pi-verbosity-control
```

The original [ferologics package](https://github.com/ferologics/pi-verbosity-control) remains available as `npm:pi-verbosity-control`. The Git fork retains its attribution and has its own version history. This repository does not publish the upstream npm package.

Restart Pi after changing extension code or dependencies. On the qualified official and fork 0.87 hosts, `/reload` refreshes settings and non-code resources but does not activate updated extension code.

## What it does

- Reads `verbosity.json` from Pi's active agent directory: `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` when set.
- Supports overrides by bare model id (`gpt-5.4`) or exact provider/model (`openai-codex/gpt-5.4`). Exact entries win.
- Applies `text.verbosity` immediately before supported requests are sent, preserving other payload and `text` fields.
- Cycles the current model's verbosity and saves it back to the same file.
- Optionally publishes `🗣  <level>` through Pi's native `verbosity` status key.

Supported APIs: `openai-responses`, `openai-codex-responses`, and `azure-openai-responses`. OpenAI and Azure GPT-4 and o1/o3/o4 models accept only `medium`; the extension leaves them unchanged and warns when cycling. Other APIs, including Anthropic, are left unchanged. Effort/thinking controls are separate from verbosity.

## Shortcuts

| Action | macOS | Other platforms |
| --- | --- | --- |
| Cycle verbosity | `Alt+V` | `Ctrl+Alt+V` |
| Toggle indicator | `Alt+Shift+V` | `Ctrl+Alt+Shift+V` |

The cycle is `low → medium → high → low`. An unconfigured supported model starts at `low`. Codex already sends `low` by default, so its first press selects `medium`.

Shortcut saves use a cross-process file lock and re-read the configuration before changing it, preserving concurrent changes from other updated Pi sessions. They replace the file only after a complete write, so failed writes leave the previous config intact. If the file cannot be read or parsed, the shortcut reports an error and leaves it unchanged. Manual editors do not participate in this lock.

## Config

Example `verbosity.json`:

```json
{
    "showIndicator": false,
    "models": {
        "gpt-5.4": "low",
        "openai/gpt-5.4": "medium"
    }
}
```

`showIndicator` defaults to `false`. Hiding the indicator does not disable request overrides. The indicator is absent when the selected model is unsupported or has no configured override.

The controller owns both the request setting and its displayed status. It watches the agent directory for edits and atomic file replacements, and refreshes at startup, model changes, requests, and shortcuts. Unreadable files or syntactically invalid JSON retain the last good settings until corrected; a missing file restores defaults. If directory watching is unavailable, native event boundaries still refresh the configuration; `/reload` also retries the watcher.

The stock footer displays the native status in its extension-status row. Custom footers can read `footerData.getExtensionStatuses().get("verbosity")`; they should not read the config themselves. The extension does not replace or patch any footer. Shutdown and reload clear its status and close its watcher.

## Working-session checkpoints

On hosts supporting the optional native `session_checkpoint` event, the extension verifies that the existing file reconstructs its active settings before allowing sleep. Checkpointing neither runs shutdown nor rewrites the file. Unreconciled edits, malformed JSON, and read errors prevent sleep readiness. A missing file qualifies only when the active settings are defaults.

A watcher change invalidates a held receipt before updating active settings. The archive owner must still preserve the active agent directory's `verbosity.json` and freeze external filesystem writers during capture. Hosts without checkpoint support retain normal behavior.

## Tests

Use Node 24 and the repository's pinned official Pi **0.87.1** dependencies. Tests run on Node's built-in test runner:

```bash
npm ci --ignore-scripts
npm run check:compat
```

The suite covers config normalization, a nondefault agent directory, model precedence and API eligibility, shortcuts, shared request/status updates, watcher cleanup, and native extension loading, stock-footer rendering, model selection, and reload. Native checkpoint cases run when the host supports them; `PI_COMPAT_HOST=fork` requires that capability rather than skipping it. A compatibility runner can install maintained-fork artifacts into this checkout before running the same command.

Tests use temporary config directories and synthetic request payloads; they do not contact OpenAI or dispatch terminal keystrokes. To isolate the command environment as well (Bash):

```bash
fixture=$(mktemp -d /tmp/verbosity-ci.XXXXXX)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/home" "$fixture/agent" "$fixture/tmp"
env -i PATH="$PATH" HOME="$fixture/home" USERPROFILE="$fixture/home" \
    TMPDIR="$fixture/tmp" PI_CODING_AGENT_DIR="$fixture/agent" \
    PI_OFFLINE=1 PI_TELEMETRY=0 PI_COMPAT_HOST=official \
    npm run check:compat
```
