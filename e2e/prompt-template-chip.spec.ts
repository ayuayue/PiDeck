import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";

/**
 * 提示词模板 chip 端到端：`/<模板名>` 必须在**发送前本地展开**并保留模板名。
 *
 * 覆盖的缺陷（2026-10 现场）：包带模板（npm 包声明的 `pi.prompts`，如 pi-subagents 的
 * `parallel-review`）不在 PiDeck 的 prompts:list 里，于是 `/名称` 原样发给 pi，由 pi 展开成
 * 纯正文落盘——模板名丢失。表现是「运行中气泡有 chip，停止/重载后整段展开」。
 *
 * 断言的落点是 **RPC 线上形态**（mock 会把收到的每条命令写进自己的日志）：pi 收到的必须是
 * 自包含块而不是 `/名称`。真机上 pi 收到什么就原样写进会话文件，所以这一条同时钉住了
 * 「重载后还能还原 chip」的依据。
 */

const seedProject = makeSeedProject("PromptTemplateChip");
const TEMPLATE_NAME = "e2e-template";
// 唯一探针串：并发/历史日志里靠它定位本次用例的那一条 prompt
const PROBE = `chip-probe-${Date.now().toString(36)}`;
const TEMPLATE_BODY = "E2E-TEMPLATE-BODY：请只回复 OK。";

const HISTORY_TITLE = "模板 chip 历史会话";
const HISTORY_BODY = "历史模板正文：这段只该进模型上下文。";

test.use({
	seedProjects: [seedProject],
	mockSessionInProject: true,
	// 预置一条「已经落盘」的历史消息：用户消息就是自包含模板块（真机上 pi 收到的形态）。
	// 用它验证**从磁盘还原 chip** —— 也就是用户报的那个症状（暂停/重载后整段展开）。
	seedSessionFiles: [
		{
			projectPath: seedProject.path,
			entries: [
				{ type: "session", version: 3, id: "template-chip-history", parentId: null, name: HISTORY_TITLE, cwd: seedProject.path, timestamp: new Date(Date.now() - 120_000).toISOString() },
				{
					type: "message",
					id: "template-chip-history-user",
					parentId: "template-chip-history",
					timestamp: new Date(Date.now() - 119_000).toISOString(),
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `<prompt_template name="${TEMPLATE_NAME}">
${HISTORY_BODY}
</prompt_template>

总结一下`,
							},
						],
					},
				},
				{
					type: "message",
					id: "template-chip-history-assistant",
					parentId: "template-chip-history-user",
					timestamp: new Date(Date.now() - 118_000).toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "好的。" }] },
				},
			],
		},
	],
});

test.beforeAll(() => {
	// mock-pi 的 get_commands 按项目内固定路径登记模板（见 e2e/mock-pi.cjs）
	mkdirSync(join(seedProject.path, ".pi"), { recursive: true });
	writeFileSync(join(seedProject.path, ".pi", "e2e-template.md"), `---\ndescription: E2E 模板\n---\n${TEMPLATE_BODY}\n`, "utf8");
});

/**
 * 本次用例发给 pi 的全部 prompt 文本（从 mock 的 RPC 日志里取）。
 *
 * 用探针串定位。返回数组而不是单条：忙碌时消息会先入队、随后 flush，
 * 不能假设「最后一条就是模板命令」（2026-10 间歇失败就是这个假设导致的）。
 */
function sentPromptTexts(): string[] {
	const dir = tmpdir();
	const logs = readdirSync(dir).filter((name) => name.startsWith("mock-pi-") && name.endsWith(".log"));
	const texts: string[] = [];
	for (const name of logs) {
		let body = "";
		try {
			body = readFileSync(join(dir, name), "utf8");
		} catch {
			continue;
		}
		if (!body.includes(PROBE)) continue;
		for (const line of body.split("\n")) {
			if (!line.startsWith("< ")) continue;
			let command: { type?: string; message?: string };
			try {
				command = JSON.parse(line.slice(2)) as { type?: string; message?: string };
			} catch {
				continue;
			}
			if (command.type === "prompt" && typeof command.message === "string" && command.message.includes(PROBE)) texts.push(command.message);
		}
	}
	return texts;
}

async function openProjectSession(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 侧栏默认停在「聊天」分段；工作区项目行在「项目」分段下。必须从项目行进会话，
	// 保证 agent 的 cwd 就是种子项目（mock 的 get_commands 按 cwd 定位模板文件）。
	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.locator(".conversation", { hasText: seedProject.name }).first();
	await expect(projectRow).toBeVisible({ timeout: 20_000 });
	await projectRow.click();
	await projectRow.hover();
	await projectRow.getByRole("button", { name: "普通会话" }).first().click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

test("发 /模板名：发给 pi 的是自包含块（带模板名），气泡只显示 chip", async ({ window }) => {
	const composer = await openProjectSession(window);
	// 注意：这里**不预热**——直接在新开的会话里发模板命令，覆盖「第一条消息」场景
	// （此刻还没有 runtime target，模板表只能来自项目 standby 池的草稿预览）。
	await composer.click();
	await window.keyboard.insertText(`/${TEMPLATE_NAME} ${PROBE}`);
	await expect(composer).toContainText(TEMPLATE_NAME);
	await window.keyboard.press("Enter");

	// mock 回包即本轮结束（说明 prompt 已被 pi 接收）
	await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「", { timeout: 25_000 });

	// ── 线上契约：PiDeck 必须自己展开，并把模板名写进消息 ──
	// 忙碌时消息会先入队再 flush：轮询等它真的到达 pi，而不是立刻断言。
	await expect.poll(() => sentPromptTexts().some((text) => text.includes(`<prompt_template name="${TEMPLATE_NAME}">`)), { timeout: 25_000, message: "模板命令必须被本地展开后到达 pi" }).toBe(true);
	const sent = sentPromptTexts().find((text) => text.includes("<prompt_template"));
	expect(sent, "必须能取到本次发给 pi 的模板 prompt").toBeTruthy();
	expect(sent!, "发送前必须在本地展开成自包含块").toContain(`<prompt_template name="${TEMPLATE_NAME}">`);
	expect(sent!, "模板正文仍要进消息（模型读全文）").toContain(TEMPLATE_BODY);
	expect(sent!, "命令后的用户输入不能丢").toContain(PROBE);
	expect(sent!, "★ 关键：`/名称` 不能原样发给 pi（否则 pi 展开成无名字的正文）").not.toMatch(new RegExp(`(^|\\s)/${TEMPLATE_NAME}(\\s|$)`));

	// ── 气泡契约：显示模板名（chip），不铺模板正文 ──
	const bubble = window.locator(".user-turn").last();
	await expect(bubble).toContainText(TEMPLATE_NAME);
	await expect(bubble, "模板正文属于模型上下文，不能铺在气泡里").not.toContainText("E2E-TEMPLATE-BODY");
});

test("从磁盘还原：模板块显示成 chip（data-type=template），不铺模板正文", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.locator(".conversation", { hasText: seedProject.name }).first();
	await expect(projectRow).toBeVisible({ timeout: 20_000 });
	await projectRow.click();
	await window.locator(".conversation", { hasText: HISTORY_TITLE }).first().click();

	const bubble = window.locator(".user-turn").first();
	await expect(bubble).toContainText(TEMPLATE_NAME);
	// 模板正文属于模型上下文：气泡里不能出现
	await expect(bubble).not.toContainText("历史模板正文");
	// W4：模板块是独立类型（与 pi 的 skill / prompt 资源对齐），不再冒充技能
	await expect(bubble.locator('[data-type="template"]')).toHaveCount(1);
});
