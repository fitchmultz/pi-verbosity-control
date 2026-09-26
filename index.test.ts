import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock, type Mock } from "node:test";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import type { Api, Model } from "@earendil-works/pi-ai";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
    cycleVerbosity,
    getExactModelKey,
    loadConfig,
    patchPayloadVerbosity,
    resolveConfiguredVerbosity,
    saveConfig,
    type VerbosityConfig,
} from "./index.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let testHome = "";

before(async () => {
    testHome = await mkdtemp(path.join(os.tmpdir(), "pi-verbosity-control-test-"));
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
    process.env.PI_CODING_AGENT_DIR = path.join(testHome, "agent-config");
});

beforeEach(async () => {
    await rm(sdk.getAgentDir(), { recursive: true, force: true });
    await rm(path.join(testHome, ".pi"), { recursive: true, force: true });
});

after(async () => {
    await rm(testHome, { recursive: true, force: true });

    for (const [key, value] of Object.entries({
        HOME: originalHome, USERPROFILE: originalUserProfile, PI_CODING_AGENT_DIR: originalAgentDir,
    })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

async function waitFor(check: () => void): Promise<void> {
    const deadline = Date.now() + 1000;
    while (true) {
        try {
            return check();
        } catch (error) {
            if (Date.now() > deadline) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

function lastArgs(fn: Mock<(...args: never[]) => void>): unknown[] | undefined {
    return fn.mock.calls.at(-1)?.arguments;
}

function createModel(overrides?: Partial<Model<Api>>): Model<Api> {
    return {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
        contextWindow: 272000,
        maxTokens: 128000,
        ...overrides,
    };
}

describe("pi-verbosity-control helpers", () => {
    it("cycles verbosity in a loop", () => {
        assert.equal(cycleVerbosity(undefined), "low");
        assert.equal(cycleVerbosity("low"), "medium");
        assert.equal(cycleVerbosity("medium"), "high");
        assert.equal(cycleVerbosity("high"), "low");
    });

    it("prefers exact provider/model matches over bare model ids", () => {
        const model = createModel();
        const config: VerbosityConfig = {
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
                "openai-codex/gpt-5.4": "high",
            },
        };

        assert.deepEqual(resolveConfiguredVerbosity(config, model), {
            key: "openai-codex/gpt-5.4",
            verbosity: "high",
        });
    });

    it("patches payload text verbosity without dropping existing text fields", () => {
        const payload = {
            model: "gpt-5.4",
            text: {
                format: "plain",
            },
        };

        assert.deepEqual(patchPayloadVerbosity(payload, "low"), {
            model: "gpt-5.4",
            text: {
                format: "plain",
                verbosity: "low",
            },
        });
    });
});

function runLimitedShortcut(modelId: string): string {
    const child = spawnSync("bash", [
        "-c", 'ulimit -f 1; exec "$@"', "bash", process.execPath, "--input-type=module", "-e", `
            process.on("SIGXFSZ", () => {});
            const { default: extension } = await import(${JSON.stringify(pathToFileURL(path.resolve("index.ts")).href)});
            const shortcuts = new Map();
            extension({ on() {}, registerShortcut(key, { handler }) { shortcuts.set(key, handler); } });
            const ctx = {
                model: { provider: "openai", id: ${JSON.stringify(modelId)}, api: "openai-responses" },
                hasUI: true,
                ui: { setStatus() {}, notify(message) { console.log(message); } },
            };
            await shortcuts.get(${JSON.stringify(process.platform === "darwin" ? "alt+v" : "ctrl+alt+v")})(ctx);
        `,
    ], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
}

describe("pi-verbosity-control config io", () => {
    it("loads missing config as empty with hidden indicator", async () => {
        assert.deepEqual(await loadConfig(), { showIndicator: false, models: {} });
    });

    it("saves config with pretty JSON", async () => {
        const config: VerbosityConfig = {
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        };

        await saveConfig(config);

        await assert.rejects(readFile(path.join(testHome, ".pi/agent/verbosity.json"), "utf8"), { code: "ENOENT" });
        const raw = await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8");
        assert.equal(raw, `{
    "showIndicator": false,
    "models": {
        "gpt-5.4": "low"
    }
}\n`);
    });

    it("preserves the existing config when a shortcut write fails", { skip: process.platform === "win32" }, async () => {
        await saveConfig({ showIndicator: true, models: {} });
        const file = path.join(sdk.getAgentDir(), "verbosity.json");
        const before = await readFile(file, "utf8");

        assert.match(runLimitedShortcut("x".repeat(2048)), /Failed to save verbosity config: EFBIG/);
        assert.equal(await readFile(file, "utf8"), before);
    });

    it("saves a smaller config when the old file exceeds the file limit", { skip: process.platform === "win32" }, async () => {
        const file = path.join(sdk.getAgentDir(), "verbosity.json");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({
            showIndicator: false,
            models: { "gpt-5.4": "low" },
            ignored: "x".repeat(2048),
        }));

        assert.match(runLimitedShortcut("gpt-5.4"), /Verbosity for gpt-5\.4 → medium/);
        assert.deepEqual(await loadConfig(), { showIndicator: false, models: { "gpt-5.4": "medium" } });
    });

    it("saves through a symlink to a missing config file", { skip: process.platform === "win32" }, async () => {
        const agentDir = sdk.getAgentDir();
        const file = path.join(agentDir, "verbosity.json");
        const target = path.join(agentDir, "shared", "verbosity.json");
        await mkdir(path.dirname(target), { recursive: true });
        await symlink("shared/verbosity.json", file);
        const config: VerbosityConfig = { showIndicator: true, models: { "gpt-5.4": "high" } };

        await saveConfig(config);

        assert.equal(await readlink(file), "shared/verbosity.json");
        assert.deepEqual(JSON.parse(await readFile(target, "utf8")), config);
    });

    it("ignores invalid config values and keeps valid ones", async () => {
        const configPath = path.join(sdk.getAgentDir(), "verbosity.json");
        await mkdir(path.dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            `${JSON.stringify(
                {
                    showIndicator: true,
                    models: {
                        "gpt-5.4": "LOW",
                        "openai-codex/gpt-5.4": "banana",
                        "": "medium",
                    },
                },
                null,
                4,
            )}\n`,
            "utf8",
        );

        assert.deepEqual(await loadConfig(), {
            showIndicator: true,
            models: {
                "gpt-5.4": "low",
            },
        });
    });

    it("builds the expected exact model key", () => {
        assert.equal(getExactModelKey(createModel()), "openai-codex/gpt-5.4");
    });
});

async function createRuntime(config: VerbosityConfig) {
    await saveConfig(config);

    const { default: verbosityControlExtension } = await import("./index.ts");

    let sessionStartHandler: ((event: unknown, ctx: TestContext) => Promise<void> | void) | undefined;
    let sessionShutdownHandler: ((event: unknown, ctx: TestContext) => Promise<void> | void) | undefined;
    let modelSelectHandler: ((event: unknown, ctx: TestContext) => Promise<void> | void) | undefined;
    let beforeProviderRequestHandler: ((event: { payload: unknown }, ctx: TestContext) => unknown) | undefined;
    const shortcutHandlers = new Map<string, (ctx: TestContext) => Promise<void> | void>();

    const pi = {
        on: (event: string, handler: (event: unknown, ctx: TestContext) => Promise<void> | void) => {
            if (event === "session_start") {
                sessionStartHandler = handler;
            }
            if (event === "session_shutdown") {
                sessionShutdownHandler = handler;
            }
            if (event === "model_select") {
                modelSelectHandler = handler;
            }
            if (event === "before_provider_request") {
                beforeProviderRequestHandler = handler as (event: { payload: unknown }, ctx: TestContext) => unknown;
            }
        },
        registerShortcut: (shortcut: string, options: { handler: (ctx: TestContext) => Promise<void> | void }) => {
            shortcutHandlers.set(shortcut, options.handler);
        },
    };

    verbosityControlExtension(pi as never);

    const cycleShortcut = process.platform === "darwin" ? "alt+v" : "ctrl+alt+v";
    const toggleIndicatorShortcut = process.platform === "darwin" ? "alt+shift+v" : "ctrl+alt+shift+v";
    const cycleShortcutHandler = shortcutHandlers.get(cycleShortcut);
    const toggleIndicatorShortcutHandler = shortcutHandlers.get(toggleIndicatorShortcut);

    if (
        !sessionStartHandler ||
        !sessionShutdownHandler ||
        !beforeProviderRequestHandler ||
        !cycleShortcutHandler ||
        !toggleIndicatorShortcutHandler
    ) {
        throw new Error("Extension did not register expected handlers");
    }

    return {
        sessionStartHandler,
        sessionShutdownHandler,
        modelSelectHandler: (event: unknown, ctx: TestContext) => {
            if (!modelSelectHandler) throw new Error("Missing model_select handler");
            return modelSelectHandler(event, ctx);
        },
        beforeProviderRequestHandler,
        cycleShortcutHandler,
        toggleIndicatorShortcutHandler,
    };
}

type TestContext = {
    hasUI: boolean;
    model: Model<Api> | undefined;
    ui: {
        notify: Mock<(message: string, level?: string) => void>;
        setStatus: Mock<(key: string, value: string | undefined) => void>;
    };
};

function createContext(model: Model<Api>): TestContext {
    return { hasUI: true, model, ui: { notify: mock.fn(), setStatus: mock.fn() } };
}

// Checkpoints are a fork capability; upstream SDK types do not declare them.
type SessionCheckpoint = NonNullable<Parameters<typeof sdk.createAgentSession>[0]> extends { checkpoint?: infer C }
    ? Exclude<C, undefined>
    : never;
type CheckpointHold = {
    sleepReady: boolean;
    sleepBlockers: unknown[];
    checkpoint: SessionCheckpoint;
    signal: AbortSignal;
    release(): void;
};
type CheckpointSession = sdk.AgentSession & {
    acquireCheckpoint(options: { quiesce: () => () => void; signal?: AbortSignal }): Promise<CheckpointHold>;
    cancelCheckpoint?(): void;
    extensionRunner: { checkpointActivity: { run<T>(callback: () => T): T } };
};

// Optional on older hosts, mandatory in the designated native CI lane.
const hasCheckpoint = "acquireCheckpoint" in sdk.AgentSession.prototype;
if ((process.env.PI_COMPAT_HOST === "fork" || process.env.PI_REQUIRE_CHECKPOINT === "1") && !hasCheckpoint) {
    throw new Error("Fork qualification requires AgentSession.acquireCheckpoint; native tests must not skip");
}
const nativeStatuses = new WeakMap<sdk.AgentSession, Map<string, string>>();

// No provider calls: use an empty credential store, disable discovery/network, and
// invoke the existing request hook with a synthetic payload to observe active state.
async function start(checkpoint?: SessionCheckpoint): Promise<CheckpointSession> {
    const cwd = path.join(testHome, "workspace");
    const agentDir = sdk.getAgentDir();
    await mkdir(cwd, { recursive: true });
    const settingsManager = sdk.SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false },
    });
    const resourceLoader = new sdk.DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true,
        noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [path.resolve("index.ts")],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(resourceLoader.getExtensions().extensions.length, 1);
    const model = createModel({ provider: "checkpoint-test", api: "openai-responses", baseUrl: "http://127.0.0.1:1" });
    const modelsPath = path.join(agentDir, "models.json");
    await mkdir(agentDir, { recursive: true });
    await writeFile(modelsPath, JSON.stringify({ providers: { "checkpoint-test": {
        baseUrl: model.baseUrl, api: model.api, apiKey: "synthetic-not-a-credential", models: [model],
    } } }));
    const modelRuntime = await sdk.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath,
        allowModelNetwork: false, refreshOnCreate: false,
    });
    const { session } = await sdk.createAgentSession({
        cwd, agentDir, settingsManager, resourceLoader, modelRuntime,
        model, tools: [], ...(checkpoint === undefined ? {} : { checkpoint }),
    });
    const statuses = new Map<string, string>();
    nativeStatuses.set(session, statuses);
    await session.bindExtensions({
        mode: "tui",
        uiContext: {
            ...session.extensionRunner.createContext().ui,
            setStatus: (key, value) => {
                if (value === undefined) statuses.delete(key);
                else statuses.set(key, value);
            },
        },
        onError: (error) => { throw new Error(error.error); },
    });
    return session as CheckpointSession;
}

