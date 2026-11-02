import { constants, readFileSync, watch, type FSWatcher } from "node:fs";
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readlink,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
    type BeforeProviderRequestEvent,
    type ExtensionAPI,
    type ExtensionContext,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export type Verbosity = "low" | "medium" | "high";

export type VerbosityConfig = {
    showIndicator: boolean;
    models: Record<string, Verbosity>;
};

/** The host-API surface this extension consumes; Pi passes its full ExtensionAPI. */
export type VerbosityExtensionApi = Pick<ExtensionAPI, "on" | "registerShortcut">;

type JsonObject = Record<string, unknown>;

type SupportedVerbosityApi =
    | "openai-responses"
    | "openai-codex-responses"
    | "azure-openai-responses";

type ModelInfo = Pick<Model<Api>, "api" | "provider" | "id">;

const DEFAULT_CONFIG: VerbosityConfig = {
    showIndicator: false,
    models: {},
};

const MACOS_CYCLE_SHORTCUT: KeyId = "alt+v";
const OTHER_CYCLE_SHORTCUT: KeyId = "ctrl+alt+v";
const MACOS_TOGGLE_INDICATOR_SHORTCUT: KeyId = "alt+shift+v";
const OTHER_TOGGLE_INDICATOR_SHORTCUT: KeyId = "ctrl+alt+shift+v";
const SUPPORTED_APIS: ReadonlySet<string> = new Set([
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
]);
// These older OpenAI models accept only medium, so cycling to low/high rejects requests.
const LEGACY_OPENAI_MODELS = /^(?:gpt-4|o[134](?:-|$))/;

function createDefaultConfig(): VerbosityConfig {
    return {
        showIndicator: DEFAULT_CONFIG.showIndicator,
        models: {},
    };
}

export function getGlobalConfigPath(): string {
    return path.join(getAgentDir(), "verbosity.json");
}

export function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The SDK context exposes Model<any>; funnel it through this typed boundary once. */
function asModelInfo(model: ExtensionContext["model"]): ModelInfo | undefined {
    return model;
}

function errnoCode(error: unknown): string | undefined {
    return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

export function normalizeVerbosity(value: unknown): Verbosity | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "low" || normalized === "medium" || normalized === "high") {
        return normalized;
    }

    return undefined;
}

export function parseConfig(value: unknown): VerbosityConfig {
    if (!isObject(value)) {
        return createDefaultConfig();
    }

    const parsedModels = isObject(value.models) ? value.models : {};
    const models: Record<string, Verbosity> = {};

    for (const [rawKey, rawValue] of Object.entries(parsedModels)) {
        const key = rawKey.trim();
        const verbosity = normalizeVerbosity(rawValue);
        if (key === "" || verbosity === undefined) {
            continue;
        }

        models[key] = verbosity;
    }

    return {
        showIndicator:
            typeof value.showIndicator === "boolean"
                ? value.showIndicator
                : DEFAULT_CONFIG.showIndicator,
        models,
    };
}

function readConfig(configPath: string): VerbosityConfig {
    try {
        return parseConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
    } catch (error) {
        if (errnoCode(error) === "ENOENT") {
            return createDefaultConfig();
        }
        throw error;
    }
}

