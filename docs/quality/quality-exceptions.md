# Quality exceptions

This repository adopts [Strict Oxlint and Oxfmt Engineering Standard
v5.1.2](strict-oxlint-oxfmt-5.1.2.md). Recorded exceptions are listed below using the standard's
Appendix B template. `npm run policy:check` enforces the allowance, the authorized directive
inventory, the tool floors, and source coverage; any other suppression directive fails the gate.

## QX-001 — node:test registration allowance in the test profile

```text
ID and title:
  QX-001 — node:test registration allowance on the test-profile override.

Rule, option, or threshold; installed tool versions:
  typescript/no-floating-promises with allowForKnownSafeCalls =
  [{from: "package", package: "@types/node", name: [nodeDescribe, nodeIt]}].
  oxlint 1.90.0; oxlint-tsgolint 7.0.2005 (type-aware); oxfmt 0.75.0; oxc-parser 0.156.0.

Scope: files, authorized operations, origins, or bounded pattern:
  The test-profile override in .oxlintrc.json (**/*.test.*, **/*.spec.*, **/__tests__/**). Authorized
  operations: top-level and suite-body test registrations made through those two mapped local
  names. Nothing else in the file changes; every other rule and option in the baseline stays
  exactly as the standard sets it.

Directive selectors/inventory and optional duplication bounds:
  No directives are used. Two mapped names, one package origin, test profile only.

Diagnostic and required contract:
  An un-awaited `nodeIt(...)` registration reports "Promises must be awaited". The registration is
  fire-and-forget by design: the node:test runner owns the returned promise, schedules the test, and
  reports the result through its own reporter, so awaiting it is not the contract. Awaiting a
  registration can alter module evaluation and hook timing (standard section 6.4). The test file
  imports describe and it under the mapped names for this reason.

Actual compliant alternative and demonstrated quality cost:
  The compliant alternative is `void nodeIt(...)` (or `await`) at every registration site, because
  ignoreVoid and every other option stay at the baseline. That adds non-semantic ceremony to every
  test in the repository while removing no real risk. The standard defines this mapping for
  precisely this case (Section 6.4), so the allowance is the narrower choice: it exempts two named
  functions instead of silencing the rule for a file, a directory, or the whole test profile.

Chosen adjustment and why its scope is appropriate:
  Declaration-qualified allowance limited to the two names the repository actually uses, applied
  only in the test profile. Production sources keep the rule unrestricted.

Structural comparison or unsafe-type evidence, where applicable:
  Not a structural exception. Type flow is the standard's own example mapping, narrowed to the
  names in use (see lost detection below).

Verification commands, relevant tests, and results:
  npm run quality:probes (tests/quality-harness.test.ts) on the qualification host. Valid fixtures
  (registration, long test) report zero diagnostics; each intended violation fixture (subtest,
  same-named-local, same-named-import, body-promise, unrelated-promise) reports exactly one
  floating-promise diagnostic, and the checker exits nonzero. Results are asserted per fixture
  file, per rule id, and by exit status.

Retained protection, lost detection, and established assumptions:
  Retained: all other floating-promise options (ignoreVoid false, ignoreIIFE false, checkThenables
  true, allowForKnownSafePromises empty) plus every other rule in both profiles. Lost detection:
  the shorthand modifiers cannot be mapped here — the installed checker does not support them
  through mapped aliases — so registrations using them through those names are not exempted. The
  repository uses none; a new one will surface as an ordinary finding in `npm run lint`.

Review and revisit trigger:
  Any upgrade of oxlint or oxlint-tsgolint, any new registration form, or the first use of a
  shorthand modifier through a mapped name. Re-measure with npm run quality:probes and update
  this record.
```

## QX-002 — unbound-method references used only for identity comparison

