import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSettings } from "./open-session";

/**
 * 全区域配色调优巡检（不进常规门禁，手动/调优时跑）：
 * Git 面板（分支+工作区改动）、文件抽屉（文件树）、内置浏览器面板、
 * 设置弹窗、配置管理、公告中心——明暗各截一组，输出 test-results/visual-tune/。
 */

const OUT_DIR = join(__dirname, "..", "test-results", "visual-tune");
mkdirSync(OUT_DIR, { recursive: true });

// 仓库路径避开 isEphemeralProjectPath 过滤名单（模块加载时就绪，fixture 启动前执行）
const repoDir = join(tmpdir(), "pideck-seed-visual-repo");

function git(args: string) {
	return execSync(`git ${args}`, { cwd: repoDir, encoding: "utf8" }).trim();
}

rmSync(repoDir, { recursive: true, force: true });
mkdirSync(repoDir, { recursive: true });
git("init -b main");
git("config user.email e2e@pideck.local");
git("config user.name pideck-e2e");
// 文件树样本：两级目录 + 多类型文件
writeFileSync(join(repoDir, "README.md"), "# Visual Repo\n\n调优巡检用样本仓库。\n");
writeFileSync(join(repoDir, "package.json"), '{\n  "name": "visual-repo"\n}\n');
mkdirSync(join(repoDir, "src", "components"), { recursive: true });
writeFileSync(join(repoDir, "src", "main.ts"), "export function main() {\n\treturn 1;\n}\n");
writeFileSync(join(repoDir, "src", "components", "App.tsx"), "export default function App() {\n\treturn null;\n}\n");
mkdirSync(join(repoDir, "docs"), { recursive: true });
writeFileSync(join(repoDir, "docs", "guide.md"), "# Guide\n");
git("add .");
git("commit -m init");
git("checkout -b feature/polish");
git("checkout main");
// 工作区改动（未暂存 + 新增未跟踪），让 Git 状态列表有内容
appendFileSync(join(repoDir, "README.md"), "\nchanged by visual tune\n");
writeFileSync(join(repoDir, "src", "note.md"), "untracked\n");

async function shot(window: Page, name: string) {
	await window.screenshot({ path: join(OUT_DIR, `${name}.png`) });
}

async function openWorkbenchDrawer(window: Page, rail: string) {
	const drawer = window.locator(".detail-drawer");
	// 抽屉未开才点开关；rail 点击是切换语义——点已激活的 tab 会把抽屉收回，先查激活态
	if ((await drawer.getAttribute("data-open")) !== "true") {
		await window.locator(".header-drawer-toggle").first().click();
		await expect(drawer).toHaveAttribute("data-open", "true", { timeout: 5000 });
	}
	// 浏览器等可选面板默认不钉在 rail：从「添加常驻面板」下拉里勾选后才会出现
	if (!(await window.getByTestId(rail).count())) {
		await window.getByRole("button", { name: "添加常驻面板" }).click();
		await window.getByRole("menuitemcheckbox", { name: /内置浏览器/ }).click();
		await window.keyboard.press("Escape");
	}
	const railBtn = window.getByTestId(rail);
	if ((await railBtn.getAttribute("aria-selected")) !== "true") {
		await railBtn.click();
	}
	await expect(railBtn).toHaveAttribute("aria-selected", "true", { timeout: 5000 });
	await window.waitForTimeout(400);
}

async function runSurfaces(window: Page, prefix: string) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 进入种子项目并开一个会话（抽屉开关只在会话视图渲染）
	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.locator(".conversation", { hasText: "VisualRepo" }).first();
	await projectRow.click();
	await projectRow.getByTitle("普通会话").first().click();
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });

	// 1. 文件抽屉（文件树）
	await openWorkbenchDrawer(window, "drawer-rail-files");
	await shot(window, `${prefix}30-drawer-files`);

	// 2. Git 面板（分支 + 工作区改动列表）；旧 GitDrawerHost 壳也带 .git-panel，按 aria 定位真面板
	await openWorkbenchDrawer(window, "drawer-rail-git");
	const gitPanel = window.locator(".git-panel[aria-label]");
	await expect(gitPanel).toBeVisible({ timeout: 15_000 });
	await expect(gitPanel.locator(".git-branch-label")).toHaveText("main", { timeout: 15_000 });
	await window.waitForTimeout(600);
	await shot(window, `${prefix}31-drawer-git`);

	// 3. 内置浏览器面板
	await openWorkbenchDrawer(window, "drawer-rail-browser");
	await window.waitForTimeout(800);
	await shot(window, `${prefix}32-drawer-browser`);

	// 收起抽屉再截弹窗，避免右侧内容干扰。
	// 抽屉打开时 Tab 栏的开关会隐藏（开关并入抽屉活动栏左端），再点一次激活的 rail tab 收回。
	await window.getByTestId("drawer-rail-browser").click();
	await window.waitForTimeout(300);

	// 4. 设置弹窗
	await openSettings(window);
	await window.waitForTimeout(500);
	await shot(window, `${prefix}40-settings`);
	await window.keyboard.press("Escape");
	await window.waitForTimeout(300);

	// 5. 配置管理分区（SettingsModal 顶层分区 tab；ConfigPane 嵌入式渲染不再有独立 .config-modal 壳）
	const settings2 = await openSettings(window);
	await settings2.getByRole("tab", { name: /配置管理/ }).click();
	await window.waitForTimeout(800);
	await shot(window, `${prefix}41-config`);
	await window.keyboard.press("Escape");
	await window.waitForTimeout(300);

	// 6. 公告中心（侧栏底栏 Megaphone 入口；e2e 环境未拉取到远程公告时是空态壳）
	const announceBtn = window.getByRole("button", { name: /^公告/ }).first();
	if (await announceBtn.isVisible().catch(() => false)) {
		await announceBtn.click();
		await window.waitForTimeout(500);
		await shot(window, `${prefix}42-announcements`);
		await window.keyboard.press("Escape");
	}
}

test.describe("light", () => {
	test.use({ seedProjects: [{ id: "e2e-visual-repo", name: "VisualRepo", path: repoDir }] });
	test("workbench surfaces", async ({ window }) => {
		test.setTimeout(180_000);
		await runSurfaces(window, "1");
	});
});

test.describe("dark", () => {
	test.use({ seedProjects: [{ id: "e2e-visual-repo", name: "VisualRepo", path: repoDir }], seedSettings: { theme: "dark" } });
	test("workbench surfaces", async ({ window }) => {
		test.setTimeout(180_000);
		await runSurfaces(window, "2");
	});
});
