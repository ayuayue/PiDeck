import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { makeSeedProject } from "./open-session";

/**
 * 历史消息编辑/删除/重发 × Agent 状态矩阵 E2E（2026-11 追加）。
 *
 * 与 session-history-mutation.spec.ts（运行中 idle / 已停止）互补，补齐三种状态：
 * - 流式中（streaming）：删除已落盘的前一轮消息 → 弹「先停止 Agent」→ 停止生效；
 *   且正在流式、未落盘的尾部随停止被丢弃（无残留重复）。
 * - 崩溃后（closed/detached）：agent 进程异常退出后，runtime target 不存在 →
 *   删除/编辑不再要求「先停止」，直接改 JSONL 立即生效。
 * - 从未启动（never-started）：打开预置历史会话（agent 从未 spawn）→ 删除确认、编辑直改、
 *   重发自动激活 runtime（spawn mock pi）→ 截断旧轮次后恰好一份新回复。
 *
 * 决策矩阵实现见 src/renderer/src/utils/sessionHistoryMutationPolicy.ts 与
 * src/renderer/src/hooks/useSessionHistoryMutations.ts。
 */

async function startAgent(window: Page) {
	// UI 2.0 合成器优先欢迎页：不再有「启动 Agent」按钮，首次输入即激活 runtime
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

/** 发送一条消息并等待 mock 完整回复（含「流式渲染验证完成」收尾标记）。 */
async function sendTurn(window: Page, text: string) {
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await window.keyboard.type(text);
	await window.keyboard.press("Enter");
	const reply = `Mock 回复：「${text}」流式渲染验证完成。`;
	await expect(window.locator(".message-timeline")).toContainText(reply, { timeout: 30_000 });
	return reply;
}

/** 时间线中某段文本的出现次数（去重断言用）。 */
async function countOccurrences(window: Page, text: string): Promise<number> {
	const contents = await window.locator(".message-timeline").allTextContents();
	return contents.join("\n").split(text).length - 1;
}

/** 等待 agent 空闲（发送键 busy 时切换为「停止」）。 */
async function waitIdle(window: Page) {
	const sendControl = window.locator(".composer-send-primary");
	await expect(sendControl).toHaveAttribute("aria-label", "发送", { timeout: 20_000 });
}

// ──────────────────────────────────────────────────────────────
// 状态一：流式中（streaming）删除 → 先停止，立即生效，流式尾巴不残留
// ──────────────────────────────────────────────────────────────
test("delete while streaming: stops agent first, applies immediately, no partial tail", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	const timeline = window.locator(".message-timeline");

	// 完整第一轮（会落盘 JSONL），作为删除目标
	const reply1 = await sendTurn(window, "流中删除目标");
	await waitIdle(window);

	// 第二轮慢速流式（SLOW），中途对第一轮已落盘消息执行删除
	await sendTurnBegin(window, "SLOW 流中删除进行中");
	// 等部分流式文本出现，确认 agent 处于 streaming 态
	await expect(timeline).toContainText("Mock 回复：「SLOW 流中删除进行中」", { timeout: 10_000 });

	// 流式中删除 → 弹「先停止 Agent」确认
	const firstTurn = timeline.locator(".turn-row").filter({ hasText: reply1 });
	await firstTurn.getByTitle("删除").click();
	const dialog = window.getByRole("alertdialog");
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await expect(dialog).toContainText("会话正在运行。删除消息会先停止 Agent");
	await dialog.getByRole("button", { name: "停止" }).click();

	// 停止 + 删除立即生效：第一轮回复消失；流式中的第二轮未落盘，随停止丢弃
	await expect(timeline).not.toContainText(reply1, { timeout: 30_000 });
	await window.waitForTimeout(1500); // 给残留流窗口
	await expect(timeline).not.toContainText("SLOW 流中删除进行中」流式渲染验证完成");
	// 无重复
	expect(await countOccurrences(window, reply1)).toBe(0);
});

/** 发送但不等完整回复（用于构造 streaming 态）。 */
async function sendTurnBegin(window: Page, text: string) {
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await window.keyboard.type(text);
	await window.keyboard.press("Enter");
}

