import { constants, readFileSync, watch, type FSWatcher } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export type Verbosity = "low" | "medium" | "high";

export type VerbosityConfig = {
    showIndicator: boolean;
    models: Record<string, Verbosity>;
};

type JsonObject = Record<string, unknown>;

type SupportedVerbosityApi = "openai-responses" | "openai-codex-responses" | "azure-openai-responses";

const DEFAULT_CONFIG: VerbosityConfig = {
    showIndicator: false,
    models: {},
};

const MACOS_CYCLE_SHORTCUT = "alt+v";
const OTHER_CYCLE_SHORTCUT = "ctrl+alt+v";
const MACOS_TOGGLE_INDICATOR_SHORTCUT = "alt+shift+v";
const OTHER_TOGGLE_INDICATOR_SHORTCUT = "ctrl+alt+shift+v";
const SUPPORTED_APIS = new Set<SupportedVerbosityApi>([
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
]);

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
        if (!key || !verbosity) {
            continue;
        }

        models[key] = verbosity;
    }

    return {
        showIndicator: typeof value.showIndicator === "boolean" ? value.showIndicator : DEFAULT_CONFIG.showIndicator,
        models,
    };
}

function readConfig(configPath: string): VerbosityConfig {
    try {
        return parseConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
    } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
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

export async function saveConfig(config: VerbosityConfig, configPath = getGlobalConfigPath()): Promise<void> {
    await mkdir(path.dirname(configPath), { recursive: true });
    let targetPath = configPath;
    while (true) {
        try {
            targetPath = await realpath(targetPath);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
            // A dangling symlink must still point to the new file after the save.
            const link = await readlink(targetPath);
            targetPath = path.isAbsolute(link) ? link : `${path.dirname(targetPath)}${path.sep}${link}`;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "EINVAL") throw error;
            break;
        }
    }
    targetPath = path.join(await realpath(path.dirname(targetPath)), path.basename(targetPath));
    const stagingDir = await mkdtemp(`${targetPath}.`);
    const stagedPath = path.join(stagingDir, "config");
    try {
        const previous = await stat(targetPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
        });
        if (previous) await access(targetPath, constants.W_OK);
        await writeFile(stagedPath, `${JSON.stringify(config, null, 4)}\n`, "utf8");
        if (previous) await chmod(stagedPath, previous.mode & 0o777);
        await rename(stagedPath, targetPath);
    } finally {
        await rm(stagingDir, { recursive: true, force: true });
    }
}

export function getExactModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
    return `${model.provider}/${model.id}`;
}

export function supportsVerbosityControl(model: Pick<Model<Api>, "api"> | undefined): boolean {
    if (!model) {
        return false;
    }

    return SUPPORTED_APIS.has(model.api as SupportedVerbosityApi);
}

export function resolveConfiguredVerbosity(
    config: VerbosityConfig,
    model: Pick<Model<Api>, "provider" | "id">,
): { key?: string; verbosity?: Verbosity } {
    const exactKey = getExactModelKey(model);
    const exactVerbosity = config.models[exactKey];
    if (exactVerbosity) {
        return { key: exactKey, verbosity: exactVerbosity };
    }

    const sharedVerbosity = config.models[model.id];
    if (sharedVerbosity) {
        return { key: model.id, verbosity: sharedVerbosity };
    }

    return {};
}

export function cycleVerbosity(current: Verbosity | undefined): Verbosity {
    switch (current) {
        case "low":
            return "medium";
        case "medium":
            return "high";
        case "high":
            return "low";
        default:
            return "low";
    }
}

export function setModelVerbosity(config: VerbosityConfig, key: string, verbosity: Verbosity): VerbosityConfig {
    return {
        showIndicator: config.showIndicator,
        models: {
            ...config.models,
            [key]: verbosity,
        },
    };
}

export function setIndicatorVisibility(config: VerbosityConfig, showIndicator: boolean): VerbosityConfig {
    return {
        showIndicator,
        models: { ...config.models },
    };
}

export function patchPayloadVerbosity(payload: unknown, verbosity: Verbosity): unknown {
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
    return process.platform === "darwin" ? (MACOS_CYCLE_SHORTCUT as KeyId) : (OTHER_CYCLE_SHORTCUT as KeyId);
}

function getToggleIndicatorShortcut(): KeyId {
    return process.platform === "darwin"
        ? (MACOS_TOGGLE_INDICATOR_SHORTCUT as KeyId)
        : (OTHER_TOGGLE_INDICATOR_SHORTCUT as KeyId);
}

