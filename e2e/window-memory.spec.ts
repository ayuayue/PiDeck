import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * 窗口几何记忆回归（startupWindowMode="last"）：
 * 1) 主进程 close 接线——正常退出应用时把当前窗口位置 + 尺寸写入 userData/last-window-bounds.json；
 * 2) 启动接线——带位置的记录按原位置还原（不再居中）。
 * 读取/钳位/顺延的纯逻辑由 tests/windowState.test.mjs 覆盖；maximized 恢复走 applyStartupWindowMode，
 * 该函数在 E2E 下刻意静默（不铺满屏遮挡用户），故不在此断言。
 *
 * last 是默认模式，直接用 seedSettings 落盘即可，不走设置页 UI（UI 路径由 settings 系列 E2E 覆盖）。
 */
test.use({ seedSettings: { startupWindowMode: "last" } });

test("window memory: close writes position + size to userData", async ({ app, window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const userDataPath = await app.evaluate(({ app: e }) => e.getPath("userData"));
	await app.evaluate(({ BrowserWindow }) => {
		const w = BrowserWindow.getAllWindows()[0];
		// 首启无 last 记录会顺延最大化：先还原再设几何，否则 setBounds 不生效
		w?.unmaximize();
		w?.setBounds({ x: 120, y: 90, width: 1200, height: 760 });
	});
	// 非 100% DPI 下 Windows 会把尺寸取整到物理像素再换算回来（1200 → 1201），
	// 位置精确、尺寸取 Electron 实际落定值作为基准，避免测试绑死显示缩放。
	await expect
		.poll(() =>
			app.evaluate(({ BrowserWindow }) => {
				const w = BrowserWindow.getAllWindows()[0];
				return w ? [w.getBounds().x, w.getBounds().y] : null;
			}),
		)
		.toEqual([120, 90]);
	const settled = await app.evaluate(({ BrowserWindow, screen }) => {
		const b = BrowserWindow.getAllWindows()[0].getBounds();
		return { x: b.x, y: b.y, width: b.width, height: b.height, workArea: screen.getDisplayMatching(b).workArea };
	});
	expect(Math.abs(settled.width - 1200)).toBeLessThanOrEqual(4);
	expect(Math.abs(settled.height - 760)).toBeLessThanOrEqual(4);
	await app.close();

	// close 接线：关闭前保存 normal bounds 含位置；非最大化不写 maximized
	const file = join(userDataPath, "last-window-bounds.json");
	expect(existsSync(file)).toBe(true);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(settled);
});

test("window memory: edge-aligned native bounds survive full quit and restart", async ({ app, window, userDataRoot }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const recorded = await app.evaluate(({ BrowserWindow, screen }) => {
		const w = BrowserWindow.getAllWindows()[0];
		const area = screen.getDisplayMatching(w.getBounds()).workArea;
		w.unmaximize();
		// 原生吸附外框可含工作区外的不可见 resize border；用同类几何验证真实建窗与退出链路。
		w.setBounds({ x: area.x - 7, y: area.y, width: Math.max(880, Math.floor(area.width / 2)) + 14, height: area.height + 7 });
		const b = w.getBounds();
		return { x: b.x, y: b.y, width: b.width, height: b.height, workArea: area };
	});
	await app.close();
	const profileDir = join(userDataRoot, "profile");
	expect(JSON.parse(readFileSync(join(profileDir, "last-window-bounds.json"), "utf8"))).toEqual(recorded);
	// ProcessEnv 注解：展开 process.env 会让 ELECTRON_RENDERER_URL 被推断为必填 string，
	// 下面 delete 需要可选键才合法；显式注解零行为差异，只让类型与现实一致。
	const restartEnv: NodeJS.ProcessEnv = {
		...process.env,
		ELECTRON_RENDERER_URL: "",
		PIDECK_E2E: "1",
		PIDECK_E2E_USER_DATA_DIR: profileDir,
		CI: "1",
		...(process.platform === "win32" ? { APPDATA: userDataRoot, LOCALAPPDATA: userDataRoot, USERPROFILE: userDataRoot, HOME: userDataRoot } : process.platform === "darwin" ? { HOME: userDataRoot } : { XDG_CONFIG_HOME: userDataRoot, HOME: userDataRoot }),
	};
	delete restartEnv.ELECTRON_RENDERER_URL;
	const executablePath = process.env.PIDEK_E2E_EXECUTABLE_PATH;
	const restarted = await electron.launch({
		...(executablePath ? { executablePath } : {}),
		args: executablePath ? [`--user-data-dir=${profileDir}`] : [join(__dirname, ".."), `--user-data-dir=${profileDir}`],
		env: restartEnv,
	});
	try {
		const reopened = await restarted.firstWindow();
		await reopened.waitForLoadState("domcontentloaded");
		const restored = await restarted.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
		expect([restored.x, restored.y]).toEqual([recorded.x, recorded.y]);
		expect(Math.abs(restored.width - recorded.width)).toBeLessThanOrEqual(1);
		expect(Math.abs(restored.height - recorded.height)).toBeLessThanOrEqual(1);
	} finally {
		await restarted.close();
	}
});

test.describe("window memory: startup restores recorded geometry", () => {
	test.beforeEach(({ userDataRoot }) => {
		// 模拟上一次退出留下的记录：位置在 workArea 内、非最大化
		const profile = join(userDataRoot, "profile");
		mkdirSync(profile, { recursive: true });
		writeFileSync(join(profile, "last-window-bounds.json"), JSON.stringify({ x: 140, y: 70, width: 1180, height: 740 }), "utf8");
	});

	test("recorded position is restored instead of centering", async ({ app, window }) => {
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		const state = await app.evaluate(({ BrowserWindow }) => {
			const w = BrowserWindow.getAllWindows()[0];
			const b = w.getBounds();
			return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: w.isMaximized() };
		});
		// 位置是本回归的核心断言（此前一律居中）；尺寸容忍 DPI 取整误差
		expect([state.x, state.y, state.maximized]).toEqual([140, 70, false]);
		expect(Math.abs(state.width - 1180)).toBeLessThanOrEqual(4);
		expect(Math.abs(state.height - 740)).toBeLessThanOrEqual(4);
	});
});
