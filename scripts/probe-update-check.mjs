#!/usr/bin/env node
/**
 * 更新探查端到端自检（release gate，手动运行；不属于 node --test 套件——单测禁止真实网络）。
 *
 * 目的：回答「发版后，老客户端真的能探查到新版本并拿到可下载资产吗」。
 * 直接运行生产检查代码 src/main/update/*（纯 Node 无 Electron 依赖，与桌面端同一实现），
 * 打真实 GitHub 端点，模拟一个旧版本客户端的完整检查流程：
 *   releases/latest 重定向 → latest.yml → atom 校验 → 推荐资产 → 资产 URL 可下载。
 *
 * 为什么对当前 release（而不是未来版本）验证即等价：检查代码动态读「最新 release」，
 * 与具体版本号无关。用 0.0.1 伪装旧客户端能对 v0.7.1 走通 hasUpdate=true + 资产可下载，
 * 即证明未来发出 v0.7.2/v0.7.3 时，存量用户走的是同一条已被验证的代码路径。
 *
 * 用法：node scripts/probe-update-check.mjs        （需要 node >= 18，联网）
 * 退出码：0 = 全部通过；1 = 存在失败项。Pi CLI 探查为附带信息，不计入失败。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);
const UA = "pi-desktop-update-probe";

/** 与 tests/updateCheck.test.mjs 相同的 TS 内编译方式：加载生产代码而非复刻逻辑。 */
function compileModule(filePath, requireOverride) {
	const source = readFileSync(filePath, "utf8");
	const output = nodeRequire("typescript").transpileModule(source, {
		compilerOptions: { module: nodeRequire("typescript").ModuleKind.CommonJS, target: nodeRequire("typescript").ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = requireOverride ? (specifier) => requireOverride(specifier) ?? nodeRequire(specifier) : nodeRequire;
	// 生产默认 fetchImpl 用到 fetch/AbortController/setTimeout：单测总是注入 fetchImpl 所以
	// 不需要这些全局；探查脚本走真实 fetch 路径，必须注入宿主全局。
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
			URL: globalThis.URL,
			process: globalThis.process,
			fetch: globalThis.fetch,
			AbortController: globalThis.AbortController,
			setTimeout: globalThis.setTimeout,
			clearTimeout: globalThis.clearTimeout,
		},
		{ filename: filePath },
	);
	return module.exports;
}

const githubFeed = compileModule("src/main/update/githubFeed.ts");
const appUpdateCheck = compileModule("src/main/update/appUpdateCheck.ts", (specifier) => {
	if (specifier === "./githubFeed") return githubFeed;
	return null;
});
const { checkAppUpdate, UPDATE_REPO_OWNER, UPDATE_REPO } = appUpdateCheck;
const { compareVersions, getChannelFilename } = githubFeed;

const currentVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const results = [];
const record = (ok, label, detail = "") => {
	results.push({ ok, label, detail });
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/** HEAD 探测资产可下载性；个别环境对 HEAD 异常时降级 Range GET。 */
async function probeUrl(url) {
	try {
		const response = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA }, redirect: "follow" });
		if (response.ok) return { ok: true, status: response.status, size: response.headers.get("content-length") };
	} catch {
		/* 落到 GET 重试 */
	}
	try {
		const response = await fetch(url, { headers: { "User-Agent": UA, Range: "bytes=0-0" }, redirect: "follow" });
		return { ok: response.status === 206 || response.status === 200, status: response.status };
	} catch (error) {
		return { ok: false, status: error instanceof Error ? error.message : String(error) };
	}
}

/** 带超时的子进程命令（npm view / pi --version 探查）。 */
function runCommand(command, args, timeoutMs = 30_000) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { shell: process.platform === "win32", windowsHide: true });
		let stdout = "";
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(value);
			}
		};
		const timer = setTimeout(() => {
			child.kill();
			done(null);
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", () => done(null));
		child.on("close", (code) => done(code === 0 ? stdout.trim() : null));
	});
}

// ── 场景 B：伪装旧客户端 0.0.1，验证「发现新版本 → 推荐资产真实可下载」 ──
console.log(`\n== 场景 B：模拟旧客户端（0.0.1）对真实最新 release 的完整探查 ==`);
const startedAt = Date.now();
let upgrade;
try {
	// 不注入 fetchImpl：走生产代码默认 fetch + 10s AbortController 超时，即桌面端真实路径。
	upgrade = await checkAppUpdate({
		owner: UPDATE_REPO_OWNER,
		repo: UPDATE_REPO,
		currentVersion: "0.0.1",
		installationType: process.platform === "win32" ? "installed" : undefined,
	});
	record(true, "checkAppUpdate 全流程完成（无抛错/无挂起）", `${Date.now() - startedAt}ms`);
} catch (error) {
	record(false, "checkAppUpdate 全流程完成", error instanceof Error ? error.message : String(error));
	console.log(`\n主路径失败即探查失败，中止后续断言。`);
	process.exit(1);
}