export async function loadConfig(configPath = getGlobalConfigPath()): Promise<VerbosityConfig> {
    try {
        return readConfig(configPath);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-verbosity-control] Failed to read ${configPath}: ${message}`);
        return createDefaultConfig();
    }
}

async function resolveConfigTarget(configPath: string): Promise<string> {
    let targetPath = configPath;
    while (true) {
        try {
            targetPath = await realpath(targetPath);
            break;
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") {
                throw error;
            }
        }
        try {
            // A dangling symlink must still point to the new file after the save.
            const link = await readlink(targetPath);
            targetPath = path.isAbsolute(link)
                ? link
                : `${path.dirname(targetPath)}${path.sep}${link}`;
        } catch (error) {
            const code = errnoCode(error);
            if (code !== "ENOENT" && code !== "EINVAL") {
                throw error;
            }
            break;
        }
    }
    return path.join(await realpath(path.dirname(targetPath)), path.basename(targetPath));
}

export async function saveConfig(
    config: VerbosityConfig,
    configPath = getGlobalConfigPath(),
): Promise<void> {
    await mkdir(path.dirname(configPath), { recursive: true });
    const targetPath = await resolveConfigTarget(configPath);
    const stagingDir = await mkdtemp(`${targetPath}.`);
    const stagedPath = path.join(stagingDir, "config");
    try {
        const previous = await stat(targetPath).catch((error: unknown): null => {
            if (errnoCode(error) !== "ENOENT") {
                throw error;
            }
            return null;
        });
        if (previous !== null) {
            await access(targetPath, constants.W_OK);
        }
        await writeFile(stagedPath, `${JSON.stringify(config, null, 4)}\n`, "utf8");
        if (previous !== null) {
            await chmod(stagedPath, previous.mode & 0o7777);
        }
        await rename(stagedPath, targetPath);
    } finally {
        await rm(stagingDir, { recursive: true, force: true });
    }
}

function getExactModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
    return `${model.provider}/${model.id}`;
}

function isSupportedApi(api: Api): api is SupportedVerbosityApi {
    return SUPPORTED_APIS.has(api);
}

export function supportsVerbosityControl(model: ModelInfo | undefined): boolean {
    if (model === undefined) {
        return false;
    }

    const officialOpenAI =
        model.provider === "openai" || model.provider === "azure-openai-responses";
    return isSupportedApi(model.api) && !(officialOpenAI && LEGACY_OPENAI_MODELS.test(model.id));
}

function resolveConfiguredVerbosity(
    config: VerbosityConfig,
    model: Pick<Model<Api>, "provider" | "id">,
): { key?: string; verbosity?: Verbosity } {
    const exactKey = getExactModelKey(model);
    const exactVerbosity = normalizeVerbosity(config.models[exactKey]);
    if (exactVerbosity !== undefined) {
        return { key: exactKey, verbosity: exactVerbosity };
    }

    const sharedVerbosity = normalizeVerbosity(config.models[model.id]);
    if (sharedVerbosity !== undefined) {
        return { key: model.id, verbosity: sharedVerbosity };
    }

    return {};
}

function nextVerbosity(current: Verbosity | undefined): Verbosity {
    switch (current) {
        case "low":
            return "medium";
        case "medium":
            return "high";
        case "high":
            return "low";
        case undefined:
            return "low";
    }
}

export function setModelVerbosity(
    config: VerbosityConfig,
    key: string,
    verbosity: Verbosity,
): VerbosityConfig {
    return {
        showIndicator: config.showIndicator,
        models: {
            ...config.models,
            [key]: verbosity,
        },
    };
}

export function setIndicatorVisibility(
    config: VerbosityConfig,
    showIndicator: boolean,
): VerbosityConfig {
    return {
        showIndicator,
        models: { ...config.models },
    };
}

function patchPayloadVerbosity(payload: unknown, verbosity: Verbosity): unknown {
    if (!isObject(payload)) {
        return payload;
    }

    const text = isObject(payload.text) ? payload.text : {};

    return {
        ...payload,
        text: {
            ...text,
            verbosity,
        },
    };
}

function getCycleShortcut(): KeyId {
    return process.platform === "darwin" ? MACOS_CYCLE_SHORTCUT : OTHER_CYCLE_SHORTCUT;
}

function getToggleIndicatorShortcut(): KeyId {
    return process.platform === "darwin"
        ? MACOS_TOGGLE_INDICATOR_SHORTCUT
        : OTHER_TOGGLE_INDICATOR_SHORTCUT;
}

function notifyUser(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
): void {
    if (ctx.hasUI) {
        ctx.ui.notify(message, level);
    }
}

function reportSaveFailure(ctx: ExtensionContext, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    notifyUser(ctx, `Failed to save verbosity config: ${message}`, "error");
}

function initialCycleVerbosity(
    model: Pick<Model<Api>, "api">,
    configured: Verbosity | undefined,
): Verbosity | undefined {
    // pi-ai sends low when a Codex request omits verbosity, so cycling must start past it.
    return configured ?? (model.api === "openai-codex-responses" ? "low" : undefined);
}

/** Owns the active configuration, the bound session context, and the config watcher. */
class VerbosityController {
    private config: VerbosityConfig = createDefaultConfig();
    private context: ExtensionContext | undefined;
    private watcher: FSWatcher | undefined;
    private readonly configPath: string;

    constructor(configPath: string) {
        this.configPath = configPath;
    }

    publishStatus(ctx: ExtensionContext): Verbosity | undefined {
        const model = asModelInfo(ctx.model);
        const verbosity =
            model !== undefined && supportsVerbosityControl(model)
                ? resolveConfiguredVerbosity(this.config, model).verbosity
                : undefined;
        const indicator =
            this.config.showIndicator && verbosity !== undefined ? `🗣  ${verbosity}` : undefined;
        ctx.ui.setStatus("verbosity", indicator);
        return verbosity;
    }

    refresh(ctx: ExtensionContext, fromWatcher = false): Verbosity | undefined {
        this.context = ctx;
        let nextConfig = this.config;
        try {
            // One synchronous snapshot for the request policy and its native status.
            nextConfig = readConfig(this.configPath);
            if (fromWatcher && isDeepStrictEqual(nextConfig, this.config)) {
                return;
            }
        } catch {
            // Keep the last good settings while an editor is writing incomplete JSON.
        }
        this.config = nextConfig;
        return this.publishStatus(ctx);
    }

    private async updateConfig(
        update: (config: VerbosityConfig) => VerbosityConfig,
    ): Promise<VerbosityConfig> {
        await mkdir(path.dirname(this.configPath), { recursive: true });
        const targetPath = await resolveConfigTarget(this.configPath);
        const release = await lockfile.lock(targetPath, {
            realpath: false,
            retries: { retries: 10, minTimeout: 20, maxTimeout: 100 },
        });
        try {
            // Re-read under the cross-process lock so another session's changes survive.
            const current = readConfig(targetPath);
            const next = update(current);
            await saveConfig(next, targetPath);
            return next;
        } finally {
            await release();
        }
    }

    async cycleVerbosity(ctx: ExtensionContext): Promise<void> {
        this.refresh(ctx);
        const model = asModelInfo(ctx.model);
        if (model === undefined) {
            notifyUser(ctx, "No active model.", "warning");
            return;
        }

        if (!supportsVerbosityControl(model)) {
            notifyUser(
                ctx,
                `Verbosity control is not supported for ${model.provider}/${model.id}.`,
                "warning",
            );
            return;
        }

        let appliedKey = "";
        let appliedVerbosity: Verbosity = "medium";
        let nextConfig: VerbosityConfig;
        try {
            nextConfig = await this.updateConfig((config) => {
                const resolved = resolveConfiguredVerbosity(config, model);
                appliedKey = resolved.key ?? getExactModelKey(model);
                appliedVerbosity = nextVerbosity(initialCycleVerbosity(model, resolved.verbosity));
                return setModelVerbosity(config, appliedKey, appliedVerbosity);
            });
        } catch (error) {
            if (this.context === undefined) {
                return;
            }
            reportSaveFailure(ctx, error);
            return;
        }

        const activeContext = this.context;
        if (activeContext === undefined) {
            return;
        }
        this.config = nextConfig;
        this.publishStatus(activeContext);
        notifyUser(ctx, `Verbosity for ${appliedKey} → ${appliedVerbosity}`, "info");
    }

    async toggleIndicator(ctx: ExtensionContext): Promise<void> {
        this.refresh(ctx);
        let nextConfig: VerbosityConfig;
        try {
            nextConfig = await this.updateConfig((config) =>
                setIndicatorVisibility(config, !config.showIndicator),
            );
        } catch (error) {
            if (this.context === undefined) {
                return;
            }
            reportSaveFailure(ctx, error);
            return;
        }

        const activeContext = this.context;
        if (activeContext === undefined) {
            return;
        }
        this.config = nextConfig;
        this.publishStatus(activeContext);
        notifyUser(
            ctx,
            `Verbosity indicator ${nextConfig.showIndicator ? "shown" : "hidden"}.`,
            "info",
        );
    }

    sessionStart(ctx: ExtensionContext): void {
        this.watcher?.close();
        this.refresh(ctx);
        try {
            // Watch the directory so atomic file replacements keep working.
            this.watcher = watch(
                path.dirname(this.configPath),
                { persistent: false },
                (_change, filename) => {
                    const activeContext = this.context;
                    if (activeContext === undefined) {
                        return;
                    }
                    if (
                        filename !== null &&
                        filename !== "" &&
                        filename !== path.basename(this.configPath)
                    ) {
                        return;
                    }
                    this.refresh(activeContext, true);
                },
            );
            this.watcher.on("error", () => {
                this.watcher?.close();
            });
        } catch {
            // Native request/model/shortcut boundaries still refresh without a watcher.
        }
    }

    sessionShutdown(ctx: ExtensionContext): void {
        this.watcher?.close();
        this.watcher = undefined;
        this.context = undefined;
        ctx.ui.setStatus("verbosity", undefined);
    }

    patchRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext): unknown {
        const verbosity = this.refresh(ctx);
        if (verbosity === undefined) {
            return;
        }
        return patchPayloadVerbosity(event.payload, verbosity);
    }
}

export default function piVerbosityControlExtension(pi: VerbosityExtensionApi): void {
    const controller = new VerbosityController(getGlobalConfigPath());

    pi.registerShortcut(getCycleShortcut(), {
        description: "Cycle response verbosity for the current model",
        handler: (ctx) => controller.cycleVerbosity(ctx),
    });

    pi.registerShortcut(getToggleIndicatorShortcut(), {
        description: "Toggle verbosity indicator visibility",
        handler: (ctx) => controller.toggleIndicator(ctx),
    });

    pi.on("session_start", (_event, ctx) => {
        controller.sessionStart(ctx);
    });

    pi.on("model_select", (_event, ctx) => {
        controller.refresh(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        controller.sessionShutdown(ctx);
    });

    pi.on("before_provider_request", (event, ctx) => controller.patchRequest(event, ctx));
}
