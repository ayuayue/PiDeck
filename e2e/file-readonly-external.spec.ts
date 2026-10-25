import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";

/**
 * 会话里点文件链接的两种「不在当前项目内」场景（用户现场 2026-10：预览转编辑后
 * 打字不保存、Ctrl+S 毫无反应，且界面上没有任何提示）：
 *
 *  A. 真·项目外文件（不在任何已打开项目里）→ 按只读打开：必须显式可见「只读」徽标、
 *     编辑器真的不可输入、Ctrl+S 给出说明。此前编辑器硬编码 readOnly={false}，能随便
 *     打字却永远不落盘（allowSave=false 时 saveNow 直接 return）。
 *  B. 落在另一个已打开项目里的文件 → 走那个项目的写边界正常打开，可编辑并能自动保存。
 *     此前一律当「项目外」只读打开，换个会话看同一份文件就只能看不能改。
 *  C. 真·项目外文件仍然可以改（如 ~/.pi/agent/AGENTS.md 这类永不在项目里的文件）：
 *     头部「转为可编辑」→ 二次确认写明会直接写该路径 → 该 tab 才变成可编辑可保存。
 *
 * 本文件前半是 A、后半是 B，共用一套预置项目（A 项目 + 兄弟项目）。
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-ro-scope-"));
// 兄弟项目：另一个已登记项目，链接落在它目录内 → 应该可写
const siblingDir = mkdtempSync(join(tmpdir(), "pideck-ro-sibling-"));
const siblingFile = join(siblingDir, "sibling-target.ts");
writeFileSync(siblingFile, "export const siblingTargetMarker = 1;\n");
// 项目外目录：与两个项目都无关，路径不在任何项目根内
const externalDir = mkdtempSync(join(tmpdir(), "pideck-ro-outside-"));
const externalFile = join(externalDir, "outside-target.ts");
writeFileSync(externalFile, "export const outsideTargetMarker = 1;\n");
// 解锁用例专用文件：A 用例在同一个外部目录里验证过「打字被丢弃」，这里验证显式解锁后真的能写盘
const unlockFile = join(externalDir, "unlock-target.ts");
writeFileSync(unlockFile, "export const unlockTargetMarker = 1;\n");

// markdown 链接里的盘符路径要写成 /C:/...；POSIX 本身以 / 开头不再前置
const toLink = (filePath: string) => `${process.platform === "win32" ? "/" : ""}${filePath.replace(/\\/g, "/")}:1`;

/** 会话头 + 一条用户消息 + 一条带文件链接的助手消息（行格式与 mock-pi 的 JSONL 一致） */
const seedSession = (id: string, fileName: string, name: string, userText: string, assistantText: string) => ({
	projectPath: projectDir,
	// 同一项目放多个历史会话必须显式区分文件名，否则后一个覆盖前一个
	fileName,
	entries: [
		{
			type: "session",
			version: 3,
			id: `${id}-s`,
			parentId: null,
			name,
			cwd: projectDir,
			timestamp: new Date(Date.now() - 60_000).toISOString(),
		},
		{
			type: "message",
			id: `${id}-u`,
			parentId: `${id}-s`,
			timestamp: new Date(Date.now() - 59_000).toISOString(),
			message: { role: "user", content: [{ type: "text", text: userText }] },
		},
		{
			type: "message",
			id: `${id}-a`,
			parentId: `${id}-u`,
			timestamp: new Date(Date.now() - 58_000).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
		},
	],
});

// 多项种子必须用函数式覆盖：数组字面量 >=2 元素会被 Playwright 当成 [value, options] 元组截断
test.use({
	seedProjects: async ({}, use) =>
		use([
			{ id: "p1", name: "readonly-scope", path: projectDir },
			{ id: "p2", name: "sibling-scope", path: siblingDir },
		]),
	seedSessionFiles: async ({}, use) =>
		use([
			seedSession("ro", "outside-history.jsonl", "项目外链接锚点", "看下项目外的文件", `项目外文件：[outside-target.ts](${toLink(externalFile)})`),
			seedSession("sib", "sibling-history.jsonl", "跨项目链接锚点", "看下兄弟项目的文件", `兄弟项目文件：[sibling-target.ts](${toLink(siblingFile)})`),
			seedSession("unlock", "unlock-history.jsonl", "项目外解锁锚点", "看下这个项目外文件", `待改文件：[unlock-target.ts](${toLink(unlockFile)})`),
		]),
});

/** 打开「readonly-scope」项目下的指定历史会话（侧栏默认停在「聊天」分段） */
async function openHistorySession(window: Page, name: string) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.locator(".conversation", { hasText: "readonly-scope" }).first();
	await expect(projectRow).toBeVisible({ timeout: 20_000 });
	await projectRow.click();
	const historyRow = window.locator(".conversation", { hasText: name }).first();
	await expect(historyRow).toBeVisible({ timeout: 20_000 });
	await historyRow.click();
}

