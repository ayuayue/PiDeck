import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ImageGenConfigFile } from "../src/shared/types/imagegen";
import { armStartupOverlayDismissal } from "./startupOverlays";
import { ensureWindowsProfileSkeleton } from "./win-profile";

/**
 * Mock pi fixture（#115 U6）：在隔离 userData 中预置 settings.json，
 * 把 customPiPath 指向 e2e/mock-pi.cjs 的 .cmd shim，让应用走真实
 * spawn + stdio JSON-RPC 链路，但不需要安装真实 pi / 不访问网络。
 */
export type MockPiFixture = {
	app: ElectronApplication;
	window: Page;
};

/** 测试文件可通过 test.use({ seedProjects }) 预置项目列表（写入 projects.json） */
export type SeedProject = { id: string; name: string; path: string; pinned?: boolean };

/** 测试文件可通过 test.use({ seedFeishuBots }) 预置飞书 Bot 配置（写入 pi-desktop/feishu.json） */
export type SeedFeishuBot = { id: string; name: string; appId: string };

/** 测试文件可通过 test.use({ seedSessionFiles }) 预置历史会话文件（未启动 agent 场景）：
 *  写入 <projectPath>/.pi/sessions/<encode>.jsonl + .pi/settings.json（sessionDir 配置），
 *  SessionScanner 扫描后侧栏出现历史会话；打开时不 spawn agent，即「从未启动」状态。 */
export type SeedSessionFile = {
	projectPath: string;
	/** 同一项目多个历史文件时显式区分，默认名称保持 mock-pi 的单文件会话约定。 */
	fileName?: string;
	/** JSONL 行（header + message entries），格式与 mock-pi.cjs appendSessionMessages 一致 */
	entries: unknown[];
};