export default function piVerbosityControlExtension(pi: ExtensionAPI): void {
    let activeConfig = createDefaultConfig();

    const configPath = getGlobalConfigPath();
    let activeContext: ExtensionContext | undefined;
    let watcher: FSWatcher | undefined;
    let checkpoint: { signal: AbortSignal; invalidate(): void } | undefined;

    const publishStatus = (ctx: ExtensionContext) => {
        const model = ctx.model;
        const verbosity = model && supportsVerbosityControl(model)
            ? resolveConfiguredVerbosity(activeConfig, model).verbosity
            : undefined;
        ctx.ui.setStatus("verbosity", activeConfig.showIndicator && verbosity ? `🗣  ${verbosity}` : undefined);
        return verbosity;
    };

    const refresh = (ctx: ExtensionContext, fromWatcher = false) => {
        activeContext = ctx;
        let nextConfig = activeConfig;
        try {
            // One synchronous snapshot for the request policy and its native status.
            nextConfig = readConfig(configPath);
            if (fromWatcher && isDeepStrictEqual(nextConfig, activeConfig)) return;
        } catch {
            // Keep the last good settings while an editor is writing incomplete JSON.
        }
        if (checkpoint && !checkpoint.signal.aborted) checkpoint.invalidate();
        activeConfig = nextConfig;
        return publishStatus(ctx);
    };

    const updateConfig = async (update: (config: VerbosityConfig) => VerbosityConfig) => {
        await mkdir(path.dirname(configPath), { recursive: true });
        const release = await lockfile.lock(configPath, {
            realpath: false,
            retries: { retries: 10, minTimeout: 20, maxTimeout: 100 },
        });
        try {
            // Re-read under the cross-process lock so another session's changes survive.
            const current = readConfig(configPath);
            const next = update(current);
            await saveConfig(next, configPath);
            return next;
        } finally {
            await release();
        }
    };

    pi.registerShortcut(getCycleShortcut(), {
        description: "Cycle response verbosity for the current model",
        handler: async (ctx) => {
            refresh(ctx);
            const model = ctx.model;
            if (!model) {
                if (ctx.hasUI) {
                    ctx.ui.notify("No active model.", "warning");
                }
                return;
            }

            if (!supportsVerbosityControl(model)) {
                if (ctx.hasUI) {
                    ctx.ui.notify(`Verbosity control is not supported for ${model.provider}/${model.id}.`, "warning");
                }
                return;
            }

            let nextConfig: VerbosityConfig;
            try {
                nextConfig = await updateConfig((config) => {
                    const resolved = resolveConfiguredVerbosity(config, model);
                    return setModelVerbosity(config, resolved.key ?? getExactModelKey(model), cycleVerbosity(resolved.verbosity));
                });
            } catch (error) {
                if (!activeContext) return;
                const message = error instanceof Error ? error.message : String(error);
                if (ctx.hasUI) {
                    ctx.ui.notify(`Failed to save verbosity config: ${message}`, "error");
                }
                return;
            }

            if (!activeContext) return;
            activeConfig = nextConfig;
            publishStatus(activeContext);

            if (ctx.hasUI) {
                const resolved = resolveConfiguredVerbosity(nextConfig, model);
                ctx.ui.notify(`Verbosity for ${resolved.key} → ${resolved.verbosity}`, "info");
            }
        },
    });

    pi.registerShortcut(getToggleIndicatorShortcut(), {
        description: "Toggle verbosity indicator visibility",
        handler: async (ctx) => {
            refresh(ctx);
            let nextConfig: VerbosityConfig;
            try {
                nextConfig = await updateConfig((config) => setIndicatorVisibility(config, !config.showIndicator));
            } catch (error) {
                if (!activeContext) return;
                const message = error instanceof Error ? error.message : String(error);
                if (ctx.hasUI) {
                    ctx.ui.notify(`Failed to save verbosity config: ${message}`, "error");
                }
                return;
            }

            if (!activeContext) return;
            activeConfig = nextConfig;
            publishStatus(activeContext);

            if (ctx.hasUI) {
                ctx.ui.notify(`Verbosity indicator ${activeConfig.showIndicator ? "shown" : "hidden"}.`, "info");
            }
        },
    });

    pi.on("session_start", (_event, ctx) => {
        watcher?.close();
        refresh(ctx);
        try {
            // Watch the directory so atomic file replacements keep working.
            watcher = watch(path.dirname(configPath), { persistent: false }, (_event, filename) => {
                if (!activeContext || (filename && filename !== path.basename(configPath))) return;
                refresh(activeContext, true);
            });
            watcher.on("error", () => watcher?.close());
        } catch {
            // Native request/model/shortcut boundaries still refresh without a watcher.
        }
    });

    pi.on("model_select", (_event, ctx) => { refresh(ctx); });

    pi.on("session_shutdown", (_event, ctx) => {
        watcher?.close();
        watcher = undefined;
        activeContext = undefined;
        checkpoint = undefined;
        ctx.ui.setStatus("verbosity", undefined);
    });

    // Additive native event: older upstream hosts accept the registration but
    // never emit it. Keep the local signature compatible with their API types.
    const onCheckpoint = pi.on as unknown as (event: "session_checkpoint", handler: (event: {
        signal: AbortSignal;
        invalidate(): void;
    }) => Promise<{
        sleepReady: boolean;
        reason?: string;
    }>) => unknown;
    onCheckpoint("session_checkpoint", async (event) => {
        checkpoint = event;
        // Native ownership joins shortcuts; the watcher invalidates a held receipt
        // before accepting a new file snapshot. Never rewrite external edits here.
        let persisted: VerbosityConfig;
        try {
            persisted = readConfig(configPath);
        } catch {
            return { sleepReady: false, reason: "Verbosity config could not be read or parsed" };
        }
        return isDeepStrictEqual(persisted, activeConfig)
            ? { sleepReady: true }
            : { sleepReady: false, reason: "Verbosity config differs from active settings" };
    });

    pi.on("before_provider_request", (event, ctx) => {
        const verbosity = refresh(ctx);
        if (!verbosity) {
            return undefined;
        }

        return patchPayloadVerbosity(event.payload, verbosity);
    });
}
