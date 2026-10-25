import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { openFirstSession } from "./open-session";

/**
 * Ask 提问 UI 全链路 E2E（mock pi 真实 RPC）：
 * 发消息 → mock pi emit extension_ui_request → 桌面端渲染提问卡片 →
 * 用户点击/输入 → extension_ui_response 回 pi → 会话出现包含答案的回复。
 *
 * 覆盖 4 种提问方式（select / confirm / input / editor）+ 批量 batch_ask
 * + select 无选项降级 + 自定义输入 + 取消 + 多 pending 显示最新。
 */

const timeline = (window: Page) => window.locator(".message-timeline");
const askBar = (window: Page) => window.locator(".ask-inline-bar");

/**
 * 打开第一个会话并使合成器可用。UI 2.0 起欢迎页不再有「启动 Agent」按钮，
 * 改为侧栏常驻的「新建会话」（app.newSession），复用 open-session 公共前置。
 */
async function startAgent(window: Page) {
	return openFirstSession(window);
}

/** 发送一条消息并等待 ask 卡片出现 */
async function sendAndWaitAsk(window: Page, message: string) {
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await window.keyboard.type(message);
	await window.keyboard.press("Enter");
	await expect(askBar(window)).toBeVisible({ timeout: 15_000 });
}

test("ask select: 点击选项后会话出现对应答案", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await startAgent(window);
	await composer.click();
	await window.keyboard.type("ASK_SELECT 选一个");
	await window.keyboard.press("Enter");

	const bar = askBar(window);
	await expect(bar).toBeVisible({ timeout: 15_000 });
	await expect(bar).toContainText("请选择操作");
	// 两个选项按钮 + 无自定义输入框（allowOther=false）
	const options = bar.locator(".ask-inline-bar-option");
	await expect(options).toHaveCount(2);
	await expect(bar.locator("input")).toHaveCount(0);

	await options.filter({ hasText: "选项B" }).click();
	// 回答回到 pi，流式回复包含答案
	await expect(timeline(window)).toContainText("选项B", { timeout: 15_000 });
});

test("ask select 无选项: 降级为输入框而不是消失", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	await sendAndWaitAsk(window, "ASK_SELECT_NOOPTS 无选项");

	const bar = askBar(window);
	await expect(bar).toContainText("无选项提问（应降级为输入）");
	// 降级后是 input 输入框，不是选项按钮
	await expect(bar.locator(".ask-inline-bar-option")).toHaveCount(0);
	const input = bar.locator("input");
	await expect(input).toBeVisible();
	await input.fill("手动回答");
	await bar.getByRole("button", { name: "提交" }).click();
	await expect(timeline(window)).toContainText("手动回答", { timeout: 15_000 });
});

test("ask select 自定义输入: allowOther 输入框提交", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	await sendAndWaitAsk(window, "ASK_SELECT_CUSTOM 自定义");

	const bar = askBar(window);
	await expect(bar.locator(".ask-inline-bar-option")).toHaveCount(2);
	const input = bar.locator("input");
	await expect(input).toBeVisible();
	await input.fill("我的自定义选项");
	await bar.getByRole("button", { name: "提交" }).click();
	await expect(timeline(window)).toContainText("我的自定义选项", { timeout: 15_000 });
});

test("ask confirm: 确认/取消都回传正确结果", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);

	// 点「确认」
	await sendAndWaitAsk(window, "ASK_CONFIRM 第一次");
	let bar = askBar(window);
	await expect(bar).toContainText("确认继续吗？");
	await bar.getByRole("button", { name: "确认" }).click();
	await expect(timeline(window)).toContainText("答案：true", { timeout: 15_000 });

	// 点「取消」（confirm 的取消按钮）
	await sendAndWaitAsk(window, "ASK_CONFIRM 第二次");
	bar = askBar(window);
	await bar.getByRole("button", { name: "取消" }).click();
	await expect(timeline(window)).toContainText("答案：false", { timeout: 15_000 });
});

test("ask input: 输入文本提交后回传", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	await sendAndWaitAsk(window, "ASK_INPUT 名字");

	const bar = askBar(window);
	await expect(bar).toContainText("请输入你的名字");
	const input = bar.locator("input");
	await expect(input).toHaveAttribute("placeholder", /张三/);
	await input.fill("李四");
	await bar.getByRole("button", { name: "提交" }).click();
	await expect(timeline(window)).toContainText("李四", { timeout: 15_000 });
});

