import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemotePiResourceBackend } = loadTsCommonJs("src/main/config/RemotePiResourceBackend.ts", {
	stubs: {
		"../extensions/piExtensionCatalog": {
			parsePiListOutput: () => [
				{ id: "user:npm:example", source: "npm:example", scope: "user", path: "/home/test/.pi/agent/npm/node_modules/example" },
				{ id: "user:npm:@scope/other", source: "npm:@scope/other", scope: "user", path: "/home/test/.pi/agent/npm/node_modules/@scope/other" },
			],
		},
		"../pi/piSelfUpdateRunner": { supportsPiSelfUpdate: () => false },
	},
});
const { REMOTE_EXTENSION_VERSION_SCRIPT } = loadTsCommonJs("src/main/config/remoteExtensionVersions.ts");
const HOST = "11111111-1111-4111-8111-111111111111";
const listOutput = "User packages:\n  npm:example\n    /home/test/.pi/agent/npm/node_modules/example\n  npm:@scope/other\n    /home/test/.pi/agent/npm/node_modules/@scope/other\n";

function backendWith(run) {
	return createRemotePiResourceBackend({
		request: async () => ({}),
		requestProject: async () => ({}),
		resolveProject: async () => ({ code: "missing" }),
		resolveFacts: async () => ({ home: "/home/test", nodePath: "/usr/bin/node", piPath: "/usr/bin/pi", version: "1.5.2" }),
		run,
	});
}

test("remote package list adds independently retrieved versions and update status", async () => {
	const commands = [];
	const backend = backendWith(async (input) => {
		commands.push(input);
		return commands.length === 1 ? { exitCode: 0, stdout: listOutput } : { exitCode: 0, stdout: JSON.stringify([{ currentVersion: "1.0.0", latestVersion: "1.2.0" }, { currentVersion: "2.0.0" }]) };
	});
	const result = await backend.execute(HOST, { action: "packages", operation: "list" });
	assert.equal(result.extensions[0].currentVersion, "1.0.0");
	assert.equal(result.extensions[0].latestVersion, "1.2.0");
	assert.equal(result.extensions[0].hasUpdate, true);
	assert.equal(result.extensions[1].currentVersion, "2.0.0");
	assert.equal(result.extensions[1].latestVersion, undefined);
	assert.ok(commands.every((item) => item.hostId === HOST));
});

test("the remote script reads each manifest and keeps it when npm fails", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-remote-versions-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const first = join(dir, "first");
	const second = join(dir, "second");
	mkdirSync(first);
	mkdirSync(second);
	writeFileSync(join(first, "package.json"), JSON.stringify({ version: "1.0.0" }));
	writeFileSync(join(second, "package.json"), JSON.stringify({ version: "2.0.0" }));
	const npm = join(dir, "npm.cjs");
	writeFileSync(npm, 'if (process.argv[3] === "example") console.log("1.2.0"); else process.exitCode = 1;');
	const entries = [{ path: first, packageName: "example" }, { path: second, packageName: "unavailable" }, { path: join(dir, "missing") }];
	const payload = Buffer.from(JSON.stringify(entries)).toString("base64");
	const output = execFileSync(process.execPath, ["-e", REMOTE_EXTENSION_VERSION_SCRIPT, payload, npm], { encoding: "utf8", timeout: 10000 });
	assert.deepEqual(JSON.parse(output), [{ currentVersion: "1.0.0", latestVersion: "1.2.0" }, { currentVersion: "2.0.0" }, {}]);
});

test("the remote script allows a slow npm query to finish", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-remote-slow-version-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const npm = join(dir, "npm.cjs");
	writeFileSync(npm, 'setTimeout(() => console.log("1.2.0"), 9000);');
	const payload = Buffer.from(JSON.stringify([{ packageName: "example" }])).toString("base64");
	const { stdout } = await promisify(execFile)(process.execPath, ["-e", REMOTE_EXTENSION_VERSION_SCRIPT, payload, npm], { encoding: "utf8", timeout: 15000 });
	assert.deepEqual(JSON.parse(stdout), [{ latestVersion: "1.2.0" }]);
});

test("lightweight list skips remote version checks", async () => {
	let count = 0;
	const backend = backendWith(async () => {
		count++;
		return { exitCode: 0, stdout: listOutput };
	});
	const result = await backend.execute(HOST, { action: "packages", operation: "list", includeVersions: false });
	assert.equal(result.extensions.length, 2);
	assert.equal(count, 1);
	await assert.rejects(() => backend.execute(HOST, { action: "packages", operation: "update", includeVersions: false }), /PI_RESOURCE_TARGET_INVALID/);
});

test("a failed remote version lookup preserves the package list", async () => {
	let count = 0;
	const backend = backendWith(async () => (++count === 1 ? { exitCode: 0, stdout: listOutput } : Promise.reject(new Error("offline"))));
	const result = await backend.execute(HOST, { action: "packages", operation: "list" });
	assert.equal(result.extensions.length, 2);
	assert.equal(result.extensions[0].currentVersion, undefined);
});
