import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Use one normally installed/built Pi source host for both SDK and test runner.
// No extension-local dependencies or hand-made node_modules links are needed.
if (!process.env.PI_HOST_ROOT) {
    throw new Error("Set PI_HOST_ROOT to a Pi source checkout with npm ci and npm run build completed");
}
const host = path.resolve(process.env.PI_HOST_ROOT);

export default {
    root: fileURLToPath(new URL(".", import.meta.url)),
    cacheDir: path.join(os.tmpdir(), "pi-verbosity-control-vite"),
    resolve: { alias: [
        { find: /^@earendil-works\/pi-coding-agent$/, replacement: `${host}/packages/coding-agent/dist/index.js` },
        { find: /^@earendil-works\/pi-ai$/, replacement: `${host}/packages/ai/dist/index.js` },
        { find: /^@earendil-works\/pi-tui$/, replacement: `${host}/packages/tui/dist/index.js` },
        { find: /^vitest$/, replacement: `${host}/node_modules/vitest/dist/index.js` },
    ] },
    test: { include: ["index.test.ts"], fileParallelism: false, testTimeout: 15000 },
};
