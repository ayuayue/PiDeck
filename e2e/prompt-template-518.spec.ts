import { test, expect } from "./mock-pi-fixture";
import type { Locator, Page } from "@playwright/test";

/**
 * #518 回归：提示词模板「正文为空」与删除确认弹框不消失。
 *
 * 两个症状都来自同一条前提——模板表/确认弹框是**渲染层缓存**，外部（设置页保存、IPC）改动后
 * 不会自动回灌：
 * - 新建模板只写 frontmatter，编辑正文后会话缓存仍停在空壳态，发送 `/模板名` 被误判成空模板；
 * - 删除确认弹框由父组件状态控制，`confirmDeletePrompt` 不清状态、`ConfirmDialog` 的确认标记
 *   也不复位，删完弹框既留在页面上、也关不掉。
 *
 * 这里不驱动设置页编辑器（CodeMirror 输入与本次缺陷无关），而是走真实 IPC：
 * `prompts.create` 建空壳 → 打开选择器让渲染层缓存它 → `prompts.edit` 补正文（等价设置页保存）
 * → 发送 `/模板名`。重建/保存都走 `PromptManager`，主进程 list 缓存会正常失效，
 * 因此失败只可能来自渲染层缓存没补拉（本次修复点）。
 */

const TEMPLATE = "e2e-518";
const DELETED = "e2e-del";
const BODY = "e2e 模板正文五幺八";

/** contextBridge 暴露的 prompts 通道（只在页面上下文里可用）。 */
type PromptsBridge = {
	prompts: {
		create(input: { name: string; description: string }): Promise<{ path: string }>;
		edit(path: string, content: string): Promise<void>;
	};
};

async function createTemplate(window: Page, name: string, description: string, content: string): Promise<string> {
	return await window.evaluate(
		async ({ name, description, content }) => {
			const api = (window as unknown as { piDesktop: PromptsBridge }).piDesktop.prompts;
			const created = await api.create({ name, description });
			await api.edit(created.path, content);
			return created.path;
		},
		{ name, description, content },
	);
}

async function saveTemplate(window: Page, path: string, content: string): Promise<void> {
	await window.evaluate(
		async ({ path, content }) => {
			const api = (window as unknown as { piDesktop: PromptsBridge }).piDesktop.prompts;
			await api.edit(path, content);
		},
		{ path, content },
	);
}

async function waitForHome(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
}

/** 写入并发送草稿（冷启动首发送可能被启动浮层抢焦点：清空草稿后重试，不重复发送）。 */
async function sendDraft(window: Page, composer: Locator, text: string) {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await composer.click();
		await window.keyboard.press("Control+a");
		await window.keyboard.press("Delete");
		await window.keyboard.insertText(text);
		await expect(composer).toHaveText(text);
		await window.keyboard.press("Escape"); // 关掉斜杠联想菜单，避免回车选中菜单项
		await window.keyboard.press("Enter");
		try {
			await expect(composer).toHaveText("", { timeout: 6000 });
			return;
		} catch {
			// 冷启动/焦点被抢：下一轮重来（草稿仍在，不会重复发送）。
		}
	}
	await expect(composer).toHaveText("");
}

async function openConfigPane(window: Page) {
	await waitForHome(window);
	await window.getByRole("button", { name: "设置", exact: true }).first().click();
	const configEntry = window
		.getByRole("tab", { name: "配置管理", exact: true })
		.or(window.getByRole("button", { name: "配置管理", exact: true }))
		.first();
	await expect(configEntry).toBeVisible({ timeout: 20_000 });
	await configEntry.click();
	// 左侧「配置管理」导航：提示词模板页签（PromptsTab 内还有一个同名子页签，取第一个）。
	await expect(window.getByRole("tab", { name: "提示词模板", exact: true }).first()).toBeVisible({ timeout: 20_000 });
}

test("模板正文补上后，发送 /模板名 不再被当成空模板", async ({ window }) => {
	await waitForHome(window);
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// 0. 先发一条普通消息把 runtime 绑定下来：之后点击/发送不再触发模板表重载，
	// 缓存才会真的停在「空壳」那一步（缺陷的前提）。
	await sendDraft(window, composer, "e2e 预热消息");

	// 1. 建一个只有 frontmatter 的空壳模板（= 设置页「新建模板」的产物）。
	const path = await createTemplate(window, TEMPLATE, "e2e 空壳模板", `---\ndescription: e2e 空壳模板\n---\n`);

	// 2. 打开一次提示词选择器：让会话缓存记住这份空正文（缺陷的前提）。
	await window.getByRole("button", { name: "添加附件、技能、提示词或模式" }).click();
	await window.getByRole("menuitem", { name: "选择提示词" }).click();
	await expect(window.getByText(`/${TEMPLATE}`).first()).toBeVisible({ timeout: 10_000 });
	// 关掉选择器与它下面的「+」菜单：菜单还开着时回车会被它吃掉，发送不出去。
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await window.keyboard.press("Escape");
		if ((await window.getByRole("menu").count()) === 0 && (await window.getByText(`/${TEMPLATE}`).count()) === 0) break;
		await window.waitForTimeout(200);
	}
	await expect(window.getByRole("menu")).toHaveCount(0);

	// 3. 等价于「设置页编辑并保存正文」。
	await saveTemplate(window, path, `---\ndescription: e2e 空壳模板\n---\n\n${BODY}\n`);

	// 4. 发送 /模板名：缓存里是空壳，必须补拉后才能展开。
	await sendDraft(window, composer, `/${TEMPLATE}`);

	// 发送被接受（缺陷下会被 rejectEmptyTemplate 拦住，草稿留在输入框里）。
	await expect(window.getByText(/正文为空/)).toHaveCount(0);
});

test("删除提示词模板：取消只关弹框，确认后弹框与行都消失", async ({ window }) => {
	await waitForHome(window);
	await createTemplate(window, DELETED, "e2e 待删模板", `---\ndescription: e2e 待删模板\n---\n\n待删正文\n`);

	await openConfigPane(window);
	await window.getByRole("tab", { name: "提示词模板", exact: true }).first().click();

	const row = window.getByRole("row", { name: new RegExp(`/${DELETED}`) });
	await expect(row).toBeVisible({ timeout: 10_000 });
	const dialog = window.getByRole("alertdialog");
	const deleteButton = row.getByRole("button", { name: "删除", exact: true });

	// 取消：弹框关闭，行保留（缺陷下 onCancel 被 confirmedRef 吞掉，弹框关不掉）。
	await deleteButton.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "取消", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(row).toBeVisible();

	// 确认：模板被删掉，弹框也必须消失（缺陷下父组件不清状态，弹框一直挂着）。
	await deleteButton.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "删除", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(row).toHaveCount(0);
});
