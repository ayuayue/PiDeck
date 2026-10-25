import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 跨会话正文搜索（session-index sidecar）的扫描根解析回归。
 *
 * 背景（用户现场）：「会话内容搜索搜不到明明存在的消息」。根因是扫描根只含全局
 * 默认根 + 全局 settings.sessionDir，而项目 `.pi/settings.json` 的 sessionDir
 * 才是不少用户实际的会话落点——项目级目录不进 roots，sidecar 里根本没有这些语料，
 * 于是标题/预览能搜到、正文一条都搜不到。这里锁定：
 *   - 项目级 sessionDir 进 roots（相对路径相对项目 cwd、绝对路径、`~` 三种形态）；
 *   - 无配置 / 目录不存在 / WSL 模式不产生 roots；
 *   - 与全局根合并去重；
 *   - settings 按 mtime+size 缓存（每次按键都会调用，不能重复读盘）。
 */

const sandboxRoot = mkdtempSync(join(tmpdir(), "pideck-search-roots-"));
const homeDir = join(sandboxRoot, "home");
const userDataDir = join(sandboxRoot, "userData");
mkdirSync(homeDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });
mkdirSync(join(homeDir, ".pi", "agent", "sessions"), { recursive: true });

const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
	stubs: {
		electron: {
			app: { getPath: (name) => (name === "home" ? homeDir : userDataDir) },
			shell: { openPath: () => undefined },
		},
	},
});

/**
 * vm realm 的数组原型与测试 realm 不同，deepStrictEqual 会因原型身份失败（内容一模一样）：
 * 逐元素比对。
 */
function assertSameRoots(actual, expected, message) {
	assert.equal(actual.length, expected.length, message);
	actual.forEach((root, index) => assert.equal(root, expected[index], message));
}

const defaultGlobalRoot = join(homeDir, ".pi", "agent", "sessions");

/** 造一个项目目录（可选写入项目级 sessionDir 配置与目录）。 */
function createProject(name, sessionDir, options = {}) {
	const projectPath = join(sandboxRoot, name);
	mkdirSync(join(projectPath, ".pi"), { recursive: true });
	if (sessionDir !== undefined) {
		writeSettings(join(projectPath, ".pi", "settings.json"), { sessionDir });
	}
	if (options.createDir) {
		mkdirSync(join(projectPath, options.createDir), { recursive: true });
	}
	return projectPath;
}

function writeSettings(settingsPath, payload) {
	writeFileSync(settingsPath, JSON.stringify(payload), "utf8");
}

test("项目级 sessionDir 进正文搜索根（相对路径相对项目 cwd）", async () => {
	const projectPath = createProject("project-relative", ".pi/sessions", { createDir: ".pi/sessions" });
	const scanner = new SessionScanner();

	assertSameRoots(await scanner.resolveProjectSearchRoots([projectPath]), [join(projectPath, ".pi", "sessions")]);
	const roots = await scanner.resolveContentSearchRoots([projectPath]);
	assertSameRoots(roots, [defaultGlobalRoot, join(projectPath, ".pi", "sessions")]);
});

test("无配置 / 目录不存在不产生根；绝对路径与 ~ 正常解析", async () => {
	const noSettings = createProject("project-no-settings");
	const missingDir = createProject("project-missing-dir", ".pi/nope");
	const absoluteTarget = join(sandboxRoot, "absolute-sessions");
	mkdirSync(absoluteTarget, { recursive: true });
	const absoluteProject = createProject("project-absolute", absoluteTarget);
	const tildeProject = createProject("project-tilde", "~/from-home");
	mkdirSync(join(homeDir, "from-home"), { recursive: true });
	const scanner = new SessionScanner();

	assertSameRoots(await scanner.resolveProjectSearchRoots([noSettings, missingDir]), []);
	assertSameRoots(await scanner.resolveProjectSearchRoots([absoluteProject, tildeProject]), [absoluteTarget, join(homeDir, "from-home")]);
});