async function close(session: CheckpointSession) {
    session.cancelCheckpoint?.();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
}

async function receipt(session: CheckpointSession) {
    const hold = await session.acquireCheckpoint({
        quiesce: () => () => {}, signal: AbortSignal.timeout(2000),
    });
    try {
        return { sleepReady: hold.sleepReady, blockers: hold.sleepBlockers, checkpoint: hold.checkpoint };
    } finally {
        hold.release();
    }
}

async function shortcut(session: CheckpointSession, toggle = false) {
    const key = process.platform === "darwin"
        ? (toggle ? "alt+shift+v" : "alt+v")
        : (toggle ? "ctrl+alt+shift+v" : "ctrl+alt+v");
    const handler = session.extensionRunner.getShortcuts({}).get(key)!.handler;
    // Use native callback ownership, as an SDK host must for shortcut dispatch.
    return session.extensionRunner.checkpointActivity.run(() => handler(session.extensionRunner.createContext()));
}

async function activeVerbosity(session: sdk.AgentSession) {
    const payload = await session.extensionRunner.emitBeforeProviderRequest({ text: { format: "plain" } });
    return (payload as { text: { verbosity?: string } }).text.verbosity;
}

function footer(session: sdk.AgentSession) {
    sdk.initTheme("dark");
    return new FooterComponent(session, {
        getGitBranch: () => null, getExtensionStatuses: () => nativeStatuses.get(session)!,
        getAvailableProviderCount: () => 1, onBranchChange: () => () => {},
    }).render(160).join("\n");
}

