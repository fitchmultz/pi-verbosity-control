import assert from "node:assert/strict";
import {
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import {
    after,
    before,
    beforeEach,
    describe as nodeDescribe,
    it as nodeIt,
    mock,
    type Mock,
} from "node:test";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { type ExtensionContext, FooterComponent } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
    isObject,
    loadConfig,
    saveConfig,
    type VerbosityConfig,
    type VerbosityExtensionApi,
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
        HOME: originalHome,
        USERPROFILE: originalUserProfile,
        PI_CODING_AGENT_DIR: originalAgentDir,
    })) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

async function waitFor(check: () => void): Promise<void> {
    const deadline = Date.now() + 1000;
    while (true) {
        try {
            check();
            return;
        } catch (error) {
            if (Date.now() > deadline) {
                throw error;
            }
        }
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
        });
    }
}

function lastArgs(fn: Mock<(...args: never[]) => void>): unknown[] | undefined {
    return fn.mock.calls.at(-1)?.arguments;
}

function lastNotifyArgs(ctx: TestContext): [string, string] {
    const args = lastArgs(ctx.ui.notify);
    if (
        args === undefined ||
        args.length !== 2 ||
        typeof args[0] !== "string" ||
        typeof args[1] !== "string"
    ) {
        throw new Error(`Expected a two-string notify call, got ${JSON.stringify(args)}`);
    }
    return [args[0], args[1]];
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

function runLimitedShortcut(modelId: string): string {
    const child = spawnSync(
        "bash",
        [
            "-c",
            'ulimit -f 1; exec "$@"',
            "bash",
            process.execPath,
            "--input-type=module",
            "-e",
            `
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
        ],
        { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
}

nodeDescribe("pi-verbosity-control config io", () => {
    nodeIt("loads missing config as empty with hidden indicator", async () => {
        assert.deepEqual(await loadConfig(), { showIndicator: false, models: {} });
    });

    nodeIt("saves config with pretty JSON", async () => {
        const config: VerbosityConfig = {
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        };

        await saveConfig(config);

        await assert.rejects(readFile(path.join(testHome, ".pi/agent/verbosity.json"), "utf8"), {
            code: "ENOENT",
        });
        const raw = await readFile(path.join(sdk.getAgentDir(), "verbosity.json"), "utf8");
        assert.equal(
            raw,
            `{
    "showIndicator": false,
    "models": {
        "gpt-5.4": "low"
    }
}\n`,
        );
    });

    nodeIt(
        "preserves the existing config when a shortcut write fails",
        { skip: process.platform === "win32" },
        async () => {
            await saveConfig({ showIndicator: true, models: {} });
            const file = path.join(sdk.getAgentDir(), "verbosity.json");
            const prior = await readFile(file, "utf8");

            assert.match(
                runLimitedShortcut("x".repeat(2048)),
                /Failed to save verbosity config: EFBIG/,
            );
            assert.equal(await readFile(file, "utf8"), prior);
        },
    );

    nodeIt(
        "saves a smaller config when the old file exceeds the file limit",
        { skip: process.platform === "win32" },
        async () => {
            const file = path.join(sdk.getAgentDir(), "verbosity.json");
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(
                file,
                JSON.stringify({
                    showIndicator: false,
                    models: { "gpt-5.4": "low" },
                    ignored: "x".repeat(2048),
                }),
            );

            assert.match(runLimitedShortcut("gpt-5.4"), /Verbosity for gpt-5\.4 → medium/);
            assert.deepEqual(await loadConfig(), {
                showIndicator: false,
                models: { "gpt-5.4": "medium" },
            });
        },
    );

    nodeIt(
        "saves through a symlink to a missing config file",
        { skip: process.platform === "win32" },
        async () => {
            const agentDir = sdk.getAgentDir();
            const file = path.join(agentDir, "verbosity.json");
            const target = path.join(agentDir, "shared", "verbosity.json");
            await mkdir(path.dirname(target), { recursive: true });
            await symlink("shared/verbosity.json", file);
            const config: VerbosityConfig = { showIndicator: true, models: { "gpt-5.4": "high" } };

            await saveConfig(config);

            assert.equal(await readlink(file), "shared/verbosity.json");
            assert.deepEqual(JSON.parse(await readFile(target, "utf8")) as unknown, config);
        },
    );

    nodeIt("ignores invalid config values and keeps valid ones", async () => {
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
});

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

/** Recorded handler call convention for the API spy below. */
type RecordedHandler = (event: unknown, ctx: TestContext) => unknown;

type RecordedShortcut = (ctx: TestContext) => Promise<void> | void;

function createApiSpy(): {
    pi: VerbosityExtensionApi;
    handlers: Map<string, unknown>;
    shortcuts: Map<string, unknown>;
} {
    const handlers = new Map<string, unknown>();
    const shortcuts = new Map<string, unknown>();
    const pi: VerbosityExtensionApi = {
        on: (
            event: string,
            handler: (event: never, ctx: ExtensionContext) => unknown,
        ): (() => void) => {
            // Recorded handlers are invoked only through asRecordedHandler below, with the
            // synthetic events and contexts each handler's code path actually reads.
            handlers.set(event, handler);
            return () => {
                handlers.delete(event);
            };
        },
        registerShortcut: (
            shortcut: string,
            options: { handler: (ctx: ExtensionContext) => Promise<void> | void },
        ): void => {
            shortcuts.set(shortcut, options.handler);
        },
    };
    return { pi, handlers, shortcuts };
}

/** The recorded call convention: any callable the extension registered through the spy. */
function isRecordedHandler(value: unknown): value is RecordedHandler {
    return typeof value === "function";
}

function isRecordedShortcut(value: unknown): value is RecordedShortcut {
    return typeof value === "function";
}

function asRecordedHandler(handlers: Map<string, unknown>, event: string): RecordedHandler {
    const handler = handlers.get(event);
    if (!isRecordedHandler(handler)) {
        throw new Error(`Extension did not register a callable ${event} handler`);
    }
    // The extension's handlers read only the context members TestContext provides (model,
    // hasUI, ui.notify, ui.setStatus) and, for before_provider_request, event.payload; the
    // recorded call convention supplies exactly those, checked here at runtime.
    return handler;
}

function asRecordedShortcut(shortcuts: Map<string, unknown>, shortcut: string): RecordedShortcut {
    const handler = shortcuts.get(shortcut);
    if (!isRecordedShortcut(handler)) {
        throw new Error(`Extension did not register a callable ${shortcut} shortcut handler`);
    }
    // Shortcut handlers receive the same recorded TestContext convention.
    return handler;
}

type RuntimeHandlers = {
    sessionStartHandler: RecordedHandler;
    sessionShutdownHandler: RecordedHandler;
    modelSelectHandler: RecordedHandler;
    beforeProviderRequestHandler: (event: { payload: unknown }, ctx: TestContext) => unknown;
    cycleShortcutHandler: RecordedShortcut;
    toggleIndicatorShortcutHandler: RecordedShortcut;
};

async function createRuntime(config: VerbosityConfig): Promise<RuntimeHandlers> {
    await saveConfig(config);

    const { default: verbosityControlExtension } = await import("./index.ts");

    const { pi, handlers, shortcuts } = createApiSpy();
    verbosityControlExtension(pi);

    const cycleShortcut = process.platform === "darwin" ? "alt+v" : "ctrl+alt+v";
    const toggleIndicatorShortcut =
        process.platform === "darwin" ? "alt+shift+v" : "ctrl+alt+shift+v";

    return {
        sessionStartHandler: asRecordedHandler(handlers, "session_start"),
        sessionShutdownHandler: asRecordedHandler(handlers, "session_shutdown"),
        modelSelectHandler: asRecordedHandler(handlers, "model_select"),
        beforeProviderRequestHandler: asRecordedHandler(handlers, "before_provider_request"),
        cycleShortcutHandler: asRecordedShortcut(shortcuts, cycleShortcut),
        toggleIndicatorShortcutHandler: asRecordedShortcut(shortcuts, toggleIndicatorShortcut),
    };
}

const nativeStatuses = new WeakMap<sdk.AgentSession, Map<string, string>>();

function statusesFor(session: sdk.AgentSession): Map<string, string> {
    const statuses = nativeStatuses.get(session);
    assert.ok(statuses !== undefined, "No recorded statuses for this session");
    return statuses;
}

// No provider calls: use an empty credential store, disable discovery/network, and
// invoke the existing request hook with a synthetic payload to observe active state.
async function start(): Promise<sdk.AgentSession> {
    const cwd = path.join(testHome, "workspace");
    const agentDir = sdk.getAgentDir();
    await mkdir(cwd, { recursive: true });
    const settingsManager = sdk.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
    });
    const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [path.resolve("index.ts")],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(resourceLoader.getExtensions().extensions.length, 1);
    const model = createModel({
        provider: "verbosity-test",
        api: "openai-responses",
        baseUrl: "http://127.0.0.1:1",
    });
    const modelsPath = path.join(agentDir, "models.json");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
        modelsPath,
        JSON.stringify({
            providers: {
                "verbosity-test": {
                    baseUrl: model.baseUrl,
                    api: model.api,
                    apiKey: "synthetic-not-a-credential",
                    models: [model],
                },
            },
        }),
    );
    const modelRuntime = await sdk.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    const { session } = await sdk.createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader,
        modelRuntime,
        model,
        tools: [],
    });
    const statuses = new Map<string, string>();
    nativeStatuses.set(session, statuses);
    await session.bindExtensions({
        mode: "tui",
        uiContext: {
            ...session.extensionRunner.createContext().ui,
            setStatus: (key: string, value: string | undefined) => {
                if (value === undefined) {
                    statuses.delete(key);
                } else {
                    statuses.set(key, value);
                }
            },
        },
        onError: (error) => {
            throw new Error(error.error);
        },
    });
    return session;
}

async function close(session: sdk.AgentSession): Promise<void> {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
}

function payloadTextVerbosity(payload: unknown): string | undefined {
    if (isObject(payload) && isObject(payload.text) && typeof payload.text.verbosity === "string") {
        return payload.text.verbosity;
    }
    return undefined;
}

async function activeVerbosity(session: sdk.AgentSession): Promise<string | undefined> {
    const payload = await session.extensionRunner.emitBeforeProviderRequest({
        text: { format: "plain" },
    });
    return payloadTextVerbosity(payload);
}

function footer(session: sdk.AgentSession): string {
    sdk.initTheme("dark");
    return new FooterComponent(session, {
        getGitBranch: () => null,
        getExtensionStatuses: () => statusesFor(session),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => () => {
            /* No branch changes occur in this harness. */
        },
    })
        .render(160)
        .join("\n");
}

/** The extension must never replace or patch the stock footer renderer. */
function createRenderGuard(): { assertUnchanged: () => void } {
    // oxlint-disable-next-line typescript/unbound-method -- QX-002: captured for identity comparison only; this reference is never invoked without a receiver.
    const originalRender = FooterComponent.prototype.render;
    return {
        assertUnchanged: () => {
            // oxlint-disable-next-line typescript/unbound-method -- QX-002: identity comparison against the captured reference, not an unbound invocation.
            assert.equal(FooterComponent.prototype.render, originalRender);
        },
    };
}

nodeDescribe("native official/fork baseline", () => {
    nodeIt(
        "loads through the native loader, publishes stock-footer status, and reconciles config on reload",
        async () => {
            await saveConfig({ showIndicator: true, models: { "gpt-5.4": "low" } });
            const renderGuard = createRenderGuard();
            const session = await start();
            try {
                const payload = await session.extensionRunner.emitBeforeProviderRequest({
                    text: { format: "plain" },
                });
                assert.deepEqual(payload, { text: { format: "plain", verbosity: "low" } });
                assert.equal(nativeStatuses.get(session)?.get("verbosity"), "🗣  low");
                renderGuard.assertUnchanged();
                assert.ok(footer(session).includes("🗣 low"));
                for (const width of [40, 80, 160]) {
                    const component = new FooterComponent(session, {
                        getGitBranch: () => null,
                        getExtensionStatuses: () => statusesFor(session),
                        getAvailableProviderCount: () => 1,
                        onBranchChange: () => () => {
                            /* No branch changes occur in this harness. */
                        },
                    });
                    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
                }
                await session.setModel(
                    createModel({
                        id: "unsupported",
                        provider: "verbosity-test",
                        api: "anthropic-messages",
                    }),
                );
                assert.equal(nativeStatuses.get(session)?.has("verbosity"), false);
                assert.equal(await activeVerbosity(session), undefined);
                await session.setModel(
                    createModel({ provider: "verbosity-test", api: "openai-responses" }),
                );
                assert.equal(nativeStatuses.get(session)?.get("verbosity"), "🗣  low");
                await saveConfig({ showIndicator: false, models: { "gpt-5.4": "high" } });
                await session.reload();
                assert.equal(await activeVerbosity(session), "high");
                assert.ok(!footer(session).includes("🗣"));
                renderGuard.assertUnchanged();
            } finally {
                await close(session);
            }
            renderGuard.assertUnchanged();
        },
    );
});

nodeDescribe("pi-verbosity-control runtime", () => {
    for (const shortcut of ["cycleShortcutHandler", "toggleIndicatorShortcutHandler"] as const) {
        nodeIt(`${shortcut} preserves malformed config and reports the save failure`, async () => {
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
                const [message, level] = lastNotifyArgs(ctx);
                assert.match(message, /^Failed to save verbosity config:/);
                assert.equal(level, "error");
                await saveConfig(config);
                await runtime[shortcut](ctx);
                assert.equal(lastArgs(ctx.ui.notify)?.at(-1), "info");
                assert.deepEqual(
                    await loadConfig(),
                    shortcut === "cycleShortcutHandler"
                        ? { ...config, models: { "gpt-5.4": "low" } }
                        : { ...config, showIndicator: true },
                );
            } finally {
                await runtime.sessionShutdownHandler({}, ctx);
            }
        });
    }

    nodeIt("waits for another process's lock and reads its changes before saving", async () => {
        await saveConfig({ showIndicator: false, models: { "gpt-5.4": "low" } });
        let release: (() => Promise<void>) | undefined = await lockfile.lock(
            path.join(sdk.getAgentDir(), "verbosity.json"),
            { realpath: false },
        );
        const child = spawn(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `
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
        `,
            ],
            { stdio: ["ignore", "ignore", "inherit", "ipc"], env: process.env },
        );
        const exited = once(child, "exit");
        try {
            assert.deepEqual(await once(child, "message"), ["started", undefined]);
            await saveConfig({
                showIndicator: true,
                models: { "gpt-5.4": "low", "other-model": "high" },
            });
            await release();
            release = undefined;
            assert.deepEqual(await exited, [0, null]);
            assert.deepEqual(await loadConfig(), {
                showIndicator: true,
                models: { "gpt-5.4": "medium", "other-model": "high" },
            });
        } finally {
            await release?.();
            if (child.exitCode === null) {
                child.kill();
                await exited;
            }
        }
    });

    nodeIt(
        "serializes shortcuts through symlink aliases of one config",
        { skip: process.platform === "win32" },
        async () => {
            const config: VerbosityConfig = { showIndicator: false, models: { "gpt-5.4": "low" } };
            const target = path.join(testHome, "shared", "verbosity.json");
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, JSON.stringify(config));
            const directories = ["first", "second"].map((name) =>
                path.join(testHome, `agent-${name}`),
            );
            for (const dir of directories) {
                await mkdir(dir);
                await symlink(target, path.join(dir, "verbosity.json"));
            }

            const originalDir = process.env.PI_CODING_AGENT_DIR;
            assert.ok(originalDir !== undefined);
            const runtimes: RuntimeHandlers[] = [];
            try {
                for (const dir of directories) {
                    process.env.PI_CODING_AGENT_DIR = dir;
                    runtimes.push(await createRuntime(config));
                }
            } finally {
                process.env.PI_CODING_AGENT_DIR = originalDir;
            }
            const [first, second] = runtimes;
            assert.ok(first !== undefined && second !== undefined, "Expected two runtimes");
            const a = createContext(createModel());
            const b = createContext(createModel());
            try {
                await first.sessionStartHandler({}, a);
                await second.sessionStartHandler({}, b);
                await Promise.all([first.cycleShortcutHandler(a), second.cycleShortcutHandler(b)]);
                assert.deepEqual(JSON.parse(await readFile(target, "utf8")) as unknown, {
                    showIndicator: false,
                    models: { "gpt-5.4": "high" },
                });
                assert.deepEqual(
                    [lastArgs(a.ui.notify)?.[0], lastArgs(b.ui.notify)?.[0]].sort((x, y) =>
                        String(x).localeCompare(String(y)),
                    ),
                    ["Verbosity for gpt-5.4 → high", "Verbosity for gpt-5.4 → medium"],
                );
            } finally {
                await first.sessionShutdownHandler({}, a);
                await second.sessionShutdownHandler({}, b);
            }
        },
    );

    for (const { name, secondModel, toggle, models, showIndicator } of [
        {
            name: "different models",
            secondModel: "gpt-5.3-codex",
            toggle: false,
            models: { "gpt-5.4": "medium", "gpt-5.3-codex": "medium" },
            showIndicator: false,
        },
        {
            name: "the same model",
            secondModel: "gpt-5.4",
            toggle: false,
            models: { "gpt-5.4": "high", "gpt-5.3-codex": "low" },
            showIndicator: false,
        },
        {
            name: "a model and the indicator",
            secondModel: "gpt-5.4",
            toggle: true,
            models: { "gpt-5.4": "medium", "gpt-5.3-codex": "low" },
            showIndicator: true,
        },
    ]) {
        nodeIt(`preserves concurrent changes to ${name}`, async () => {
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
                    toggle
                        ? second.toggleIndicatorShortcutHandler(b)
                        : second.cycleShortcutHandler(b),
                ]);
                assert.deepEqual(await loadConfig(), { models, showIndicator });
                assert.equal(lastArgs(a.ui.notify)?.at(-1), "info");
                assert.equal(lastArgs(b.ui.notify)?.at(-1), "info");
            } finally {
                await first.sessionShutdownHandler({}, a);
                await second.sessionShutdownHandler({}, b);
            }
        });
    }

    nodeIt(
        "keeps status and requests in sync across external edits, shortcuts, model changes and shutdown",
        async () => {
            const runtime = await createRuntime({
                showIndicator: true,
                models: { "gpt-5.4": "low", "openai-codex/gpt-5.4": "high" },
            });
            const ctx = createContext(createModel());
            const status = () => lastArgs(ctx.ui.setStatus);
            const payload = { model: "gpt-5.4", stream: true, text: { format: "plain" } };
            const request = () => runtime.beforeProviderRequestHandler({ payload }, ctx);
            await runtime.sessionStartHandler({}, ctx);
            try {
                assert.deepEqual(status(), ["verbosity", "🗣  high"]);
                assert.deepEqual(request(), {
                    ...payload,
                    text: { format: "plain", verbosity: "high" },
                });

                await runtime.cycleShortcutHandler(ctx);
                assert.deepEqual(status(), ["verbosity", "🗣  low"]);
                assert.partialDeepStrictEqual(request(), { text: { verbosity: "low" } });
                await runtime.toggleIndicatorShortcutHandler(ctx);
                assert.deepEqual(status(), ["verbosity", undefined]);
                assert.partialDeepStrictEqual(request(), { text: { verbosity: "low" } });

                const replacement = path.join(sdk.getAgentDir(), "replacement.json");
                await writeFile(
                    replacement,
                    JSON.stringify({ showIndicator: true, models: { "gpt-5.4": "medium" } }),
                );
                await rename(replacement, path.join(sdk.getAgentDir(), "verbosity.json"));
                await waitFor(() => assert.deepEqual(status(), ["verbosity", "🗣  medium"]));
                assert.partialDeepStrictEqual(request(), { text: { verbosity: "medium" } });

                // A native request boundary must refresh even before fs.watch is delivered.
                writeFileSync(
                    path.join(sdk.getAgentDir(), "verbosity.json"),
                    '{"showIndicator":true,"models":{"gpt-5.4":"high"}}',
                );
                assert.partialDeepStrictEqual(request(), { text: { verbosity: "high" } });
                assert.deepEqual(status(), ["verbosity", "🗣  high"]);
                await runtime.cycleShortcutHandler(ctx);
                assert.deepEqual(status(), ["verbosity", "🗣  low"]);

                for (const model of [
                    createModel({ api: "anthropic-messages" }),
                    createModel({ id: "unconfigured" }),
                    undefined,
                ]) {
                    ctx.model = model;
                    await runtime.modelSelectHandler({}, ctx);
                    assert.deepEqual(status(), ["verbosity", undefined]);
                    assert.equal(request(), undefined);
                }
                ctx.model = createModel({
                    provider: "another-provider",
                    api: "azure-openai-responses",
                });
                await runtime.modelSelectHandler({}, ctx);
                assert.deepEqual(status(), ["verbosity", "🗣  low"]);
                assert.partialDeepStrictEqual(request(), { text: { verbosity: "low" } });
            } finally {
                await runtime.sessionShutdownHandler({}, ctx);
            }
            assert.deepEqual(status(), ["verbosity", undefined]);
            const calls = ctx.ui.setStatus.mock.callCount();
            await saveConfig({ showIndicator: true, models: { "gpt-5.4": "high" } });
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 100);
            });
            assert.equal(ctx.ui.setStatus.mock.callCount(), calls);
        },
    );

    for (const handler of ["cycleShortcutHandler", "toggleIndicatorShortcutHandler"] as const) {
        nodeIt(`does not republish status when ${handler} finishes after shutdown`, async () => {
            const runtime = await createRuntime({
                showIndicator: true,
                models: { "gpt-5.4": "low" },
            });
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

    nodeIt("patches requests for configured models after session start", async () => {
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
        nodeIt(
            `leaves ${provider}/${id} requests unchanged when verbosity is unsupported`,
            async () => {
                const config: VerbosityConfig = { showIndicator: true, models: {} };
                const runtime = await createRuntime(config);
                const ctx = createContext(createModel({ provider, api, id }));
                await runtime.sessionStartHandler({}, ctx);
                try {
                    await runtime.cycleShortcutHandler(ctx);
                    assert.deepEqual(lastArgs(ctx.ui.notify), [
                        `Verbosity control is not supported for ${provider}/${id}.`,
                        "warning",
                    ]);
                    assert.deepEqual(await loadConfig(), config);

                    await saveConfig({ showIndicator: true, models: { [id]: "low" } });
                    assert.equal(
                        runtime.beforeProviderRequestHandler({ payload: { model: id } }, ctx),
                        undefined,
                    );
                    assert.deepEqual(lastArgs(ctx.ui.setStatus), ["verbosity", undefined]);
                } finally {
                    await runtime.sessionShutdownHandler({}, ctx);
                }
            },
        );
    }

    nodeIt("cycles and persists the current model setting from the shortcut", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const ctx = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);
        await runtime.cycleShortcutHandler(ctx);

        const saved = await loadConfig();

        assert.equal(saved.showIndicator, false);
        assert.equal(saved.models["gpt-5.4"], "medium");
        assert.deepEqual(lastArgs(ctx.ui.notify), ["Verbosity for gpt-5.4 → medium", "info"]);

        await runtime.sessionShutdownHandler({}, ctx);
    });

    for (const { model, expected, expectedKey } of [
        { model: createModel(), expected: "medium", expectedKey: "openai-codex/gpt-5.4" },
        {
            model: createModel({ provider: "openai", api: "openai-responses" }),
            expected: "low",
            expectedKey: "openai/gpt-5.4",
        },
    ]) {
        nodeIt(
            `first cycle of unconfigured ${model.provider}/${model.id} changes its effective verbosity to ${expected}`,
            async () => {
                const runtime = await createRuntime({ showIndicator: false, models: {} });
                const ctx = createContext(model);
                await runtime.sessionStartHandler({}, ctx);
                try {
                    await runtime.cycleShortcutHandler(ctx);
                    assert.deepEqual(await loadConfig(), {
                        showIndicator: false,
                        models: { [expectedKey]: expected },
                    });
                } finally {
                    await runtime.sessionShutdownHandler({}, ctx);
                }
            },
        );
    }

    nodeIt("toggles indicator visibility and persists it", async () => {
        const runtime = await createRuntime({
            showIndicator: false,
            models: {
                "gpt-5.4": "low",
            },
        });
        const ctx = createContext(createModel());

        await runtime.sessionStartHandler({}, ctx);
        await runtime.toggleIndicatorShortcutHandler(ctx);

        const saved = await loadConfig();

        assert.equal(saved.showIndicator, true);
        assert.equal(saved.models["gpt-5.4"], "low");
        assert.deepEqual(lastArgs(ctx.ui.notify), ["Verbosity indicator shown.", "info"]);

        await runtime.sessionShutdownHandler({}, ctx);
    });
});
