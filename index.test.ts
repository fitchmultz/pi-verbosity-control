import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    default as verbosityControlExtension,
    buildFooterRightSideCandidates,
    cycleVerbosity,
    getExactModelKey,
    injectVerbosityIntoFooterLine,
    loadConfig,
    patchPayloadVerbosity,
    resolveConfiguredVerbosity,
    saveConfig,
    type VerbosityConfig,
} from "./index.js";

const originalHome = process.env.HOME;
let testHome = "";

beforeAll(async () => {
    testHome = await mkdtemp(path.join(os.tmpdir(), "pi-verbosity-control-test-"));
    process.env.HOME = testHome;
});

beforeEach(async () => {
    await rm(path.join(testHome, ".pi"), { recursive: true, force: true });
});

afterAll(async () => {
    await rm(testHome, { recursive: true, force: true });

    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
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

    it("builds footer candidates with and without provider prefix", () => {
        expect(buildFooterRightSideCandidates(createModel(), "xhigh")).toEqual([
            "(openai-codex) gpt-5.4 • xhigh",
            "gpt-5.4 • xhigh",
        ]);
    });

    it("injects verbosity into the footer line by consuming padding", () => {
        const line = "↑1.2k ↓3.4k          (openai-codex) gpt-5.4 • xhigh";

        expect(injectVerbosityIntoFooterLine(line, createModel(), "xhigh", "low")).toBe(
            "↑1.2k ↓3.4k (openai-codex) gpt-5.4 • xhigh • 🗣  low",
        );
    });

    it("keeps the footer width stable when space is tight", () => {
        const line = "stats  gpt-5.4 • xhigh";
        const nextLine = injectVerbosityIntoFooterLine(line, createModel(), "xhigh", "low");

        expect(visibleWidth(nextLine)).toBe(visibleWidth(line));
        expect(nextLine).toContain("gpt-5.4 • xhigh •");
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

        const raw = await readFile(path.join(testHome, ".pi", "agent", "verbosity.json"), "utf8");
        expect(raw).toBe(`{
    "showIndicator": false,
    "models": {
        "gpt-5.4": "low"
    }
}\n`);
    });

    it("ignores invalid config values and keeps valid ones", async () => {
        const configPath = path.join(testHome, ".pi", "agent", "verbosity.json");
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
            },
        },
        notifyMock,
    };
}