test("与全局根合并去重：项目指向全局 sessionDir 时不重复", async () => {
	mkdirSync(join(homeDir, ".pi", "agent", "global-sessions"), { recursive: true });
	writeSettings(join(homeDir, ".pi", "agent", "settings.json"), { sessionDir: "global-sessions" });
	const sameAsGlobal = createProject("project-same-as-global", join(homeDir, ".pi", "agent", "global-sessions"));
	const other = createProject("project-other-global", ".pi/sessions", { createDir: ".pi/sessions" });
	const scanner = new SessionScanner();

	const roots = await scanner.resolveContentSearchRoots([sameAsGlobal, sameAsGlobal, other]);
	assertSameRoots(roots, [defaultGlobalRoot, join(homeDir, ".pi", "agent", "global-sessions"), join(other, ".pi", "sessions")]);
});

test("两个项目指向同一目录时只保留一份", async () => {
	const shared = join(sandboxRoot, "shared-sessions");
	mkdirSync(shared, { recursive: true });
	const first = createProject("project-shared-a", shared);
	const second = createProject("project-shared-b", shared);
	const scanner = new SessionScanner();

	assertSameRoots(await scanner.resolveProjectSearchRoots([first, second]), [shared]);
});

test("settings 按 mtime+size 缓存：内容未变不重读，变了才失效", async () => {
	const projectPath = createProject("project-cache", ".pi/sessions-a", { createDir: ".pi/sessions-a" });
	mkdirSync(join(projectPath, ".pi", "sessions-b"), { recursive: true });
	const settingsPath = join(projectPath, ".pi", "settings.json");
	const scanner = new SessionScanner();

	// 关键：把 mtime 归一到整秒（NTFS 有 100ns 精度，直接回收 stat 的 Date 会丢小数毫秒），
	// 之后同长度改写 + 同一 mtime 才能造出完全相同的版本键。
	const frozen = new Date(1_700_000_000_000);
	utimesSync(settingsPath, frozen, frozen);
	assertSameRoots(await scanner.resolveProjectSearchRoots([projectPath]), [join(projectPath, ".pi", "sessions-a")]);

	// 同长度改写 + 还原 mtime：版本键不变 → 命中缓存，仍返回旧目录（证明没有每次重读）
	writeSettings(settingsPath, { sessionDir: ".pi/sessions-b" });
	utimesSync(settingsPath, frozen, frozen);
	assertSameRoots(await scanner.resolveProjectSearchRoots([projectPath]), [join(projectPath, ".pi", "sessions-a")]);

	// 版本变化（长度不同）→ 缓存失效，读到新目录
	writeSettings(settingsPath, { sessionDir: ".pi/sessions-bbb" });
	mkdirSync(join(projectPath, ".pi", "sessions-bbb"), { recursive: true });
	assertSameRoots(await scanner.resolveProjectSearchRoots([projectPath]), [join(projectPath, ".pi", "sessions-bbb")]);
});

test("WSL 模式下项目级根与全局根都为空（宿主 Go 读 UNC 不可靠）", async () => {
	const projectPath = createProject("project-wsl", ".pi/sessions", { createDir: ".pi/sessions" });
	const scanner = new SessionScanner();
	await scanner.configureWsl({ distro: "Ubuntu", user: "tester", linuxHome: "/home/tester" });

	assertSameRoots(await scanner.resolveProjectSearchRoots([projectPath]), []);
	assertSameRoots(await scanner.resolveContentSearchRoots([projectPath]), []);
});

test("装配侧契约：正文搜索闭包与预热都走组合根，并过滤 WSL 项目", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	// 项目来源抽成模块级函数（闭包在 registerSessionIpc 前、5s 预热在装配尾部，两处都要用）
	assert.match(source, /function\s+projectPathsForContentSearch\(\)\s*:\s*string\[\]\s*\{/);
	assert.match(source, /\.filter\(\(project\)\s*=>\s*project\.environment\s*!==\s*"wsl"\)/);
	// 正文搜索闭包、会话内查找闭包与 5s 预热各一处，且不得再有只取全局根的旧调用
	// （会话内查找复用同一组合根：它也要项目级 sessionDir，否则「明明有这条消息却搜不到」）
	assert.equal(source.match(/resolveContentSearchRoots\(projectPathsForContentSearch\(\)\)/g)?.length, 3);
	assert.doesNotMatch(source, /sessionScanner\.resolveGlobalSearchRoots\(\)/);
});