describe("native official/fork baseline", () => {
    it("loads through the native loader, publishes stock-footer status, and reconciles config on reload", async () => {
        await saveConfig({ showIndicator: true, models: { "gpt-5.4": "low" } });
        const originalRender = FooterComponent.prototype.render;
        const session = await start();
        try {
            const payload = await session.extensionRunner.emitBeforeProviderRequest({ text: { format: "plain" } });
            assert.deepEqual(payload, { text: { format: "plain", verbosity: "low" } });
            assert.equal(nativeStatuses.get(session)?.get("verbosity"), "🗣  low");
            assert.equal(FooterComponent.prototype.render, originalRender);
            assert.ok(footer(session).includes("🗣 low"));
            for (const width of [40, 80, 160]) {
                const component = new FooterComponent(session, {
                    getGitBranch: () => null, getExtensionStatuses: () => nativeStatuses.get(session)!,
                    getAvailableProviderCount: () => 1, onBranchChange: () => () => {},
                });
                assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
            }
            await session.setModel(createModel({ id: "unsupported", provider: "checkpoint-test", api: "anthropic-messages" }));
            assert.equal(nativeStatuses.get(session)?.has("verbosity"), false);
            assert.equal(await activeVerbosity(session), undefined);
            await session.setModel(createModel({ provider: "checkpoint-test", api: "openai-responses" }));
            assert.equal(nativeStatuses.get(session)?.get("verbosity"), "🗣  low");
            await saveConfig({ showIndicator: false, models: { "gpt-5.4": "high" } });
            await session.reload();
            assert.equal(await activeVerbosity(session), "high");
            assert.ok(!footer(session).includes("🗣"));
            assert.equal(FooterComponent.prototype.render, originalRender);
        } finally { await close(session); }
        assert.equal(FooterComponent.prototype.render, originalRender);
    });
});

