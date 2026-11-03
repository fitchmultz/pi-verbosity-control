# Changelog

## 0.6.8 - 2026-11-03

<!-- npm-release:unreleased:start -->
<!-- npm-release:unreleased:end -->

- Skip no-op releases and restate malformed remediation dispositions (#47) ([6d94d59](https://github.com/fitchmultz/pi-verbosity-control/commit/6d94d59d44320baf94c14c674c597e3752b14435))

### What's Changed
* Skip no-op releases and restate malformed remediation dispositions by @fitchmultz in https://github.com/fitchmultz/pi-verbosity-control/pull/47


**Full Changelog**: https://github.com/fitchmultz/pi-verbosity-control/compare/v0.6.7...v0.6.8

## 0.6.7 - 2026-11-02

<!-- npm-release:unreleased:start -->
<!-- npm-release:unreleased:end -->

- Recheck unreported Cursor reviews in automatic releases (#44) ([5467fe7](https://github.com/fitchmultz/pi-verbosity-control/commit/5467fe7af8795e0d08ed6064b04071c4795f49ca))

### What's Changed
* Recheck unreported Cursor reviews in automatic releases by @fitchmultz in https://github.com/fitchmultz/pi-verbosity-control/pull/44


**Full Changelog**: https://github.com/fitchmultz/pi-verbosity-control/compare/v0.6.6...v0.6.7

## 0.6.6 - 2026-11-02

<!-- npm-release:unreleased:start -->
<!-- npm-release:unreleased:end -->

- Raise the Pi floor to 1.5.0 (#42) ([53968a8](https://github.com/fitchmultz/pi-verbosity-control/commit/53968a8f3ed94a65802bc99e045750efef35c86d))

### What's Changed
* Raise the Pi floor to 1.5.0 by @fitchmultz in https://github.com/fitchmultz/pi-verbosity-control/pull/42


**Full Changelog**: https://github.com/fitchmultz/pi-verbosity-control/compare/v0.6.5...v0.6.6

## 0.6.5 - 2026-11-02

<!-- npm-release:unreleased:start -->
<!-- npm-release:unreleased:end -->

- Adopt the Strict Oxlint and Oxfmt Engineering Standard v5.1.2 (#40) ([702829a](https://github.com/fitchmultz/pi-verbosity-control/commit/702829aeb5cc44a5e51034a0e4f17da2b8033783))

### What's Changed
* Adopt the Strict Oxlint and Oxfmt Engineering Standard v5.1.2 by @fitchmultz in https://github.com/fitchmultz/pi-verbosity-control/pull/40


**Full Changelog**: https://github.com/fitchmultz/pi-verbosity-control/compare/v0.6.4...v0.6.5

## 0.6.4 - 2026-11-01

<!-- npm-release:unreleased:start -->
<!-- npm-release:unreleased:end -->

- Use direct Flash for automatic release remediation (#38) ([c02de8b](https://github.com/fitchmultz/pi-verbosity-control/commit/c02de8bf3d105b9988c345fabe09271b667a80c5))

### What's Changed
* Use direct Flash for necessary release remediation by @fitchmultz in https://github.com/fitchmultz/pi-verbosity-control/pull/38


**Full Changelog**: https://github.com/fitchmultz/pi-verbosity-control/compare/v0.6.3...v0.6.4

## 0.6.3 - 2026-11-01

<!-- npm-release:unreleased:start -->
<!-- npm-release:unreleased:end -->

- Automate reviewed npm patch releases (#36) ([10fcbc0](https://github.com/fitchmultz/pi-verbosity-control/commit/10fcbc09a54f270414a924515bc9625ab6c1a9d6))

### What's Changed
* Automate reviewed npm patch releases by @fitchmultz in https://github.com/fitchmultz/pi-verbosity-control/pull/36


**Full Changelog**: https://github.com/fitchmultz/pi-verbosity-control/compare/v0.6.2...v0.6.3

## 0.6.2 — 31 October 2026

- Refresh the release and host-qualification workflows and clarify compatibility and the scoped npm and GitHub release process.

## 0.6.1 — 4 October 2026

- Distribute this maintained fork as the public scoped package `@fitchmultz/pi-verbosity-control`, with a runtime-only package allowlist and scoped-first installation guidance. Preserve upstream attribution, existing Git installs and the `verbosity.json` configuration contract.
- Qualify the once-resolved latest stable official Pi and maintained fork main, including the existing native request/status/model/reload and configuration checks, before publishing from this repository's main-only release pipeline.

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

This maintained fork is distributed as `@fitchmultz/pi-verbosity-control` and through Git. It does not publish the upstream unscoped npm package.