// ──────────────────────────────────────────────────────────────
// 状态二：崩溃后（closed）→ 不要求先停止，删除/编辑直接改文件生效
// ──────────────────────────────────────────────────────────────
test("after agent crash: delete and edit apply directly without stop prompt", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	const timeline = window.locator(".message-timeline");

	const reply1 = await sendTurn(window, "崩溃前完整轮");
	// 触发 mock pi 崩溃（推一个 chunk 后 process.exit(1)，无 agent_end/settled）
	await sendTurnBegin(window, "CRASH 崩溃触发");
	await expect(timeline).toContainText("崩溃前最后输出", { timeout: 10_000 });
	// 等桌面端识别进程退出并清理 runtime（发送键回归「发送」）
	await waitIdle(window);

	// 崩溃后删除：不再弹「先停止 Agent」，直接是删除确认
	const firstUser = timeline.locator(".user-turn").filter({ hasText: "崩溃前完整轮" });
	await firstUser.locator(".user-turn-actions").getByTitle("删除").click();
	const dialog = window.getByRole("alertdialog");
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await expect(dialog).toContainText("删除后该消息将从会话中移除");
	await dialog.getByRole("button", { name: "删除" }).click();
	await expect(timeline.locator(".user-turn").filter({ hasText: "崩溃前完整轮" })).toHaveCount(0, { timeout: 30_000 });

	// 崩溃后编辑：无任何确认弹窗，保存即生效
	const turn = timeline.locator(".turn-row").filter({ hasText: reply1 });
	await turn.getByTitle("编辑").click();
	await expect(timeline.locator("textarea")).toBeVisible({ timeout: 10_000 });
	await timeline.locator("textarea").fill("崩溃后修改的回复内容");
	await timeline.getByRole("button", { name: "保存" }).click();
	// 非 live 路径不弹停止确认：直接改文件 → 立即生效
	await expect(window.getByRole("alertdialog")).toHaveCount(0, { timeout: 5_000 });
	await expect(timeline).toContainText("崩溃后修改的回复内容", { timeout: 30_000 });
	expect(await countOccurrences(window, reply1)).toBe(0);
});

// ──────────────────────────────────────────────────────────────
// 状态三：从未启动（never-started）→ 删除/编辑直接改文件；重发自动激活
// ──────────────────────────────────────────────────────────────
const neverStartedProject = makeSeedProject("never-started-history");

test.use({
	seedProjects: [neverStartedProject],
	seedSessionFiles: [
		{
			projectPath: neverStartedProject.path,
			entries: [
				{
					type: "session",
					version: 3,
					id: "e1",
					parentId: null,
					name: "未启动会话锚点",
					cwd: neverStartedProject.path,
					timestamp: new Date(Date.now() - 60_000).toISOString(),
				},
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: new Date(Date.now() - 59_000).toISOString(),
					message: { role: "user", content: [{ type: "text", text: "未启动会话锚点" }] },
				},
				{
					type: "message",
					id: "e3",
					parentId: "e2",
					timestamp: new Date(Date.now() - 58_000).toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "未启动回复一" }] },
				},
				{
					type: "message",
					id: "e4",
					parentId: "e3",
					timestamp: new Date(Date.now() - 57_000).toISOString(),
					message: { role: "user", content: [{ type: "text", text: "未启动第二问" }] },
				},
				{
					type: "message",
					id: "e5",
					parentId: "e4",
					timestamp: new Date(Date.now() - 56_000).toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "未启动回复二" }] },
				},
			],
		},
	],
});

test("never-started session: delete confirms, edit applies directly, resend auto-activates runtime", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 进入预置项目：项目行默认折叠，先点击展开（同时选中项目），会话行才渲染
	const projectRow = window
		.locator(".conversation", {
			hasText: "pideck-seed-never-started-history-",
		})
		.first();
	await expect(projectRow).toBeVisible({ timeout: 30_000 });
	await projectRow.click();

	// 打开预置历史会话（agent 从未 spawn；打开不输入不会 activateRuntime）
	const historyRow = window.locator(".conversation", { hasText: "未启动会话锚点" }).first();
	await expect(historyRow).toBeVisible({ timeout: 15_000 });
	await historyRow.click();
	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("未启动回复一", { timeout: 20_000 });
	await expect(timeline).toContainText("未启动回复二", { timeout: 10_000 });

	// ── 删除：无 runtime → 弹「删除后该消息将从会话中移除」而非「先停止」──
	const lastTurn = timeline.locator(".turn-row").filter({ hasText: "未启动回复二" });
	await lastTurn.getByTitle("删除").click();
	const dialog = window.getByRole("alertdialog");
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await expect(dialog).toContainText("删除后该消息将从会话中移除");
	await dialog.getByRole("button", { name: "删除" }).click();
	await expect(timeline).not.toContainText("未启动回复二", { timeout: 30_000 });

	// ── 编辑：无 runtime → 无任何确认弹窗，保存即生效 ──
	const firstTurn = timeline.locator(".turn-row").filter({ hasText: "未启动回复一" });
	await firstTurn.getByTitle("编辑").click();
	await expect(timeline.locator("textarea")).toBeVisible({ timeout: 10_000 });
	await timeline.locator("textarea").fill("未启动编辑后的回复");
	await timeline.getByRole("button", { name: "保存" }).click();
	await expect(window.getByRole("alertdialog")).toHaveCount(0, { timeout: 5_000 });
	await expect(timeline).toContainText("未启动编辑后的回复", { timeout: 30_000 });

	// ── 编辑 user 消息：同样无 runtime → 直接改文件生效（回归：曾出现「编辑框关了但没变」）──
	const firstUserTurn = timeline.locator(".user-turn").filter({ hasText: "未启动会话锚点" });
	await firstUserTurn.locator(".user-turn-actions").getByTitle("编辑", { exact: true }).click();
	await expect(timeline.locator("textarea")).toBeVisible({ timeout: 10_000 });
	await timeline.locator("textarea").fill("未启动编辑后的用户消息");
	await timeline.getByRole("button", { name: "保存" }).click();
	await expect(window.getByRole("alertdialog")).toHaveCount(0, { timeout: 5_000 });
	await expect(timeline).toContainText("未启动编辑后的用户消息", { timeout: 30_000 });
	await expect(timeline.getByText("未启动会话锚点")).toHaveCount(0, { timeout: 10_000 });

	// ── 重发：无 runtime → 直接截断 + 自动激活 runtime（spawn mock pi）→ 恰好一份新回复 ──
	const lastUser = timeline.locator(".user-turn").filter({ hasText: "未启动第二问" });
	await lastUser.locator(".user-turn-actions").getByTitle("用同一条用户消息再次发送给 AI").click();
	// 重发 spawn mock pi（activateRuntime）。项目信任已由 fixture 预写 trust.json（tmpdir 根）
	// 静默放行，不再弹「项目信任确认」（见 mock-pi-fixture.ts），故无需点弹框。
	// 截断旧轮次：原「未启动回复二」已删，重发后旧轮从时间线移除，随后新回复出现（唯一一份）。
	// 用 toHaveCount(1) 而非一次性 countOccurrences：agent_settled 会触发时间线从磁盘重建，
	// 一次性读取可能落在重建窗口内读到空，toHaveCount 会自动重试直到稳定。
	const fullReply = "Mock 回复：「未启动第二问」流式渲染验证完成。";
	await expect(timeline.getByText(fullReply)).toHaveCount(1, { timeout: 45_000 });
	await window.waitForTimeout(1500);
	// 前一轮内容保留且唯一
	await expect(timeline.getByText("未启动编辑后的回复")).toHaveCount(1, { timeout: 10_000 });
	await expect(timeline.getByText("未启动回复一")).toHaveCount(0, { timeout: 10_000 });
	// 旧回复（已被删除）绝不再出现
	await expect(timeline.getByText("未启动回复二")).toHaveCount(0, { timeout: 10_000 });
});

