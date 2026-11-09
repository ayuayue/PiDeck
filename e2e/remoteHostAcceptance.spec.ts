import { expect, type Page } from "@playwright/test";
import { encodePiSessionDirectory } from "../src/main/remote/remoteSessionProjectMatch";
import { join } from "node:path";
import { REMOTE_ACCEPTANCE_ENV, REMOTE_APP_DATA_DIR_NAME, attachRemoteDiagnostics, chooseRemoteDirectory, matchesRemoteFingerprint, readPinnedHostKeyFingerprint, readRemoteAcceptanceCredentials, readRemoteAcceptanceTimeouts, runRemoteCommand, test } from "./remote-fixtures";

/**
 * 远端主机功能级验收（task-25 / J1）：在真实 Electron 里跑通「加主机 → 连接 → 登记远端项目 →
 * 远端会话 列表/惰性标题/导入 → 项目级 root 状态」。
 *
 * 门控（硬要求 1）：三个必需环境变量缺任意一个就整体 skip。test.skip 放在 describe 回调内、
 * 任何 test body 之外，Playwright 在 fixture setup 之前就标记跳过，所以无凭据跑本 spec
 * **不会启动 Electron**，npm run e2e / CI 仍然全绿。
 *
 * 隔离（硬要求 2）：userData 走临时目录（--user-data-dir + APPDATA/LOCALAPPDATA + PIDECK_E2E_USER_DATA_DIR）；
 * 刻意**不隔离 HOME/USERPROFILE**——产品用系统 OpenSSH 连接，必须读到真实用户的 ~/.ssh/config 与私钥。
 *
 * 远端夹具（硬要求 5）：会话夹具与两个项目目录都用唯一 runId 命名，finally 里恢复被移动的目录并整目录删除，
 * 不留远端垃圾；失败时 Playwright 的 trace（retain-on-failure）与截图会保留在 test-results/。
 *
 * 真实主机/指纹只来自环境变量：本文件不出现任何主机或指纹字面量。
 * 凭据环境变量：PIDECK_E2E_REMOTE_HOST / PIDECK_E2E_REMOTE_USER / PIDECK_E2E_REMOTE_FINGERPRINT（端口 PIDECK_E2E_REMOTE_PORT 与两个超时可选）。
 */
const credentials = readRemoteAcceptanceCredentials(process.env);
const timeouts = readRemoteAcceptanceTimeouts(process.env);
const HELP_TEXT = "set " + [REMOTE_ACCEPTANCE_ENV.host, REMOTE_ACCEPTANCE_ENV.user, REMOTE_ACCEPTANCE_ENV.fingerprint].join(" / ") + " to run the real-host acceptance test";

/** 侧栏项目行的容器（ProjectTree 的 SidebarRemovalRow 用这个类名）。 */
function projectRow(window: Page, projectName: string) {
	return window.locator(".project-group").filter({ hasText: projectName });
}

/** 点侧栏项目名（选择 = 打开该项目的页面；同一按钮也做手风琴折叠，调用点要自己保证顺序）。 */
async function selectProject(window: Page, projectName: string): Promise<void> {
	await projectRow(window, projectName).getByText(projectName, { exact: true }).first().click();
}

/** 项目清单刷新（侧栏项目分组 ⋯ → 刷新所有项目）：远端 root 状态只随清单身份变化重新查询。 */
async function refreshAllProjects(window: Page): Promise<void> {
	await window.locator('section[aria-label="项目"]').getByRole("button", { name: "更多操作" }).first().click();
	await window.getByRole("menuitem", { name: "刷新所有项目" }).click();
}