test("A: 项目外文件链接按只读打开——显式只读徽标 + 编辑器不可输入 + Ctrl+S 有提示", async ({ window }) => {
	await openHistorySession(window, "项目外链接锚点");
	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("看下项目外的文件", { timeout: 20_000 });

	// 项目外绝对路径的 href 是 /C:/... 形态（不是 file:// 前缀），按文案定位即可
	const link = timeline.locator("a", { hasText: "outside-target.ts" }).first();
	await expect(link).toBeVisible({ timeout: 15_000 });
	await link.click();

	// 默认安全等级（off / 不限目录）直接放行；若某个等级改成二次确认，这里跟着点一下
	const confirm = window.getByRole("button", { name: "只读查看" });
	if ((await confirm.count()) > 0) await confirm.first().click();

	const viewer = window.locator(".file-diff-viewer").first();
	await expect(viewer).toBeVisible({ timeout: 15_000 });
	// 1. 只读必须显式可见
	await expect(viewer.locator(".file-diff-header")).toContainText("只读", { timeout: 15_000 });

	// 2. .ts 直接进编辑器：内容可选中但输入无效
	const editor = viewer.locator(".cm-content").first();
	await expect(editor).toContainText("outsideTargetMarker", { timeout: 15_000 });
	await editor.click();
	await window.keyboard.type("READONLY_TYPING_SHOULD_BE_DROPPED");
	await expect(editor).not.toContainText("READONLY_TYPING_SHOULD_BE_DROPPED");

	// 3. Ctrl+S 不再静默：走全局通知给出「这是只读查看」的说明（头部徽标不算数，断言具体文案）
	await window.keyboard.press("Control+s");
	await expect(window.locator("[data-sonner-toaster]")).toContainText("按只读方式打开", { timeout: 10_000 });
});

test("C: 项目外文件可以显式「转为可编辑」——二次确认后真的能写盘", async ({ window }) => {
	await openHistorySession(window, "项目外解锁锚点");
	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("看下这个项目外文件", { timeout: 20_000 });

	const link = timeline.locator("a", { hasText: "unlock-target.ts" }).first();
	await expect(link).toBeVisible({ timeout: 15_000 });
	await link.click();
	const confirmReadOnly = window.getByRole("button", { name: "只读查看" });
	if ((await confirmReadOnly.count()) > 0) await confirmReadOnly.first().click();

	const viewer = window.locator(".file-diff-viewer").first();
	await expect(viewer.locator(".file-diff-header")).toContainText("只读", { timeout: 15_000 });

	// 解锁必须经二次确认：点按钮只弹框，不直接变成可写
	await window.getByRole("button", { name: "转为可编辑" }).first().click();
	const dialog = window.getByRole("alertdialog");
	await expect(dialog).toContainText("允许编辑项目外文件", { timeout: 10_000 });
	await expect(dialog).toContainText("直接写入");
	await dialog.getByRole("button", { name: "允许编辑" }).click();

	// 解锁后：只读徽标消失、编辑器可输入，并且 500ms 防抖后真的写到项目外路径
	await expect(viewer.locator(".file-diff-header")).not.toContainText("只读", { timeout: 10_000 });
	const editor = viewer.locator(".cm-content").first();
	await editor.click();
	await window.keyboard.press("Control+End");
	await window.keyboard.type("\nexport const UNLOCKED_EXTERNAL_EDIT = 1;\n");
	await expect.poll(() => readFileSync(unlockFile, "utf8"), { timeout: 15_000, message: "显式解锁后项目外文件应能落盘" }).toContain("UNLOCKED_EXTERNAL_EDIT");
});

test("B: 另一个已打开项目里的文件照常可编辑并自动保存", async ({ window }) => {
	await openHistorySession(window, "跨项目链接锚点");
	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("看下兄弟项目的文件", { timeout: 20_000 });

	const link = timeline.locator("a", { hasText: "sibling-target.ts" }).first();
	await expect(link).toBeVisible({ timeout: 15_000 });
	await link.click();

	const viewer = window.locator(".file-diff-viewer").first();
	await expect(viewer).toBeVisible({ timeout: 15_000 });
	// 不是只读：没有「只读」徽标，编辑器可输入
	await expect(viewer.locator(".file-diff-header")).not.toContainText("只读");
	const editor = viewer.locator(".cm-content").first();
	await expect(editor).toContainText("siblingTargetMarker", { timeout: 15_000 });

	await editor.click();
	await window.keyboard.press("Control+End");
	await window.keyboard.type("\nexport const CROSS_PROJECT_EDIT = 1;\n");
	// 500ms 防抖后自动落盘：直接读磁盘证明写的是兄弟项目文件
	await expect.poll(() => readFileSync(siblingFile, "utf8"), { timeout: 15_000, message: "跨项目文件的自动保存应落盘" }).toContain("CROSS_PROJECT_EDIT");
});
