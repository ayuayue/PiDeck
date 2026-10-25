import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 问题复现巡检：AI 输出里的裸文件路径被渲染成可点击链接后，
 * 点击应打开对应文件并显示真实内容；本测试断言「打开后内容非空」。
 *
 * 用例矩阵：
 * A. live 会话（agent 运行中）：相对路径 .ts / .md 链接 → 打开有内容
 * B. 历史会话（无 agent，baseDir=项目路径）：绝对 \ 与 / 路径链接 → 打开有内容
 * C. 死链（文件不存在，绝对路径，有 baseDir）：应显示 fileNotFound 错误，而非空白
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-linkrepro-"));
mkdirSync(join(projectDir, "src", "main"), { recursive: true });
mkdirSync(join(projectDir, "docs"), { recursive: true });
writeFileSync(join(projectDir, "src", "main", "index.ts"), "export const seedContent = 42;\n// link-repro marker-a\n");
// 40 行的跳转目标：第 25 行为特征行 "// line 25"，用于断言「打开后滚动定位到指定行」
writeFileSync(join(projectDir, "src", "main", "jump.ts"), Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n");
writeFileSync(join(projectDir, "docs", "ui-2.0-revamp-plan.md"), "# Revamp Plan\n\nlink-repro marker-b content.\n");

const isWin32 = process.platform === "win32";
const fsJumpPath = join(projectDir, "src", "main", "jump.ts");
const fsJumpFwd = fsJumpPath.replace(/\\/g, "/");
// 显式链接 href：Windows 盘符绝对路径用 URL 表示法 /C:/...（裸盘符 F:/ 曾被
// defaultUrlTransform 当未知协议清空 href → 点击无反应，已修复后两种形态都要覆盖）；
// POSIX 路径本身以 / 开头，不能再前置 /（否则变成协议相对 //var/... 同样点不开）。
const fsJumpMarkdown = `${isWin32 ? "/" : ""}${fsJumpFwd}:25`;

const fsAbsPath = join(projectDir, "docs", "ui-2.0-revamp-plan.md"); // C:\...\ui-2.0-revamp-plan.md
const fsAbsFwd = fsAbsPath.replace(/\\/g, "/");
const fsAbsMarkdown = `${isWin32 ? "/" : ""}${fsAbsFwd}:1`;
// 裸 absolute href（不带前导斜杠）：Windows 为 C:/...，POSIX 为 /...——跨端都应可点
const fsNakedMarkdown = `${fsAbsFwd}:1`;
const fsAbsDead = join(projectDir, "no-such-file.ts");

test.use({
	seedProjects: [{ id: "p1", name: "link-repro", path: projectDir }],
	seedSessionFiles: [
		{
			projectPath: projectDir,
			entries: [
				{
					type: "session",
					version: 3,
					id: "e1",
					parentId: null,
					name: "历史链接锚点",
					cwd: projectDir,
					timestamp: new Date(Date.now() - 60_000).toISOString(),
				},
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: new Date(Date.now() - 59_000).toISOString(),
					message: { role: "user", content: [{ type: "text", text: "绝对路径巡检" }] },
				},
				{
					type: "message",
					id: "e3",
					parentId: "e2",
					timestamp: new Date(Date.now() - 58_000).toISOString(),
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: `绝对路径巡检：\n反斜杠 ${fsAbsPath}\n正斜杠 ${fsAbsFwd}\n显式行号链接：[ui-2.0-revamp-plan.md](${fsAbsMarkdown})\n裸 href 链接：[naked-drive-link](${fsNakedMarkdown})\n跳行链接：[jump.ts](${fsJumpMarkdown})\n相对 src/main/index.ts\n不存在 ${fsAbsDead}`,
							},
						],
					},
				},
			],
		},
	],
});

// ── A. live 会话：相对路径链接 ──
test("A: live session relative-path links open non-empty content", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 侧栏分段(56469f95)后默认停在「聊天」分段，工作区项目行在「项目」分段下，先切换
	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "pideck-linkrepro-" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	const projectRow = window.locator(".conversation", { hasText: "pideck-linkrepro-" }).first();
	await projectRow.hover();
	await projectRow.getByRole("button", { name: "普通会话" }).first().click();

	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	const timeline = window.locator(".message-timeline");

	await composer.click();
	await window.keyboard.type("MDEMO 元素巡检");
	await window.keyboard.press("Enter");
	await expect(timeline).toContainText("渲染元素巡检", { timeout: 15_000 });

	// .ts 相对路径链接 → CodeMirror 显示真实内容
	const tsLink = timeline.locator('a[href^="file://"]', { hasText: "src/main/index.ts" }).first();
	await expect(tsLink).toBeVisible({ timeout: 15_000 });
	await tsLink.click();
	await expect(window.locator(".workbench-stage-split").first()).toBeVisible({ timeout: 15_000 });
	await expect(window.locator(".cm-content").first()).toContainText("link-repro marker-a", { timeout: 10_000 });

	// .md 相对路径链接 → markdown 预览显示真实内容（分裂查看器内）
	const stage = window.locator(".workbench-stage-split").first();
	const mdLink = timeline.locator('a[href^="file://"]', { hasText: "ui-2.0-revamp-plan.md" }).first();
	await expect(mdLink).toBeVisible({ timeout: 15_000 });
	await mdLink.click();
	await expect(stage).toContainText("link-repro marker-b", { timeout: 10_000 });
});