/** 登记一个远端项目：侧栏「+ → 远端（SSH）…」→ 选主机 → 输入路径 → canonical 确认 → 添加。 */
async function enrollRemoteProject(window: Page, remotePath: string): Promise<void> {
	await window.getByRole("button", { name: "添加项目" }).first().click();
	await window.getByRole("menuitem", { name: /远端（SSH）/ }).click();
	const enrollDialog = window.locator('[role="dialog"]').filter({ hasText: "添加远端项目" });
	await expect(enrollDialog).toBeVisible();
	// 主机下拉由 hook 自动选中第一台可用主机；这个 profile 只有一台，断言它确实有值。
	await expect(enrollDialog.locator("#remote-enroll-host")).not.toBeEmpty();
	await chooseRemoteDirectory(window, remotePath);
	await enrollDialog.getByRole("button", { name: "解析并确认" }).click();
	// canonical 确认阶段：展示的是主进程解析出的、真正会被 confinement 的路径。
	const confirmDialog = window.locator('[role="dialog"]').filter({ hasText: "确认远端项目目录" });
	await expect(confirmDialog).toBeVisible({ timeout: timeouts.helperMs });
	await expect(confirmDialog.getByText(remotePath, { exact: false }).first()).toBeVisible();
	await confirmDialog.getByRole("button", { name: "添加项目" }).click();
	const enrolledDialog = window.locator('[role="dialog"]').filter({ hasText: "已添加远端项目" });
	await expect(enrolledDialog).toBeVisible({ timeout: timeouts.helperMs });
	await enrolledDialog.getByRole("button", { name: "完成" }).click();
	await expect(enrolledDialog).toHaveCount(0);
}

/**
 * D1 诊断（失败路径专用，见 task-36）：读 UI 上的失败文本与项目 id。两个都自己吞掉异常并返回
 * null —— 诊断连「读不到」都不该把测试弄挂，更不该成为新的失败源。
 */
async function readRemoteSessionsSectionText(window: Page, projectName: string): Promise<string | null> {
	try {
		const section = projectRow(window, projectName).getByTestId("remote-sessions-section");
		return (await section.innerText()).slice(0, 4000);
	} catch {
		return null;
	}
}

async function readProjectId(window: Page, projectName: string): Promise<string | null> {
	try {
		return await projectRow(window, projectName).getAttribute("data-sidebar-removal-id");
	} catch {
		return null;
	}
}

/** 展开项目行：折叠按钮只在「收起」时点一次，避免把已展开的行又收起来。 */
async function expandProject(window: Page, projectName: string): Promise<void> {
	const row = projectRow(window, projectName);
	const expand = row.getByRole("button", { name: "展开", exact: true });
	if ((await expand.count()) > 0) await expand.first().click();
	await expect(row.locator(".project-fold")).toHaveAttribute("aria-label", "折叠");
}

/**
 * 首启引导（CommandPaletteOnboarding）会盖住整个界面：存在就点「以后再说」关掉，不存在不算失败。
 * waitMs 给第一次调用留出引导的延迟弹出窗口（产品在有活动项目后延迟 2.5s 才弹）；后续调用传 0 只做
 * 一次廉价兜底——引导关闭时产品会写 localStorage 标记，正常情况下不会再出现。
 */
async function dismissOnboarding(window: Page, waitMs: number): Promise<void> {
	const dialog = window.locator('[role="dialog"]').filter({ hasText: "用命令面板直达任何设置" });
	if (waitMs > 0) await dialog.waitFor({ state: "visible", timeout: waitMs }).catch(() => undefined);
	if ((await dialog.count()) === 0) return;
	await dialog.getByRole("button", { name: "以后再说" }).click();
	await expect(dialog, "引导关闭后不应再可见").toHaveCount(0);
}

