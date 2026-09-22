import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    cycleVerbosity,
    getExactModelKey,
    loadConfig,
    patchPayloadVerbosity,
    resolveConfiguredVerbosity,
    saveConfig,
    type VerbosityConfig,
} from "./index.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let testHome = "";

beforeAll(async () => {
    testHome = await mkdtemp(path.join(os.tmpdir(), "pi-verbosity-control-test-"));
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
    process.env.PI_CODING_AGENT_DIR = path.join(testHome, "agent-config");
});

beforeEach(async () => {
    await rm(sdk.getAgentDir(), { recursive: true, force: true });
    await rm(path.join(testHome, ".pi"), { recursive: true, force: true });
});

afterAll(async () => {
    await rm(testHome, { recursive: true, force: true });

    for (const [key, value] of Object.entries({
        HOME: originalHome, USERPROFILE: originalUserProfile, PI_CODING_AGENT_DIR: originalAgentDir,
    })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

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
        expect(cycleVerbosity(undefined)).toBe("low");
        expect(cycleVerbosity("low")).toBe("medium");
        expect(cycleVerbosity("medium")).toBe("high");
        expect(cycleVerbosity("high")).toBe("low");
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

        expect(resolveConfiguredVerbosity(config, model)).toEqual({
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

        expect(patchPayloadVerbosity(payload, "low")).toEqual({
            model: "gpt-5.4",
            text: {
                format: "plain",
                verbosity: "low",
            },
        });
    });


});

describe("pi-verbosity-control config io", () => {
    it("loads missing config as empty with hidden indicator", async () => {
        await expect(loadConfig()).resolves.toEqual({ showIndicator: false, models: {} });
    });

    it("saves config with pretty JSON", async () => {
        const config: VerbosityConfig = {
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        };

        await saveConfig(config);

        await expect(readFile(path.join(testHome, ".pi/agent/verbosity.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        const raw = await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8");
        expect(raw).toBe(`{
    "showIndicator": false,
    "models": {
        "gpt-5.4": "low"
    }
}\n`);
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

        await expect(loadConfig()).resolves.toEqual({
            showIndicator: true,
            models: {
                "gpt-5.4": "low",
            },
        });
    });

    it("builds the expected exact model key", () => {
        expect(getExactModelKey(createModel())).toBe("openai-codex/gpt-5.4");
    });
});

async function createRuntime(config: VerbosityConfig) {
    await saveConfig(config);

    const { default: verbosityControlExtension } = await import("./index.js");

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
        notify: (message: string, level?: string) => void;
        setStatus: (key: string, value: string | undefined) => void;
    };
};

function createContext(model: Model<Api>): {
    ctx: TestContext;
    notifyMock: ReturnType<typeof vi.fn>;
} {
    const notifyMock = vi.fn();

    return {
        ctx: {
            hasUI: true,
            model,
            ui: {
                notify: notifyMock,
                setStatus: vi.fn(),
            },
        },
        notifyMock,
    };
}

// Optional on older hosts, mandatory in the designated native CI lane.
const hasCheckpoint = typeof sdk.AgentSession.prototype.acquireCheckpoint === "function";
if ((process.env.PI_COMPAT_HOST === "fork" || process.env.PI_REQUIRE_CHECKPOINT === "1") && !hasCheckpoint) {
    throw new Error("Fork qualification requires AgentSession.acquireCheckpoint; native tests must not skip");
}
const nativeStatuses = new WeakMap<sdk.AgentSession, Map<string, string>>();

// No provider calls: use an empty credential store, disable discovery/network, and
// invoke the existing request hook with a synthetic payload to observe active state.
    async function start(checkpoint?: sdk.SessionCheckpoint) {
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
        expect(resourceLoader.getExtensions().errors).toEqual([]);
        expect(resourceLoader.getExtensions().extensions).toHaveLength(1);
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
            model, tools: [], checkpoint,
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
        return session;
    }

    async function close(session: sdk.AgentSession) {
        session.cancelCheckpoint?.();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
    }

    async function receipt(session: sdk.AgentSession) {
        const hold = await session.acquireCheckpoint({
            quiesce: () => () => {}, signal: AbortSignal.timeout(2000),
        });
        try {
            return { sleepReady: hold.sleepReady, blockers: hold.sleepBlockers, checkpoint: hold.checkpoint };
        } finally {
            hold.release();
        }
    }

    async function shortcut(session: sdk.AgentSession, toggle = false) {
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
            expect(payload).toEqual({ text: { format: "plain", verbosity: "low" } });
            expect(nativeStatuses.get(session)?.get("verbosity")).toBe("🗣  low");
            expect(FooterComponent.prototype.render).toBe(originalRender);
            expect(footer(session)).toContain("🗣 low");
            for (const width of [40, 80, 160]) {
                const component = new FooterComponent(session, {
                    getGitBranch: () => null, getExtensionStatuses: () => nativeStatuses.get(session)!,
                    getAvailableProviderCount: () => 1, onBranchChange: () => () => {},
                });
                expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
            }
            await session.setModel(createModel({ id: "unsupported", provider: "checkpoint-test", api: "anthropic-messages" }));
            expect(nativeStatuses.get(session)?.has("verbosity")).toBe(false);
            expect(await activeVerbosity(session)).toBeUndefined();
            await session.setModel(createModel({ provider: "checkpoint-test", api: "openai-responses" }));
            expect(nativeStatuses.get(session)?.get("verbosity")).toBe("🗣  low");
            await saveConfig({ showIndicator: false, models: { "gpt-5.4": "high" } });
            await session.reload();
            expect(await activeVerbosity(session)).toBe("high");
            expect(footer(session)).not.toContain("🗣");
            expect(FooterComponent.prototype.render).toBe(originalRender);
        } finally { await close(session); }
        expect(FooterComponent.prototype.render).toBe(originalRender);
    });
});

