import { describe as nodeDescribe, it as nodeIt } from "node:test";

nodeDescribe("suite registration is accepted", () => {
    nodeIt("suite-body registration is accepted", () => {
        // Nothing to run; the harness reads diagnostics only.
    });
});

nodeIt("top-level registration is accepted", () => {
    // Nothing to run; the harness reads diagnostics only.
});