test.describe("远端主机功能级验收（真机）", () => {
	// 无凭据整体 skip：在 fixture setup 之前生效，所以既不会建临时 userData，也不会启动 Electron。
	test.skip(credentials === undefined, HELP_TEXT);

	test("加主机 pin → 连接 ready → 登记两个远端项目 → 远端会话 列表/标题/导入 → 项目级 root 状态", async ({ remoteWindow, remoteUserDataRoot }) => {
		// 真机 bootstrap + 多次 helper root 切换 + 两侧项目复核：给足预算；超时是失败，不是挂起。
		test.setTimeout(900_000);
		const creds = credentials;
		if (creds === undefined) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const window = remoteWindow;
		// 隔离 userData ⇒ 每次都是首启：命令面板引导会在有活动项目后延迟 2.5s 弹出并盖住界面。
		// 先等它、关掉它（不存在不算失败）；产品会写 localStorage 标记，所以整轮只会真正出现一次。
		await dismissOnboarding(window, 8_000);
		const runId = "e2e" + Date.now().toString(36);
		const home = (await runRemoteCommand(creds, 'printf %s "$HOME"', 30_000)).stdout.trim();
		expect(home.startsWith("/"), "远端 $HOME 必须是绝对 POSIX 路径").toBe(true);
		expect(/\s/.test(home), "远端 $HOME 含空白：夹具与清理脚本按既有风格不做引用，先在这里拒绝").toBe(false);
		const e2eRoot = home + "/.pideck-e2e-" + runId;
		const sessionRoot = home + "/.pi/agent/sessions";
		const projectAName = "proj-a-" + runId;
		const projectBName = "proj-b-" + runId;
		const projectAPath = e2eRoot + "/" + projectAName;
		const projectBPath = e2eRoot + "/" + projectBName;
		const movedPath = e2eRoot + "/" + projectAName + "-moved";
		// 会话夹具必须放在**项目 A 的 encoded-cwd 目录**下：pi 的真实布局就是
		// `<sessions>/<encoded-cwd>/<file>.jsonl`（cwd 即项目目录），而归属性判定正是按同一编码比对。
		// 曾经用编造的 `pideck-e2e-<runId>` 目录：归属判不出来，产品会**正确地** fail-closed
		// （REMOTE_SESSION_PROJECT_UNRESOLVED）—— 夹具得像真的，否则测的不是真实行为。
		const sessionWorkspaceDir = encodePiSessionDirectory(projectAPath);
		const authStem = "e2e-auth-" + runId;
		const weakStem = "e2e-weak-" + runId;
		const authSessionId = sessionWorkspaceDir + "/" + authStem + ".jsonl";
		const weakSessionId = sessionWorkspaceDir + "/" + weakStem + ".jsonl";
		const authTitle = "E2E authoritative " + runId;
		const weakTitle = "E2E inferred " + runId;
		let movedA = false;
		// 一条结构化日志即可（诊断 run 与目标；不含任何凭据正文，主机来自 env）。
		console.log("[remote-acceptance] run=" + runId + " host=" + creds.host + " user=" + creds.user);
		try {
			await test.step("远端前置：两个项目目录 + 两条会话夹具（唯一命名，结束清理）", async () => {
				const authLine = '{"type":"session_info","name":"' + authTitle + '"}';
				const weakLine = '{"type":"message","message":{"role":"user","content":"' + weakTitle + '"}}';
				const script = [
					"set -e",
					"mkdir -p " + projectAPath + " " + projectBPath + " " + sessionRoot + "/" + sessionWorkspaceDir,
					"echo hello-a > " + projectAPath + "/hello-a.txt",
					"echo hello-b > " + projectBPath + "/hello-b.txt",
					// 夹具 JSONL 无反斜杠，single-quote + echo 在 dash/bash 下都逐字写入。
					"echo '" + authLine + "' > " + sessionRoot + "/" + authSessionId,
					"echo '" + weakLine + "' > " + sessionRoot + "/" + weakSessionId,
				].join(" && ");
				await runRemoteCommand(creds, script, 60_000);
			});

			await test.step("设置页加主机：ssh config 候选中挑出目标 user@host，指纹必须与注入的期望值一致", async () => {
				// 设置入口是左下角 Dock 的第一个按钮（Bolt）：aria-label 是「设置」或「设置（有新版本可用）」。
				await dismissOnboarding(window, 0);
				await window.getByRole("button", { name: /^设置/ }).click();
				const modal = window.locator(".settings-modal");
				await expect(modal).toBeVisible();
				await modal.getByRole("tab", { name: "连接", exact: true }).click();
				await modal.getByRole("button", { name: /^(添加|新建连接)$/ }).click();
				const addDialog = window.getByRole("dialog", { name: /^(新建连接|添加 SSH 连接)$/ });
				await expect(addDialog, "点「添加」必须打开 AddHostDialog").toBeVisible();
				// 候选来自真实 ~/.ssh/config：按 user@host 精确匹配，不依赖别名怎么起。
				// 同一条 ssh config 可能对同一台主机给出多条别名（IP 别名与短名别名指向同一个 HostName），
				// 所以断言「至少一条」再取第一条，而不是断言恰好一条。
				// 面板自 1dd8ceb7e 起默认收起「从 SSH config 导入」列表：先展开再挑候选；
				// 提交入口也在同一次改造里从「保存」变成「添加并连接」。
				const importToggle = addDialog.getByRole("button", { name: "从 SSH config 导入" });
				if ((await importToggle.count()) > 0 && (await importToggle.getAttribute("aria-expanded")) !== "true") await importToggle.click();
				// 候选列表是对话框之上的独立弹层，不在 AddHostDialog 子树内：按页面作用域找（与 remoteSessionAcceptance 同口径）。
				const candidate = window.getByRole("button", { name: new RegExp(creds.user + "@" + creds.host.replace(/\./g, "\\.")) });
				await expect(candidate.first(), "ssh config 里需要至少一条 " + creds.user + "@" + creds.host + " 候选").toBeVisible({ timeout: 30_000 });
				await candidate.first().click();
				// 提交入口现在是「保存并检测」：测试通过后就地保存主机、建会话并探测远端 pi（不再另开进度弹窗）。
				await addDialog
					.getByRole("button", { name: /^(保存并检测|保存并重新检测|保存|添加并连接)$/ })
					.first()
					.click();
				// 指纹：产品自 74682ad72 起在主进程内完成首次信任（TOFU），不再弹「确认主机指纹」；验收要证的仍是
				// 「产品为这台主机钉住的是期望的那把钥匙」，改成读它实际落盘的 pin（后续 StrictHostKeyChecking 用的就是它）。
				const pinDeadline = Date.now() + 30_000;
				let pinned: string | undefined;
				while (Date.now() < pinDeadline && pinned === undefined) {
					pinned = readPinnedHostKeyFingerprint(join(remoteUserDataRoot, REMOTE_APP_DATA_DIR_NAME), creds.host);
					if (pinned === undefined) await window.waitForTimeout(200);
				}
				expect(matchesRemoteFingerprint(creds.fingerprint, pinned === undefined ? [] : [pinned]), "落盘 pin 的主机指纹必须命中 " + REMOTE_ACCEPTANCE_ENV.fingerprint + "（期望 " + creds.fingerprint + "，实到 " + String(pinned) + "）").toBe(true);
			});

			await test.step('连接到达 "ready"：保存并检测完成后行状态是「已连接」，开关翻成「断开」', async () => {
				// 2026-10 起整条检测内联在添加对话框里（测试 → 保存 → 建会话 → 探测 pi），不再有独立进度弹窗：
				// 远端 pi 探测通过后对话框给出「完成」，点掉它才回到设置页。
				const addDialog = window.getByRole("dialog", { name: /^(新建连接|添加 SSH 连接)$/ });
				await expect(addDialog.getByText("测试 SSH 连接"), "对话框里应展示四步检测轨").toBeVisible({ timeout: 30_000 });
				const complete = addDialog.getByRole("button", { name: /^完成$/ });
				const completeVisible = await complete
					.waitFor({ state: "visible", timeout: timeouts.helperMs })
					.then(() => true)
					.catch(() => false);
				// 探测失败时表单里会写原因：带着它报错，而不是干等超时后只说「按钮必须出现」。
				if (!completeVisible) throw new Error("添加对话框未完成远端 pi 探测：" + ((await addDialog.textContent().catch(() => null)) ?? "").trim());
				await complete.click();
				await expect(addDialog).toHaveCount(0);
				await expect(window.getByText("已连接").first()).toBeVisible({ timeout: timeouts.helperMs });
				await expect(window.getByRole("button", { name: "断开", exact: true }).first()).toBeVisible();
				await window.locator(".settings-modal").getByRole("button", { name: "关闭" }).first().click();
				await expect(window.locator(".settings-modal")).toHaveCount(0);
			});

			await test.step("侧栏登记两个远端项目（canonical 确认 + 立即选中，不创建本地会话）", async () => {
				// 显式切到「项目」页签：侧栏远端会话区块只在项目树里渲染。
				await window.getByRole("tab", { name: "项目" }).click();
				await enrollRemoteProject(window, projectAPath);
				await enrollRemoteProject(window, projectBPath);
				await expect(projectRow(window, projectAName)).toBeVisible();
				await expect(projectRow(window, projectBName)).toBeVisible();
				// 登记成功后项目被选中：空态直接是远端项目的输入页（59a1fb351 起文件浏览降为次级视图）。
				// 旧断言等的是文件管理器标题「远端项目」，改版后该标题只在「浏览远端文件」后出现。
				await expect(window.getByRole("combobox", { name: "选择要创建会话的项目" }), "中栏项目选择器必须切到新登记的远端项目").toContainText(projectBName, { timeout: timeouts.helperMs });
				await expect(window.getByRole("button", { name: "浏览远端文件" }), "远端空态必须保留文件浏览次入口").toBeVisible();
			});
			await test.step("展开项目 A 行：远端会话 列表按主机只读列出夹具会话", async () => {
				try {
					// 登记项目会改变活动项目，引导理论上可能再次触发：这里再兜一次底（通常已关过，不会再出现）。
					await dismissOnboarding(window, 0);
					await expandProject(window, projectAName);
					const section = projectRow(window, projectAName).getByTestId("remote-sessions-section");
					await expect(section, "远端项目的展开区必须有「远端会话」区块").toBeVisible({ timeout: timeouts.helperMs });
					await expect(section.getByText("远端会话", { exact: true })).toBeVisible();
					// 扫描是显式动作（不进视口就不发远端读取）：点一次，等我们唯一命名的两条夹具会话出现。
					await section.getByTestId("remote-sessions-scan").click();
					const authRow = section.locator('li[data-remote-session-id="' + authSessionId + '"]');
					const weakRow = section.locator('li[data-remote-session-id="' + weakSessionId + '"]');
					await expect(authRow, "夹具会话（authoritative）必须出现在远端会话列表").toBeVisible({ timeout: timeouts.helperMs });
					await expect(weakRow, "夹具会话（inferred）必须出现在远端会话列表").toBeVisible({ timeout: timeouts.helperMs });
				} catch (error) {
					// D1（task-36）：**只在失败路径**导出 App 自身的诊断（含判别性探针）。诊断不参与任何断言，
					// 自己再包一层 try/catch —— 即使诊断实现有 bug，也只能留下告警，绝不改变原有的失败结论。
					try {
						await attachRemoteDiagnostics(window, test.info(), {
							reason: "step5: 远端会话列表未出现夹具会话（疑似扫描返回远端 home 解析失败）",
							uiFailureText: await readRemoteSessionsSectionText(window, projectAName),
							projectIds: [await readProjectId(window, projectAName), await readProjectId(window, projectBName)],
						});
					} catch (diagnosticError) {
						console.warn("[remote-acceptance] diagnostics failed: " + (diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)));
					}
					throw error;
				}
			});

			await test.step("惰性标题：authoritative 显示真名，「暂定」只出现在非 authoritative 时", async () => {
				const section = projectRow(window, projectAName).getByTestId("remote-sessions-section");
				const authRow = section.locator('li[data-remote-session-id="' + authSessionId + '"]');
				const weakRow = section.locator('li[data-remote-session-id="' + weakSessionId + '"]');
				// authoritative：session_info 的名字就是真名，不得标「暂定」。
				await expect(authRow.getByTestId("remote-session-title")).toHaveText(authTitle, { timeout: timeouts.helperMs });
				await expect(authRow.getByTestId("remote-session-tentative"), "authoritative 标题不得标「暂定」").toHaveCount(0);
				// inferred：首条 user 文本是弱兜底，可以显示，但必须显式标「暂定」。
				await expect(weakRow.getByTestId("remote-session-title")).toHaveText(weakTitle, { timeout: timeouts.helperMs });
				await expect(weakRow.getByTestId("remote-session-tentative"), "inferred 标题必须标「暂定」").toBeVisible();
			});

			await test.step("导入一条会话：清单刷新 + 被选中；不新建会话、不开 Tab", async () => {
				const section = projectRow(window, projectAName).getByTestId("remote-sessions-section");
				const authRow = section.locator('li[data-remote-session-id="' + authSessionId + '"]');
				const projectA = projectRow(window, projectAName);
				const tabsBefore = await window.locator('[role="tab"][data-session-id]').count();
				expect(await projectA.locator(".session-row").count(), "导入前项目 A 不该有本地会话").toBe(0);
				await authRow.getByTestId("remote-session-import").click();
				await expect(section.getByTestId("remote-sessions-feedback"), "导入必须有显式回执").toHaveText("已导入并在本地选中。", { timeout: timeouts.helperMs });
				await expect(authRow.getByText("已导入", { exact: true }), "导入后该行要显示「已导入」标记").toBeVisible();
				// 清单刷新：导入的记录出现在项目 A 的会话树里，并且处于选中态。
				const importedRow = projectA.locator(".session-row").filter({ hasText: authStem });
				await expect(importedRow, "导入的会话必须出现在本地会话清单里").toHaveCount(1, { timeout: timeouts.helperMs });
				await expect(importedRow, "导入的会话必须被选中").toHaveClass(/active/);
				// 不新建会话（没有草稿行、项目 A 下恰好这一条），也不开新 Tab。
				await expect(projectA.locator(".session-row")).toHaveCount(1);
				await expect(projectA.locator(".draft-session-trigger")).toHaveCount(0);
				expect(await window.locator('[role="tab"][data-session-id]').count(), "导入不得打开新 Tab").toBe(tabsBefore);
			});

			await test.step("重复导入同一条：created=false 的区分回执（不是又建一条）", async () => {
				const section = projectRow(window, projectAName).getByTestId("remote-sessions-section");
				const authRow = section.locator('li[data-remote-session-id="' + authSessionId + '"]');
				const projectA = projectRow(window, projectAName);
				const tabsBefore = await window.locator('[role="tab"][data-session-id]').count();
				await authRow.getByTestId("remote-session-import").click();
				// 用户路径的回执：必须说「已在本地存在」，不能静默。
				await expect(section.getByTestId("remote-sessions-feedback")).toHaveText("这条会话已在本地存在，已刷新并选中。", { timeout: timeouts.helperMs });
				// 同一 remoteSessionId 再登记一次，主进程必须回答 created=false（区分回执的机器可检形式）。
				const receipt = await window.evaluate(
					async (input: { remoteSessionId: string }) => {
						const api = (window as unknown as { piDesktop: { remoteHosts: { list: () => Promise<{ ok: boolean; hosts?: Array<{ id: string }> }> }; remoteSessions: { register: (hostId: string, remoteSessionId: string) => Promise<unknown> } } }).piDesktop;
						const listed = await api.remoteHosts.list();
						const hostId = listed.ok ? listed.hosts?.[0]?.id : undefined;
						if (hostId === undefined) return { ok: false, code: "REMOTE_ACCEPTANCE_NO_HOST" };
						return api.remoteSessions.register(hostId, input.remoteSessionId);
					},
					{ remoteSessionId: authSessionId },
				);
				// 2026-10 契约迁移后修正（非放宽）：register 现走 Op 信封，事实在 value 里；仍断言 ok/created/remoteSessionId 三个事实。
				expect(receipt, "重复登记必须是 created=false 的区分回执").toMatchObject({ ok: true, value: { created: false, remoteSessionId: authSessionId } });
				// 没有多出一条记录，也没有多开 Tab。
				await expect(projectA.locator(".session-row")).toHaveCount(1);
				expect(await window.locator('[role="tab"][data-session-id]').count(), "重复导入不得开新 Tab").toBe(tabsBefore);
			});

			await test.step("项目级 root 状态：A 漂移后「需处理」带稳定码，邻居 B 仍可读且状态 ok", async () => {
				// 服务器侧漂移：把 A 的 canonical 目录改名移走（finally 里恢复）。
				await runRemoteCommand(creds, "mv " + projectAPath + " " + movedPath, 30_000);
				movedA = true;
				// 选中 A 会读它的 root，从而在会话建立时复核 root → fail-closed，并把这个项目的状态记成 needs-attention。
				await selectProject(window, projectAName);
				// 空态默认是输入页：从次入口进入文件面板，才会触发列目录并按失效 root fail-closed。
				await window.getByRole("button", { name: "浏览远端文件" }).click();
				const failure = window.locator("p").filter({ hasText: "无法列出目录：" }).first();
				await expect(failure, "失效的 root 必须 fail-closed，而不是列出别的目录").toBeVisible({ timeout: timeouts.helperMs });
				const failureCode = ((await failure.textContent()) ?? "").replace("无法列出目录：", "").trim();
				expect(failureCode, "A 的失败必须带稳定码：" + failureCode).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
				// 刷新项目清单 → root 状态重新查询；A 显示「需处理」，hint 带稳定码。
				await refreshAllProjects(window);
				const tagA = projectRow(window, projectAName).getByTestId("remote-project-needs-attention");
				await expect(tagA, "A 必须显示「需处理」").toBeVisible({ timeout: timeouts.helperMs });
				await expect(tagA).toHaveText("需处理");
				await expect(tagA, "「需处理」必须带稳定码").toHaveAttribute("title", /SSH_PROJECT_ROOT_(UNRESOLVED|CHANGED)/);
				// 设计 (i)：漂移是项目级的。B 不得被污染，状态探针还必须回答 ok。
				const tagB = projectRow(window, projectBName).getByTestId("remote-project-needs-attention");
				await expect(tagB, "B 不得被 A 的漂移污染").toHaveCount(0);
				const projectBId = await projectRow(window, projectBName).getAttribute("data-sidebar-removal-id");
				const statusB = await window.evaluate(async (projectId: string) => {
					const api = (window as unknown as { piDesktop: { remoteHosts: { rootStatus: (id: string) => Promise<unknown> } } }).piDesktop;
					return api.remoteHosts.rootStatus(projectId);
				}, projectBId ?? "");
				// 2026-10 契约迁移后修正（同重复导入回执）：rootStatus 走 Op 信封，事实在 value 里；helperCapabilities 是可选诊断，不参与断言。
				expect(statusB, "B 仍应是 ok").toMatchObject({ ok: true, value: { status: "ok" } });
				// B 仍能正常读取：选中 B，面板必须列出它的文件。
				await selectProject(window, projectBName);
				await window.getByRole("button", { name: "浏览远端文件" }).click();
				await expect(window.getByText("hello-b.txt", { exact: true }), "B 必须仍能列出目录内容").toBeVisible({ timeout: timeouts.helperMs });
			});
		} finally {
			// 收拾远端：恢复被移走的目录（若动过），删除 e2e 根目录与夹具会话目录，不留远端垃圾。
			const restore = movedA ? "if [ -d " + movedPath + " ]; then mv " + movedPath + " " + projectAPath + "; fi; " : "";
			const cleanup = restore + "rm -rf " + e2eRoot + " " + sessionRoot + "/" + sessionWorkspaceDir;
			await runRemoteCommand(creds, cleanup, 60_000).catch((error: unknown) => {
				// 清理失败不掩盖被测结论，但必须留下痕迹（日志/trace 里能查到）。
				console.warn("[remote-acceptance] cleanup failed: " + (error instanceof Error ? error.message : String(error)));
			});
		}
	});
});