record(upgrade.hasUpdate === true, "旧客户端判定 hasUpdate=true", `latest=${upgrade.latestVersion}`);
record(/\/PiDeck\/releases/.test(upgrade.releaseUrl ?? ""), "release 指向 PiDeck 仓库（非旧名 pi-desktop）", upgrade.releaseUrl ?? "(missing)");
record((upgrade.assets?.length ?? 0) > 0, "latest.yml 解析出资产清单", `${upgrade.assets?.length ?? 0} 个资产`);

const recommended = upgrade.recommendedAsset;
record(Boolean(recommended), "为本平台选出推荐资产", recommended ? recommended.name : "(none)");

if (recommended) {
	const head = await probeUrl(recommended.url);
	record(head.ok, "推荐资产 URL 真实可下载", `${head.status}${head.size ? ` / ${Math.round(Number(head.size) / 1024 / 1024)}MB` : ""}`);
}

// 三个平台的 channel 元数据都在（mac/linux 缺失只降级不致命 → 警告不计失败）。
const tagVersion = upgrade.latestVersion;
for (const platformName of ["win32", "darwin", "linux"]) {
	const channel = getChannelFilename(platformName === "darwin" ? "darwin" : platformName === "linux" ? "linux" : "win32");
	const url = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases/download/v${tagVersion}/${channel}`;
	const probe = await probeUrl(url);
	record(probe.ok || platformName !== "win32", `${platformName} channel 元数据（${channel}）存在`, probe.ok ? "HTTP ok" : `HTTP ${probe.status}${platformName !== "win32" ? "（非本平台，降级路径可兜底，仅警告）" : ""}`);
}

// REST 兜底端点（仅降级路径使用）：附带你配额受限时的现状，不算失败。
try {
	const api = await fetch(`https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases/tags/v${tagVersion}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": UA } });
	console.log(`ℹ REST 兜底端点 HTTP ${api.status}${api.status === 403 ? "（限流，不影响主路径）" : ""}`);
} catch {
	console.log("ℹ REST 兜底端点不可达（不影响主路径）");
}

// ── 场景 A：真实当前版本跑一遍（应无抛错；顺带验证 atom 一致性）──
console.log(`\n== 场景 A：当前开发版本（${currentVersion}）真实探查 ==`);
try {
	const live = await checkAppUpdate({
		owner: UPDATE_REPO_OWNER,
		repo: UPDATE_REPO,
		currentVersion,
		installationType: process.platform === "win32" ? "installed" : undefined,
	});
	record(true, "当前版本探查完成", `latest=${live.latestVersion}, hasUpdate=${live.hasUpdate}`);
	record(compareVersions(live.latestVersion, currentVersion) > 0 ? !live.hasUpdate : true, "hasUpdate 与版本比较语义一致", `compareVersions(${live.latestVersion}, ${currentVersion})`);
} catch (error) {
	record(false, "当前版本探查完成", error instanceof Error ? error.message : String(error));
}

// ── 提示判定矩阵：直接回答「哪些存量用户在下个版本发出后会被提示」 ──
console.log(`\n== 提示判定矩阵（基于当前线上最新 ${upgrade.latestVersion}）==`);
for (const client of ["0.6.6", "0.7.0", "0.7.1", "0.7.2-beta", currentVersion]) {
	const willPrompt = compareVersions(upgrade.latestVersion, client) > 0;
	console.log(`  客户端 ${client.padEnd(10)} → ${willPrompt ? "提示更新" : "不提示"}`);
}
// 预发布语义（semver 对齐）：同版本号下 正式版 > beta，beta 测试客户端会收到正式版提示。
record(compareVersions("0.7.2", "0.7.2-beta") > 0, "预发布语义：同号正式版高于 beta（beta 客户端能收到正式版提示）");

// ── Pi CLI 探查（npm registry + 本机 pi，附带信息）──
console.log(`\n== Pi CLI 探查（npm registry / 本机）==`);
const npmLatest = await runCommand("npm", ["view", "@earendil-works/pi-coding-agent", "version"]);
record(Boolean(npmLatest && /^\d+\.\d+\.\d+/.test(npmLatest)), "npm view 拿到 pi 最新版本", npmLatest ?? "（失败）");
const localPi = await runCommand("pi", ["--version"], 10_000);
if (localPi) {
	const piVersion = localPi.split(/\s+/).find((part) => /^\d+\.\d+/.test(part)) ?? localPi;
	const piHasUpdate = compareVersions(npmLatest ?? "0.0.0", piVersion) > 0;
	console.log(`  本机 pi ${piVersion} → ${piHasUpdate ? "有更新" : "已是最新"}（compareVersions 判定）`);
} else {
	console.log("ℹ 本机未检测到 pi（跳过比较；检查逻辑与 npm registry 探查均已在上面验证）");
}

// ── 汇总 ──
const failed = results.filter((item) => !item.ok);
console.log(`\n== 结果：${results.length - failed.length}/${results.length} 项通过 ==`);
process.exit(failed.length > 0 ? 1 : 0);