/** 把 cwd 编码成 pi sessions 目录名（与 mock-pi.cjs encodeSessionDir / SessionScanner.decodeSessionDir 对偶） */
function encodeSessionDir(cwd: string): string {
	const norm = cwd.replace(/\\/g, "/");
	if (/^[A-Za-z]:/.test(norm)) {
		const drive = norm[0].toUpperCase();
		const rest = norm.slice(2).replace(/^\//, "").replace(/\//g, "-");
		return `--${drive}--${rest}--`;
	}
	return `--${norm.replace(/^\//, "").replace(/\//g, "-")}--`;
}

/** 测试文件可通过 test.use({ seedFavorites }) 预置收藏（写入 <userData>/favorites.json）。 */
export type SeedFavorite = {
	id: string;
	text: string;
	kind?: "message" | "selection";
	role?: "user" | "assistant" | "system" | null;
	createdAt?: number;
	sessionTitle?: string | null;
	model?: string | null;
};

/** 测试文件可通过 test.use({ seedSettings }) 追加预置设置项（合并进 settings.json） */
export type SeedSettings = Record<string, unknown>;

/** 测试文件可预置独立 imagegen.json，使首帧 Composer 读取真实供应商配置。 */
export type SeedImageGenConfig = ImageGenConfigFile;

const repoRoot = resolve(__dirname, "..");

/**
 * 主窗口识别：主窗口加载渲染层入口（打包态 file://…/index.html，dev 态 localhost 根），
 * 系统级划词浮窗加载 selection-tool.html。
 *
 * 为什么不能用 app.firstWindow()：主进程会 warmUp 划词浮窗（SelectionToolWindow），它是
 * 同进程的第二个 BrowserWindow，且经常比主窗口先完成加载；firstWindow() 拿到浮窗后，
 * 整条用例的断言都跑在浮窗页上，表现为「项目 Tab 永远等不到」（2026-10-21 全量 e2e 红）。
 */
function isMainWindow(page: Page): boolean {
	const url = page.url();
	if (!url || url === "about:blank") return false;
	if (url.includes("selection-tool")) return false;
	return /index\.html(?:[?#]|$)/.test(url) || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url);
}

/** 等主窗口出现（浮窗预热可能先到）；超时按启动失败处理，避免用例在错误页上漂移到别处超时。 */
async function waitForMainWindow(app: ElectronApplication): Promise<Page> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const page = app.windows().find(isMainWindow);
		if (page) return page;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("e2e: main window did not appear within 60s（只看到划词浮窗或空页）");
}

/**
 * Playwright option fixture 的「元组陷阱」归一化入口。
 *
 * `test.use({ seedXxx: [...] })` 的值会被 Playwright 按
 * `isFixtureTuple = Array.isArray(v) && typeof v[1] === "object"` 判定：
 * - 1 个元素（`[p1]`）→ 不是元组，整数组透传（正常）；
 * - ≥2 个元素（`[p1, p2]`）→ **被当成 [value, options] 元组**，只取第 0 个元素，
 *   第 2 个及之后静默丢弃（2027-01 实际踩到：多项目种子只剩第一个）。
 *
 * 同一写法在 1 个和 2 个种子时行为不同，排查成本极高，所以这里不再静默兼容：
 * 收到「单个对象」直接报错并给出可用写法（函数式覆盖），让用例在启动前失败。
 * ≥2 个种子请用函数式覆盖（函数形态不经过元组解析）：
 * ```ts
 * test.use({ seedProjects: async ({}, use) => use([projectA, projectB]) });
 * ```
 */
function normalizeSeeds<T>(name: string, value: readonly T[] | T | undefined, requirement: string): T[] {
	if (value === undefined) return [];
	if (Array.isArray(value)) return value as T[];
	throw new Error(`${name} 只收到单个对象（不是数组）——这几乎一定是 Playwright 把 >=2 元素的数组当成 [value, options] 元组截断了。${requirement} 多个种子请用函数式覆盖：test.use({ ${name}: async ({}, use) => use([a, b]) })`);
}

/** E2E 窗口摆放：默认 quiet（屏幕外，不遮挡用户桌面）；需要真实几何的用例切 visible。 */
export type E2EWindowMode = "quiet" | "visible";

export const test = base.extend<
	MockPiFixture & {
		seedProjects: SeedProject[] | undefined;
		seedFeishuBots: SeedFeishuBot[] | undefined;
		seedFavorites: SeedFavorite[] | undefined;
		seedSessionFiles: SeedSessionFile[] | undefined;
		seedSettings: SeedSettings | undefined;
		seedImageGenConfig: SeedImageGenConfig | undefined;
		launchArgs: string[];
		mockSessionInProject: boolean;
		e2eWindowMode: E2EWindowMode;
	}
>({
	seedProjects: [undefined, { option: true }],
	e2eWindowMode: ["quiet", { option: true }],
	seedFeishuBots: [undefined, { option: true }],
	seedFavorites: [undefined, { option: true }],
	seedSessionFiles: [undefined, { option: true }],
	seedSettings: [undefined, { option: true }],
	seedImageGenConfig: [undefined, { option: true }],
	// Exercise real startup intents with the same isolated profile and mock RPC backend.
	launchArgs: [[], { option: true }],
	mockSessionInProject: [false, { option: true }],
	app: async ({ seedProjects, seedFeishuBots, seedFavorites, seedSessionFiles, seedSettings, seedImageGenConfig, launchArgs, mockSessionInProject, e2eWindowMode }, use) => {
		// 先归一化（元组陷阱见 normalizeSeeds 注释）：非法值在启动 Electron 之前就报错，
		// 避免用例因「种子项目凭空消失」在后面超时。
		const projects = normalizeSeeds("seedProjects", seedProjects, "项目需含 id / name / path（用 makeSeedProject 生成）。");
		const feishuBots = normalizeSeeds("seedFeishuBots", seedFeishuBots, "Bot 需含 id / name / appId。");
		const sessionFiles = normalizeSeeds("seedSessionFiles", seedSessionFiles, "会话文件需含 projectPath / entries。");
		const favorites = normalizeSeeds("seedFavorites", seedFavorites, "收藏需含 id / text。");
		const userDataRoot = mkdtempSync(join(tmpdir(), "pideck-mockpi-"));
		try {
			// Windows 桌面端通过 cmd shim 调起自定义 pi（见 PiLocator.createInvocation），
			// 这里生成一个指向本仓库 mock-pi.cjs 的 shim；node 用当前进程的解释器绝对路径。
			// 平台相关 shim：Windows 用 .cmd（cmd /c 路径语义）；macOS/Linux 生成可执行 .sh
			// （PiLocator.createInvocation 在非 Windows 平台直接 spawn 命令路径，.cmd 无法执行）。
			const shimName = process.platform === "win32" ? "mock-pi.cmd" : "mock-pi.sh";
			const shimPath = join(userDataRoot, shimName);
			const scriptPath = join(repoRoot, "e2e", "mock-pi.cjs");
			const shimBody = process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`;
			writeFileSync(shimPath, shimBody);
			if (process.platform !== "win32") chmodSync(shimPath, 0o755);
			// 预置设置：customPiPath 指向 shim；piEnvironmentChecked=true 跳过启动
			// 环境检测弹窗（否则会盖住欢迎页按钮造成点击竞态）。其余字段缺省。
			// 注意：main/index.ts 在 isDevBuild（未打包）时会覆盖 userData 为
			// %APPDATA%/pi-desktop-dev；但命令行显式传 --user-data-dir 时尊重该路径
			// （见 main/index.ts「开发态与正式版隔离 userData」注释），
			// 因此这里预置文件直接写到 --user-data-dir 指定的 profile 目录。
			// dshHomeDir：DSH_HOME 优先读用户真实 ~/.dsh（DshHost 设计），隔离 userData
			// 也挡不住它——本机若配过 DSH，foreign sync 会把真实会话的 cwd 注册成项目，
			// 污染侧栏断言（2026-11 修）。这里指向临时目录下不存在的位置，让 DSH 走全新 home。
			mkdirSync(join(userDataRoot, "profile"), { recursive: true });
			writeFileSync(
				join(userDataRoot, "profile", "settings.json"),
				JSON.stringify({
					customPiPath: shimPath,
					piEnvironmentChecked: true,
					// 与 fixtures.ts 同一理由：缺省 system 会跟宿主语系变，中文文案断言在 en-US runner 必堵。
					language: "zh-CN",
					enableGitManagement: true,
					dshHomeDir: join(userDataRoot, "dsh-home"),
					...(seedSettings ?? {}),
				}),
			);
			if (seedImageGenConfig) {
				writeFileSync(join(userDataRoot, "profile", "imagegen.json"), JSON.stringify(seedImageGenConfig));
			}

			// 可选：预置项目列表。ProjectStore.load 会保留种子项目并追加内置聊天项目。
			if (projects.length > 0) {
				writeFileSync(
					join(userDataRoot, "profile", "projects.json"),
					JSON.stringify(
						projects.map((project, index) => ({
							lastOpenedAt: Date.now() + index,
							sortOrder: index,
							...project,
						})),
					),
				);
			}
			// 可选：预置收藏（FavoritesStore 读 <userData>/favorites.json；数组顺序即展示顺序）。
			if (favorites.length > 0) {
				writeFileSync(
					join(userDataRoot, "profile", "favorites.json"),
					JSON.stringify({
						version: 1,
						entries: favorites.map((favorite, index) => ({
							kind: "message",
							role: "assistant",
							createdAt: Date.now() - index * 60_000,
							sessionTitle: null,
							model: null,
							sessionId: null,
							projectId: null,
							messageId: null,
							partial: false,
							truncated: false,
							...favorite,
						})),
					}),
				);
			}

			// 可选：预置飞书 Bot 配置（FeishuConfig 读 userData/pi-desktop/feishu.json）。
			// appSecret 用 base64（encryptSecret 的简化格式），空串即可——e2e 不真连飞书。
			if (feishuBots.length > 0) {
				mkdirSync(join(userDataRoot, "profile", "pi-desktop"), { recursive: true });
				writeFileSync(
					join(userDataRoot, "profile", "pi-desktop", "feishu.json"),
					JSON.stringify({
						version: 2,
						bots: feishuBots.map((bot) => ({
							id: bot.id,
							name: bot.name,
							appId: bot.appId,
							appSecret: "",
							enabled: true,
						})),
						deletedBotIdsByAppId: {},
					}),
				);
			}

			// 可选：预置历史会话文件（未启动 agent 场景）。mock-pi 的会话文件名 = encodeSessionDir(cwd) + ".jsonl"，
			// 与 SessionScanner.decodeSessionDir 对偶；必须同时写 .pi/settings.json（sessionDir: ".pi/sessions"）
			// 否则扫描根只有全局 ~/.pi/agent/sessions，项目级文件不会被发现。
			if (sessionFiles.length > 0) {
				for (const seedFile of sessionFiles) {
					const sessionsDir = join(seedFile.projectPath, ".pi", "sessions");
					mkdirSync(sessionsDir, { recursive: true });
					writeFileSync(join(sessionsDir, seedFile.fileName ?? encodeSessionDir(seedFile.projectPath) + ".jsonl"), seedFile.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
					writeFileSync(join(seedFile.projectPath, ".pi", "settings.json"), JSON.stringify({ sessionDir: ".pi/sessions" }, null, 2));
				}
			}

			// 项目信任静默：seed 项目写 .pi/settings.json 会被 AgentManager 判定为「含 pi 配置资源」，
			// spawn pi 时弹「项目信任确认」（60s 未点默认拒绝）。ConfigManager 用 os.homedir() 定位
			// ~/.pi/agent/trust.json（Windows homedir() 读 USERPROFILE，见下 env 隔离）。
			// 预写 trust.json 信任临时目录根，findNearestTrustEntry 沿父目录链继承 → 所有 seed 项目
			// （mkdtempSync 在 tmpdir 下）直接放行，弹框根本不出现，也不污染真实 ~/.pi/agent。
			const trustDir = join(userDataRoot, ".pi", "agent");
			mkdirSync(trustDir, { recursive: true });
			writeFileSync(join(trustDir, "trust.json"), JSON.stringify({ [tmpdir()]: true }));

			// 重定向 USERPROFILE 后，shell 文件夹解析要求配置目录骨架存在
			// （否则 app.getPath("appData") 抛错、主进程启动即崩，见 ./win-profile.ts）。
			if (process.platform === "win32") ensureWindowsProfileSkeleton(userDataRoot);
			const env = {
				...process.env,
				CI: "1",
				// PIDECK_E2E：主进程 isE2E 开关，窗口不抢焦点、不最大化，并默认摆到屏幕外（见 main/index.ts）
				PIDECK_E2E: "1",
				// quiet（默认）= 窗口屏幕外，不遮挡用户桌面；visible 给需要真实窗口几何的用例回退。
				PIDECK_E2E_WINDOW_MODE: e2eWindowMode,
				PIDECK_MOCK_SESSION_IN_PROJECT: mockSessionInProject ? "1" : "0",
				// 主进程按 PIDECK_E2E_USER_DATA_DIR 覆写 userData（与 fixtures.ts 同源）。
				// 缺了它 app.setPath("userData") 仍指向真实开发目录：seedProjects / seedSettings /
				// seedSessionFiles 全写进临时目录但应用不读，表现为「种子项目凭空消失」
				// （layout.spec 等依赖项目行的用例因此失败）。
				PIDECK_E2E_USER_DATA_DIR: join(userDataRoot, "profile"),
				...(process.platform === "win32" ? { APPDATA: userDataRoot, USERPROFILE: userDataRoot } : process.platform === "darwin" ? { HOME: userDataRoot } : { XDG_CONFIG_HOME: userDataRoot, HOME: userDataRoot }),
			};
			delete env.ELECTRON_RENDERER_URL;
			const app = await electron.launch({
				args: [repoRoot, `--user-data-dir=${join(userDataRoot, "profile")}`, ...launchArgs],
				env,
			});
			await use(app);
			await app.close();
		} finally {
			// 调试可用 PIDECK_E2E_KEEP=1 保留 userData（含主进程日志），排查 spawn/状态问题
			if (!process.env.PIDECK_E2E_KEEP) {
				try {
					rmSync(userDataRoot, { recursive: true, force: true });
				} catch {
					/* Windows 文件锁，忽略 */
				}
			} else {
				console.log("[mock-pi-fixture] kept userDataRoot:", userDataRoot);
			}
		}
	},
	window: async ({ app }, use) => {
		const window = await waitForMainWindow(app);
		await window.waitForLoadState("domcontentloaded");
		// 启动引导弹窗会抢焦点/遮拦点击，统一在这里挂上「出现即关」，
		// 否则会伪装成业务失败（点击超时、打字被吞）。
		await armStartupOverlayDismissal(window);
		await use(window);
	},
});

export { expect } from "@playwright/test";
