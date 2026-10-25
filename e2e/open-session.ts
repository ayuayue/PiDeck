import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeedProject } from "./fixtures";

/**
 * 创建真实存在的临时项目目录（ProjectStore 需要路径有效），
 * 返回可传给 test.use({ seedProjects }) 的种子项目。
 */
/**
 * 生成 e2e 预置项目：临时目录 + 稳定 id。
 * 注意：目录前缀必须避开 projectPathPolicy.isEphemeralProjectPath 的过滤名单
 * （pideck-mockpi-/pideck-e2e-/pideck-fv- 等），否则 ProjectStore.load 启动时
 * 会把种子项目当 e2e 残留清掉，侧栏只剩内置 Chat（layout/drawer/file-viewer
 * 等点击项目行的 spec 会因项目行缺失而失败）。
 */
export function makeSeedProject(name: string, id = `e2e-${name.toLowerCase().replace(/\s+/g, "-")}`): SeedProject {
	const dir = mkdtempSync(join(tmpdir(), `pideck-seed-${name.toLowerCase().replace(/\s+/g, "-")}-`));
	mkdirSync(dir, { recursive: true });
	return { id, name, path: dir };
}

/**
 * 打开第一个项目会话（e2e 公共前置）：
 * 侧栏常驻入口的「新建会话」（i18n app.newSession，SidebarContent 顶部按钮）——
 * 项目行内的「新建 Agent」是 hover 才显示的 dimmed actions（opacity-0 +
 * pointer-events-none），headless 下不可点。
 * 注意：旧的「新会话」(app.new) 已移入 Tab 栏项目下拉、不再常驻渲染，2026-10 前
 * 用 name:"新会话" 的 spec 会集体卡在 toBeVisible（见 subagents-foreground.spec.ts 注释）。
 * .first() 取侧栏那一个（Tab 栏同文案按钮在其后）。
 * 等 composer 可输入（contenteditable="true"，TipTap 可用时不渲染 aria-disabled，
 * 见 agent-flow.spec.ts 注释）后返回 composer 定位器。
 */
export async function openFirstSession(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const newSession = window.getByRole("button", { name: "新建会话", exact: true }).first();
	await expect(newSession).toBeVisible({ timeout: 15_000 });
	await newSession.click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

/**
 * 打开设置窗口（侧栏底栏 dock 的设置按钮，原 `.settings-icon` 类已随侧栏重构删除）。
 * 有可用更新时该按钮可访问名会带「（有新版本可用）」后缀（settings.titleWithUpdate），
 * 故这里用前缀正则匹配，不用 exact。返回设置对话框定位器。
 */
export async function openSettings(window: Page) {
	await window.getByRole("button", { name: /^设置/ }).first().click();
	const dialog = window.getByRole("dialog", { name: "设置" });
	await expect(dialog).toBeVisible({ timeout: 15_000 });
	return dialog;
}

/**
 * 打开设置窗口的「配置管理」分区（原独立 `.config-icon` 入口已并入设置窗口）。
 * 分区根元素仍带 `.config-modal` 类（ConfigPane 的 DialogContent），并自带一个
 * name="配置管理" 的内层对话框，旧断言照常可用。返回 `.config-modal` 定位器。
 */
export async function openConfigPane(window: Page) {
	const dialog = await openSettings(window);
	await dialog.getByRole("tab", { name: /配置管理/ }).click();
	const pane = window.locator(".config-modal");
	await expect(pane).toBeVisible({ timeout: 15_000 });
	return pane;
}

/**
 * 多项目种子（函数式覆盖）。
 *
 * 不要写 `test.use({ seedProjects: [a, b] })`：Playwright 的 option fixture 会把
 * ≥2 元素的数组当成 `[value, options]` 元组，只取第 0 个元素（`[a]` 则不会），
 * 于是 b 及之后静默消失（详见 mock-pi-fixture 的 normalizeSeeds 注释）。
 * 函数形态不经过元组解析，任意条数都安全：
 *
 * ```ts
 * test.use({ seedProjects: seedProjectsOption([a, b]) });
 * ```
 */
export function seedProjectsOption(projects: SeedProject[]) {
	return async ({}, use: (value: SeedProject[]) => Promise<void>) => {
		await use(projects);
	};
}
