import { it as nodeIt } from "node:test";

nodeIt("unawaited subtest registration is reported", async (t) => {
    t.test("nested unawaited registration", () => {
        // Nothing to run; the harness reads diagnostics only.
    });
});