describe.skipIf(!hasCheckpoint)("native checkpoints", () => {
    it("qualifies persisted idle state and reconstructs verbosity and indicator from the existing file", async () => {
        await saveConfig({ showIndicator: false, models: { "gpt-5.4": "low" } });
        const originalRender = FooterComponent.prototype.render;
        const session = await start();
        let checkpoint: sdk.SessionCheckpoint;
        try {
            await shortcut(session);
            await shortcut(session, true);
            expect(await activeVerbosity(session)).toBe("medium");
            expect(footer(session)).toContain("🗣 medium");
            const before = await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8");
            const result = await receipt(session);
            expect(result.blockers).toEqual([]);
            expect(result.sleepReady).toBe(true);
            expect(await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8")).toBe(before);
            checkpoint = result.checkpoint;
        } finally { await close(session); }
        expect(FooterComponent.prototype.render).toBe(originalRender);
        const restored = await start(checkpoint!);
        try {
            expect(await activeVerbosity(restored)).toBe("medium");
            expect(footer(restored)).toContain("🗣 medium");
            expect((await receipt(restored)).sleepReady).toBe(true);
        } finally { await close(restored); }
        expect(FooterComponent.prototype.render).toBe(originalRender);
    });

    it("keeps malformed or unreadable config out of active state and blocks sleep", async () => {
        const config = { showIndicator: true, models: { "gpt-5.4": "high" as const } };
        await saveConfig(config);
        const session = await start();
        const file = path.join(sdk.getAgentDir(), "verbosity.json");
        try {
            await writeFile(file, '{"models":');
            expect(await activeVerbosity(session)).toBe("high");
            expect(nativeStatuses.get(session)?.get("verbosity")).toBe("🗣  high");
            expect((await receipt(session)).sleepReady).toBe(false);
            expect(await readFile(file, "utf8")).toBe('{"models":');
            await rm(file);
            await mkdir(file);
            expect((await receipt(session)).sleepReady).toBe(false);
            await rm(file, { recursive: true });
            await saveConfig(config);
            expect(await activeVerbosity(session)).toBe("high");
            expect((await receipt(session)).sleepReady).toBe(true);
        } finally { await close(session); }
    });

    it("invalidates a held receipt before applying a changed file snapshot", async () => {
        await saveConfig({ showIndicator: true, models: { "gpt-5.4": "high" } });
        const session = await start();
        const hold = await session.acquireCheckpoint({ quiesce: () => () => {} });
        try {
            expect(hold.sleepReady).toBe(true);
            // Semantically identical writes must not invalidate a reconstructible receipt.
            const replacement = path.join(sdk.getAgentDir(), "replacement.json");
            await writeFile(replacement, '{"models":{"gpt-5.4":"HIGH"},"showIndicator":true}');
            await rename(replacement, path.join(sdk.getAgentDir(), "verbosity.json"));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(hold.signal.aborted).toBe(false);
            await saveConfig({ showIndicator: true, models: { "gpt-5.4": "low" } });
            await vi.waitFor(() => expect(hold.signal.aborted).toBe(true));
            expect(nativeStatuses.get(session)?.get("verbosity")).toBe("🗣  low");
            expect(await activeVerbosity(session)).toBe("low");
            expect((await receipt(session)).sleepReady).toBe(true);
        } finally { hold.release(); await close(session); }
    });

    it("accepts missing defaults and semantic equality but not malformed fallback defaults", async () => {
        const session = await start();
        const file = path.join(sdk.getAgentDir(), "verbosity.json");
        try {
            expect((await receipt(session)).sleepReady).toBe(true);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, "{");
            expect((await receipt(session)).sleepReady).toBe(false);
            await writeFile(file, '{"models": {}, "showIndicator": false, "ignored": true}');
            expect((await receipt(session)).sleepReady).toBe(true);
        } finally { await close(session); }
    });

    it("reconciles external edits before sleep and recreates status ownership on reload", async () => {
        await saveConfig({ showIndicator: true, models: { "gpt-5.4": "high", "another-model": "low" } });
        const originalRender = FooterComponent.prototype.render;
        const session = await start();
        const file = path.join(sdk.getAgentDir(), "verbosity.json");
        try {
            await writeFile(file, '{"models":{"another-model":"LOW","gpt-5.4":"HIGH"},"showIndicator":true}');
            expect((await receipt(session)).sleepReady).toBe(true);
            const changed = '{"showIndicator":false,"models":{"gpt-5.4":"low"}}';
            await writeFile(file, changed);
            await vi.waitFor(() => expect(nativeStatuses.get(session)?.has("verbosity")).toBe(false));
            expect(await activeVerbosity(session)).toBe("low");
            expect((await receipt(session)).sleepReady).toBe(true);
            await session.reload();
            expect(await activeVerbosity(session)).toBe("low");
            expect(FooterComponent.prototype.render).toBe(originalRender);
            expect(footer(session)).not.toContain("🗣");
            expect((await receipt(session)).sleepReady).toBe(true);
            expect(await readFile(file, "utf8")).toBe(changed);
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
            expect(await activeVerbosity(session)).toBe("high");
            expect(footer(session)).toContain("🗣 high");
            expect((await receipt(session)).sleepReady).toBe(false);
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
            expect(acquired).toBe(false);
            cancel.abort();
            await expect(pending).rejects.toThrow("Checkpoint cancelled");
            finish();
            await callback;
            expect((await receipt(session)).sleepReady).toBe(true);
        } finally { finish(); await callback; await close(session); }
    });
});

