import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const deploy = loadTsCommonJs("src/main/wsl/WslHelperDeploy.ts");
const entry = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const command = loadTsCommonJs("src/main/remote/RemoteHelperCommand.ts");

const WINDOWS = process.platform === "win32";
const NONCE = "0123456789abcdef0123456789abcdef";
const SOURCE = deploy.WSL_HELPER_DEPLOY_INLINE_SOURCE;
const REQUEST = deploy.buildWslHelperDeployRequest();
const HASH = REQUEST.bundleSha256;

/** 记录端口：证明 argv/stdin 形状与退出码映射，不真跑 wsl.exe。 */
function recordingExec(code, stdout = "") {
	const calls = [];
	return {
		calls,
		async exec(input) {
			calls.push(input);
			return { code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8") };
		},
	};
}

function deployedFrame(overrides = {}) {
	return JSON.stringify({ v: 1, op: "deployed", deployRoot: "/root/.pideck/remote-host", active: `./bundles/${HASH}`, bundleSha256: HASH, reused: false, nodeVersion: "v22.3.0", ...overrides });
}

test("deploy argv keeps distro/user/nonce out of the script and injects the probed node PATH", () => {
	const args = deploy.buildWslHelperDeployArgs({ distro: "Debian", user: "root;rm -rf ~", nodeBinDir: "/home/u/.nvm/versions/node/v22.3.0/bin", nonce: NONCE, bundleSha256: HASH });
	assert.deepEqual(Array.from(args.slice(0, 8)), ["-d", "Debian", "-u", "root;rm -rf ~", "-e", "/usr/bin/env", "PATH=/home/u/.nvm/versions/node/v22.3.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "node"]);
	assert.equal(args[8], "-e");
	assert.equal(args[9], SOURCE);
	assert.deepEqual(Array.from(args.slice(10)), ["--", deploy.WSL_HELPER_DEPLOY_INLINE_ENTRY, HASH, NONCE]);
	// 用户段只出现在 -u 的独立 argv 里：脚本本身不含它。
	assert.equal(SOURCE.includes("rm -rf"), false);

	// nodeBinDir 为 "/" 时不产生前导冒号（PATH 里空段等于当前目录）。
	const rooted = deploy.buildWslHelperDeployArgs({ distro: "Debian", user: "root", nodeBinDir: "/", nonce: NONCE, bundleSha256: HASH });
	assert.equal(rooted[6], "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
});

test("deploy argv refuses anything it cannot pass verbatim", () => {
	const base = { distro: "Debian", user: "root", nodeBinDir: "/usr/bin", nonce: NONCE, bundleSha256: HASH };
	for (const broken of [{ distro: "" }, { distro: "De\nbian" }, { user: "" }, { user: "ro\u0000ot" }, { nodeBinDir: "relative/bin" }, { nonce: "short" }, { nonce: "x".repeat(80) }, { bundleSha256: "abc" }]) {
		assert.throws(() => deploy.buildWslHelperDeployArgs({ ...base, ...broken }), { message: "WSL_HELPER_DEPLOY_INPUT_INVALID" }, JSON.stringify(broken));
	}
});

test("the frozen deploy body is one line, parses, and pins the deploy layout literals", () => {
	assert.equal(SOURCE.includes("\n"), false);
	assert.equal(SOURCE.includes("\r"), false);
	assert.doesNotThrow(() => new vm.Script(SOURCE));
	assert.ok(SOURCE.includes(deploy.WSL_HELPER_DEPLOY_INLINE_ENTRY));
	// 这些字面量与 main 侧常量必须一致：部署根、内容地址目录、staging 前缀。
	for (const literal of ['".pideck"', '"remote-host"', '"bundles"', '".staging-"']) {
		assert.ok(SOURCE.includes(literal), `missing ${literal}`);
	}
	// 首页从环境推导，不在 main 里拼第二遍。
	assert.ok(SOURCE.includes("process.env.HOME"));
});

test("the payload declares the frozen bundle identity with byte-proven bodies", () => {
	const payload = JSON.parse(REQUEST.payload);
	assert.equal(payload.v, 1);
	assert.equal(payload.op, "deploy");
	assert.equal(payload.bundleSha256, HASH);
	assert.match(HASH, /^[0-9a-f]{64}$/);
	// 名字来自冻结清单本身（排序后）：7 个 helper 产物 + runner 入口，没有第二份清单。
	assert.deepEqual(Array.from(payload.files.map((file) => file.name)), ["config.mjs", "git-read.mjs", "git-sync.mjs", "git-write.mjs", "helper.mjs", "runner.mjs", "search-content.mjs", "terminal-runner.mjs"]);
	for (const file of payload.files) {
		const bytes = Buffer.from(file.data, "base64");
		assert.equal(bytes.length, file.bytes, file.name);
		assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.name);
		// mode 是内容地址的一部分：冻结清单没有声明可执行文件。
		assert.equal(file.mode, "0600");
	}
	const helper = payload.files.find((file) => file.name === "helper.mjs");
	assert.equal(helper.sha256, entry.REMOTE_HELPER_ENTRY_SHA256);
	assert.equal(Buffer.from(helper.data, "base64").toString("utf8"), entry.REMOTE_HELPER_INLINE_SOURCE);
});

test("parses the deployed frame and refuses shapes it never emits", () => {
	const parsed = deploy.parseWslHelperDeployOutput(`${deployedFrame()}\n`);
	assert.equal(parsed.status, "deployed");
	assert.equal(parsed.deployment.deployRoot, "/root/.pideck/remote-host");
	assert.equal(parsed.deployment.active, `./bundles/${HASH}`);
	assert.equal(parsed.deployment.reused, false);

	// 部署根必须是绝对 POSIX 路径；active 必须就是本 bundle 的内容地址目录。
	assert.equal(deploy.parseWslHelperDeployOutput(deployedFrame({ deployRoot: "relative" })).code, "WSL_HELPER_DEPLOY_INTERNAL");
	assert.equal(deploy.parseWslHelperDeployOutput(deployedFrame({ deployRoot: "/root/../etc" })).code, "WSL_HELPER_DEPLOY_INTERNAL");
	assert.equal(deploy.parseWslHelperDeployOutput(deployedFrame({ active: `./bundles/${"0".repeat(64)}` })).code, "WSL_HELPER_DEPLOY_INTERNAL");
	assert.equal(deploy.parseWslHelperDeployOutput(deployedFrame({ bundleSha256: 1 })).code, "WSL_HELPER_DEPLOY_INTERNAL");

	// 闭集外的码折成 unavailable，而不是把脚本的自由文本带出来。
	assert.equal(deploy.parseWslHelperDeployOutput('{"v":1,"op":"error","code":"NOT_IN_THE_CLOSED_SET"}').code, "WSL_HELPER_DEPLOY_UNAVAILABLE");
	assert.equal(deploy.parseWslHelperDeployOutput('{"v":1,"op":"error","code":"WSL_HELPER_DEPLOY_ACTIVE_CONFLICT"}').code, "WSL_HELPER_DEPLOY_ACTIVE_CONFLICT");
	// 没有帧就是 unknown：调用方据此回 unavailable，不会把「什么都没说」当成成功。
	assert.equal(deploy.parseWslHelperDeployOutput("").status, "unknown");
	assert.equal(deploy.parseWslHelperDeployOutput("not json").status, "unknown");
	// 帧之前的噪音不影响结论。
	assert.equal(deploy.parseWslHelperDeployOutput(`(node warning)\n${deployedFrame()}`).status, "deployed");
});

test("deploy maps the script result onto a closed Op without trusting exit code alone", async () => {
	const input = { distro: "Debian", user: "root", nodeBinDir: "/usr/bin" };
	const ok = recordingExec(0, `${deployedFrame()}\n`);
	const deployed = await deploy.deployWslHelperBundle(input, { platform: "win32", exec: ok.exec, nonce: NONCE });
	assert.equal(deployed.ok, true);
	assert.equal(deployed.value.bundleSha256, HASH);
	assert.equal(deployed.value.reused, false);
	assert.equal(ok.calls.length, 1);
	assert.equal(ok.calls[0].stdin, REQUEST.payload);
	assert.equal(ok.calls[0].args[9], SOURCE);

	// 已激活过：reused 原样透出，调用方据此跳过任何写入确认。
	const reused = await deploy.deployWslHelperBundle(input, { platform: "win32", exec: recordingExec(0, `${deployedFrame({ reused: true })}\n`).exec, nonce: NONCE });
	assert.equal(reused.ok, true);
	assert.equal(reused.value.reused, true);

	// 脚本明确拒绝：码原样回去，退出码不改变这个结论。
	for (const [code, exit] of [
		["WSL_HELPER_DEPLOY_ACTIVE_CONFLICT", 1],
		["WSL_HELPER_DEPLOY_FILE_MISMATCH", 0],
	]) {
		const rejected = await deploy.deployWslHelperBundle(input, { platform: "win32", exec: recordingExec(exit, `{"v":1,"op":"error","code":"${code}"}\n`).exec, nonce: NONCE });
		assert.equal(rejected.ok, false);
		assert.equal(rejected.code, code);
		assert.equal(rejected.outcome, "rejected");
	}

	// 非零退出且没有结论帧：一律 unavailable，绝不把「可能写了一半」当成功。
	for (const [exit, stdout] of [
		[1, ""],
		[137, "(killed)"],
		[1, `${deployedFrame()}\n`],
	]) {
		const rejected = await deploy.deployWslHelperBundle(input, { platform: "win32", exec: recordingExec(exit, stdout).exec, nonce: NONCE });
		assert.equal(rejected.ok, false);
		assert.equal(rejected.code, "WSL_HELPER_DEPLOY_UNAVAILABLE", `exit ${exit}`);
	}

	// node 版本门槛沿用 SSH 的同一个判定函数与同一个码。
	const oldNode = await deploy.deployWslHelperBundle(input, { platform: "win32", exec: recordingExec(0, `${deployedFrame({ nodeVersion: "v20.11.0" })}\n`).exec, nonce: NONCE });
	assert.equal(oldNode.ok, false);
	assert.equal(oldNode.code, "REMOTE_NODE_VERSION_UNSUPPORTED");

	// spawn 失败 / 非 Windows：都是 unavailable，且不产生一次「假装跑过」的调用。
	const throwing = {
		calls: [],
		async exec() {
			this.calls.push(1);
			throw new Error("spawn ENOENT");
		},
	};
	const spawnFailed = await deploy.deployWslHelperBundle(input, { platform: "win32", exec: throwing.exec.bind(throwing), nonce: NONCE });
	assert.equal(spawnFailed.ok, false);
	assert.equal(spawnFailed.code, "WSL_HELPER_DEPLOY_UNAVAILABLE");
	const notWindows = recordingExec(0, `${deployedFrame()}\n`);
	const unavailable = await deploy.deployWslHelperBundle(input, { platform: "linux", exec: notWindows.exec, nonce: NONCE });
	assert.equal(unavailable.code, "WSL_HELPER_DEPLOY_UNAVAILABLE");
	assert.equal(notWindows.calls.length, 0);

	const badBin = await deploy.deployWslHelperBundle({ ...input, nodeBinDir: "relative" }, { platform: "win32", exec: ok.exec, nonce: NONCE });
	assert.equal(badBin.code, "WSL_HELPER_DEPLOY_INPUT_INVALID");
});

/**
 * 真实子进程：在 POSIX 主机上用本机 node 跑冻结体本身。
 * win32 跳过——部署根来自 `$HOME` 且必须是绝对 POSIX 路径，Windows 的盘符路径会被脚本按设计拒绝
 * （与 `remoteBootstrapSessionIntegration` 同一条跳过理由）。
 */
test("the frozen body deploys, re-verifies and refuses tampering on a real filesystem", { skip: WINDOWS ? "the deploy root is a POSIX $HOME path" : false }, () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-deploy-"));
	const raw = (payload, env = { HOME: home }, argv = [deploy.WSL_HELPER_DEPLOY_INLINE_ENTRY, HASH, NONCE]) => {
		try {
			return { code: 0, stdout: execFileSync(process.execPath, ["-e", SOURCE, "--", ...argv], { input: payload, env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000 }) };
		} catch (error) {
			return { code: typeof error.status === "number" ? error.status : -1, stdout: String(error.stdout ?? "") };
		}
	};
	const run = (payload, env, argv) => {
		const result = raw(payload, env, argv);
		return { code: result.code, frame: result.stdout.trim() === "" ? null : JSON.parse(result.stdout) };
	};
	try {
		const first = run(REQUEST.payload);
		assert.equal(first.code, 0);
		assert.equal(first.frame.op, "deployed");
		assert.equal(first.frame.reused, false);
		assert.equal(first.frame.deployRoot, `${home}/.pideck/remote-host`);
		assert.equal(first.frame.active, `./bundles/${HASH}`);
		assert.equal(first.frame.nodeVersion, process.version);

		// 落盘形状正是 helper 的 readDeployFacts 要求的那一段：<deployRoot>/bundles/<64hex>/helper.mjs。
		const bundleDir = `${home}/.pideck/remote-host/bundles/${HASH}`;
		assert.equal(command.resolveHelperEntryPath({ deployRoot: first.frame.deployRoot, bundleSha256: HASH, entryName: "helper.mjs" }), `${bundleDir}/helper.mjs`);
		const payload = JSON.parse(REQUEST.payload);
		for (const file of payload.files) {
			const path = `${bundleDir}/${file.name}`;
			assert.equal(statSync(path).mode & 0o777, 0o600, file.name);
			assert.deepEqual(readFileSync(path), Buffer.from(file.data, "base64"), file.name);
		}
		assert.equal(statSync(`${home}/.pideck`).mode & 0o077, 0);
		assert.equal(statSync(`${home}/.pideck/remote-host`).mode & 0o077, 0);
		assert.deepEqual(readFileSync(`${bundleDir}/helper.mjs`, "utf8"), entry.REMOTE_HELPER_INLINE_SOURCE);

		// 幂等：同一内容地址再跑一次只做只读复核，不重写。
		const again = run(REQUEST.payload);
		assert.deepEqual([again.code, again.frame.op, again.frame.reused], [0, "deployed", true]);

		// 已激活目录被动过：conflict，且不覆盖、不修复。
		writeFileSync(`${bundleDir}/helper.mjs`, "tampered", { mode: 0o600 });
		const conflict = run(REQUEST.payload);
		assert.deepEqual([conflict.code, conflict.frame.op, conflict.frame.code], [1, "error", "WSL_HELPER_DEPLOY_ACTIVE_CONFLICT"]);
		assert.equal(readFileSync(`${bundleDir}/helper.mjs`, "utf8"), "tampered");

		// 声明的摘要与字节不符：写前拒绝，发行版里不留半份内容。
		const forged = JSON.parse(REQUEST.payload);
		forged.files[0].data = Buffer.from("not the reviewed file").toString("base64");
		const mismatchHome = mkdtempSync(join(tmpdir(), "pideck-wsl-deploy-forged-"));
		const mismatch = run(JSON.stringify(forged), { HOME: mismatchHome });
		assert.deepEqual([mismatch.code, mismatch.frame.op, mismatch.frame.code], [1, "error", "WSL_HELPER_DEPLOY_FILE_MISMATCH"]);
		assert.deepEqual(Array.from(readdirSync(mismatchHome)), []);
		rmSync(mismatchHome, { recursive: true, force: true });

		// HOME 不可用：回 homeInvalid，而不会写进当前目录。
		assert.equal(run(REQUEST.payload, { HOME: "relative" }).frame.code, "WSL_HELPER_DEPLOY_HOME_INVALID");
		assert.equal(run(REQUEST.payload, { HOME: "/" }).frame.code, "WSL_HELPER_DEPLOY_HOME_INVALID");

		// 已被别人占用的 .pideck（组/其他人可读）：拒绝而不是 chmod 用户的目录。
		const sharedHome = mkdtempSync(join(tmpdir(), "pideck-wsl-deploy-shared-"));
		mkdirSync(`${sharedHome}/.pideck`, { mode: 0o755 });
		chmodSync(`${sharedHome}/.pideck`, 0o755);
		assert.equal(run(REQUEST.payload, { HOME: sharedHome }).frame.code, "WSL_HELPER_DEPLOY_HOME_INVALID");
		rmSync(sharedHome, { recursive: true, force: true });

		// 只有固定入口 token 被接受（其余参数不改变这个判断）。
		const argvFailure = run(REQUEST.payload, { HOME: home }, ["--other-entry", HASH, NONCE]);
		assert.deepEqual([argvFailure.code, argvFailure.frame.op, argvFailure.frame.code], [1, "error", "WSL_HELPER_DEPLOY_INPUT_INVALID"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
