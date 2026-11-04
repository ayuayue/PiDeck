import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const sessionModule = loadTsCommonJs("src/main/wsl/WslHelperSession.ts");
const { WSL_HELPER_SESSION_CODES } = loadTsCommonJs("src/shared/types/wslHelper.ts");

const TARGET = { distro: "Debian", user: "root", root: "/root/project" };
const DEPLOYMENT = { deployRoot: "/root/.pideck/remote-host", active: `./bundles/${"a".repeat(64)}`, bundleSha256: "a".repeat(64), reused: false, nodeVersion: "v24.18.0" };

/** 假 helper：只实现 hello 与一个回显方法，帧形状严格按协议。 */
function fakeHelper() {
	const written = [];
	const child = {
		killed: false,
		exitHandlers: [],
		stdin: new Writable({
			write(chunk, _encoding, callback) {
				const line = chunk.toString("utf8");
				written.push(line);
				const frame = JSON.parse(line);
				queueMicrotask(() => {
					if (frame.method === "hello") {
						child.stdout.write(
							`${JSON.stringify({ v: 1, hostId: frame.hostId, generation: frame.generation, id: frame.id, ok: true, result: { protocolVersion: 1, platform: "linux", arch: "x64", home: "/root", root: TARGET.root, capabilities: ["echo", "fs.stat", "fs.list", "fs.read"], helperVersion: "1.25.1", nodeVersion: "24.18.0", pid: 42 } })}\n`,
						);
						return;
					}
					child.stdout.write(`${JSON.stringify({ v: 1, hostId: frame.hostId, generation: frame.generation, id: frame.id, ok: true, result: { echoed: frame.method } })}\n`);
				});
				callback();
			},
		}),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		on(event, listener) {
			if (event === "exit") child.exitHandlers.push(listener);
			return child;
		},
		kill() {
			child.killed = true;
			return true;
		},
		exit() {
			for (const listener of child.exitHandlers) listener(0, null);
		},
		written,
	};
	return child;
}

function makePool(overrides = {}) {
	const children = [];
	const spawnCalls = [];
	const pool = sessionModule.createWslHelperSessionPool({
		platform: "win32",
		lookupNodeBinDir: async () => "/usr/local/bin",
		deploy: async () => ({ ok: true, value: DEPLOYMENT }),
		spawn: (input) => {
			spawnCalls.push(input);
			const child = fakeHelper();
			children.push(child);
			return child;
		},
		handshakeTimeoutMs: 2_000,
		...overrides,
	});
	return { pool, children, spawnCalls };
}

