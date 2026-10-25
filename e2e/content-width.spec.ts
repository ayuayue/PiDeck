import { test, expect } from "./mock-pi-fixture";
import { openFirstSession, makeSeedProject, openSettings } from "./open-session";

/**
 * 聊天内容宽度（百分比体系）E2E：
 * 1. 设置滑块 60–100；
 * 2. 保存 85% 后，消息区与输入框共享当前会话栏宽度（≈85%），消除「一边最大一边最小」；
 * 3. 窄栏仍按百分比留白（不再用容器查询盖掉滑块），消息与输入框继续同宽。
 *
 * 用 mock-pi fixture 隔离 userData（--user-data-dir 被 main/index.ts 尊重）：
 * 滑块保存只写临时 profile 的 settings.json，不触碰真实用户设置。
 * 会话通过 seed 项目 +「新建 Agent」打开（UI 2.0 点项目行只展开/收起，不再自动进 Chat 面）。
 */
const seedProject = makeSeedProject("ContentWidthE2E");
test.use({ seedProjects: [seedProject] });

test("content width: 85% shared margin, composer aligns with message list", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// ── 打开设置，切到外观设置 tab，滑块设为 85% ──
	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByText("外观设置").click();

	const slider = modal.locator('input[type="range"][aria-label="聊天内容宽度"]');
	await expect(slider).toBeVisible();
	await expect(slider).toHaveAttribute("min", "60");
	await expect(slider).toHaveAttribute("max", "100");
	// fill() 对 range input 不触发 React onChange，用原生 value setter + 事件派发
	await slider.evaluate((el) => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
		setter.call(el, "85");
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
	// 滑块右侧显示当前百分比（85 为非默认值，验证 onChange 生效）
	await expect(modal.getByText("85%", { exact: true })).toBeVisible();

	// 保存按钮常驻可用（非 dirty 时禁用——刚改过所以可点）
	await modal.getByRole("button", { name: "保存" }).click();
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(modal).toHaveCount(0);

	// ── 新建会话：发一条消息（mock-pi 回复）让消息列表容器渲染（宽度验证锚点）──
	const composerInput = await openFirstSession(window);
	const sessionPane = window.locator(".session-split-solo, .session-split-pane").first();
	await expect(sessionPane).toBeVisible();
	const composer = window.locator(".composer-box");
	await expect(composer).toBeVisible({ timeout: 20_000 });
	await composerInput.click();
	await window.keyboard.type("宽度验证");
	await window.keyboard.press("Enter");
	// 消息列表容器（留白锚点）；空会话不渲染 .message-list，等 mock 回复挂载
	const messageList = window.locator(".message-list");
	await expect(messageList).toBeVisible({ timeout: 20_000 });

	// ── 断言：消息区与输入框同宽，且约为当前会话栏的 85% ──
	const paneBox = await sessionPane.boundingBox();
	const msgBox = await messageList.boundingBox();
	const composerBox = await composer.boundingBox();
	expect(paneBox).not.toBeNull();
	expect(msgBox).not.toBeNull();
	expect(composerBox).not.toBeNull();

	const paneW = paneBox!.width;
	const msgW = msgBox!.width;
	const composerW = composerBox!.width;
	// 消息区 ≈ 输入框（同在会话栏宿主的内容盒内；timeline 滚动条约 10px，容差 14px）
	expect(Math.abs(msgW - composerW)).toBeLessThanOrEqual(14);
	// 内容区 ≈ 85% 面板宽度（±4% 容差：含最小 12px 边距与边框）
	expect(msgW / paneW).toBeGreaterThan(0.81);
	expect(msgW / paneW).toBeLessThan(0.89);

	// ── 窄栏仍按 85%，不因容器查询把滑块盖成全宽 ──
	await sessionPane.evaluate((element) => {
		const pane = element as HTMLElement;
		pane.style.flex = "0 0 900px";
		pane.style.width = "900px";
	});
	await window.waitForTimeout(400);
	const narrowMsgBox = await messageList.boundingBox();
	const narrowComposerBox = await composer.boundingBox();
	const narrowPaneBox = await sessionPane.boundingBox();
	expect(narrowMsgBox).not.toBeNull();
	expect(narrowComposerBox).not.toBeNull();
	expect(narrowPaneBox).not.toBeNull();
	expect(Math.abs(narrowMsgBox!.width - narrowComposerBox!.width)).toBeLessThanOrEqual(14);
	expect(narrowMsgBox!.width / narrowPaneBox!.width).toBeGreaterThan(0.81);
	expect(narrowMsgBox!.width / narrowPaneBox!.width).toBeLessThan(0.89);
});
