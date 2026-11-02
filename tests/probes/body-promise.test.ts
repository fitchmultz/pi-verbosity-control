import { probeHelper } from "./helper.ts";
import { it as nodeIt } from "node:test";

nodeIt("floating promise inside a test body is reported", () => {
    probeHelper();
});