describe("native checkpoints", { skip: !hasCheckpoint }, () => {
    it("qualifies persisted idle state and reconstructs verbosity and indicator from the existing file", async () => {
        await saveConfig({ showIndicator: false, models: { "gpt-5.4": "low" } });
        const originalRender = FooterComponent.prototype.render;
        const session = await start();
        let checkpoint: SessionCheckpoint;
        try {
            await shortcut(session);
            await shortcut(session, true);
            assert.equal(await activeVerbosity(session), "medium");
            assert.ok(footer(session).includes("🗣 medium"));
            const before = await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8");
            const result = await receipt(session);
            assert.deepEqual(result.blockers, []);
            assert.equal(result.sleepReady, true);
            assert.equal(await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8"), before);
            checkpoint = result.checkpoint;
        } finally { await close(session); }
        assert.equal(FooterComponent.prototype.render, originalRender);
        const restored = await start(checkpoint);
        try {
            assert.equal(await activeVerbosity(restored), "medium");
            assert.ok(footer(restored).includes("🗣 medium"));
            assert.equal((await receipt(restored)).sleepReady, true);
        } finally { await close(restored); }
        assert.equal(FooterComponent.prototype.render, originalRender);
    });

    it("keeps malformed or unreadable config out of active state and blocks sleep", async () => {
        const config = { showIndicator: true, models: { "gpt-5.4": "high" as const } };
        await saveConfig(config);
        const session = await start();
        const file = path.join(sdk.getAgentDir(), "verbosity.json");
        try {
            await writeFile(file, '{"models":');
            assert.equal(await activeVerbosity(session), "high");
            assert.equal(nativeStatuses.get(session)?.get("verbosity"), "🗣  high");
            assert.equal((await receipt(session)).sleepReady, false);
            assert.equal(await readFile(file, "utf8"), '{"models":');
            await rm(file);
            await mkdir(file);
            assert.equal((await receipt(session)).sleepReady, false);
            await rm(file, { recursive: true });
            await saveConfig(config);
            assert.equal(await activeVerbosity(session), "high");
            assert.equal((await receipt(session)).sleepReady, true);
        } finally { await close(session); }
    });

    it("invalidates a held receipt before applying a changed file snapshot", async () => {
        await saveConfig({ showIndicator: true, models: { "gpt-5.4": "high" } });
        const session = await start();
        const hold = await session.acquireCheckpoint({ quiesce: () => () => {} });
        try {
            assert.equal(hold.sleepReady, true);
            // Semantically identical writes must not invalidate a reconstructible receipt.
            const replacement = path.join(sdk.getAgentDir(), "replacement.json");
            await writeFile(replacement, '{"models":{"gpt-5.4":"HIGH"},"showIndicator":true}');
            await rename(replacement, path.join(sdk.getAgentDir(), "verbosity.json"));
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(hold.signal.aborted, false);
            await saveConfig({ showIndicator: true, models: { "gpt-5.4": "low" } });
            await waitFor(() => assert.equal(hold.signal.aborted, true));
            assert.equal(nativeStatuses.get(session)?.get("verbosity"), "🗣  low");
            assert.equal(await activeVerbosity(session), "low");
            assert.equal((await receipt(session)).sleepReady, true);
        } finally { hold.release(); await close(session); }
    });

    it("accepts missing defaults and semantic equality but not malformed fallback defaults", async () => {
        const session = await start();
        const file = path.join(sdk.getAgentDir(), "verbosity.json");
        try {
            assert.equal((await receipt(session)).sleepReady, true);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, "{");
            assert.equal((await receipt(session)).sleepReady, false);
            await writeFile(file, '{"models": {}, "showIndicator": false, "ignored": true}');
            assert.equal((await receipt(session)).sleepReady, true);
        } finally { await close(session); }
    });

    it("reconciles external edits before sleep and recreates status ownership on reload", async () => {
        await saveConfig({ showIndicator: true, models: { "gpt-5.4": "high", "another-model": "low" } });
        const originalRender = FooterComponent.prototype.render;
        const session = await start();
        const file = path.join(sdk.getAgentDir(), "verbosity.json");
        try {
            await writeFile(file, '{"models":{"another-model":"LOW","gpt-5.4":"HIGH"},"showIndicator":true}');
            assert.equal((await receipt(session)).sleepReady, true);
            const changed = '{"showIndicator":false,"models":{"gpt-5.4":"low"}}';
            await writeFile(file, changed);
            await waitFor(() => assert.equal(nativeStatuses.get(session)?.has("verbosity"), false));
            assert.equal(await activeVerbosity(session), "low");
            assert.equal((await receipt(session)).sleepReady, true);
            await session.reload();
            assert.equal(await activeVerbosity(session), "low");
            assert.equal(FooterComponent.prototype.render, originalRender);
            assert.ok(!footer(session).includes("🗣"));
            assert.equal((await receipt(session)).sleepReady, true);
            assert.equal(await readFile(file, "utf8"), changed);
        } finally { await close(session); }
    });

    it("keeps failed shortcut writes out of active state and blocks unrecoverable file state", async () => {
        await saveConfig({ showIndicator: true, models: { "gpt-5.4": "high" } });
        const session = await start();
        const file = path.join(sdk.getAgentDir(), "verbosity.json");
        try {
            // Keep the fixture transition in one turn: a real deletion would reset settings before EISDIR.
            rmSync(file);
            mkdirSync(file); // Real EISDIR failure, not mocked saveConfig.
            await shortcut(session);
            await shortcut(session, true);
            assert.equal(await activeVerbosity(session), "high");
            assert.ok(footer(session).includes("🗣 high"));
            assert.equal((await receipt(session)).sleepReady, false);
        } finally { await close(session); }
    });

    it("native ownership defers acquisition until the returned callback has finished", async () => {
        await saveConfig({ showIndicator: false, models: { "gpt-5.4": "low" } });
        const session = await start();
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => { finish = resolve; });
        const callback = session.extensionRunner.checkpointActivity.run(async () => {
            await shortcut(session);
            await gate;
        });
        try {
            const cancel = new AbortController();
            const pending = session.acquireCheckpoint({ quiesce: () => () => {}, signal: cancel.signal });
            let acquired = false;
            void pending.then(() => { acquired = true; }, () => {});
            await new Promise((resolve) => setTimeout(resolve, 40));
            assert.equal(acquired, false);
            cancel.abort();
            await assert.rejects(pending, /Checkpoint cancelled/);
            finish();
            await callback;
            assert.equal((await receipt(session)).sleepReady, true);
        } finally { finish(); await callback; await close(session); }
    });
});