describe("pi-verbosity-control runtime", () => {
    it("keeps status and requests in sync across external edits, shortcuts, model changes and shutdown", async () => {
        const runtime = await createRuntime({
            showIndicator: true,
            models: { "gpt-5.4": "low", "openai-codex/gpt-5.4": "high" },
        });
        const { ctx } = createContext(createModel());
        const payload = { stream: true, text: { format: "plain" } };
        const request = () => runtime.beforeProviderRequestHandler({ payload }, ctx);
        await runtime.sessionStartHandler({}, ctx);
        try {
            expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", "🗣  high");
            expect(request()).toEqual({ ...payload, text: { format: "plain", verbosity: "high" } });

            await runtime.cycleShortcutHandler(ctx);
            expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", "🗣  low");
            expect(request()).toMatchObject({ text: { verbosity: "low" } });
            await runtime.toggleIndicatorShortcutHandler(ctx);
            expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", undefined);
            expect(request()).toMatchObject({ text: { verbosity: "low" } });

            const replacement = path.join(sdk.getAgentDir(), "replacement.json");
            await writeFile(replacement, JSON.stringify({ showIndicator: true, models: { "gpt-5.4": "medium" } }));
            await rename(replacement, path.join(sdk.getAgentDir(), "verbosity.json"));
            await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", "🗣  medium"));
            expect(request()).toMatchObject({ text: { verbosity: "medium" } });

            // A native request boundary must refresh even before fs.watch is delivered.
            writeFileSync(path.join(sdk.getAgentDir(), "verbosity.json"), '{"showIndicator":true,"models":{"gpt-5.4":"high"}}');
            expect(request()).toMatchObject({ text: { verbosity: "high" } });
            expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", "🗣  high");
            await runtime.cycleShortcutHandler(ctx);
            expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", "🗣  low");

            for (const model of [createModel({ api: "anthropic-messages" }), createModel({ id: "unconfigured" }), undefined]) {
                ctx.model = model;
                await runtime.modelSelectHandler({}, ctx);
                expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", undefined);
                expect(request()).toBeUndefined();
            }
            ctx.model = createModel({ provider: "another-provider", api: "azure-openai-responses" });
            await runtime.modelSelectHandler({}, ctx);
            expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", "🗣  low");
            expect(request()).toMatchObject({ text: { verbosity: "low" } });
        } finally {
            await runtime.sessionShutdownHandler({}, ctx);
        }
        expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", undefined);
        const calls = vi.mocked(ctx.ui.setStatus).mock.calls.length;
        await saveConfig({ showIndicator: true, models: { "gpt-5.4": "high" } });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(ctx.ui.setStatus).toHaveBeenCalledTimes(calls);
    });
    it.each(["cycleShortcutHandler", "toggleIndicatorShortcutHandler"] as const)("does not republish status when %s finishes after shutdown", async (handler) => {
        const runtime = await createRuntime({ showIndicator: true, models: { "gpt-5.4": "low" } });
        const { ctx } = createContext(createModel());
        await runtime.sessionStartHandler({}, ctx);
        const saving = runtime[handler](ctx);
        await runtime.sessionShutdownHandler({}, ctx);
        const calls = vi.mocked(ctx.ui.setStatus).mock.calls.length;
        await saving;
        expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", undefined);
        expect(ctx.ui.setStatus).toHaveBeenCalledTimes(calls);
    });

    it("patches requests for configured models after session start", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const { ctx } = createContext(createModel());

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

        expect(patched).toEqual({
            model: "gpt-5.4",
            stream: true,
            text: {
                verbosity: "low",
            },
        });

        await runtime.sessionShutdownHandler({}, ctx);
    });

    it("cycles and persists the current model setting from the shortcut", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const { ctx, notifyMock } = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);
        await runtime.cycleShortcutHandler(ctx);

        const saved = JSON.parse(await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8")) as {
            showIndicator: boolean;
            models: Record<string, string>;
        };

        expect(saved.showIndicator).toBe(false);
        expect(saved.models["gpt-5.4"]).toBe("medium");
        expect(notifyMock).toHaveBeenLastCalledWith("Verbosity for gpt-5.4 → medium", "info");

        await runtime.sessionShutdownHandler({}, ctx);
    });

    it("toggles indicator visibility and persists it", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const { ctx, notifyMock } = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);
        await runtime.toggleIndicatorShortcutHandler(ctx);

        const saved = JSON.parse(await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8")) as {
            showIndicator: boolean;
            models: Record<string, string>;
        };

        expect(saved.showIndicator).toBe(true);
        expect(saved.models["gpt-5.4"]).toBe("low");
        expect(notifyMock).toHaveBeenLastCalledWith("Verbosity indicator shown.", "info");

        await runtime.sessionShutdownHandler({}, ctx);
    });

    it("publishes native status without patching the footer and clears it on shutdown", async () => {
        const runtime = await createRuntime({
            showIndicator: true,
            models: {
                "gpt-5.4": "low",
            },
        });
        const { ctx } = createContext(createModel());
        const originalRender = FooterComponent.prototype.render;

        await runtime.sessionStartHandler({}, ctx);
        expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", "🗣  low");
        expect(FooterComponent.prototype.render).toBe(originalRender);

        await runtime.sessionShutdownHandler({}, ctx);
        expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("verbosity", undefined);
        expect(FooterComponent.prototype.render).toBe(originalRender);
    });
});
