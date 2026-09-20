# pi-verbosity-control

Apply per-model OpenAI `text.verbosity` overrides and cycle the current model's setting from the keyboard.

## Install

```bash
pi install npm:pi-verbosity-control
```

Or via git:

```bash
pi install git:github.com/ferologics/pi-verbosity-control
```

Restart Pi or use `/reload` if you are developing locally.

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

Run the existing `index.test.ts` with Vitest and the Pi peer packages available. The native checkpoint integration cases automatically skip on hosts without `AgentSession.acquireCheckpoint`; on a supporting host they use isolated files and synthetic configuration, without model requests. Launch tests with an isolated `HOME` and `PI_CODING_AGENT_DIR` and `PI_OFFLINE=1`.

## Notes

- The optional footer indicator uses a runtime monkeypatch of Pi's built-in `FooterComponent`, not a public footer-composition API.
