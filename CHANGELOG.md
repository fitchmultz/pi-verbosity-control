# Changelog

## 0.6.0 — 1 October 2026

- Require and qualify the exact official Pi 1.0.0 development cohort, with the same native payload/status/model-select/shortcut and watched-config behavior. No additional configuration cache or provider override is introduced.
- Follow the owner's confirmed Pi 1.0 keep list: delete removed fork checkpoint handlers and their checkpoint-only test scaffolding. Preserve config locking, malformed-file recovery, native shutdown cleanup and reload restoration.
- Continue Git/GitHub-only delivery; do not publish the upstream author's npm package.

## 0.5.1 — 26 September 2026

- The first verbosity shortcut on an unconfigured Codex model now selects `medium`. Codex already defaults to `low`, so selecting `low` changed nothing.

## 0.5.0 — 26 September 2026

- Require Node.js 24 or newer.
- Leave OpenAI and Azure GPT-4 and o1/o3/o4 requests unchanged instead of sending unsupported low/high verbosity.
- Preserve concurrent verbosity and indicator changes across Pi sessions by locking the complete read-modify-write operation.
- Keep the previous config intact when a shortcut save fails partway through writing.
- Qualified against official Pi 0.87.1 and the maintained fork.

## 0.4.0 — 22 September 2026

- Publish verbosity through Pi's native extension status, shared by stock and custom footers, instead of patching footer internals.
- Use the active Pi agent directory and one configuration snapshot for request overrides and the indicator. Follow file edits, model changes, and existing shortcuts; release the watcher and status on shutdown.
- Preserve native checkpoint behavior and invalidate held receipts before accepting changed settings.

This maintained fork is distributed through Git. It does not publish the upstream npm package.
