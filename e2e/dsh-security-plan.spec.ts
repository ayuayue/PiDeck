import { test, expect } from "./fixtures";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { openConfigPane } from "./open-session";

/**
 * DSH 安全与 plan 模式端到端验证（真实 DSH host + host 侧 slash 命令桥）：
 * 1. 权限预设：底栏安全位显示 DSH 预设（而非 PiDeck 内置安全），切换 read-only
 *    → host /permission 命令执行 → runtime state 反映（permission/preset 事件折叠）；
 * 2. plan 模式：模式选择器「计划」→ /plan 命令 → 下一条消息的步骤生效
 *    （plan/mode 事件）→ runtime state planModeActive=true → 底栏模式按钮变「计划」；
 *    再切「普通」→ /plan off 生效；
 * 3. 配置管理页分区：预设设置 / 插件 / 安全 三个分区渲染（dsh-web 形态）。
 *
 * 隔离：settings.dshHomeDir 指向临时 DSH_HOME（复制真实 settings.yaml，不带凭证）。
 */
test("DSH 权限预设切换、plan 模式与配置页分区", async ({ window }) => {
	test.setTimeout(300_000);

	// ── 1. 隔离 DSH_HOME ──────────────────────────────────────────────────────
	const dshHome = mkdtempSync(join(tmpdir(), "pideck-e2e-dsh-"));
	const realSettings = join(homedir(), ".dsh", "settings.yaml");
	if (existsSync(realSettings)) copyFileSync(realSettings, join(dshHome, "settings.yaml"));
	await window.evaluate(async (dir) => {
		await (window as unknown as { piDesktop: { settings: { update: (patch: { dshHomeDir?: string }) => Promise<unknown> } } }).piDesktop.settings.update({ dshHomeDir: dir });
	}, dshHome);

	// ── 2. 新建 DSH 会话草稿（新会话默认 DSH 后端）──────────────────────────
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const newDsh = window.getByRole("button", { name: "新会话", exact: true });
	await expect(newDsh).toBeVisible({ timeout: 15_000 });
	await newDsh.click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// ── 2.5 草稿期权限预选（回归：未启动时下拉可点、不可灰）──────────────────
	// 旧 bug：会话未启动时权限下拉能弹出但选项是灰的、无法选中。修复后草稿期
	// 选择只写会话记录（启动时 applyPreferences 应用），选项必须可点击。
	// #214 统一后触发按钮为纯图标（与 pi 安全等级菜单同款），当前档位走 title 提示。
	const securityBtn = window.locator(".composer-bar-btn.security.dsh");
	await expect(securityBtn).toBeVisible();
	// 草稿期展示 settings permission.defaultPreset（workspace-write）
	await expect(securityBtn).toHaveAttribute("title", /Workspace Write/, { timeout: 10_000 });
	await securityBtn.click();
	const permissionPicker = window.locator(".dsh-permission-menu");
	await expect(permissionPicker).toBeVisible();
	await expect(permissionPicker.locator('[data-picker-value="read-only"]')).toBeVisible();
	await expect(permissionPicker.locator('[data-picker-value="workspace-write"]')).toBeVisible();
	await expect(permissionPicker.locator('[data-picker-value="danger-full-access"]')).toBeVisible();
	// 选项必须可交互（disabled 状态即旧 bug 的灰态）
	await expect(permissionPicker.locator('[data-picker-value="read-only"]')).toBeEnabled();
	await permissionPicker.locator('[data-picker-value="read-only"]').click();
	await expect(permissionPicker).toHaveCount(0, { timeout: 5_000 });
	// 草稿期选择持久化到会话记录
	const draftRecord = await window.evaluate(async () => {
		const pi = (window as unknown as { piDesktop: { sessions: { listCatalog: (projectId: string, opts?: unknown) => Promise<Array<{ id: string; title: string; permissionPreset?: string; backend?: string }>> } } }).piDesktop;
		try {
			const records = await pi.sessions.listCatalog("builtin-chat", { scan: false });
			const dsh = records.find((r) => r.backend === "dsh");
			return dsh ? { id: dsh.id, permissionPreset: dsh.permissionPreset } : null;
		} catch {
			return null;
		}
	});
	expect(draftRecord?.permissionPreset).toBe("read-only");
	await expect(securityBtn).toHaveAttribute("title", /Read Only/, { timeout: 10_000 });

	// 发送激活：applyPreferences 把草稿期预选的 read-only 套到 host 会话
	await composer.click();
	await window.keyboard.type("启动会话");
	await window.keyboard.press("Enter");

	const readDshRuntimeState = () =>
		window.evaluate(async () => {
			const pi = (
				window as unknown as {
					piDesktop: {
						sessions: {
							listRuntimes: () => Promise<Array<{ sessionId: string; agentId: string; runtimeGeneration: number }>>;
							getRuntimeState: (target: unknown) => Promise<{ ok: boolean; value: { value?: { permissionPreset?: string; planModeActive?: boolean; modelId?: string } } }>;
						};
					};
				}
			).piDesktop;
			const runtimes = await pi.sessions.listRuntimes();
			const dsh = runtimes.find((runtime) => runtime.agentId.startsWith("dsh:"));
			if (!dsh) return null;
			const result = await pi.sessions.getRuntimeState(dsh);
			return result.ok ? (result.value.value ?? null) : null;
		});
	const waitForState = async (predicate: (state: NonNullable<Awaited<ReturnType<typeof readDshRuntimeState>>>) => boolean, attempts = 30) => {
		for (let i = 0; i < attempts; i += 1) {
			const state = await readDshRuntimeState();
			if (state && predicate(state)) return state;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		return readDshRuntimeState();
	};

	// 等 runtime 激活（turn 无凭证会失败，但会话已 idle）
	const activated = await waitForState((state) => state.modelId !== undefined, 40);
	expect(activated?.modelId).toBeTruthy();

	// ── 3. 权限预设：激活后底栏盾牌按钮 → host 命令切换 workspace-write ──────
	// 激活时 applyPreferences 已把草稿期预选的 read-only 套到 host
	await expect(securityBtn).toHaveAttribute("title", /Read Only/, { timeout: 10_000 });

	await securityBtn.click();
	await expect(permissionPicker).toBeVisible();
	await expect(permissionPicker.locator('[data-picker-value="read-only"]')).toBeVisible();
	await expect(permissionPicker.locator('[data-picker-value="workspace-write"]')).toBeVisible();
	await expect(permissionPicker.locator('[data-picker-value="danger-full-access"]')).toBeVisible();
	await permissionPicker.locator('[data-picker-value="workspace-write"]').click();
	await expect(permissionPicker).toHaveCount(0, { timeout: 5_000 });

	// host /permission 命令执行：permission/preset 事件折叠进 runtime state
	const readWrite = await waitForState((state) => state.permissionPreset === "workspace-write", 20);
	expect(readWrite?.permissionPreset).toBe("workspace-write");
	await expect(securityBtn).toHaveAttribute("title", /Workspace Write/, { timeout: 10_000 });

	// ── 4. plan 模式：「+」菜单 → 模式分组「计划」→ 下一条消息生效 ────────────
	// 2026-10 改版：模式入口收进「+」菜单（普通模式不列项），底栏用可退出的 chip 显示当前模式。
	const modeChip = window.locator("[data-composer-mode='plan']");
	await window.locator('[data-testid="composer-add-menu"]').click();
	await window.locator('[data-picker-value="plan"]').click();
	await expect(modeChip).toHaveText("计划", { timeout: 10_000 });

	// 计划模式待生效：发一条消息让 plan/mode 在 pre-step 落地
	await composer.click();
	await window.keyboard.type("按计划执行");
	await window.keyboard.press("Enter");
	const planned = await waitForState((state) => state.planModeActive === true, 30);
	expect(planned?.planModeActive).toBe(true);
	// 底栏 chip 显示短名「计划」（不再带「模式」二字）
	await expect(modeChip).toHaveText("计划", { timeout: 10_000 });

	// 退出计划模式：鼠标移到 chip 上（图标变 ×）后点击——整枚 chip 就是退出按钮
	await modeChip.hover();
	await modeChip.click();
	await composer.click();
	await window.keyboard.type("恢复正常");
	await window.keyboard.press("Enter");
	const normal = await waitForState((state) => state.planModeActive === false, 30);
	expect(normal?.planModeActive).toBe(false);
	await expect(modeChip).toHaveCount(0, { timeout: 10_000 });

	// ── 5. 配置管理页：预设设置 / 插件 / 安全 分区 ───────────────────────────
	await openConfigPane(window);
	const modal = window.getByRole("dialog", { name: "配置管理" });
	await expect(modal).toBeVisible({ timeout: 10_000 });
	const dshTab = modal.getByRole("tab", { name: "DSH 配置管理" });
	await expect(dshTab).toBeVisible();
	await dshTab.click();

	// 预设设置：分区渲染（当前部署未装配 agent 预设目录 → 空态提示；装配后列出 roster）
	const presetsNav = modal.getByRole("button", { name: "预设设置" });
	await expect(presetsNav).toBeVisible();
	await presetsNav.click();
	await expect(modal.getByText("Agent 预设", { exact: false }).first()).toBeVisible({ timeout: 15_000 });

	// 插件：agent-loop / shell / web-search-deepseek 分区
	await modal.getByRole("button", { name: "插件", exact: true }).click();
	await expect(modal.getByText("Agent Loop", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
	await expect(modal.getByText("Shell", { exact: false }).first()).toBeVisible();
	await expect(modal.getByText("Web Search", { exact: false }).first()).toBeVisible();

	// 安全：默认预设选择器（workspace-write 当前值）
	await modal.getByRole("button", { name: "安全", exact: true }).click();
	await expect(modal.getByText("新会话默认权限预设", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
	await expect(modal.getByText("Workspace Write", { exact: false }).first()).toBeVisible();
});
