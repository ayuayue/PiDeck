import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { createLabFeed, buildLabConfig, BUNDLE_ID, FEED_URL } from "../scripts/mac-upgrade-lab.mjs";
import fs from "node:fs";

const bootstrap = await readFile(new URL("../scripts/mac-upgrade-lab-bootstrap.cjs", import.meta.url), "utf8");

test("lab bootstrap isolates home and all Electron data before loading PiDeck, including a relaunch without environment flags", async (t) => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pideck-lab-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, "mac-upgrade-lab-root.json"), JSON.stringify({ bundleId: BUNDLE_ID }));
	for (let launch = 0; launch < 2; launch++) {
		const app = new EventEmitter();
		const paths = {};
		Object.assign(app, { setPath: (key, value) => (paths[key] = value), getPath: (key) => paths[key], getVersion: () => `0.0.${launch + 1}`, whenReady: () => Promise.resolve(), commandLine: { appendSwitch() {} } });
		const os = { homedir: () => "/real-home" };
		const process = { env: { HOME: "/real-home", PIDEK_UPDATE_FEED_URL: "https://production.invalid" }, pid: launch, execPath: "/test/PiDeck.app" };
		let loaded = false;
		vm.runInNewContext(bootstrap, {
			URL,
			process,
			require(name) {
				if (name === "electron") return { app };
				if (name === "electron-updater") return { autoUpdater: new EventEmitter() };
				if (name === "node:module") return { syncBuiltinESMExports() {} };
				if (name === "node:os") return os;
				if (name === "node:fs") return fs;
				if (name === "node:path") return path;
				if (name === "./mac-upgrade-lab.json") return { root, bundleId: BUNDLE_ID, feedUrl: FEED_URL };
				if (name === "./index.js") {
					assert.equal(os.homedir(), path.join(root, "home"));
					assert.equal(process.env.HOME, "/real-home");
					assert.equal(process.env.PIDEK_UPDATE_FEED_URL, FEED_URL);
					assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, "home/.pi/agent"));
					assert.equal(paths.userData, path.join(root, "user-data"));
					assert.equal(app.setAsDefaultProtocolClient("pideck"), false);
					loaded = true;
					return {};
				}
				throw new Error(name);
			},
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(loaded, true);
	}
	const records = (await readFile(path.join(root, "evidence/runtime.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
	assert.deepEqual(
		records.filter((r) => r.event === "ready").map((r) => r.version),
		["0.0.1", "0.0.2"],
	);
});

test("lab bootstrap refuses an unprepared root or a remote update feed before touching application data", () => {
	for (const feedUrl of [FEED_URL, "https://github.com/production"]) {
		assert.throws(
			() =>
				vm.runInNewContext(bootstrap, {
					URL,
					require(name) {
						if (name === "node:fs") return fs;
						if (name === "node:path") return path;
						if (name === "node:os") return {};
						if (name === "node:module") return {};
						if (name === "electron") return { app: {} };
						if (name === "./mac-upgrade-lab.json") return { root: "/nonexistent-pideck-upgrade-lab", bundleId: BUNDLE_ID, feedUrl };
						throw new Error(name);
					},
				}),
			/ENOENT|loopback/,
		);
	}
});

test("test packages retain a separate bundle identity and generic loopback feed", () => {
	const config = buildLabConfig({ source: path.resolve("."), output: "/tmp/lab-build", version: "0.0.2", env: { CSC_NAME: "Example (TEAM)", APPLE_KEYCHAIN_PROFILE: "lab" } });
	assert.equal(config.appId, BUNDLE_ID);
	assert.deepEqual(config.publish, { provider: "generic", url: FEED_URL, channel: "latest" });
	assert.equal(config.forceCodeSigning, true);
	assert.equal(config.mac.notarize, true);
	assert.deepEqual(config.protocols, []);
	assert.equal(config.extraMetadata.main, "out/main/mac-upgrade-lab-bootstrap.cjs");
});

test("real artifact feed supports HEAD/ranges and refuses traversal or unlisted files", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pideck-feed-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, "latest-mac.yml"), "version: 0.0.2\n");
	await writeFile(path.join(root, "app.zip"), "0123456789");
	await writeFile(path.join(root, "private.txt"), "not an artifact");
	const server = await createLabFeed(root);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const base = `http://127.0.0.1:${server.address().port}`;
	const response = await fetch(`${base}/app.zip`, { headers: { Range: "bytes=3-6" } });
	assert.equal(response.status, 206);
	assert.equal(response.headers.get("content-range"), "bytes 3-6/10");
	assert.equal(await response.text(), "3456");
	assert.equal((await fetch(`${base}/app.zip`, { method: "HEAD" })).headers.get("content-length"), "10");
	assert.equal((await fetch(`${base}/app.zip`, { headers: { Range: "bytes=100-" } })).status, 416);
	assert.equal((await fetch(`${base}/private.txt`)).status, 404);
	assert.equal((await fetch(`${base}/%2e%2e%2fprivate.txt`)).status, 404);
});