// Optional on older hosts, mandatory in the designated native CI lane.
const hasCheckpoint = typeof sdk.AgentSession.prototype.acquireCheckpoint === "function";
if (process.env.PI_REQUIRE_CHECKPOINT === "1" && !hasCheckpoint) {
    throw new Error("PI_REQUIRE_CHECKPOINT=1 requires AgentSession.acquireCheckpoint; native tests must not skip");
}
// No provider calls: use an empty credential store, disable discovery/network, and
// invoke the existing request hook with a synthetic payload to observe active state.
describe.skipIf(!hasCheckpoint)("native checkpoints", () => {
    async function start(checkpoint?: sdk.SessionCheckpoint) {
        const cwd = path.join(testHome, "workspace");
        const agentDir = path.join(testHome, ".pi", "agent");
        await mkdir(cwd, { recursive: true });
        const settingsManager = sdk.SettingsManager.inMemory({
            compaction: { enabled: false }, retry: { enabled: false },
        });
        const resourceLoader = new sdk.DefaultResourceLoader({
            cwd, agentDir, settingsManager,
            noExtensions: true, noSkills: true, noPromptTemplates: true,
            noThemes: true, noContextFiles: true,
            extensionFactories: [{ name: "verbosity-control", factory: verbosityControlExtension }],
        });
        await resourceLoader.reload();
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
        await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
        return session;
    }

    async function close(session: sdk.AgentSession) {
        session.cancelCheckpoint();
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
            getGitBranch: () => null, getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 1, onBranchChange: () => () => {},
        }).render(160).join("\n");
    }

    it("qualifies persisted idle state and reconstructs verbosity and indicator from the existing file", async () => {
        await saveConfig({ showIndicator: false, models: { "gpt-5.4": "low" } });
        const originalRender = FooterComponent.prototype.render;
        const session = await start();
        let checkpoint: sdk.SessionCheckpoint;
        try {
            await shortcut(session);
            await shortcut(session, true);
            expect(await activeVerbosity(session)).toBe("medium");
            expect(footer(session)).toContain("🗣  medium");
            const before = await readFile(path.join(testHome, ".pi/agent/verbosity.json"), "utf8");
            const result = await receipt(session);
            expect(result.blockers).toEqual([]);
            expect(result.sleepReady).toBe(true);
            expect(await readFile(path.join(testHome, ".pi/agent/verbosity.json"), "utf8")).toBe(before);
            checkpoint = result.checkpoint;
        } finally { await close(session); }
        expect(FooterComponent.prototype.render).toBe(originalRender);
        const restored = await start(checkpoint!);
        try {
            expect(await activeVerbosity(restored)).toBe("medium");
            expect(footer(restored)).toContain("🗣  medium");
            expect((await receipt(restored)).sleepReady).toBe(true);
        } finally { await close(restored); }
        expect(FooterComponent.prototype.render).toBe(originalRender);
    });

    it("does not certify divergent, truncated, missing, or unreadable nondefault config", async () => {
        const config = { showIndicator: true, models: { "gpt-5.4": "high" as const } };
        await saveConfig(config);
        const session = await start();
        const file = path.join(testHome, ".pi/agent/verbosity.json");
        try {
            for (const changed of [JSON.stringify({ ...config, showIndicator: false }),
                JSON.stringify({ ...config, models: { "gpt-5.4": "low" } }), '{"models":']) {
                await writeFile(file, changed);
                const result = await receipt(session);
                expect(result.sleepReady).toBe(false);
                expect(result.blockers.join()).toContain("Verbosity config");
                expect(await readFile(file, "utf8")).toBe(changed);
                expect(await activeVerbosity(session)).toBe("high");
            }
            await rm(file);
            expect((await receipt(session)).sleepReady).toBe(false);
            await mkdir(file);
            expect((await receipt(session)).sleepReady).toBe(false);
            await rm(file, { recursive: true });
            await saveConfig(config);
            expect((await receipt(session)).sleepReady).toBe(true);
        } finally { await close(session); }
    });

    it("accepts missing defaults and semantic equality but not malformed fallback defaults", async () => {
        const session = await start();
        const file = path.join(testHome, ".pi/agent/verbosity.json");
        try {
            expect((await receipt(session)).sleepReady).toBe(true);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, "{");
            expect((await receipt(session)).sleepReady).toBe(false);
            await writeFile(file, '{"models": {}, "showIndicator": false, "ignored": true}');
            expect((await receipt(session)).sleepReady).toBe(true);
        } finally { await close(session); }
    });

    it("reload reconciles an external edit and retains footer teardown", async () => {
        await saveConfig({ showIndicator: true, models: { "gpt-5.4": "high", "another-model": "low" } });
        const originalRender = FooterComponent.prototype.render;
        const session = await start();
        const file = path.join(testHome, ".pi/agent/verbosity.json");
        try {
            await writeFile(file, '{"models":{"another-model":"LOW","gpt-5.4":"HIGH"},"showIndicator":true}');
            expect((await receipt(session)).sleepReady).toBe(true);
            const changed = '{"showIndicator":false,"models":{"gpt-5.4":"low"}}';
            await writeFile(file, changed);
            expect((await receipt(session)).sleepReady).toBe(false);
            expect(footer(session)).toContain("🗣  high");
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
        const file = path.join(testHome, ".pi/agent/verbosity.json");
        try {
            await rm(file);
            await mkdir(file); // Real EISDIR failure, not mocked saveConfig.
            await shortcut(session);
            await shortcut(session, true);
            expect(await activeVerbosity(session)).toBe("high");
            expect(footer(session)).toContain("🗣  high");
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

        const saved = JSON.parse(await readFile(path.join(testHome, ".pi", "agent", "verbosity.json"), "utf8")) as {
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

        const saved = JSON.parse(await readFile(path.join(testHome, ".pi", "agent", "verbosity.json"), "utf8")) as {
            showIndicator: boolean;
            models: Record<string, string>;
        };

        expect(saved.showIndicator).toBe(true);
        expect(saved.models["gpt-5.4"]).toBe("low");
        expect(notifyMock).toHaveBeenLastCalledWith("Verbosity indicator shown.", "info");

        await runtime.sessionShutdownHandler({}, ctx);
    });

    it("patches only while the indicator is enabled and cleans up on session shutdown", async () => {
        const runtime = await createRuntime({
            showIndicator: true,
            models: {
                "gpt-5.4": "low",
            },
        });
        const { ctx } = createContext(createModel());
        const originalRender = FooterComponent.prototype.render;

        await runtime.sessionStartHandler({}, ctx);
        expect(FooterComponent.prototype.render).not.toBe(originalRender);

        await runtime.sessionShutdownHandler({}, ctx);
        expect(FooterComponent.prototype.render).toBe(originalRender);
    });
});
