#!/usr/bin/env node
/**
 * 更新探查端到端自检（release gate，手动运行；不属于 node --test 套件——单测禁止真实网络）。
 *
 * 目的：回答「发版之后，存量客户端真的能探查到新版本、并下载到真实可用的安装包吗」。
 * 只打真实端点，校验 4 件线上事实：
 *   1. GitHub `/releases/latest` 指向的 tag —— Windows（electron-updater）与 macOS/Linux
 *      手动更新检查读的都是它，`release.yml` 的 finalize-release 作业保证它等于本次 tag；
 *   2. 该 tag 的 latest.yml 里 `version:` 必须等于该 tag（v0.9.9 事故就是这个不成立：
 *      latest 静默停在 v0.9.8，latest.yml 于是也是 0.9.8，用户完全收不到更新）；
 *   3. latest.yml 声明的安装包在 `/releases/latest/download/` 下真实可下载，且字节数与声明一致
 *      （防止 latest 已对齐、资产却没传完的中间态被当成通过）；
 *   4. AtomGit（默认更新源）的 latest 标记与它的 latest.yml 同样对齐，避免「GitHub 修好了、
 *      国内用户还停在旧版」。
 *
 * 为什么用「最新 release」验证即等价：更新检查代码动态读 latest，与具体版本号无关。
 *
 * 用法：node scripts/probe-update-check.mjs
 * 退出码：0 = 全部通过；1 = 存在失败项。AtomGit 限流/不可达与 Pi CLI 探查为附带信息，不计入失败。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);
const UA = "pi-desktop-update-probe";
const TIMEOUT_MS = 20_000;

/** 与 tests/updateCheck.test.mjs 相同的 TS 内编译方式：加载生产代码而非复刻逻辑。 */
function compileModule(filePath, requireOverride) {
	const source = readFileSync(filePath, "utf8");
	const output = nodeRequire("typescript").transpileModule(source, {
		compilerOptions: { module: nodeRequire("typescript").ModuleKind.CommonJS, target: nodeRequire("typescript").ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = requireOverride ? (specifier) => requireOverride(specifier) ?? nodeRequire(specifier) : nodeRequire;
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

const updateSources = compileModule("src/shared/updateSources.ts");
const mirrorHealth = compileModule("src/main/update/mirrorHealth.ts", (specifier) => {
	if (specifier.endsWith("shared/updateSources")) return updateSources;
	return null;
});
const { compareVersions, normalizeVersion } = compileModule("src/main/utils/versionCompare.ts");
const { resolveProbeFileName } = mirrorHealth;
const { UPDATE_REPO_OWNER, UPDATE_REPO, gitHubReleasesBase, gitHubLatestDownloadBase, atomGitFeedUrl, atomGitLatestReleaseApiUrl } = updateSources;

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const currentVersion = packageJson.version;
const results = [];
const record = (ok, label, detail = "") => {
	results.push({ ok, label, detail });
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const info = (label, detail = "") => console.log(`ℹ ${label}${detail ? ` — ${detail}` : ""}`);
const warn = (label, detail = "") => console.log(`⚠ ${label}${detail ? ` — ${detail}` : ""}`);

/** 带超时的 fetch；网络异常统一收成 { ok:false, error }，由调用方决定是失败还是警告。 */
async function httpGet(url, init = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, { redirect: "follow", headers: { "User-Agent": UA }, ...init, signal: controller.signal });
	} catch (error) {
		return { ok: false, status: error instanceof Error ? error.message : String(error), error: true };
	} finally {
		clearTimeout(timer);
	}
}

/** 从 latest.yml 取字段（generic provider 的 yml 结构固定，这里只读顶层标量）。 */
function readYmlField(ymlText, field) {
	const match = ymlText.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
	return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null;
}

/** latest.yml 里声明的安装包字节数（files[] 首条的 size）。 */
function readYmlFirstFileSize(ymlText) {
	const match = ymlText.match(/^\s+size:\s*(\d+)\s*$/m);
	return match?.[1] ? Number(match[1]) : null;
}

// ── 0. 仓库坐标单一事实来源：shared/updateSources 与 electron-updater 的 build.publish 必须一致 ──
console.log("== 仓库坐标一致性 ==");
const publish = packageJson.build?.publish ?? {};
record(publish.owner === UPDATE_REPO_OWNER && publish.repo === UPDATE_REPO, "package.json build.publish 与 shared/updateSources 指向同一仓库", `${publish.owner}/${publish.repo} vs ${UPDATE_REPO_OWNER}/${UPDATE_REPO}`);

// ── 1. GitHub latest → tag ──
console.log("\n== GitHub /releases/latest ==");
let ghLatestVersion = null;
const latestRedirect = await httpGet(`${gitHubReleasesBase()}/releases/latest`);
if (!latestRedirect.ok) {
	record(false, "GitHub /releases/latest 可达", String(latestRedirect.status));
} else {
	const tagMatch = String(latestRedirect.url ?? "").match(/\/releases\/tag\/(v[0-9][^/?#]*)/);
	ghLatestVersion = tagMatch ? normalizeVersion(tagMatch[1]) : null;
	record(Boolean(ghLatestVersion), "/releases/latest 302 到具体 tag", latestRedirect.url ?? "(无最终 URL)");
}

// REST 视角交叉验证（配额受限时只警告：Web 302 才是更新链路主路径）。
const restLatest = await httpGet(`https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases/latest`, {
	headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
});
if (restLatest.status === 403 || restLatest.status === 429) {
	warn("REST /releases/latest 配额受限（不影响主路径判定）", String(restLatest.status));
} else if (!restLatest.ok) {
	warn("REST /releases/latest 不可达（不影响主路径判定）", String(restLatest.status));
} else {
	const payload = await restLatest.json();
	record(normalizeVersion(String(payload.tag_name ?? "")) === ghLatestVersion, "REST latest 与 Web 302 指向同一 tag", `${payload.tag_name} / name=${payload.name}`);
	record(payload.prerelease !== true, "latest 不是预发布", `prerelease=${payload.prerelease}`);
	if (payload.name && payload.name !== payload.tag_name) {
		warn("Release 名称与 tag 不一致（发版收尾作业会覆写为 tag）", `${payload.name} → ${payload.tag_name}`);
	}
}

// ── 2/3. latest.yml 版本对齐 + 安装包真实可下载 ──
console.log("\n== GitHub latest.yml 与安装包 ==");
let recommendedUrl = null;
if (ghLatestVersion) {
	const ymlResponse = await httpGet(`${gitHubLatestDownloadBase()}/latest.yml`);
	if (!ymlResponse.ok) {
		record(false, "latest.yml 可下载", String(ymlResponse.status));
	} else {
		const ymlText = await ymlResponse.text();
		const ymlVersion = normalizeVersion(readYmlField(ymlText, "version") ?? "");
		// P0 判定：latest 指向的 tag 与它自己的 latest.yml 版本必须一致，否则客户端「检查到有新版、装上去还是旧版」。
		record(ymlVersion === ghLatestVersion, "latest.yml 版本 === /releases/latest 的 tag", `yml=${ymlVersion || "(缺失)"}, latest=${ghLatestVersion}`);

		const fileName = resolveProbeFileName(ymlText);
		const declaredSize = readYmlFirstFileSize(ymlText);
		recommendedUrl = `${gitHubLatestDownloadBase()}/${encodeURIComponent(fileName)}`;
		const head = await httpGet(recommendedUrl, { method: "HEAD" });
		const contentLength = Number(head.headers?.get?.("content-length") ?? NaN);
		record(head.ok, "latest.yml 声明的安装包可下载", `${fileName} → HTTP ${head.status}`);
		record(Number.isFinite(declaredSize) ? contentLength === declaredSize : true, "安装包字节数与 latest.yml 一致", Number.isFinite(declaredSize) ? `${contentLength} vs ${declaredSize}` : "（yml 未声明 size，跳过）");

		// 三平台 channel 元数据：win32 必须有（应用内更新只认 NSIS），mac/linux 缺了走手动降级。
		for (const platformName of ["win32", "darwin", "linux"]) {
			const channelFile = platformName === "win32" ? "latest.yml" : platformName === "darwin" ? "latest-mac.yml" : "latest-linux.yml";
			const probe = await httpGet(`${gitHubLatestDownloadBase()}/${channelFile}`, { method: "HEAD" });
			const optional = platformName !== "win32";
			if (probe.ok) {
				info(`${platformName} channel 元数据存在`, channelFile);
			} else if (optional) {
				warn(`${platformName} channel 元数据缺失（可用手动安装包下载兜底）`, `${channelFile} → HTTP ${probe.status}`);
			} else {
				record(false, `${platformName} channel 元数据存在`, `${channelFile} → HTTP ${probe.status}`);
			}
		}
	}
}

// ── 4. AtomGit（默认更新源）latest 对齐 ──
console.log("\n== AtomGit latest（默认更新源）==");
const atomLatest = await httpGet(atomGitLatestReleaseApiUrl());
if (!atomLatest.ok) {
	// OpenAPI 是公开共享额度（实测会 429），不可达不算产品故障；下面的 latest.yml 才是客户端实际下载路径。
	warn("AtomGit OpenAPI latest 不可达（限流/网络，不影响下面的 feed 判定）", String(atomLatest.status));
} else {
	const payload = await atomLatest.json();
	const atomTag = normalizeVersion(String(payload.tag_name ?? ""));
	record(Boolean(atomTag), "AtomGit OpenAPI latest 可解析", `tag_name=${payload.tag_name ?? "(缺失)"}`);
	if (atomTag && ghLatestVersion) {
		record(atomTag === ghLatestVersion, "AtomGit latest 与 GitHub latest 一致", `atomgit=${atomTag}, github=${ghLatestVersion}`);
	}
}
const atomYml = await httpGet(`${atomGitFeedUrl()}/latest.yml`);
if (!atomYml.ok) {
	warn("AtomGit latest.yml 不可达（feed 走泛型 provider，源码用户会降级到 GitHub）", String(atomYml.status));
} else {
	const atomVersion = normalizeVersion(readYmlField(await atomYml.text(), "version") ?? "");
	record(Boolean(atomVersion), "AtomGit latest.yml 解析出版本", atomVersion || "(缺失)");
	if (atomVersion && ghLatestVersion) {
		record(atomVersion === ghLatestVersion, "AtomGit latest.yml 版本与 GitHub latest 一致", `atomgit=${atomVersion}, github=${ghLatestVersion}`);
	}
}

// ── 5. 提示判定矩阵：哪些存量客户端在下个版本发出后会被提示 ──
console.log(`\n== 提示判定矩阵（线上最新 ${ghLatestVersion ?? "?"}）==`);
if (ghLatestVersion) {
	for (const client of ["0.7.1", "0.8.0", "0.8.8", "0.9.0", currentVersion]) {
		if (compareVersions(client, currentVersion) > 0) continue;
		const willPrompt = compareVersions(ghLatestVersion, client) > 0;
		console.log(`  客户端 ${client.padEnd(10)} → ${willPrompt ? "提示更新" : "不提示"}`);
	}
}
// 预发布语义（semver 对齐）：同版本号下 正式版 > beta，beta 客户端会收到正式版提示。
record(compareVersions("0.9.9", "0.9.9-beta.1") > 0, "预发布语义：同号正式版高于 beta（beta 客户端能收到正式版提示）");

// ── Pi CLI 探查（npm registry + 本机 pi，附带信息，不计入失败）──
console.log("\n== Pi CLI 探查（npm registry / 本机）==");
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
const npmLatest = await runCommand("npm", ["view", "@earendil-works/pi-coding-agent", "version"]);
info("npm view pi 最新版本", npmLatest ?? "（失败）");
const localPi = await runCommand("pi", ["--version"], 10_000);
if (localPi) {
	const piVersion = localPi.split(/\s+/).find((part) => /^\d+\.\d+/.test(part)) ?? localPi;
	const piHasUpdate = compareVersions(npmLatest ?? "0.0.0", piVersion) > 0;
	info(`本机 pi ${piVersion}`, piHasUpdate ? "有更新" : "已是最新");
} else {
	info("本机未检测到 pi（跳过比较）");
}

// ── 汇总 ──
const failed = results.filter((item) => !item.ok);
console.log(`\n== 结果：${results.length - failed.length}/${results.length} 项通过 ==`);
if (failed.length > 0) {
	console.log("失败项：");
	for (const item of failed) console.log(`  ✗ ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
	console.log("\n提示：latest 指针没跟进时，用 release.yml 的 finalize-release 同款命令补修（见 docs/release-process.md「latest 指针」）。");
}
if (recommendedUrl) console.log(`\n推荐资产：${recommendedUrl}`);
process.exit(failed.length > 0 ? 1 : 0);
