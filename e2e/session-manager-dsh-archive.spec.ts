import { test, expect } from "./fixtures";
import { makeSeedProject } from "./open-session";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

/**
 * DSH 会话管理归档回归（用户问题：「归档后不显示会话名 / 取消归档后列表不显示正确名字」）。
 *
 * 覆盖：
 * 1. 归档视图按「项目上下文 = worktree 家族」过滤，不再全量跨项目；
 * 2. DSH 归档行显示 manifest 标题（不再裸 host id）；旧归档无标题时按日志折叠补全；
 * 3. 恢复后归档行消失、主列表出现该会话且标题正确（不再「新会话」占位）。
 *
 * 不启动真实 DSH host：归档区是纯目录操作（list/unarchive 只读 manifest/移动目录），
 * 用 seedSettings.dshHomeDir 把 DSH_HOME 指到临时目录，预置 .pideck-archive 数据。
 * 项目目录必须走 makeSeedProject（pideck-seed- 前缀）：pideck-e2e- 等前缀会被
 * projectPathPolicy 当 e2e 残留清掉，侧栏项目行不会出现。
 */

const seedProject = makeSeedProject("arch");
const projectDir = seedProject.path;
const otherDir = mkdtempSync(join(tmpdir(), "pideck-seed-other-"));
const dshHome = mkdtempSync(join(tmpdir(), "pideck-seed-dshhome-"));
const projectName = basename(projectDir);

test.use({
	seedProjects: [seedProject],
	seedSettings: { dshHomeDir: dshHome },
});

/** 预置一个 DSH 归档目录（manifest + 可选日志；返回目录路径）。 */
function seedArchivedDshSession(sessionId: string, cwd: string, opts: { title?: string; logWithTitle?: string } = {}): string {
	const dir = join(dshHome, ".pideck-archive", sessionId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "pideck-manifest.json"),
		JSON.stringify({
			dshSessionId: sessionId,
			cwd,
			archivedAt: Date.now(),
			...(opts.title ? { title: opts.title } : {}),
		}),
		"utf8",
	);
	if (opts.logWithTitle) {
		// 未压缩 session.jsonl：header 行 + session/title 事件（foldSessionTitleFromDir 只读折叠）。
		// 必须走 JSON.stringify：Windows 路径含反斜杠，模板字符串拼 JSON 会产生非法转义。
		writeFileSync(join(dir, "session.jsonl"), [JSON.stringify({ type: "session", id: sessionId, cwd }), JSON.stringify({ type: "session/title", seq: 1, data: { title: opts.logWithTitle } })].join("\n"), "utf8");
	}
	return dir;
}

test("DSH 归档：标题展示、家族过滤、恢复后主列表标题正确", async ({ window }) => {
	test.setTimeout(180_000);

	// 本家族会话：manifest 带标题
	seedArchivedDshSession("session-a", projectDir, { title: "归档会话标题A" });
	// 本家族会话：manifest 无标题（旧归档）→ 日志折叠补全
	seedArchivedDshSession("session-folded", projectDir, { logWithTitle: "旧归档折叠标题" });
	// 其它项目会话：cwd 指向别的目录 → 弹窗归档视图必须过滤掉
	seedArchivedDshSession("session-other", otherDir, { title: "别的项目归档" });

	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await expect(window.locator(".chat-list-pane")).toBeVisible({ timeout: 15_000 });

	// 侧栏项目行右键 → 会话管理
	const projectRow = window.locator(".project-group").filter({ hasText: projectName }).first();
	await expect(projectRow).toBeVisible({ timeout: 15_000 });
	await projectRow.click({ button: "right" });
	const menu = window.locator("[data-slot='dropdown-menu-content']").first();
	await expect(menu).toBeVisible({ timeout: 5000 });
	await menu.getByText("会话管理").click();

	// 弹窗打开 → 切「已归档」
	const dialog = window.locator("[data-slot='dialog-content']").filter({ hasText: "会话管理" });
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await dialog.getByRole("button", { name: "已归档" }).click();

	const archivedBody = dialog.locator("[data-slot='table-body']");
	// 1) 标题展示：manifest 标题与日志折叠标题都在
	await expect(archivedBody.getByText("归档会话标题A")).toBeVisible({ timeout: 10_000 });
	await expect(archivedBody.getByText("旧归档折叠标题")).toBeVisible({ timeout: 10_000 });
	// 2) 家族过滤：别的项目归档不出现；也不显示裸 host id / cwd 路径
	await expect(archivedBody.getByText("别的项目归档")).toHaveCount(0);
	await expect(archivedBody.getByText("session-a", { exact: true })).toHaveCount(0);
	await expect(dialog.getByText(projectDir)).toHaveCount(0);

	// 3) 恢复「归档会话标题A」：归档行消失
	const targetRow = archivedBody.locator("tr").filter({ hasText: "归档会话标题A" });
	await targetRow.getByRole("button", { name: "恢复" }).click();
	await expect(archivedBody.getByText("归档会话标题A")).toHaveCount(0, { timeout: 10_000 });

	// 4) 切回主列表：恢复的会话出现且标题正确（不再是「新会话」占位）
	await dialog.getByRole("button", { name: "已归档" }).click();
	const mainBody = dialog.locator("[data-slot='table-body']");
	await expect(mainBody.getByText("归档会话标题A")).toBeVisible({ timeout: 15_000 });
	await expect(mainBody.getByText("新会话", { exact: true })).toHaveCount(0);
});
