/**
 * 技能商店安装链路测试：输出→进度解析、失败原因清洗、代理 env、spawn 执行器，以及链路契约扫描。
 *
 * 背景（用户反馈「商店加载会阻塞主进程卡死、没有下载进度」）：
 * - 搜索走裸全局 fetch（undici 不读系统代理/Electron 代理）→ 需要代理的网络上挂到超时；
 * - 安装走 execFile → 30s 冷安装期间界面零信息，且 stdout（CLI 真实报错所在）被丢弃；
 * - 安装子进程的 git clone 不认 Chromium 代理 → 无代理必失败。
 * 本文件把这三点的修复固化为契约，防止回退到 execFile/裸 fetch。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const progressModule = loadTsCommonJs("src/main/skills/skillHubInstallProgress.ts");
const proxyModule = loadTsCommonJs("src/main/skills/skillHubInstallProxy.ts");
const runnerModule = loadTsCommonJs("src/main/skills/skillHubInstallRunner.ts");

// ── 进度解析 ─────────────────────────────────────────────

test("进度解析：npm 拉 cli → clone → 写入，阶段按顺序推进", () => {
	const parser = progressModule.createInstallProgressParser({ minIntervalMs: 0 });
	const phases = [];
	const collect = (chunk) => {
		const update = parser.push(chunk);
		if (update) phases.push(update.phase);
	};
	collect("npm warn exec The following package was not found and will be installed: skills@1.7.2\n");
	collect("Cloning repository https://github.com/anthropics/skills.git\n");
	collect("Installing pdf skill to /home/u/.pi/agent/skills\n");
	assert.deepEqual([...phases], ["preparing", "downloading", "installing"]);
});

test("进度解析：CR 原地刷新的 git 进度行也能解析出百分比", () => {
	const parser = progressModule.createInstallProgressParser({ minIntervalMs: 0 });
	parser.push("Cloning repository https://github.com/anthropics/skills.git\n");
	// git 的进度条用 CR 刷新，只按 LF 切分会把整段进度憋到进程结束
	const update = parser.push("Receiving objects:  45% (450/1000), 1.2 MiB | 3.4 MiB/s\r");
	assert.equal(update.phase, "downloading");
	assert.equal(update.percent, 45);
});

test("进度解析：ANSI 光标重画（skills 的 spinner）不把多帧拼成一行", () => {
	// 实测输出形态：ESC[2K 清行 + ESC[1G 回列首 + 一帧文字，帧间既无 CR 也无 LF，
	// 旧实现去掉转义后会得到「◒ Cloning…◐ Cloning…◓ Discovering…」这样的一行。
	const parser = progressModule.createInstallProgressParser({ minIntervalMs: 0 });
	const emitted = [];
	const feed = (chunk) => {
		const update = parser.push(chunk);
		if (update) emitted.push(update);
	};
	feed("\u001b[2K\u001b[1G◒  Cloning repository…\u001b[2K\u001b[1G◐  Cloning repository…\u001b[2K\u001b[1G◓  Discovering skills…");
	feed("\n");
	assert.equal(emitted.map((update) => update.detail).join("|"), "Cloning repository…|Discovering skills…");
	for (const update of emitted) {
		assert.ok(!/[\u25A0-\u25FF\u2800-\u28FF]/u.test(update.detail), `detail 残留 spinner 字形: ${update.detail}`);
	}
});

test("进度解析：ANSI 转义与 spinner 帧不污染 detail，且百分比不倒退", () => {
	const parser = progressModule.createInstallProgressParser({ minIntervalMs: 0 });
	const cloning = parser.push("\u001b[36m⠋\u001b[39m Cloning repository https://github.com/a/b.git\n");
	assert.equal(cloning.detail, "Cloning repository https://github.com/a/b.git");
	parser.push("Receiving objects: 80% (800/1000)\r");
	// Resolving deltas 行本身没有百分比，不能把进度倒回 0/undefined
	const after = parser.push("Resolving deltas:  100% (12/12)\r");
	assert.equal(after.percent, 100);
	const plain = parser.push("Resolving deltas done, writing files\n");
	assert.equal(plain.percent, 100);
});

test("失败原因清洗：优先取 stdout 尾部（CLI 真实报错），不被 npm warn 盖住", () => {
	const stdout =
		"npm warn exec The following package was not found and will be installed: skills@1.7.2\n\u001b[36m⠋\u001b[39m Cloning repository https://github.com/anthropics/skills.git\nFailed to clone https://github.com/anthropics/skills.git: Cloning into 'C:\\Temp\\skills-1XqGZ7'...\nfatal: unable to access 'https://github.com/anthropics/skills.git/': Recv failure: Connection was reset\n";
	const stderr = "npm warn using --force\nnpm notice\n";
	const cleaned = progressModule.cleanInstallOutput({ stdout, stderr, fallback: "Command failed: npx" });
	assert.match(cleaned, /fatal: unable to access/);
	assert.match(cleaned, /Command failed: npx/);
	assert.ok(!cleaned.includes("npm notice"), cleaned);
});

test("失败原因：无 stdout 时退回 stderr，再退回兜底串并截断", () => {
	const onlyStderr = progressModule.cleanInstallOutput({ stdout: "", stderr: "npm error EACCES\n", fallback: "exit 1" });
	assert.match(onlyStderr, /npm error EACCES/);
	const onlyFallback = progressModule.cleanInstallOutput({ stdout: "\n\n", stderr: "", fallback: "安装超时（120 秒）" });
	assert.equal(onlyFallback, "安装超时（120 秒）");
	const truncated = progressModule.cleanInstallOutput({ stdout: "x".repeat(500), stderr: "", fallback: "" });
	assert.ok(truncated.length <= 301, `长度 ${truncated.length}`);
});

test("网络失败识别：git 的 Connection reset / unable to access 命中，普通权限错误不命中", () => {
	assert.equal(progressModule.isNetworkFailure("fatal: unable to access 'https://github.com/a/b/': Recv failure: Connection was reset"), true);
	assert.equal(progressModule.isNetworkFailure("Error: EACCES: permission denied"), false);
});

// ── 代理 env ─────────────────────────────────────────────

test("代理 env：桌面代理开启 → 大小写两套代理键 + NO_PROXY + NODE_USE_ENV_PROXY", () => {
	const env = proxyModule.buildSkillInstallProxyEnv({ enabled: true, url: "127.0.0.1:7890", bypass: "localhost,127.0.0.1" });
	assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
	assert.equal(env.https_proxy, "http://127.0.0.1:7890");
	assert.equal(env.ALL_PROXY, "http://127.0.0.1:7890");
	assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
	assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("代理 env：桌面代理关闭/地址非法 → 退回系统代理解析结果", () => {
	const fromSystem = proxyModule.buildSkillInstallProxyEnv({ enabled: false, url: "", bypass: "" }, "PROXY 127.0.0.1:7890");
	assert.equal(fromSystem.HTTPS_PROXY, "http://127.0.0.1:7890");
	const invalidDesktop = proxyModule.buildSkillInstallProxyEnv({ enabled: true, url: "not a url with space", bypass: "" }, "SOCKS5 10.0.0.9:1080");
	assert.equal(invalidDesktop.ALL_PROXY, "socks5://10.0.0.9:1080");
	// 系统规则 DIRECT / 空 → 不表态（既不注入也不剥离继承环境）
	assert.equal(proxyModule.buildSkillInstallProxyEnv({ enabled: false, url: "", bypass: "" }, "DIRECT"), undefined);
	assert.equal(proxyModule.buildSkillInstallProxyEnv({ enabled: false, url: "", bypass: "" }, null), undefined);
});

test("Electron 代理规则解析：取首条非 DIRECT，支持 PROXY/SOCKS 与多规则串", () => {
	assert.equal(proxyModule.parseElectronProxyRules("DIRECT"), undefined);
	assert.equal(proxyModule.parseElectronProxyRules("PROXY 1.2.3.4:8080"), "http://1.2.3.4:8080");
	assert.equal(proxyModule.parseElectronProxyRules("SOCKS4 1.2.3.4:1080"), "socks4://1.2.3.4:1080");
	assert.equal(proxyModule.parseElectronProxyRules("DIRECT; PROXY 5.6.7.8:3128"), "http://5.6.7.8:3128");
	assert.equal(proxyModule.parseElectronProxyRules(""), undefined);
});

// ── 执行器（假子进程） ─────────────────────────────────────

function createFakeSpawn(pid = 4321) {
	const child = new EventEmitter();
	child.pid = pid;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		return true;
	};
	const calls = [];
	return {
		child,
		calls,
		spawnImpl: (command, args, options) => {
			calls.push({ command, args, options });
			return child;
		},
	};
}

test("执行器：成功时 resolve，并流式上报阶段与百分比", async () => {
	const fake = createFakeSpawn();
	const updates = [];
	const pending = runnerModule.runSkillHubInstall({
		command: "npx",
		args: ["skills", "add", "a/b"],
		spawnImpl: fake.spawnImpl,
		onProgress: (update) => updates.push(update),
	});
	assert.equal(fake.calls[0].options.shell, false);
	assert.equal(fake.calls[0].options.windowsHide, true);
	fake.child.stdout.write("npm warn exec skills@1.7.2\n");
	fake.child.stdout.write("Cloning repository https://github.com/a/b.git\n");
	fake.child.stdout.write("Receiving objects:  60% (600/1000)\r");
	fake.child.emit("close", 0, null);
	await pending;
	assert.deepEqual(
		updates.map((u) => u.phase),
		["preparing", "downloading", "downloading"],
	);
	assert.equal(updates[2].percent, 60);
});

test("执行器：非零退出用 stdout 尾部的 git 报错 reject", async () => {
	const fake = createFakeSpawn();
	const pending = runnerModule.runSkillHubInstall({ command: "npx", args: [], spawnImpl: fake.spawnImpl });
	fake.child.stderr.write("npm warn using --force\n");
	fake.child.stdout.write("Failed to clone https://github.com/a/b.git\nfatal: unable to access 'https://github.com/a/b.git/': Recv failure: Connection was reset\n");
	fake.child.emit("close", 1, null);
	await assert.rejects(pending, (error) => {
		assert.match(error.message, /fatal: unable to access/);
		assert.match(error.message, /退出码 1/);
		return true;
	});
});

test("执行器：超时按树 kill 父进程并 reject 超时原因", async () => {
	const fake = createFakeSpawn(777);
	const killed = [];
	const pending = runnerModule.runSkillHubInstall({
		command: "npx",
		args: [],
		timeoutMs: 5,
		spawnImpl: fake.spawnImpl,
		killTreeImpl: (pid) => killed.push(pid),
	});
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.deepEqual([...killed], [777]);
	assert.equal(fake.child.killed, true);
	fake.child.emit("close", null, "SIGTERM");
	await assert.rejects(pending, /安装超时/);
});

test("执行器：注入的 env 合并进继承环境（SystemRoot 等不能丢）", async () => {
	const fake = createFakeSpawn();
	const pending = runnerModule.runSkillHubInstall({ command: "npx", args: [], env: { HTTPS_PROXY: "http://127.0.0.1:7890" }, spawnImpl: fake.spawnImpl });
	fake.child.emit("close", 0, null);
	await pending;
	const merged = fake.calls[0].options.env;
	assert.equal(merged.HTTPS_PROXY, "http://127.0.0.1:7890");
	assert.ok(Object.keys(merged).length > 1, "必须与 process.env 合并而不是替换");
});

// ── 链路契约（源码扫描，正则空白容忍） ────────────────────────

const readSource = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

/** 去掉注释后再做「不得使用 X」类断言：注释里解释历史实现不算回退。 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*(\/\/|\*).*$/gm, "");

test("契约：安装进度通道三处同步（channel / preload / previewApi）", () => {
	const ipc = readSource("src/shared/ipc.ts");
	assert.match(ipc, /skillHubInstallProgress\s*:\s*"skill-hub:install-progress"/);
	const preload = readSource("src/preload/index.ts");
	assert.match(preload, /onInstallProgress:[\s\S]{0,160}ipcChannels\.skillHubInstallProgress/);
	const preview = readSource("src/renderer/src/previewApi.ts");
	assert.match(preview, /onInstallProgress:\s*\(\)\s*=>\s*\(\)\s*=>\s*\{\}/);
});

test("契约：主进程侧搜索走 netFetch、安装走 spawn 执行器并推送进度", () => {
	const storeIpc = readSource("src/main/ipc/storeIpc.ts");
	const storeIpcCode = stripComments(storeIpc);
	// 裸 fetch / execFile 是本次两个根因，回退即红灯
	assert.match(storeIpc, /const fetchImpl\s*=\s*netFetch\s*\?\?\s*\(\(url/);
	assert.ok(!/await fetch\(/u.test(storeIpcCode), "商店搜索不得使用裸全局 fetch");
	assert.ok(!storeIpcCode.includes("execFile"), "安装不得使用 execFile（无进度、丢 stdout）");
	assert.match(storeIpc, /runSkillHubInstall\(\{/);
	assert.match(storeIpc, /sendSkillHubInstallProgress\(\{/);
	const index = readSource("src/main/index.ts");
	assert.match(index, /netFetch:\s*\(url,\s*init\)\s*=>\s*net\.fetch\(url,\s*init\)/);
	assert.match(index, /resolveInstallProxyEnv:/);
	assert.match(index, /session\.defaultSession\.resolveProxy\(/);
	assert.match(index, /sendSkillHubInstallProgress:\s*\(progress\)/);
	const runner = readSource("src/main/skills/skillHubInstallRunner.ts");
	assert.ok(!stripComments(runner).includes("execFile"), "执行器不得使用 execFile");
	assert.match(runner, /"data"[\s\S]{0,80}/);
});

test("契约：渲染层订阅进度并渲染百分比文案", () => {
	const panel = readSource("src/renderer/src/config/SkillHubStorePanel.tsx");
	assert.match(panel, /api\.skillHub\.onInstallProgress\(/);
	assert.match(panel, /return unsubscribe;/);
	assert.match(panel, /skillHubPhaseDownloadingPercent/);
	const zh = readSource("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = readSource("src/renderer/src/i18n/rendererCopy.en-US.ts");
	for (const key of ["skillHubPhasePreparing", "skillHubPhaseDownloading", "skillHubPhaseDownloadingPercent", "skillHubPhaseInstalling", "skillHubPhaseRunning"]) {
		assert.ok(zh.includes(`config.${key}`), `zh-CN 缺少 config.${key}`);
		assert.ok(en.includes(`config.${key}`), `en-US 缺少 config.${key}`);
	}
});
