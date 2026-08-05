import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

/** 测试文件可通过 test.use({ seedSettings }) 追加预置设置项（合并进 settings.json） */
export type SeedSettings = Record<string, unknown>;

const repoRoot = resolve(__dirname, "..");

export const test = base.extend<MockPiFixture & { seedProjects: SeedProject[] | undefined; seedFeishuBots: SeedFeishuBot[] | undefined; seedSettings: SeedSettings | undefined }>({
	seedProjects: [undefined, { option: true }],
	seedFeishuBots: [undefined, { option: true }],
	seedSettings: [undefined, { option: true }],
	app: async ({ seedProjects, seedFeishuBots, seedSettings }, use) => {
		const userDataRoot = mkdtempSync(join(tmpdir(), "pideck-mockpi-"));
		try {
			// Windows 桌面端通过 cmd shim 调起自定义 pi（见 PiLocator.createInvocation），
			// 这里生成一个指向本仓库 mock-pi.cjs 的 shim；node 用当前进程的解释器绝对路径。
			// 平台相关 shim：Windows 用 .cmd（cmd /c 路径语义）；macOS/Linux 生成可执行 .sh
			// （PiLocator.createInvocation 在非 Windows 平台直接 spawn 命令路径，.cmd 无法执行）。
			const shimName = process.platform === "win32" ? "mock-pi.cmd" : "mock-pi.sh";
			const shimPath = join(userDataRoot, shimName);
			const scriptPath = join(repoRoot, "e2e", "mock-pi.cjs");
			const shimBody =
				process.platform === "win32"
					? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
					: `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`;
			writeFileSync(shimPath, shimBody);
			if (process.platform !== "win32") chmodSync(shimPath, 0o755);
			// 预置设置：customPiPath 指向 shim；piEnvironmentChecked=true 跳过启动
			// 环境检测弹窗（否则会盖住欢迎页按钮造成点击竞态）。其余字段缺省。
			// 注意：未打包运行时 main/index.ts 会把 userData 追加 "-dev" 后缀，
			// 真实 userData 是 <root>/profile-dev（与 fixtures.ts 的隔离机制一致）。
			mkdirSync(join(userDataRoot, "profile-dev"), { recursive: true });
			writeFileSync(
				join(userDataRoot, "profile-dev", "settings.json"),
				JSON.stringify({
					customPiPath: shimPath,
					piEnvironmentChecked: true,
					enableGitManagement: true,
					...(seedSettings ?? {}),
				}),
			);
			// 可选：预置项目列表。ProjectStore.load 会保留种子项目并追加内置聊天项目。
			if (seedProjects && seedProjects.length > 0) {
				writeFileSync(
					join(userDataRoot, "profile-dev", "projects.json"),
					JSON.stringify(
						seedProjects.map((project, index) => ({
							lastOpenedAt: Date.now() + index,
							sortOrder: index,
							...project,
						})),
					),
				);
			}
			// 可选：预置飞书 Bot 配置（FeishuConfig 读 userData/pi-desktop/feishu.json）。
			// appSecret 用 base64（encryptSecret 的简化格式），空串即可——e2e 不真连飞书。
			if (seedFeishuBots && seedFeishuBots.length > 0) {
				mkdirSync(join(userDataRoot, "profile-dev", "pi-desktop"), { recursive: true });
				writeFileSync(
					join(userDataRoot, "profile-dev", "pi-desktop", "feishu.json"),
					JSON.stringify({
						version: 2,
						bots: seedFeishuBots.map((bot) => ({
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

			const env = {
				...process.env,
				CI: "1",
				...(process.platform === "win32"
					? { APPDATA: userDataRoot }
					: process.platform === "darwin"
						? { HOME: userDataRoot }
						: { XDG_CONFIG_HOME: userDataRoot, HOME: userDataRoot }),
			};
			delete env.ELECTRON_RENDERER_URL;
			const app = await electron.launch({
				args: [join(repoRoot, "out", "main", "index.js"), `--user-data-dir=${join(userDataRoot, "profile")}`],
				env,
			});
			await use(app);
			await app.close();
		} finally {
			// 调试可用 PIDECK_E2E_KEEP=1 保留 userData（含主进程日志），排查 spawn/状态问题
			if (!process.env.PIDECK_E2E_KEEP) {
				try { rmSync(userDataRoot, { recursive: true, force: true }); } catch { /* Windows 文件锁，忽略 */ }
			} else {
				console.log("[mock-pi-fixture] kept userDataRoot:", userDataRoot);
			}
		}
	},
	window: async ({ app }, use) => {
		const window = await app.firstWindow();
		await window.waitForLoadState("domcontentloaded");
		await use(window);
	},
});

export { expect } from "@playwright/test";
