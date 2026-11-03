import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("root pool logs identify roots without paths, values or SSH arguments", () => {
	const lines = [];
	const { logRootPoolDiagnostic } = loadTsCommonJs("src/main/remote/RemoteRootPoolDiagnostics.ts", {
		stubs: {
			"../logging/sharedLogger": {
				getAppLogger: () => ({
					info: (...args) => {
						lines.push(args);
					},
				}),
			},
		},
	});
	const stats = { entries: 1, idle: 0, leased: 0, watched: 1, hits: 4, misses: 1, created: 1, retired: 0, evictedIdle: 0, waits: 0, waitCount: 0, waitTimeouts: 0, peakEntries: 1 };
	logRootPoolDiagnostic({ action: "sweep", before: stats, stats, roots: [{ hostId: "h", root: "/private/project", connectionId: "h#1#1", leases: 0, watchers: 1, state: "ready" }], creatingRoots: [{ hostId: "h", root: "/private/pending" }] });
	assert.equal(lines[0][0], "remote-root-pool");
	assert.equal(lines[0][2].roots[0].connectionId, "h#1#1");
	assert.equal(lines[0][2].roots[0].helpers, 1);
	assert.match(lines[0][2].roots[0].rootKey, /^[0-9a-f]{16}$/);
	assert.equal(JSON.stringify(lines).includes("/private/project"), false);
	assert.equal(JSON.stringify(lines).includes("/private/pending"), false);
	assert.deepEqual(lines[0][2].before, stats);
});