test("ask editor: 多行文本提交后回传", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	await sendAndWaitAsk(window, "ASK_EDITOR 意见");

	const bar = askBar(window);
	await expect(bar).toContainText("请写下修改意见");
	const textarea = bar.locator("textarea");
	await expect(textarea).toBeVisible();
	await textarea.fill("第一行意见\n第二行意见");
	await bar.getByRole("button", { name: "提交" }).click();
	await expect(timeline(window)).toContainText("第一行意见", { timeout: 15_000 });
});

test("ask batch: 多题 Tab 流程提交后回传序列化答案", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	await sendAndWaitAsk(window, "ASK_BATCH 批量");

	const bar = askBar(window);
	// 3 个问题 Tab
	await expect(bar.locator(".ask-batch-tab")).toHaveCount(3);

	// Q1: select 选 React
	await bar.locator(".ask-inline-bar-option", { hasText: "React" }).click();
	// Q2: confirm 点 true
	await bar.locator(".ask-batch-nav-btn.primary").click();
	await bar.locator(".ask-inline-bar-option", { hasText: "是" }).click();
	// Q3: input 填项目名并提交（提交后才算已回答，最后一题导航按钮才会启用）
	await bar.locator(".ask-batch-nav-btn.primary").click();
	const q3Body = bar.locator(".ask-batch-question-body");
	await q3Body.locator("input").fill("my-app");
	await q3Body.getByRole("button", { name: "提交" }).click();
	// 最后一题导航按钮 = 确认提交（batch 专用文案，避免与「提交」子串匹配冲突）
	await bar.getByRole("button", { name: "确认提交" }).click();

	// 序列化答案回传：会话出现 React / 是 / my-app
	await expect(timeline(window)).toContainText("my-app", { timeout: 15_000 });
	await expect(timeline(window)).toContainText("React");
});

test("ask 取消: 点 X 关闭后回传 cancelled", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	await sendAndWaitAsk(window, "ASK_INPUT 取消测试");

	const bar = askBar(window);
	await bar.getByRole("button", { name: "关闭" }).click();
	await expect(timeline(window)).toContainText("[取消]", { timeout: 15_000 });
});

/**
 * 多 pending 请求只显示最新（回归：Plan 模式的 select 挂着时，
 * 后续真正需要回答的 ask 不能被遮蔽）。
 * 不走 mock pi（pi RPC 串行，一次只发一个 ask），直接经主进程注入事件。
 */
test("ask 多 pending: 渲染最新到达的请求而不是第一个", async ({ app, window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 1. 从当前激活 Tab 读真实 currentSessionId（渲染层不会把会话 id 暴露到别处）
	const focusedSessionId = await window.locator('.session-tab[aria-selected="true"]').getAttribute("data-session-id");
	expect(focusedSessionId).toBeTruthy();

	const inject = (event: unknown) =>
		app.evaluate(({ BrowserWindow }, payload) => {
			const win = BrowserWindow.getAllWindows()[0];
			win.webContents.send("sessions:runtime-event", payload);
		}, event);

	// 2. 建立假 runtime（running），再注入两个 pending ui-request
	const agentId = "e2e-inject-agent";
	await inject({
		kind: "event",
		sessionId: focusedSessionId,
		agentId,
		runtimeGeneration: 1,
		sourceChannel: "agents:state",
		payload: { status: "running", projectId: "e2e-project", cwd: "C:/e2e", title: "E2E Agent", sessionId: "pi-e2e-1" },
	});
	await inject({
		kind: "event",
		sessionId: focusedSessionId,
		agentId,
		runtimeGeneration: 1,
		sourceChannel: "agents:ui-request",
		payload: { agentId, requestId: "req-old", method: "select", title: "旧问题", options: ["旧选项A", "旧选项B"] },
	});
	await inject({
		kind: "event",
		sessionId: focusedSessionId,
		agentId,
		runtimeGeneration: 1,
		sourceChannel: "agents:ui-request",
		payload: { agentId, requestId: "req-new", method: "input", title: "新问题：请输入", placeholder: "新输入" },
	});

	// 3. 展示的应是最新的 input（旧 select 的选项按钮不可见）
	const bar = askBar(window);
	await expect(bar).toBeVisible({ timeout: 10_000 });
	await expect(bar).toContainText("新问题：请输入");
	await expect(bar.locator(".ask-inline-bar-option")).toHaveCount(0);
	await expect(bar.locator("input")).toBeVisible();

	// 4. 交互后（binding 在主进程不存在 → respond 失败回滚）UI 必须恢复可交互，不卡死
	await bar.locator("input").fill("注入的回答");
	await bar.getByRole("button", { name: "提交" }).click();
	await window.waitForTimeout(1500);
	await expect(bar.locator("input")).toBeEnabled();
	await expect(bar.getByRole("button", { name: "提交" })).toBeEnabled();
});