describe("pi-verbosity-control runtime", () => {
    for (const shortcut of ["cycleShortcutHandler", "toggleIndicatorShortcutHandler"] as const) {
        it(`${shortcut} preserves malformed config and reports the save failure`, async () => {
            const config: VerbosityConfig = { showIndicator: false, models: { "gpt-5.4": "high" } };
            const runtime = await createRuntime(config);
            const ctx = createContext(createModel());
            const file = path.join(sdk.getAgentDir(), "verbosity.json");
            const malformed = '{"showIndicator":false,"models":{"gpt-5.4":"high",}}';
            await writeFile(file, malformed);
            await runtime.sessionStartHandler({}, ctx);
            try {
                await runtime[shortcut](ctx);
                assert.equal(await readFile(file, "utf8"), malformed);
                const [message, level] = lastArgs(ctx.ui.notify) as [string, string];
                assert.match(message, /^Failed to save verbosity config:/);
                assert.equal(level, "error");
                await saveConfig(config);
                await runtime[shortcut](ctx);
                assert.equal(lastArgs(ctx.ui.notify)?.[1], "info");
                assert.deepEqual(await loadConfig(), shortcut === "cycleShortcutHandler"
                    ? { ...config, models: { "gpt-5.4": "low" } }
                    : { ...config, showIndicator: true });
            } finally {
                await runtime.sessionShutdownHandler({}, ctx);
            }
        });
    }

    it("waits for another process's lock and reads its changes before saving", async () => {
        await saveConfig({ showIndicator: false, models: { "gpt-5.4": "low" } });
        let release: (() => Promise<void>) | undefined = await lockfile.lock(
            path.join(sdk.getAgentDir(), "verbosity.json"), { realpath: false },
        );
        const child = spawn(process.execPath, ["--input-type=module", "-e", `
            import extension from ${JSON.stringify(pathToFileURL(path.resolve("index.ts")).href)};
            let cycle;
            extension({
                on() {},
                registerShortcut(key, options) {
                    if (key === ${JSON.stringify(process.platform === "darwin" ? "alt+v" : "ctrl+alt+v")}) cycle = options.handler;
                },
            });
            const saving = cycle({
                model: { id: "gpt-5.4", provider: "openai", api: "openai-responses" },
                hasUI: false,
                ui: { setStatus() {} },
            });
            process.send("started");
            await saving;
            process.disconnect();
        `], { stdio: ["ignore", "ignore", "inherit", "ipc"], env: process.env });
        const exited = once(child, "exit");
        try {
            assert.deepEqual(await once(child, "message"), ["started", undefined]);
            await saveConfig({ showIndicator: true, models: { "gpt-5.4": "low", "other-model": "high" } });
            await release();
            release = undefined;
            assert.deepEqual(await exited, [0, null]);
            assert.deepEqual(await loadConfig(), {
                showIndicator: true, models: { "gpt-5.4": "medium", "other-model": "high" },
            });
        } finally {
            await release?.();
            if (child.exitCode === null) {
                child.kill();
                await exited;
            }
        }
    });

    it("serializes shortcuts through symlink aliases of one config", { skip: process.platform === "win32" }, async () => {
        const config: VerbosityConfig = { showIndicator: false, models: { "gpt-5.4": "low" } };
        const target = path.join(testHome, "shared", "verbosity.json");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify(config));
        const directories = ["first", "second"].map((name) => path.join(testHome, `agent-${name}`));
        for (const dir of directories) {
            await mkdir(dir);
            await symlink(target, path.join(dir, "verbosity.json"));
        }

        const originalDir = process.env.PI_CODING_AGENT_DIR!;
        const runtimes = [];
        try {
            for (const dir of directories) {
                process.env.PI_CODING_AGENT_DIR = dir;
                runtimes.push(await createRuntime(config));
            }
        } finally {
            process.env.PI_CODING_AGENT_DIR = originalDir;
        }
        const [first, second] = runtimes;
        const a = createContext(createModel());
        const b = createContext(createModel());
        try {
            await first.sessionStartHandler({}, a);
            await second.sessionStartHandler({}, b);
            await Promise.all([first.cycleShortcutHandler(a), second.cycleShortcutHandler(b)]);
            assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
                showIndicator: false, models: { "gpt-5.4": "high" },
            });
            assert.deepEqual(
                [lastArgs(a.ui.notify)?.[0], lastArgs(b.ui.notify)?.[0]].sort(),
                ["Verbosity for gpt-5.4 → high", "Verbosity for gpt-5.4 → medium"],
            );
        } finally {
            await first.sessionShutdownHandler({}, a);
            await second.sessionShutdownHandler({}, b);
        }
    });

    for (const { name, secondModel, toggle, models, showIndicator } of [
        { name: "different models", secondModel: "gpt-5.3-codex", toggle: false, models: { "gpt-5.4": "medium", "gpt-5.3-codex": "medium" }, showIndicator: false },
        { name: "the same model", secondModel: "gpt-5.4", toggle: false, models: { "gpt-5.4": "high", "gpt-5.3-codex": "low" }, showIndicator: false },
        { name: "a model and the indicator", secondModel: "gpt-5.4", toggle: true, models: { "gpt-5.4": "medium", "gpt-5.3-codex": "low" }, showIndicator: true },
    ]) {
        it(`preserves concurrent changes to ${name}`, async () => {
            const config: VerbosityConfig = {
                showIndicator: false,
                models: { "gpt-5.4": "low", "gpt-5.3-codex": "low" },
            };
            const first = await createRuntime(config);
            const second = await createRuntime(config);
            const a = createContext(createModel());
            const b = createContext(createModel({ id: secondModel }));
            await first.sessionStartHandler({}, a);
            await second.sessionStartHandler({}, b);
            try {
                await Promise.all([
                    first.cycleShortcutHandler(a),
                    toggle ? second.toggleIndicatorShortcutHandler(b) : second.cycleShortcutHandler(b),
                ]);
                assert.deepEqual(await loadConfig(), { models, showIndicator });
                assert.equal(lastArgs(a.ui.notify)?.[1], "info");
                assert.equal(lastArgs(b.ui.notify)?.[1], "info");
            } finally {
                await first.sessionShutdownHandler({}, a);
                await second.sessionShutdownHandler({}, b);
            }
        });
    }

    it("keeps status and requests in sync across external edits, shortcuts, model changes and shutdown", async () => {
        const runtime = await createRuntime({
            showIndicator: true,
            models: { "gpt-5.4": "low", "openai-codex/gpt-5.4": "high" },
        });
        const ctx = createContext(createModel());
        const status = () => lastArgs(ctx.ui.setStatus);
        const payload = { stream: true, text: { format: "plain" } };
        const request = () => runtime.beforeProviderRequestHandler({ payload }, ctx);
        await runtime.sessionStartHandler({}, ctx);
        try {
            assert.deepEqual(status(), ["verbosity", "🗣  high"]);
            assert.deepEqual(request(), { ...payload, text: { format: "plain", verbosity: "high" } });

            await runtime.cycleShortcutHandler(ctx);
            assert.deepEqual(status(), ["verbosity", "🗣  low"]);
            assert.partialDeepStrictEqual(request(), { text: { verbosity: "low" } });
            await runtime.toggleIndicatorShortcutHandler(ctx);
            assert.deepEqual(status(), ["verbosity", undefined]);
            assert.partialDeepStrictEqual(request(), { text: { verbosity: "low" } });

            const replacement = path.join(sdk.getAgentDir(), "replacement.json");
            await writeFile(replacement, JSON.stringify({ showIndicator: true, models: { "gpt-5.4": "medium" } }));
            await rename(replacement, path.join(sdk.getAgentDir(), "verbosity.json"));
            await waitFor(() => assert.deepEqual(status(), ["verbosity", "🗣  medium"]));
            assert.partialDeepStrictEqual(request(), { text: { verbosity: "medium" } });

            // A native request boundary must refresh even before fs.watch is delivered.
            writeFileSync(path.join(sdk.getAgentDir(), "verbosity.json"), '{"showIndicator":true,"models":{"gpt-5.4":"high"}}');
            assert.partialDeepStrictEqual(request(), { text: { verbosity: "high" } });
            assert.deepEqual(status(), ["verbosity", "🗣  high"]);
            await runtime.cycleShortcutHandler(ctx);
            assert.deepEqual(status(), ["verbosity", "🗣  low"]);

            for (const model of [createModel({ api: "anthropic-messages" }), createModel({ id: "unconfigured" }), undefined]) {
                ctx.model = model;
                await runtime.modelSelectHandler({}, ctx);
                assert.deepEqual(status(), ["verbosity", undefined]);
                assert.equal(request(), undefined);
            }
            ctx.model = createModel({ provider: "another-provider", api: "azure-openai-responses" });
            await runtime.modelSelectHandler({}, ctx);
            assert.deepEqual(status(), ["verbosity", "🗣  low"]);
            assert.partialDeepStrictEqual(request(), { text: { verbosity: "low" } });
        } finally {
            await runtime.sessionShutdownHandler({}, ctx);
        }
        assert.deepEqual(status(), ["verbosity", undefined]);
        const calls = ctx.ui.setStatus.mock.callCount();
        await saveConfig({ showIndicator: true, models: { "gpt-5.4": "high" } });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(ctx.ui.setStatus.mock.callCount(), calls);
    });

    for (const handler of ["cycleShortcutHandler", "toggleIndicatorShortcutHandler"] as const) {
        it(`does not republish status when ${handler} finishes after shutdown`, async () => {
            const runtime = await createRuntime({ showIndicator: true, models: { "gpt-5.4": "low" } });
            const ctx = createContext(createModel());
            await runtime.sessionStartHandler({}, ctx);
            const saving = runtime[handler](ctx);
            await runtime.sessionShutdownHandler({}, ctx);
            const calls = ctx.ui.setStatus.mock.callCount();
            await saving;
            assert.deepEqual(lastArgs(ctx.ui.setStatus), ["verbosity", undefined]);
            assert.equal(ctx.ui.setStatus.mock.callCount(), calls);
        });
    }

    it("patches requests for configured models after session start", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const ctx = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);

        const patched = runtime.beforeProviderRequestHandler(
            {
                payload: {
                    model: "gpt-5.4",
                    stream: true,
                },
            },
            ctx,
        );

        assert.deepEqual(patched, {
            model: "gpt-5.4",
            stream: true,
            text: {
                verbosity: "low",
            },
        });

        await runtime.sessionShutdownHandler({}, ctx);
    });

    for (const { provider, api, id } of [
        { provider: "openai", api: "openai-responses", id: "gpt-4.1" },
        { provider: "openai", api: "openai-responses", id: "gpt-4o-mini" },
        { provider: "openai", api: "openai-responses", id: "o3" },
        { provider: "azure-openai-responses", api: "azure-openai-responses", id: "gpt-4.1" },
    ] as const) {
        it(`leaves ${provider}/${id} requests unchanged when verbosity is unsupported`, async () => {
            const config: VerbosityConfig = { showIndicator: true, models: {} };
            const runtime = await createRuntime(config);
            const ctx = createContext(createModel({ provider, api, id }));
            await runtime.sessionStartHandler({}, ctx);
            try {
                await runtime.cycleShortcutHandler(ctx);
                assert.deepEqual(lastArgs(ctx.ui.notify), [`Verbosity control is not supported for ${provider}/${id}.`, "warning"]);
                assert.deepEqual(await loadConfig(), config);

                await saveConfig({ showIndicator: true, models: { [id]: "low" } });
                assert.equal(runtime.beforeProviderRequestHandler({ payload: { model: id } }, ctx), undefined);
                assert.deepEqual(lastArgs(ctx.ui.setStatus), ["verbosity", undefined]);
            } finally {
                await runtime.sessionShutdownHandler({}, ctx);
            }
        });
    }

    it("cycles and persists the current model setting from the shortcut", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const ctx = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);
        await runtime.cycleShortcutHandler(ctx);

        const saved = JSON.parse(await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8")) as {
            showIndicator: boolean;
            models: Record<string, string>;
        };

        assert.equal(saved.showIndicator, false);
        assert.equal(saved.models["gpt-5.4"], "medium");
        assert.deepEqual(lastArgs(ctx.ui.notify), ["Verbosity for gpt-5.4 → medium", "info"]);

        await runtime.sessionShutdownHandler({}, ctx);
    });

    it("toggles indicator visibility and persists it", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const ctx = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);
        await runtime.toggleIndicatorShortcutHandler(ctx);

        const saved = JSON.parse(await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8")) as {
            showIndicator: boolean;
            models: Record<string, string>;
        };

        assert.equal(saved.showIndicator, true);
        assert.equal(saved.models["gpt-5.4"], "low");
        assert.deepEqual(lastArgs(ctx.ui.notify), ["Verbosity indicator shown.", "info"]);

        await runtime.sessionShutdownHandler({}, ctx);
    });

    it("publishes native status without patching the footer and clears it on shutdown", async () => {
        const runtime = await createRuntime({
            showIndicator: true,
            models: {
                "gpt-5.4": "low",
            },
        });
        const ctx = createContext(createModel());
        const originalRender = FooterComponent.prototype.render;

        await runtime.sessionStartHandler({}, ctx);
        assert.deepEqual(lastArgs(ctx.ui.setStatus), ["verbosity", "🗣  low"]);
        assert.equal(FooterComponent.prototype.render, originalRender);

        await runtime.sessionShutdownHandler({}, ctx);
        assert.deepEqual(lastArgs(ctx.ui.setStatus), ["verbosity", undefined]);
        assert.equal(FooterComponent.prototype.render, originalRender);
    });
});
