import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Web 端「智能体」面板 + 输入框 `/` 斜杠命令的回归契约。
 *
 * 覆盖三件容易回归的事：
 * 1. 侧栏顶部三个控件（新建会话行 / 搜索框 / 新建项目钮）共用同一套 36px / 10px 圆角几何；
 * 2. `/` 菜单：草稿会话用本地发现 + Web 接管的 builtin，运行中的会话用运行时权威命令表，
 *    选中只替换 token、不发送；`/new` 建会话不发消息；
 * 3. 智能体「使用」= 立即建一条绑定会话 + 会话页出现角色设定提示条。
 *
 * 文案用 testid/结构定位，不依赖 zh/en 具体措辞。
 */
const projectA = makeSeedProject("pideck-dev", "agents-slash-a");

test.use({
	seedProjects: async ({}, use) => use([projectA]),
	seedSettings: {
		webServiceEnabled: true,
		webServiceHost: "127.0.0.1",
		webServicePort: 8796,
		webServiceRequiresAuth: false,
	},
});

const BASE = "http://127.0.0.1:8796";

async function waitForHealthy() {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const health = await fetch(`${BASE}/api/health`).catch(() => null);
		if (health?.ok) return true;
	}
	return false;
}

test("web sidebar: new-session row, search field and add-project share one control metric", async ({ app }) => {
	test.setTimeout(120_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto(BASE);
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });

	const newSessionRow = page.locator(".sidebar-body > button").first();
	const fieldBox = await page.locator(".search-box").boundingBox();
	const addProject = await page.getByRole("button", { name: /项目/ }).first().boundingBox();
	const newRow = await newSessionRow.boundingBox();
	expect(newRow?.height).toBe(36);
	expect(fieldBox?.height).toBe(36);
	expect(addProject?.height).toBe(36);
	// 三个控件左右缘对齐：新建会话行是整宽，搜索行 = 字段 + 36px 方钮，右缘也一致
	expect(Math.abs((newRow?.x ?? 0) - (fieldBox?.x ?? 0))).toBeLessThanOrEqual(1);
	expect(Math.abs((newRow?.x ?? 0) + (newRow?.width ?? 0) - ((addProject?.x ?? 0) + (addProject?.width ?? 0)))).toBeLessThanOrEqual(1);
});