```text
ID and title:
  QX-002 — FooterComponent.prototype.render captured and compared for identity only.

Rule, option, or threshold; installed tool versions:
  typescript/unbound-method at error severity. oxlint 1.90.0; oxlint-tsgolint 7.0.2005
  (type-aware).

Scope: files, authorized operations, origins, or bounded pattern:
  index.test.ts, createRenderGuard only: the capture of FooterComponent.prototype.render and its
  comparison inside assertUnchanged. Exactly two directive sites, both next-line, both naming
  QX-002 in the reason. scripts/policy-baseline.ts records the inventory and count bound.

Directive selectors/inventory and optional duplication bounds:
  Selector: the const originalRender initializer in createRenderGuard, and the assert.equal
  argument expression inside the returned assertUnchanged callback. Duplication bound: exactly 2
  directives with this file/rule/id combination; policy:check fails on any other count.

Diagnostic and required contract:
  Referencing FooterComponent.prototype.render without a receiver reports "Avoid referencing
  unbound methods". The reference is never invoked: it is captured before extension load and
  compared for identity afterward, proving the extension does not replace or patch the stock
  footer renderer — a documented repository promise (README: "The extension does not replace or
  patch any footer").

Actual compliant alternative and demonstrated quality cost:
  Binding the reference (render.bind(...)) breaks identity comparison — a new bound function is
  never === the original. Invoking the reference changes the receiver and is not the assertion's
  intent. Dropping the identity check weakens the test to behavioral-only detection: a wrapper
  that keeps output identical while patching the prototype would pass. Capturing once and
  comparing is the narrow sound form of the contract.

Chosen adjustment and why its scope is appropriate:
  Two next-line directives at the only two referencing sites, each with the stable QX-002
  identifier and reason. No file-wide or rule-wide disable; production sources keep the rule
  unrestricted.

Structural comparison or unsafe-type evidence, where applicable:
  Not applicable (no unsafe type flow; the reference is never called).

Verification commands, relevant tests, and results:
  npm run policy:check (authorizes exactly the two recorded directives; a copied or unauthorized
  directive fails, exercised by the harness's copied-directive control) and npm test (the
  guarded identity assertions run in the native baseline test). reportUnusedDisableDirectives at
  error makes a stale directive fail lint.

Retained protection, lost detection, and established assumptions:
  Retained: unbound-method still fires on every other method reference in the repository,
  including any new one in this file; render behavior is still verified through real component
  instances at three widths. Lost detection: none for this operation — the rule's risk (calling a
  this-using method unbound) cannot occur because the reference is never invoked. Assumption: the
  guard's references stay the only two; the count bound detects drift.

Review and revisit trigger:
  Any additional method-reference comparison, any upgrade of oxlint or oxlint-tsgolint, or removal
  of the stock-footer non-patching promise.
```

## QX-003 — preserved four-space repository indentation

```text
ID and title:
  QX-003 — tabWidth 4 preserved as the established repository convention.

Rule, option, or threshold; installed tool versions:
  oxfmt tabWidth (standard default block: 2). oxfmt 0.75.0.

Scope: files, authorized operations, origins, or bounded pattern:
  .oxfmtrc.json tabWidth: 4, applying to every file oxfmt owns. All other formatter options are
  the standard's own values. scripts/policy-baseline.ts records the mapping so policy:check
  compares against the guide block with exactly this one recorded deviation. CHANGELOG.md's
  ignorePatterns entry is not part of this exception: it is the standard's own generated-artifact
  rule (release automation owns those bytes), recorded in docs/quality/adoption.md.

Directive selectors/inventory and optional duplication bounds:
  Not a directive-based exception; the recorded option is the adjustment.

Diagnostic and required contract:
  The standard's formatter section says to preserve intentional established repository
  conventions and otherwise use the default block. This repository's established convention is
  four-space indentation across every maintained file, including the shipped runtime contract:
  verbosity.json is written with four-space indentation, asserted byte-for-byte in the test suite
  and shown in the README example.

Actual compliant alternative and demonstrated quality cost:
  Reformatting to two spaces is the block's default. It would churn every line of the maintained
  sources (a whole-tree mechanical diff), diverge from the upstream project this fork maintains
  and attributes, and make the source inconsistent with the four-space config byte contract the
  package itself writes and documents. No quality criterion in section 1.1 improves.

Chosen adjustment and why its scope is appropriate:
  One option, one value, recorded here and enforced by policy:check. printWidth and every other
  option follow the standard's block because no established convention exists for them.

Structural comparison or unsafe-type evidence, where applicable:
  Not applicable.

Verification commands, relevant tests, and results:
  npm run policy:check (accepts the guide formatter block only with tabWidth 4 and the recorded
  generated-file ownership) and npm run format:check; the qualification harness asserts misformatted
  sources fail and repeated formatting is stable.

Retained protection, lost detection, and established assumptions:
  Retained: every other formatter option at the standard's value, full formatting coverage, and
  the format gate. Lost detection: none — tabWidth is not a safety check. Assumption: the
  convention remains intentional; a deliberate switch to two spaces is a policy change that must
  update this record and .oxfmtrc.json together.

Review and revisit trigger:
  Any oxfmt upgrade, or a decision to rebase the repository's indentation onto the standard's
  default.
```

No other exceptions exist. Structural thresholds, the baseline rule set, and every other formatter
option are the standard's own values.
