function nodeIt(_name: string, fn: () => void): Promise<void> {
    fn();
    return Promise.resolve();
}

nodeIt("same-named local function is reported", () => {
    // Only node:test declarations qualify.
});