test("web composer: slash menu lists builtins on a draft and inserts without sending", async ({ app }) => {
	test.setTimeout(120_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto(BASE);
	const textarea = page.locator("textarea#prompt");
	await expect(textarea).toBeVisible({ timeout: 20_000 });

	await textarea.click();
	await textarea.fill("/");
	const menu = page.getByTestId("web-slash-menu");
	await expect(menu).toBeVisible();
	await expect(menu).toContainText("/new");
	await expect(menu).toContainText("/compact");

	// 收窄候选：Enter 只选中候选，不发送
	await textarea.fill("/com");
	await expect(menu).toContainText("/compact");
	await page.keyboard.press("Enter");
	await expect(textarea).toHaveValue("/compact ");
	await expect(menu).toBeHidden();
	// 会话没有被创建（选中命令不等于发送）
	await expect(page.locator(".chat-list-pane .session-row")).toHaveCount(0);

	// Esc 收起后不再自动弹出；继续输入会重新打开
	await textarea.fill("/");
	await expect(menu).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await textarea.fill("");

	// 移动端：菜单留在视口内，点按候选即可插入（触屏没有键盘导航）
	await page.setViewportSize({ width: 390, height: 844 });
	await textarea.fill("/comp");
	await expect(menu).toBeVisible();
	const box = await menu.boundingBox();
	expect(box).toBeTruthy();
	expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
	await menu.getByRole("option").filter({ hasText: "/compact" }).click();
	await expect(textarea).toHaveValue("/compact ");
});

test("web agents: use an agent to open a bound session and show its role prompt", async ({ app }) => {
	test.setTimeout(120_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto(BASE);
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });

	await page.locator('.web-header-actions [aria-haspopup="menu"]').last().click();
	await page.getByTestId("web-header-agents").click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	const cards = dialog.locator("button[aria-expanded]");
	await expect(cards.first()).toBeVisible({ timeout: 10_000 });
	await cards.first().click();
	await dialog.getByTestId("web-agent-use").click();
	await expect(dialog).toBeHidden({ timeout: 20_000 });

	// 新会话出现且处于选中态；角色设定提示条可见，可展开看正文
	await expect(page.locator(".chat-list-pane .session-row.active")).toHaveCount(1, { timeout: 20_000 });
	const bar = page.getByTestId("web-agent-bar");
	await expect(bar).toBeVisible({ timeout: 20_000 });
	await bar.locator("button").first().click();
	await expect(bar.locator("pre")).toBeVisible();

	// 绑定信息来自 /api/state 投影（不是渲染层自造）：sessionAgentBindings 指向刚选的智能体
	const binding = await page.evaluate(async () => {
		const state = await (await fetch("/api/state")).json();
		const sessionId = window.location.pathname.split("/").filter(Boolean).pop() ?? "";
		const agents = (await (await fetch("/api/agents")).json()).agents ?? [];
		const agentId = (state.sessionAgentBindings ?? {})[sessionId] ?? "";
		return { sessionId, agentId, agent: agents.find((item: { id: string }) => item.id === agentId) ?? null };
	});
	expect(binding.sessionId, "使用后应当切到新会话路由").toBeTruthy();
	expect(binding.agentId, "会话必须写入智能体绑定").toBeTruthy();
	expect(binding.agent?.systemPrompt, "目录里应当能取到角色设定").toBeTruthy();
	const agentName = String(binding.agent.name);
	const personaHead = String(binding.agent.systemPrompt).trim().slice(0, 16);
	await expect(page.getByTestId("web-agent-bar")).toContainText(agentName);

	// 首轮发送：主进程把角色设定拼进隐藏载荷（Web 的 sendSessionPrompt 入口），
	// 证据在 pi 会话文件里——用户消息正文 = 角色设定 + 用户原文；
	// 而 UI 气泡只显示用户原文（隐藏通道对时间线不可见）。
	await expect(page.locator(".user-bubble")).toHaveCount(0);
	const textarea = page.locator("textarea#prompt");
	await textarea.fill("你好");
	await page.keyboard.press("Enter");
	await expect(page.locator(".user-bubble").last()).toContainText("你好");
	await expect(page.locator(".user-bubble").last()).not.toContainText(personaHead);
	await expect(page.locator(".assistant-text").last()).toBeVisible({ timeout: 30_000 });

	// runtime 的 sessionPath 随 /api/state 下发：等它出现后读文件内容
	const readRuntimePath = () =>
		page.evaluate(async () => {
			const state = await (await fetch("/api/state")).json();
			const sessionId = window.location.pathname.split("/").filter(Boolean).pop() ?? "";
			return (state.runtimes ?? []).find((runtime: { sessionId?: string }) => runtime.sessionId === sessionId)?.sessionPath ?? "";
		});
	let sessionPath = "";
	for (let attempt = 0; attempt < 40 && !sessionPath; attempt += 1) {
		sessionPath = await readRuntimePath();
		if (!sessionPath) await page.waitForTimeout(500);
	}
	expect(sessionPath).toBeTruthy();
	// 文件写入与流式收尾之间有窗口：轮询到本轮用户消息落盘再断言角色设定。
	let sessionText = "";
	for (let attempt = 0; attempt < 40 && !sessionText.includes("你好"); attempt += 1) {
		sessionText = readFileSync(sessionPath, "utf8");
		if (!sessionText.includes("你好")) await page.waitForTimeout(500);
	}
	expect(sessionText).toContain("你好");
	expect(sessionText).toContain(personaHead);

	await page.reload();
	await expect(page.getByTestId("web-agent-bar")).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId("web-agent-bar")).toContainText(agentName);
});

test("web slash commands: runtime list drives the menu and /compact is taken over", async ({ app }) => {
	test.setTimeout(180_000);
	expect(await waitForHealthy()).toBe(true);
	// mock pi 的 get_commands 从项目内 .pi/e2e-template.md 读取模板名
	mkdirSync(join(projectA.path, ".pi"), { recursive: true });
	writeFileSync(join(projectA.path, ".pi", "e2e-template.md"), ["---", "description: E2E 模板", "---", "", "正文", ""].join("\n"));

	const page = await app.firstWindow();
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto(BASE);
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });

	// 在种子项目里建会话并跑一轮，让 runtime 起来
	const sessionId = await page.evaluate(async (projectId) => {
		const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId }) });
		return (await res.json())?.session?.id as string;
	}, projectA.id);
	expect(sessionId).toBeTruthy();
	await page.goto(`${BASE}/s/${sessionId}`);
	const textarea = page.locator("textarea#prompt");
	await expect(textarea).toBeVisible({ timeout: 20_000 });
	await textarea.fill("hello");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").last()).toBeVisible({ timeout: 30_000 });

	// 运行时权威命令表：只有匹配的模板进菜单
	await textarea.fill("/e2e");
	const menu = page.getByTestId("web-slash-menu");
	await expect(menu).toContainText("e2e-template", { timeout: 15_000 });
	await page.keyboard.press("Enter");
	await expect(textarea).toHaveValue("/e2e-template ");

	// /compact 由 Web 接管：命令不落用户气泡（不发模型），走运行时压缩后输入框清空
	await textarea.fill("/compact");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Enter");
	await expect(page.locator(".user-bubble", { hasText: "/compact" })).toHaveCount(0);
	await expect(textarea).toHaveValue("");
});