// ──────────────────────────────────────────────────────────────
// 状态三补：从未启动 → tab 栏「重启」激活时，会话消息区域显示加载遮罩
// （回归：曾只给 Tab 徽章/菜单项加动画，会话消息区域无任何加载反馈）
// ──────────────────────────────────────────────────────────────
const overlayRestartProject = makeSeedProject("never-started-overlay");

// 用 test.describe 块内 test.use 而非模块级 test.use：模块级 test.use 对同文件多次调用
// 会合并且后者覆盖前者（seedProjects/seedSessionFiles 均被本用例覆盖），导致前面
// 「never-started」用例的侧栏拿到 overlay 项目而失败。块内作用域互不干扰。
test.describe("content-area loading overlay", () => {
	test.use({
		seedProjects: [overlayRestartProject],
		seedSessionFiles: [
			{
				projectPath: overlayRestartProject.path,
				entries: [
					{
						type: "session",
						version: 3,
						id: "o1",
						parentId: null,
						name: "遮罩验证会话",
						cwd: overlayRestartProject.path,
						timestamp: new Date(Date.now() - 60_000).toISOString(),
					},
					{
						type: "message",
						id: "o2",
						parentId: "o1",
						timestamp: new Date(Date.now() - 59_000).toISOString(),
						message: { role: "user", content: [{ type: "text", text: "遮罩验证提问" }] },
					},
					{
						type: "message",
						id: "o3",
						parentId: "o2",
						timestamp: new Date(Date.now() - 58_000).toISOString(),
						message: { role: "assistant", content: [{ type: "text", text: "遮罩验证回复" }] },
					},
				],
			},
		],
	});

	test("never-started session: tab restart shows content-area loading overlay while activating", async ({ window }) => {
		test.setTimeout(180_000);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

		// 进入预置项目并打开历史会话（agent 从未 spawn）
		const projectRow = window
			.locator(".conversation", {
				hasText: "pideck-seed-never-started-overlay-",
			})
			.first();
		await expect(projectRow).toBeVisible({ timeout: 30_000 });
		await projectRow.click();
		const historyRow = window.locator(".conversation", { hasText: "遮罩验证会话" }).first();
		await expect(historyRow).toBeVisible({ timeout: 15_000 });
		await historyRow.click();
		const timeline = window.locator(".message-timeline");
		await expect(timeline).toContainText("遮罩验证回复", { timeout: 20_000 });

		// tab 栏「重启」：当前激活 tab 的菜单触发器（role=tab-menu，aria-label=更多操作）
		const activeTab = window.locator('.session-tab[aria-selected="true"]').first();
		await activeTab.locator('button[role="tab-menu"]').click();
		const menu = window.getByRole("menu");
		await menu.getByText("重启", { exact: true }).click();

		// 激活 runtime 需 spawn mock pi（数百 ms～1s）：会话消息区域遮罩（role=status，仅可见时挂载 role）应显示「正在启动会话…」
		await expect(window.locator('[role="status"]').filter({ hasText: "正在启动会话…" })).toBeVisible({ timeout: 10_000 });
		// 激活完成：遮罩消失（role 被摘除），会话进入 live
		await expect(window.locator('[role="status"]').filter({ hasText: "正在启动会话…" })).toHaveCount(0, { timeout: 30_000 });
	});
});