// ── B/C. 历史会话（无 agent）：绝对路径链接显示内容；死链不产生空白可点项 ──
test("B/C: history session absolute-path links show content; dead link downgraded", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 侧栏分段(56469f95)后默认停在「聊天」分段，工作区项目行在「项目」分段下，先切换
	await window.getByRole("tab", { name: "项目" }).click();

	const projectRow = window.locator(".conversation", { hasText: "pideck-linkrepro-" }).first();
	await expect(projectRow).toBeVisible({ timeout: 20_000 });
	await projectRow.click();

	const historyRow = window.locator(".conversation", { hasText: "历史链接锚点" }).first();
	await expect(historyRow).toBeVisible({ timeout: 20_000 });
	await historyRow.click();

	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("绝对路径巡检", { timeout: 20_000 });
	// 绝对 \ 路径链接（反斜杠形态）→ 打开有内容
	const backslash = timeline.locator('a[href^="file://"]', { hasText: "ui-2.0-revamp-plan.md" }).filter({ hasText: fsAbsPath }).first();
	await expect(backslash).toBeVisible({ timeout: 15_000 });
	await backslash.click();
	const stage = window.locator(".workbench-stage-split").first();
	await expect(stage).toBeVisible({ timeout: 15_000 });
	await expect(stage).toContainText("link-repro marker-b", { timeout: 10_000 });

	// 显式 Markdown 链接 `/C:/.../file.md:1`：等待存在性校验后仍应保持可点击，
	// 不能先显示胶囊再因错误路径被降级成普通文本。
	const explicit = timeline.getByRole("link", { name: "ui-2.0-revamp-plan.md", exact: true }).first();
	await expect(explicit).toBeVisible({ timeout: 15_000 });
	await expect(explicit).toHaveCount(1, { timeout: 2_000 });
	await explicit.click();
	await expect(stage).toContainText("link-repro marker-b", { timeout: 10_000 });

	// 裸 absolute href（不带前导斜杠显式链接）：Windows 为 C:/... 裸盘符、POSIX 为 /... 根路径。
	// 回归：裸盘符 href 曾被 defaultUrlTransform 当未知协议清空 → 点击无反应。
	const nakedLink = timeline.getByRole("link", { name: "naked-drive-link", exact: true }).first();
	await expect(nakedLink).toBeVisible({ timeout: 15_000 });
	await expect(nakedLink).toHaveCount(1, { timeout: 2_000 });
	await nakedLink.click();
	await expect(stage).toContainText("link-repro marker-b", { timeout: 10_000 });

	// 行号链接：打开文件后应滚动定位到第 25 行（光标所在行 = .cm-activeLine）
	const jumpLink = timeline.getByRole("link", { name: "jump.ts", exact: true }).first();
	await expect(jumpLink).toBeVisible({ timeout: 15_000 });
	await jumpLink.click();
	await expect(stage).toContainText("line 25", { timeout: 10_000 });
	const activeLine = window.locator(".cm-activeLine").first();
	await expect(activeLine).toBeVisible({ timeout: 10_000 });
	await expect(activeLine).toContainText("// line 25", { timeout: 10_000 });

	// 相对路径链接（历史会话 baseDir=项目路径）→ 打开有内容
	const rel = timeline.locator('a[href^="file://"]', { hasText: "src/main/index.ts" }).first();
	await expect(rel).toBeVisible({ timeout: 15_000 });
	await rel.click();
	await expect(stage).toContainText("link-repro marker-a", { timeout: 10_000 });

	// 死链：不存在的绝对路径 → 降级为纯文本（无 file:// 锚点），不会出现空白编辑器
	await expect(timeline.locator('a[href^="file://"]', { hasText: "no-such-file.ts" })).toHaveCount(0, { timeout: 10_000 });
	await expect(timeline.locator(".assistant-text", { hasText: "no-such-file.ts" })).toBeVisible({ timeout: 10_000 });
});