test("launch argv injects the probed node PATH and keeps the root as its own argv token", () => {
	const args = sessionModule.buildWslHelperLaunchArgs({ distro: "Debian", user: "root", nodeBinDir: "/usr/local/bin", deployRoot: "/root/.pideck/remote-host", bundleSha256: "b".repeat(64), root: "/root/ba;cli $(rm -rf /)" });
	assert.deepEqual(Array.from(args.slice(0, 6)), ["-d", "Debian", "-u", "root", "-e", "/usr/bin/env"]);
	assert.equal(args[6], `PATH=/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);
	assert.equal(args[7], "node");
	assert.equal(args[8], `/root/.pideck/remote-host/bundles/${"b".repeat(64)}/helper.mjs`);
	assert.equal(args[9], "--root");
	assert.equal(args[10], "/root/ba;cli $(rm -rf /)");
	// node 已在系统 bin：不前置任何目录，仍保留基础 PATH。
	const systemNode = sessionModule.buildWslHelperLaunchArgs({ distro: "Debian", user: "me", nodeBinDir: "/", deployRoot: "/home/me/.pideck/remote-host", bundleSha256: "c".repeat(64), root: "/home/me/p" });
	assert.equal(systemNode[6], "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
});

test("launch argv refuses unusable targets before anything is spawned", () => {
	for (const root of ["", "/", "/root/", "root/rel", "/root/" + String.fromCharCode(0) + "x"]) {
		assert.throws(() => sessionModule.buildWslHelperLaunchArgs({ distro: "Debian", user: "root", nodeBinDir: "/usr", deployRoot: "/root/.pideck/remote-host", bundleSha256: "b".repeat(64), root }), /WSL_HELPER_SESSION_INPUT_INVALID/);
	}
	assert.throws(() => sessionModule.buildWslHelperLaunchArgs({ distro: "", user: "root", nodeBinDir: "/usr", deployRoot: "/root/.pideck/remote-host", bundleSha256: "b".repeat(64), root: "/root/p" }), /WSL_HELPER_SESSION_INPUT_INVALID/);
	// nodeBinDir 必须是 Linux 绝对路径：相对值会让 PATH 前置到 wsl.exe 的工作目录。
	assert.throws(() => sessionModule.buildWslHelperLaunchArgs({ distro: "Debian", user: "root", nodeBinDir: "usr/bin", deployRoot: "/root/.pideck/remote-host", bundleSha256: "b".repeat(64), root: "/root/p" }), /WSL_HELPER_SESSION_INPUT_INVALID/);
});

test("the pool connects once per target, reuses the session and reports request ids", async () => {
	const { pool, spawnCalls } = makePool();
	const ids = [];
	const first = await pool.request(TARGET, "echo", { text: "a" }, { onRequestId: (id) => ids.push(id) });
	assert.equal(JSON.stringify(first), JSON.stringify({ echoed: "echo" }));
	const second = await pool.request(TARGET, "fs.list", { path: "." });
	assert.equal(JSON.stringify(second), JSON.stringify({ echoed: "fs.list" }));
	assert.equal(spawnCalls.length, 1);
	// 帧 id 由客户端 mint：回报值必须是它同意接受取消的形状。
	assert.equal(ids.length, 1);
	assert.match(ids[0], /^req-\d+$/);
	assert.equal(pool.activeCount(), 1);
	pool.closeAll();
	assert.equal(pool.activeCount(), 0);
});

test("two concurrent first requests share one spawn", async () => {
	const { pool, spawnCalls } = makePool();
	const [a, b] = await Promise.all([pool.request(TARGET, "echo"), pool.request(TARGET, "echo")]);
	assert.equal(JSON.stringify(a), JSON.stringify({ echoed: "echo" }));
	assert.equal(JSON.stringify(b), JSON.stringify({ echoed: "echo" }));
	assert.equal(spawnCalls.length, 1);
	pool.closeAll();
});

test("a helper with the wrong protocol, root or capabilities never becomes a session", async () => {
	const cases = [
		["protocol", { protocolVersion: 2 }, WSL_HELPER_SESSION_CODES.protocolMismatch],
		["root", { root: "/root/other" }, WSL_HELPER_SESSION_CODES.rootMismatch],
		["capabilities", { capabilities: ["fs.list", "fs.read"] }, WSL_HELPER_SESSION_CODES.capabilityMissing],
		["shape", { home: 7 }, WSL_HELPER_SESSION_CODES.handshakeInvalid],
	];
	for (const [label, patch, code] of cases) {
		const { pool, children } = makePool({
			spawn: () => {
				const child = fakeHelper();
				const original = child.stdin;
				child.stdin = new Writable({
					write(chunk, _encoding, callback) {
						const frame = JSON.parse(chunk.toString("utf8"));
						queueMicrotask(() => {
							child.stdout.write(`${JSON.stringify({ v: 1, hostId: frame.hostId, generation: frame.generation, id: frame.id, ok: true, result: { protocolVersion: 1, platform: "linux", arch: "x64", home: "/root", root: TARGET.root, capabilities: ["echo", "fs.stat", "fs.list", "fs.read"], ...patch } })}\n`);
						});
						callback();
					},
				});
				void original;
				children.push(child);
				return child;
			},
		});
		await assert.rejects(pool.request(TARGET, "fs.list", { path: "." }), new RegExp(code), label);
		assert.equal(children.at(-1).killed, true, `${label}: the refused process must be killed`);
		assert.equal(pool.activeCount(), 0, `${label}: nothing entered the pool`);
	}
});

test("deploy and node failures surface as their own stable codes", async () => {
	const noNode = makePool({ lookupNodeBinDir: async () => undefined });
	let deployed = false;
	const deployCalls = makePool({
		deploy: async () => {
			deployed = true;
			return { ok: true, value: DEPLOYMENT };
		},
	});
	await assert.rejects(noNode.pool.request(TARGET, "fs.list", { path: "." }), new RegExp(WSL_HELPER_SESSION_CODES.nodeMissing));
	assert.equal(noNode.spawnCalls.length, 0);
	await deployCalls.pool.request(TARGET, "fs.list", { path: "." });
	assert.equal(deployCalls.spawnCalls.length, 1);
	assert.equal(deployed, true);
	deployCalls.pool.closeAll();

	const deployFailed = makePool({ deploy: async () => ({ ok: false, code: "WSL_HELPER_DEPLOY_UNAVAILABLE" }) });
	await assert.rejects(deployFailed.pool.request(TARGET, "fs.list", { path: "." }), /WSL_HELPER_DEPLOY_UNAVAILABLE/);
	assert.equal(deployFailed.spawnCalls.length, 0);

	const spawnThrows = makePool({
		spawn: () => {
			throw new Error("EPERM");
		},
	});
	await assert.rejects(spawnThrows.pool.request(TARGET, "fs.list", { path: "." }), new RegExp(WSL_HELPER_SESSION_CODES.unavailable));

	const notWindows = makePool({ platform: "linux" });
	await assert.rejects(notWindows.pool.request(TARGET, "fs.list", { path: "." }), new RegExp(WSL_HELPER_SESSION_CODES.unavailable));
	assert.equal(notWindows.spawnCalls.length, 0);
});

test("invalid targets never reach the deploy or spawn path", async () => {
	const { pool, spawnCalls } = makePool();
	await assert.rejects(pool.request({ distro: "Debian", user: "root", root: "/" }, "fs.list"), new RegExp(WSL_HELPER_SESSION_CODES.inputInvalid));
	await assert.rejects(pool.request({ distro: "", user: "root", root: "/root/p" }, "fs.list"), new RegExp(WSL_HELPER_SESSION_CODES.inputInvalid));
	assert.equal(spawnCalls.length, 0);
});

test("an exited helper leaves the pool and the next request respawns", async () => {
	const { pool, children, spawnCalls } = makePool();
	await pool.request(TARGET, "echo");
	assert.equal(pool.activeCount(), 1);
	children[0].exit();
	assert.equal(pool.activeCount(), 0);
	await pool.request(TARGET, "echo");
	assert.equal(spawnCalls.length, 2);
	pool.closeAll();
});
