import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { chooseRemoteDirectory, runRemoteCommand, remoteProjectRow, openRemoteProjectFiles, type RemoteAcceptanceCredentials, type RemoteAcceptanceTimeouts } from "./remote-fixtures";

const q = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

/** 只操作本次 runId 建出来的远端目录；所有 shell 前置/佐证都走已认证 SSH，不碰用户数据。 */
async function remoteTest(credentials: RemoteAcceptanceCredentials, script: string): Promise<string> {
	return (await runRemoteCommand(credentials, script, 60_000)).stdout.trim();
}

/** 项目行 → 中心 no-session 远端面板（与「远端文本编辑」同一入口，不新建会话）。 */
async function openProjectPanel(window: Page, projectPath: string): Promise<void> {
	await remoteProjectRow(window, projectPath.split("/").at(-1) ?? "")
		.locator(".conversation-title")
		.first()
		.click();
	await openRemoteProjectFiles(window);
	await expect(window.getByTestId("remote-file-toolbar")).toBeVisible();
}

/** 主目录列表中的条目行（带行菜单按钮，避免与回收站行/下拉项混淆）。 */
/**
 * 远端文件行现在与本机文件树共用 `FileTreeNodeRow`：行是 `.file-node`，
 * 行操作走右键菜单（不再有常驻的「…」按钮）。
 */
function entryRow(window: Page, name: string) {
	return window
		.locator(".file-node")
		.filter({ has: window.locator(".file-node-name", { hasText: name }) })
		.last();
}

async function openEntry(window: Page, name: string): Promise<void> {
	await entryRow(window, name).locator("button").first().click();
}

async function rowAction(window: Page, name: string, action: "remote-file-row-rename" | "remote-file-row-delete"): Promise<void> {
	await entryRow(window, name).locator("button").first().click({ button: "right" });
	await window.getByTestId(action).click();
}

async function createEntry(window: Page, kind: "file" | "directory", name: string): Promise<void> {
	await window.getByTestId(kind === "file" ? "remote-file-create" : "remote-file-mkdir").click();
	await window.getByTestId("remote-file-new-name").fill(name);
	await window.getByTestId("remote-file-new-confirm").click();
	await expect(window.getByTestId("remote-file-new-dialog")).toHaveCount(0);
}

async function renameEntry(window: Page, name: string, target: string): Promise<void> {
	await rowAction(window, name, "remote-file-row-rename");
	await expect(window.getByTestId("remote-file-rename-input")).toBeVisible();
	await window.getByTestId("remote-file-rename-input").fill(target);
	await window.getByTestId("remote-file-rename-confirm").click();
	await expect(window.getByTestId("remote-file-rename-dialog")).toHaveCount(0);
}

async function deleteEntry(window: Page, name: string): Promise<void> {
	await rowAction(window, name, "remote-file-row-delete");
	await expect(window.getByTestId("remote-file-delete-dialog")).toBeVisible();
	await window.getByTestId("remote-file-delete-confirm").click();
	await expect(window.getByTestId("remote-file-delete-dialog")).toHaveCount(0);
}

async function toggleTrash(window: Page): Promise<void> {
	await window.getByTestId("remote-trash-toggle").click();
	await expect(window.getByTestId("remote-trash")).toBeVisible();
}

/**
 * 侧栏「+ → 远端（SSH）→ 新建空目录」：验证 create 模式的独立确认（父目录/将创建的目录两行）
 * 以及创建后项目真的出现在侧栏。目标路径必须当前不存在——由调用方保证（runId 唯一）。
 */
export async function createEmptyRemoteProjectInSidebar(window: Page, projectPath: string, limits: RemoteAcceptanceTimeouts): Promise<void> {
	await window.getByRole("tab", { name: "项目" }).click();
	await window.getByRole("button", { name: "添加项目" }).first().click();
	await window.getByRole("menuitem", { name: /远端（SSH）/ }).click();
	const enrollDialog = window.locator('[role="dialog"]').filter({ hasText: "添加远端项目" });
	await expect(enrollDialog).toBeVisible();
	await enrollDialog.getByTestId("remote-enroll-mode-create").check();
	await chooseRemoteDirectory(window, projectPath.slice(0, projectPath.lastIndexOf("/")));
	await enrollDialog.locator("#remote-enroll-leaf").fill(projectPath.split("/").at(-1) ?? "");
	await enrollDialog.getByRole("button", { name: "解析并确认" }).click();
	const confirmDialog = window.locator('[role="dialog"]').filter({ hasText: "新建空远端项目目录" });
	await expect(confirmDialog).toBeVisible({ timeout: limits.helperMs });
	// 确认框必须把「父目录」与「将创建的目录」分开展示，而不是一条输入回显。
	// exact 匹配：父路径是完整路径的前缀，substring 匹配会同时命中 body 描述与完整路径行（strict mode 三元素）。
	await expect(confirmDialog.getByText(projectPath.slice(0, projectPath.lastIndexOf("/")), { exact: true })).toBeVisible();
	await expect(confirmDialog.getByText(projectPath.split("/").at(-1) ?? "", { exact: true })).toBeVisible();
	await confirmDialog.getByRole("button", { name: "创建并添加" }).click();
	const enrolledDialog = window.locator('[role="dialog"]').filter({ hasText: "已添加远端项目" });
	await expect(enrolledDialog).toBeVisible({ timeout: limits.helperMs });
	await enrolledDialog.getByRole("button", { name: "完成" }).click();
	await expect(remoteProjectRow(window, projectPath.split("/").at(-1) ?? "")).toBeVisible({ timeout: limits.helperMs });
}

