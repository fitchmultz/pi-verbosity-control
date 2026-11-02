/**
 * The recorded policy baseline for `npm run policy:check`. The normative configuration lives in
 * the adopted standard copy (`docs/quality/strict-oxlint-oxfmt-5.1.2.md`); this file records
 * what the repository itself decides: the recorded allowance, the authorized directive
 * inventory, the source-profile mapping, and the tool versions the configuration was qualified
 * against. Evidence for the allowance lives in `docs/quality/quality-exceptions.md` and is
 * exercised by `npm run quality:probes`.
 */
export const sourceProfiles = {
    standard: "Strict Oxlint and Oxfmt Engineering Standard v5.1.2",
    /** Installed toolchain, verified current against the public registry on 2026-11-01 (section 5.1). */
    toolFloors: {
        oxlint: "1.90.0",
        "oxlint-tsgolint": "7.0.2005",
        oxfmt: "0.75.0",
        "oxc-parser": "0.156.0",
    },
    /** Compiler options that must stay enabled project-wide (section 4.2). */
    requiredCompilerOptions: [
        "strict",
        "noImplicitReturns",
        "noFallthroughCasesInSwitch",
        "noImplicitOverride",
        "noUncheckedIndexedAccess",
        "exactOptionalPropertyTypes",
        "noUncheckedSideEffectImports",
        "forceConsistentCasingInFileNames",
    ],
    /** Required when maintained JavaScript exists (section 4.2). */
    requiredJavaScriptOptions: ["allowJs", "checkJs"],
    /** Repository inventory mapped to the standard's source profiles (section 4.1). */
    profiles: [
        {
            profile: "production",
            globs: ["index.ts", "scripts/**/*.ts"],
        },
        {
            profile: "tests",
            globs: ["index.test.ts", "tests/**/*.ts"],
        },
    ],
} as const;

/** The node:test registration allowance recorded as QX-001; options do not inherit. */
export const qualityExceptions = [
    {
        id: "QX-001",
        rule: "typescript/no-floating-promises",
        options: [
            "error",
            {
                checkThenables: true,
                ignoreIIFE: false,
                ignoreVoid: false,
                allowForKnownSafeCalls: [
                    {
                        from: "package",
                        package: "@types/node",
                        name: ["nodeDescribe", "nodeIt"],
                    },
                ],
                allowForKnownSafePromises: [],
            },
        ],
    },
] as const;

/** Recorded formatter mappings: QX-003's preserved indentation plus generated-file ownership. */
export const formatMappings = {
    /** QX-003: the preserved repository indentation. */
    tabWidth: 4,
    /** The release automation writes CHANGELOG.md and owns those bytes (standard section 7.1). */
    ignorePatterns: ["CHANGELOG.md"],
} as const;

/**
 * Every suppression directive authorized by a recorded exception (section 2.4). Each entry is a
 * stable selector: file, rule, and exception id; the directive's reason must name the id.
 */
export const authorizedDirectives = [
    {
        file: "index.test.ts",
        rule: "typescript/unbound-method",
        id: "QX-002",
        count: 2,
    },
] as const;
