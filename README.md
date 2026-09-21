# pi-verbosity-control

Apply per-model OpenAI `text.verbosity` overrides and cycle the current model's setting from the keyboard.

## Install

This maintained fork is installed from Git:

```bash
pi install git:github.com/fitchmultz/pi-verbosity-control
```

The upstream ferologics package remains available as `npm:pi-verbosity-control` and
`git:github.com/ferologics/pi-verbosity-control`. Both sources currently use version
`0.3.0`, but that does **not** identify the same source revision. Qualification of
this Git fork is not qualification of the upstream npm artifact, nor a claim of
npm publishing rights. Upstream attribution and package metadata are retained.

Restart Pi after changing extension code or dependencies. Official Pi supports
code reload, but the maintained host fork deliberately requires a fresh process;
`/reload` there refreshes config/resources and reinitializes cached extension code.

## What it does

- Reads global config from `~/.pi/agent/verbosity.json`
- Supports model-specific overrides by bare model id (`gpt-5.4`) or exact provider/model (`openai-codex/gpt-5.4`)
- Applies `text.verbosity` to supported OpenAI Responses-family requests right before they are sent
- Cycles the current model's verbosity with a shortcut and saves it back to the config file
- Optionally shows the active verbosity inline in Pi's footer

Exact `provider/model` entries win over bare model ids.

## Supported APIs

- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`

## Anthropic / Claude

This extension is intentionally OpenAI-only.

Anthropic does not currently expose a direct equivalent to OpenAI `text.verbosity`. Claude's `output_config.effort` is a separate effort/thoroughness control, not a drop-in verbosity setting, so this extension does not map verbosity onto Anthropic models.

## Shortcuts

- Cycle verbosity
  - macOS: `Alt+V`
  - Other platforms: `Ctrl+Alt+V`
- Toggle footer indicator
  - macOS: `Alt+Shift+V`
  - Other platforms: `Ctrl+Alt+Shift+V`

The verbosity cycle is:

```text
low -> medium -> high -> low
```

## Config

Path:

```text
~/.pi/agent/verbosity.json
```

Example:

```json
{
    "showIndicator": false,
    "models": {
        "gpt-5.4": "low",
        "openai/gpt-5.4": "medium"
    }
}
```

- `showIndicator` defaults to `false`
- When `showIndicator` is `false`, the extension does not patch Pi's footer at all

If you edit the file manually while Pi is already running, use `/reload`.

## Working-session checkpoints

On Pi hosts supporting the optional native `session_checkpoint` event, the extension verifies that the existing config file reconstructs its active settings before allowing sleep. Native dispatch already waits for startup and shortcut callbacks; checkpointing does not run shutdown or rewrite the file.

External edits that differ from active settings, malformed JSON, and read errors keep sleep readiness false. Use `/reload` after reconciling the file. A missing file qualifies only when the active settings are the defaults. The archive owner must still preserve `~/.pi/agent/verbosity.json` and freeze external filesystem writers during capture.

Hosts without this event retain normal behavior. Footer cleanup still runs on shutdown/reload.

## Tests

`npm run check:compat` typechecks production source and runs the existing Vitest
suite against this checkout's installed dependency graph. Development Pi packages
are pinned to the official **0.86.1** cohort; Vitest remains **4.1.9**. No source-host
aliases or Pi installation from PATH are used. A compatibility runner can replace
the local Pi cohort with maintained-fork artifacts before invoking the same check.

The suite includes **14 existing helper/runtime cases, one native baseline case,
and six optional native checkpoint cases**. The baseline verifies native request-hook
dispatch, actual stock-footer rendering/width, config reload, and prototype teardown
on both hosts. Requests are synthetic; it does not contact OpenAI or dispatch terminal
keystrokes. The checkpoint cases are mandatory when `PI_COMPAT_HOST=fork` (or the
legacy `PI_REQUIRE_CHECKPOINT=1`); missing native capability fails instead of skipping.
They intentionally skip on official Pi without checkpoint support.

To reproduce the official baseline after `npm ci --ignore-scripts`, run from this
extension directory with Node 24 (Bash):

```bash
fixture=$(mktemp -d /tmp/verbosity-ci.XXXXXX)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/home" "$fixture/tmp"
env -i PATH="$PATH" HOME="$fixture/home" TMPDIR="$fixture/tmp" \
    PI_CODING_AGENT_DIR="$fixture/home/.pi/agent" \
    PI_OFFLINE=1 PI_TELEMETRY=0 PI_COMPAT_HOST=official \
    npm run check:compat
```

Keep HOME, USERPROFILE (on Windows), the agent-directory override, and temporary
files coherent and outside your real home. Tests manage their own nested HOME and
agent-directory overrides. Official 0.86.1 was locally checked with Node 24: 15 cases
passed and six checkpoint cases skipped. Fork identity must be recorded by commit
or artifact, not just its package version. Platform/terminal behavior and upstream
npm publication remain separate qualification boundaries.

## Notes

- The optional footer indicator uses a runtime monkeypatch of Pi's built-in `FooterComponent`, not a public footer-composition API.