/**
 * Phase 5 文件面真机验收（§11.2 的顺序）：新建空项目 → 面板新建/改名/移动/删除 →
 * 回收站列出/还原/清空 → 同名再建 → 显式刷新 → 每条结论都有远端 shell 佐证。
 *
 * 不做：本机路径、批量操作、覆盖语义、系统回收站等价物；所有删除都先进入项目内 .pideck-trash。
 */
export async function verifyRemoteFileManagement(input: { window: Page; credentials: RemoteAcceptanceCredentials; projectPath: string; testInfo: TestInfo; timeoutMs: number }): Promise<void> {
	const { window, credentials, projectPath, testInfo, timeoutMs } = input;
	const remote = (path: string) => projectPath + (path === "" ? "" : "/" + path);
	const entry = async (path: string): Promise<boolean> => (await remoteTest(credentials, "test -e " + q(remote(path)) + " && echo YES || echo NO")) === "YES";
	await testInfo.attach("remote-file-management-root", { body: Buffer.from(projectPath), contentType: "text/plain" });

	await test.step("新建空项目后打开面板：工具栏/回收站开关可见（无会话）", async () => {
		await openProjectPanel(window, projectPath);
		await expect(window.getByTestId("remote-file-create")).toBeVisible();
		await expect(window.getByTestId("remote-file-mkdir")).toBeVisible();
		await expect(window.getByTestId("remote-trash-toggle")).toBeVisible();
	});

	await test.step("新建单层目录 docs → 远端真实存在，且不递归创建父链", async () => {
		await createEntry(window, "directory", "docs");
		await expect.poll(() => entry("docs"), { timeout: timeoutMs }).toBe(true);
		expect(await remoteTest(credentials, "test -d " + q(remote("docs")) + " && echo DIR")).toBe("DIR");
		// 父链不被 -p 创建：在缺失父目录下新建文件必须失败并保留弹框（稳定码呈现）。
		await window.getByRole("button", { name: "docs", exact: true }).first().click();
		await window.getByTestId("remote-file-create").click();
		await window.getByTestId("remote-file-new-name").fill("x.txt");
		await window.getByTestId("remote-file-new-cancel").click();
	});

	await test.step("新建 0 字节文件 docs/notes.txt → 远端普通文件且 size=0", async () => {
		await createEntry(window, "file", "notes.txt");
		await expect.poll(() => entry("docs/notes.txt"), { timeout: timeoutMs }).toBe(true);
		expect(Number(await remoteTest(credentials, "stat -c %s " + q(remote("docs/notes.txt"))))).toBe(0);
		expect(await remoteTest(credentials, "test -f " + q(remote("docs/notes.txt")) + " && echo FILE")).toBe("FILE");
	});

	await test.step("同目录重命名 notes.txt → notes.bin → 远端旧名消失、新名存在", async () => {
		await renameEntry(window, "notes.txt", "docs/notes.bin");
		await expect.poll(() => entry("docs/notes.txt"), { timeout: timeoutMs }).toBe(false);
		await expect.poll(() => entry("docs/notes.bin"), { timeout: timeoutMs }).toBe(true);
	});

	await test.step("跨目录移动 docs/notes.bin → 根 notes.bin → 远端只剩根路径", async () => {
		// 仍在 docs 目录：重命名输入框预填项目相对路径 docs/notes.bin，改成根路径即跨目录移动。
		await renameEntry(window, "notes.bin", "notes.bin");
		await window.getByRole("button", { name: "/", exact: true }).click();
		await expect(entryRow(window, "notes.bin")).toHaveCount(1);
		expect(await remoteTest(credentials, "test -e " + q(remote("notes.bin")) + " && test ! -e " + q(remote("docs/notes.bin")) + " && echo MOVED")).toBe("MOVED");
	});

	await test.step("删除文件 → 进入项目内 .pideck-trash（manifest + payload），UI 可列出", async () => {
		await deleteEntry(window, "notes.bin");
		await toggleTrash(window);
		await expect(window.getByTestId("remote-trash-row").filter({ hasText: "notes.bin" })).toBeVisible();
		await expect.poll(() => entry("notes.bin"), { timeout: timeoutMs }).toBe(false);
		const manifest = await remoteTest(credentials, "cat " + q(remote(".pideck-trash")) + "/*/entry.json");
		expect(manifest).toContain('"schemaVersion":1');
		expect(manifest).toContain('"originalPath":"notes.bin"');
		expect(await remoteTest(credentials, "ls " + q(remote(".pideck-trash")) + "/*/payload")).toContain("payload");
	});

	await test.step("还原回收站条目 → 文件按原内容/权限回到原路径，回收站行消失", async () => {
		await window.getByTestId("remote-trash-row").filter({ hasText: "notes.bin" }).getByTestId("remote-trash-restore").click();
		await expect(window.getByTestId("remote-trash-row")).toHaveCount(0, { timeout: timeoutMs });
		await expect.poll(() => entry("notes.bin"), { timeout: timeoutMs }).toBe(true);
		expect(await remoteTest(credentials, "stat -c %s " + q(remote("notes.bin")))).toBe("0");
	});

	await test.step("删除整个目录 docs → 目录树整体进入回收站", async () => {
		// 先回到根（trash 展开不影响主列表），建文件后再整体删除目录。
		await createEntry(window, "directory", "tree");
		await openEntry(window, "tree");
		await createEntry(window, "file", "deep.txt");
		await window.getByRole("button", { name: "/", exact: true }).click();
		await deleteEntry(window, "tree");
		// 删除是异步写：弹框关闭 ≠ 远端已完成（回执可能晚于 UI）。断言改成有界等到「远端真的没有」，
		// 真失败仍会在预算内报红，只是不再把「还没写完」记成「没删掉」。
		await expect.poll(() => entry("tree"), { timeout: timeoutMs, message: "删除目录后远端不应再存在 tree" }).toBe(false);
		expect(await entry(".pideck-trash/tree")).toBe(false);
		await expect(window.getByTestId("remote-trash-row").filter({ hasText: "tree" })).toBeVisible();
	});

	await test.step("显式清空回收站（永久删除，需要独立确认）→ 条目与 payload 全部消失", async () => {
		await window.getByTestId("remote-trash-prune").click();
		await expect(window.getByTestId("remote-trash-prune-dialog")).toBeVisible();
		await expect(window.getByTestId("remote-trash-prune-dialog").getByText("无法恢复", { exact: false })).toBeVisible();
		await window.getByTestId("remote-trash-prune-confirm").click();
		await expect(window.getByTestId("remote-trash-row")).toHaveCount(0, { timeout: timeoutMs });
		expect(await remoteTest(credentials, "find " + q(remote(".pideck-trash")) + " -mindepth 1 | wc -l")).toBe("0");
	});

	await test.step("删除后同名再建（无覆盖语义的 create-only）→ 新文件存在且 size 仍为 0", async () => {
		// 上一步还原让 notes.bin 回到了根；先再次删除，同名 create 才能证明「只创建、绝不覆盖」。
		await deleteEntry(window, "notes.bin");
		await expect.poll(() => entry("notes.bin"), { timeout: timeoutMs }).toBe(false);
		await createEntry(window, "file", "notes.bin");
		await expect.poll(() => entry("notes.bin"), { timeout: timeoutMs }).toBe(true);
		expect(await remoteTest(credentials, "stat -c %s " + q(remote("notes.bin")))).toBe("0");
	});

	await test.step("显式刷新后目录状态一致（无自动轮询/后台刷新）", async () => {
		await window.getByRole("button", { name: "刷新", exact: true }).first().click();
		await expect(entryRow(window, "notes.bin")).toHaveCount(1);
		await expect.poll(() => entry("notes.bin"), { timeout: timeoutMs }).toBe(true);
	});

	await testInfo.attach("remote-file-management-proof", {
		body: Buffer.from(
			JSON.stringify(
				{
					root: projectPath,
					notes: await remoteTest(credentials, "test -f " + q(remote("notes.bin")) + " && echo NOTES_OK"),
					trashEntries: await remoteTest(credentials, "find " + q(remote(".pideck-trash")) + " -mindepth 1 | wc -l"),
				},
				null,
				2,
			),
		),
		contentType: "application/json",
	});
}
