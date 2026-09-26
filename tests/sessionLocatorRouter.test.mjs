import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionLocatorRouter } = loadTsCommonJs("src/main/sessions/SessionLocatorRouter.ts");

test("local and WSL locators resolve through the existing local history reader", () => {
	const router = new SessionLocatorRouter();
	assert.equal(router.resolveFilePath({ kind: "local", environment: "native", filePath: "C:/sessions/one.jsonl" }), "C:/sessions/one.jsonl");
	assert.equal(router.resolveFilePath({ kind: "local", environment: "wsl", filePath: "/home/dev/.pi/sessions/one.jsonl", wslDistro: "Ubuntu" }), "/home/dev/.pi/sessions/one.jsonl");
	assert.equal(router.resolveFilePath({ kind: "local", environment: "native" }), undefined);
});

test("catalog history routing uses stable session IDs and rejects SSH locators", () => {
	const router = new SessionLocatorRouter();
	const seen = [];
	const filePath = router.resolveSessionFilePath("session-a", {
		getLocator: (sessionId) => {
			seen.push(sessionId);
			return { kind: "local", environment: "native", filePath: "C:/sessions/a.jsonl" };
		},
	});
	assert.deepEqual(seen, ["session-a"]);
	assert.equal(filePath, "C:/sessions/a.jsonl");
	assert.throws(() => router.resolveSessionFilePath("session-ssh", { getLocator: () => ({ kind: "ssh", hostId: "host-a" }) }), /UNSUPPORTED_PROJECT_LOCATION/);
});

test("SSH session locations fail closed instead of becoming local file paths", () => {
	const router = new SessionLocatorRouter();
	assert.throws(() => router.resolveFilePath({ kind: "ssh", hostId: "host-a", remotePath: "/srv/.pi/sessions/one.jsonl", remoteSessionId: "session-a" }), /UNSUPPORTED_PROJECT_LOCATION/);
});
