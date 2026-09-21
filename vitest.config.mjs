import { fileURLToPath } from "node:url";

// Resolve SDK, TUI, AI and Vitest from this package's selected dependency graph.
// Compatibility runners install the official cohort or fork artifacts here.
export default {
    root: fileURLToPath(new URL(".", import.meta.url)),
    test: { include: ["index.test.ts"], fileParallelism: false, testTimeout: 15000 },
};
