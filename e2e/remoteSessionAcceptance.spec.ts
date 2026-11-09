import { expect, type Locator, type Page } from "@playwright/test";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePiSessionDirectory } from "../src/main/remote/remoteSessionProjectMatch";
import { initializeRemoteCodeFixture, verifyRemoteCodeEditing, verifyRemoteCodeIsolation, verifyRemoteCodeDisconnect, assertRemoteNodeTestExecuted } from "./remote-file-editing";
import { createEmptyRemoteProjectInSidebar, verifyRemoteFileManagement } from "./remote-file-management";
import { verifyRemoteConfig } from "./remote-config";
import { verifyRemoteModelCatalog } from "./remote-model-catalog";
import { verifyRemoteTerminals } from "./remote-terminal";
import { createLocalGitReadControl, initializeRemoteGitFixture, verifyRemoteGitRead } from "./remote-git";
import { verifyRemoteGitSoak } from "./remote-git-soak";
import { quoteSoakArgument } from "./remote-soak-evidence";
import { readRemoteGitSoakMode } from "./remote-soak-policy";
import { initializeRemoteUnbornGitFixture, verifyRemoteGitIndex } from "./remote-git-index";
import { initializeRemoteGitHistoryFixture, verifyRemoteGitHistory } from "./remote-git-history";
import { initializeRemoteGitBranchFixture, verifyRemoteGitBranch } from "./remote-git-branch";
import { initializeRemoteGitDiscardFixture, verifyRemoteGitDiscard } from "./remote-git-discard";
import { initializeRemoteGitRecoveryFixture, verifyRemoteGitRecovery } from "./remote-git-recovery";
import { initializeRemoteGitSyncFixture, verifyRemoteGitSync } from "./remote-git-sync";
import { verifyRemoteGitCompare } from "./remote-git-compare";
import { initializeRemoteGitInitFixture, verifyRemoteGitInit } from "./remote-git-init";
import { initializeRemoteGitReposFixture, verifyRemoteGitRepos } from "./remote-git-repos";
import { verifyRemoteHistoryMutations } from "./remote-history-mutations";
import {
	REMOTE_ACCEPTANCE_ENV,
	dismissRemoteToasts,
	openSessionRunMenu,
	REMOTE_APP_DATA_DIR_NAME,
	createRemoteSessionInProject,
	matchesRemoteFingerprint,
	readPinnedHostKeyFingerprint,
	chooseRemoteDirectory,
	readRemoteAcceptanceCredentials,
	readRemoteAcceptanceTimeouts,
	remoteProjectRow,
	runRemoteCommand,
	test,
	type RemoteAcceptanceCredentials,
	type RemoteAcceptanceTimeouts,
} from "./remote-fixtures";

/**
 * 远端会话功能级验收（Phase 4 P4.2 真机 UI 收口）：在真实 Electron + 真实主机上跑
 * 「加主机 + pin → 连接 ready → 登记远端项目 → **在该远端项目里新建会话** → 发一条最小 prompt →
 * 时间线出现 assistant 正文 → ⋯ 关闭 Agent（回到可重启）→ 关掉标签页再点开该会话 → 历史仍在」，
 * 并单独验收「远端会话的 trust 提示可见」。
 *
 * 门控（硬要求 1）：三个必需环境变量缺任意一个就整体 skip。test.skip 放在 describe 回调里、
 * 任何 test body 之外，Playwright 在 fixture setup 之前就标记跳过，所以无凭据跑本 spec
 * **不会启动 Electron**，npm run e2e / CI 仍然全绿。
 *
 * 隔离（硬要求 2）：userData 走 remote-fixtures 的 `remoteApp`（临时 --user-data-dir +
 * APPDATA/LOCALAPPDATA + PIDECK_E2E_USER_DATA_DIR），刻意**不隔离 HOME/USERPROFILE** ——
 * 产品用系统 OpenSSH 连接，必须读到真实用户的 ~/.ssh/config 与私钥。
 *
 * 实验门禁（硬要求 3）：不在这里发明第二种传法。远端能力在 main 里只由
 * `!app.isPackaged && <实验开关环境变量> === "1"` 裁定，`remoteApp` fixture 已经把它塞进子进程环境
 * （见 e2e/remote-fixtures.ts），本 spec 直接复用同一台 Electron。
 *
 * 为什么要拆成两个 test（**只调整顺序与分节，不删断言**）：
 * - 第 1 个 test 是**产品路**（新建 → 发送 → 正文 → 停止 → 重开历史）。它必须能独立给出结论，
 *   不能被「trust 提示」那条断言挡住——否则一条提示缺失会把「这条产品路到底通不通」一起掩盖。
 * - 第 2 个 test 单独验收 trust 提示（硬要求 d）。提示只可能出现在 runtime 存在的那段时间里
 *   （关闭 Agent 后 runtime 解绑，提示随之消失），所以它无法被排到第 1 个 test 的末尾——只能分节。
 *
 * 取值口径：真实主机/指纹只来自环境变量，本文件不出现任何主机或指纹字面量。
 * 凭据环境变量：PIDECK_E2E_REMOTE_HOST / PIDECK_E2E_REMOTE_USER / PIDECK_E2E_REMOTE_FINGERPRINT
 * （端口 PIDECK_E2E_REMOTE_PORT 与两个超时可选）。
 *
 * 诊断只走「主进程日志留档」：隔离 userData 会被夹具删除，日志只在测试内读得到；本 spec **不**
 * 通过 IPC 直调任何运行链路（驱动产品路一律走真实界面动作）。
 *
 * 「重启后历史仍在」这一条如实区分两件事：
 * - **本次交付的链路**＝`⋯ → 关闭 Agent`（杀进程 + 解绑）后**重新点开该会话**，历史仍在；
 * - **无存活 runtime 的远端正文读取**＝`⋯ → 重新加载会话`后历史仍在（应用侧从远端会话文件读回正文）。
 *   这条曾是 P4.2 遗留项、以「缺口探针」开关默认关闭；`f00977a33` 修掉「远端读页分支被本机路径守卫挡死、
 *   变成不可达死代码」之后它**进入默认门禁**——运行中的会话走 runtime 内存消息，覆盖不到这条路径，
 *   那正是该 bug 溜过验收的原因。
 */
const credentials = readRemoteAcceptanceCredentials(process.env);
const timeouts = readRemoteAcceptanceTimeouts(process.env);
const HELP_TEXT = "set " + [REMOTE_ACCEPTANCE_ENV.host, REMOTE_ACCEPTANCE_ENV.user, REMOTE_ACCEPTANCE_ENV.fingerprint].join(" / ") + " to run the real-host acceptance test";
// 破坏性演练开关：会 kill 该会话自己的远端 pi 进程（默认关闭，只在人工演练时打开）。
const REATTACH_DRILL_ENV = "PIDECK_E2E_P42_REATTACH_DRILL";
/** 最小 prompt：与 scripts/verify-remote-runtime.mjs 的协议层验收用同一条，避免两处口径漂移。 */
const PROMPT = "只回复 pong";
const FOLLOW_UP = "只回复 ping";
const FOLLOW_UP_AFTER = "只回复 pong2";
/** 远端 trust 提示的标题文案（i18n `session.remoteTrust.title`）；组件同时带 data-testid。 */
const TRUST_TITLE = "远端项目资源未加载";

/** 侧栏项目行（与 remote-fixtures 的 remoteProjectRow 同源）。 */
function projectRow(window: Page, projectName: string): Locator {
	return remoteProjectRow(window, projectName);
}

/**
 * 首启引导（CommandPaletteOnboarding）会盖住整个界面：存在就点「以后再说」关掉，不存在不算失败。
 * waitMs 给第一次调用留出引导的延迟弹出窗口（产品在有活动项目后延迟 2.5s 才弹）；后续调用传 0
 * 只做一次廉价兜底——引导关闭时产品会写 localStorage 标记，正常情况下不会再出现。
 * 与 `remoteHostAcceptance.spec.ts` 的处理逐字同款（隔离 userData ⇒ 每次都是首启）。
 */
async function dismissOnboarding(window: Page, waitMs: number): Promise<void> {
	const dialog = window.locator('[role="dialog"]').filter({ hasText: "用命令面板直达任何设置" });
	if (waitMs > 0) await dialog.waitFor({ state: "visible", timeout: waitMs }).catch(() => undefined);
	if ((await dialog.count()) === 0) return;
	await dialog.getByRole("button", { name: "以后再说" }).click();
	await expect(dialog, "引导关闭后不应再可见").toHaveCount(0);
}

/**
 * 读主进程日志里**最后一条** `Remote pi runtime plan prepared` 的 args（真机 trust 验收的判据）。
 *
 * 为什么用这条日志：远端 args 是「这次 pi 到底带没带 --approve/--no-approve」的唯一权威记录，
 * 而它出现在 runtime **准备**阶段（第一次 spawn/重启），不需要模型回合。日志位置按隔离 userData
 * 推导（夹具把 userData 指到 <root>/profile），两个候选路径都试，找不到返回空串让调用方 poll。
 */
function readLatestPlanArgs(userDataRoot: string): string {
	for (const dir of [join(userDataRoot, "profile", "logs"), join(userDataRoot, "logs")]) {
		if (!existsSync(dir)) continue;
		const files = readdirSync(dir)
			.filter((name) => name.endsWith(".log"))
			.sort();
		if (files.length === 0) continue;
		const lines = readFileSync(join(dir, files[files.length - 1]), "utf8")
			.split("\n")
			.filter((line) => line.includes("Remote pi runtime plan prepared"));
		if (lines.length === 0) return "";
		const last = lines[lines.length - 1];
		try {
			const parsed = JSON.parse(last) as { detail?: { args?: unknown } };
			if (typeof parsed.detail?.args === "string") return parsed.detail.args;
		} catch {
			// 退化成原始行（仍然只含 args 与身份，不含正文）。
		}
		return last;
	}
	return "";
}

/** 会话 Tab 栏右上角的 ⋯ 菜单（运行控制组：启动/重启、停止回答、重新加载、关闭 Agent 都在这里）。 */
async function openTabsActionMenu(window: Page): Promise<void> {
	await openSessionRunMenu(window);
}

/** 会话管理入口锚定项目标题行，不右键整个含会话正文的项目组。 */
async function openRemoteSessionManager(window: Page, projectName: string): Promise<Locator> {
	await projectRow(window, projectName).locator(".conversation-title").first().click({ button: "right" });
	await window.getByRole("menuitem", { name: "会话管理", exact: true }).click();
	const dialog = window.getByRole("dialog").filter({ hasText: "会话管理" });
	await expect(dialog).toBeVisible();
	return dialog;
}

/** 本次运行的远端夹具路径：runId 唯一命名 ⇒ 清理只可能命中本次运行造出来的东西。 */
type RemoteRunPaths = {
	runId: string;
	home: string;
	e2eRoot: string;
	sessionRoot: string;
	projectName: string;
	projectPath: string;
	/** 远端 pi 自己落的会话目录（按本项目 canonical 路径编码，与产品归属判定同一函数）。 */
	sessionEvidenceDir: string;
};

async function createRemoteRunPaths(credentials: RemoteAcceptanceCredentials): Promise<RemoteRunPaths> {
	const runId = "e2e" + Date.now().toString(36);
	const home = (await runRemoteCommand(credentials, 'printf %s "$HOME"', 30_000)).stdout.trim();
	expect(home.startsWith("/"), "远端 $HOME 必须是绝对 POSIX 路径").toBe(true);
	expect(/\s/.test(home), "远端 $HOME 含空白：夹具与清理命令按既有风格不做引用，先在这里拒绝").toBe(false);
	const e2eRoot = home + "/.pideck-e2e-" + runId;
	const sessionRoot = home + "/.pi/agent/sessions";
	const projectName = "remote-session-" + runId;
	const projectPath = e2eRoot + "/" + projectName;
	const sessionEvidenceDir = sessionRoot + "/" + encodePiSessionDirectory(projectPath);
	// 归属自检：清理命令里要 rm 的路径只能是「我们建的项目根」与「由它的编码折出来的会话目录」。
	expect(sessionEvidenceDir.startsWith(sessionRoot + "/"), "会话目录必须落在会话根之下").toBe(true);
	expect(sessionEvidenceDir.endsWith("/" + encodePiSessionDirectory(projectPath)), "会话目录的最后一段必须是本项目的编码名").toBe(true);
	return { runId, home, e2eRoot, sessionRoot, projectName, projectPath, sessionEvidenceDir };
}

/** 远端前置：一个只含 hello.txt 的项目目录（远端 pi 的 cwd）。 */
async function createRemoteProjectDirectory(credentials: RemoteAcceptanceCredentials, paths: RemoteRunPaths): Promise<void> {
	await runRemoteCommand(credentials, "mkdir -p " + paths.projectPath + " && echo hello > " + paths.projectPath + "/hello.txt", 60_000);
}

/**
 * 有界等待产品把主机 pin 落盘，返回读到的那一刻的原值（读不到就是 undefined，交给调用方断言）。
 *
 * 为什么必须等：`remoteHostAdd` 里依次是 createDraft（档案先落盘，但还没有 verifiedEndpoint）→
 * offerPin（真实 SSH 握手：self-check → 两次 `ssh -G` → 一次 `-T` 探针，ConnectTimeout=15 且
 * connectTimeoutMs=10s）→ confirmPin（这一步才写 pin）。IPC 返回时 pin 一定在盘上，但**返回之前**
 * 可能已经花掉几十秒；机器负载高（并行 e2e / 构建）时固定 30s 的预算不够，一次性读取就会把
 * 「还没写完」报成「指纹不对」（真机 G3b 偶发：实到 undefined）。等待预算因此取本文件其余步骤
 * 同一个 helperMs。
 *
 * 只放宽「等待落盘」，**不放宽语义**：读到什么就返回什么，是否命中期望指纹仍由调用方那条断言判定。
 * 失败快路：add 真的失败时产品把自己的错误留在对话框里（`settings.connections.add.failed` →
 * 「添加失败：<code>」），这时立刻返回，免得干等到超时才报一条看不出原因的 undefined。
 */
type PinnedFingerprintWait = { value: string | undefined; addFailure: string | null };

async function waitForPinnedHostKeyFingerprint(window: Page, appDataDir: string, sshHost: string, timeoutMs: number): Promise<PinnedFingerprintWait> {
	const deadline = Date.now() + timeoutMs;
	// 产品 add 失败时的固定文案（全角/半角冒号都认，免得被一次词典微调打断）。
	const addFailure = window.getByText(/^添加失败[：:]/).first();
	for (;;) {
		const value = readPinnedHostKeyFingerprint(appDataDir, sshHost);
		if (value !== undefined) return { value, addFailure: null };
		// isVisible 而不是 count：只认「此刻真的显示着」的失败文案，隐藏节点或历史节点不算。
		const failure = (await addFailure.isVisible()) ? ((await addFailure.textContent()) ?? "").trim() : "";
		if (failure !== "") return { value: undefined, addFailure: failure };
		if (Date.now() >= deadline) return { value: undefined, addFailure: null };
		// 落盘是一次短促写入：250ms 足够细，又不会把事件循环刷满。
		await window.waitForTimeout(250);
	}
}

/**
 * 设置页加主机：ssh config 候选 → 保存（首次信任在主进程内完成）→ 产品自动连接 ready。
 *
 * 这里的断言口径与旧版一致，只是证据换了一处：不再读已经取消的「确认主机指纹」弹框，而是读产品为这台
 * 主机**实际落盘**的 pin（`remote-hosts.json` 的 `verifiedEndpoint.hostKeyFingerprints[0]`）——那是它此后
 * 用 `StrictHostKeyChecking=yes` 强制执行的那把钥匙，比界面文本更硬。以下业务断言逐字不变。
 */
async function addVerifiedRemoteHostAndConnect(window: Page, credentials: RemoteAcceptanceCredentials, limits: RemoteAcceptanceTimeouts, userDataRoot: string): Promise<void> {
	await dismissOnboarding(window, 0);
	// 设置入口是左下角 Dock 的第一个按钮（Bolt）：aria-label 是「设置」或「设置（有新版本可用）」。
	await window.getByRole("button", { name: /^设置/ }).click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByRole("tab", { name: "连接", exact: true }).click();
	await modal.getByRole("button", { name: /^(添加|新建连接)$/ }).click();
	const addDialog = window.getByRole("dialog", { name: /^(新建连接|添加 SSH 连接)$/ });
	await expect(addDialog, "点「新建连接」必须打开 AddHostDialog").toBeVisible();
	// 候选来自真实 ~/.ssh/config：按 user@host 精确匹配，同一条 config 可能有多条别名指向同一主机，
	// 所以断言「至少一条」再取第一条。
	const candidate = window.getByRole("button", { name: new RegExp(credentials.user + "@" + credentials.host.replace(/\./g, "\\.")) });
	// 扫描是异步的：列表可能比对话框晚到。用可等待的可见性断言而不是 count() 立即采样，否则主机负载高
	// 时会把「还没渲染」误判成「没有候选」（2026-10-17 真机门禁偶发，均停在此断言）。
	// 面板自 1dd8ceb7e 起默认收起候选列表：先展开「从 SSH config 导入」。
	const importToggle = addDialog.getByRole("button", { name: "从 SSH config 导入" });
	if ((await importToggle.count()) > 0 && (await importToggle.getAttribute("aria-expanded")) !== "true") await importToggle.click();
	await expect(candidate.first(), "ssh config 里需要至少一条 " + credentials.user + "@" + credentials.host + " 候选").toBeVisible({ timeout: 30_000 });
	await candidate.first().click();
	// 提交入口现在是「保存并检测」：测试 → 保存 → 建会话 → 探测 pi，全部内联在对话框里。
	await addDialog
		.getByRole("button", { name: /^(保存并检测|保存并重新检测|保存|添加并连接)$/ })
		.first()
		.click();
	// 指纹：等产品落盘后再比对。等待有界（预算=helperMs，覆盖 add 里那次真实 SSH 握手），
	// 但语义不变——「必须命中期望指纹」仍是下面这一条断言，等待只放宽「什么时候读」。
	const pinned = await waitForPinnedHostKeyFingerprint(window, join(userDataRoot, REMOTE_APP_DATA_DIR_NAME), credentials.host, limits.helperMs);
	expect(
		matchesRemoteFingerprint(credentials.fingerprint, pinned.value === undefined ? [] : [pinned.value]),
		"落盘 pin 的主机指纹必须命中 " + REMOTE_ACCEPTANCE_ENV.fingerprint + "（期望 " + credentials.fingerprint + "，实到 " + String(pinned.value) + (pinned.addFailure === null ? "" : "；加主机对话框已报：" + pinned.addFailure) + "）",
	).toBe(true);
	// 保存并检测：四步检测内联在对话框里，pi 探测通过后给出「完成」。
	// `waitFor` 本身就是有界轮询（失败会一直重试到 helperMs），不是一次性读取。
	const complete = addDialog.getByRole("button", { name: /^完成$/ });
	const completeVisible = await complete
		.waitFor({ state: "visible", timeout: limits.helperMs })
		.then(() => true)
		.catch(() => false);
	// 连接/探测失败时表单里会写原因：带着它报错，而不是干等超时。
	if (!completeVisible) throw new Error("添加对话框未完成远端 pi 探测：" + ((await addDialog.textContent().catch(() => null)) ?? "").trim());
	await complete.click();
	await expect(addDialog).toHaveCount(0);
	await expect(window.getByText("已连接").first()).toBeVisible({ timeout: limits.helperMs });
	await expect(window.getByRole("button", { name: "断开", exact: true }).first()).toBeVisible();
	await window.locator(".settings-modal").getByRole("button", { name: "关闭" }).first().click();
	await expect(window.locator(".settings-modal")).toHaveCount(0);
}

/** 侧栏登记远端项目：+ → 远端（SSH）→ 路径 → canonical 确认 → 添加（与 Phase 3 同一 UI 路径）。 */
async function enrollRemoteProjectInSidebar(window: Page, projectPath: string, limits: RemoteAcceptanceTimeouts): Promise<void> {
	// 显式切到「项目」页签：侧栏项目树才会渲染。
	await window.getByRole("tab", { name: "项目" }).click();
	await window.getByRole("button", { name: "添加项目" }).first().click();
	await window.getByRole("menuitem", { name: /远端（SSH）/ }).click();
	const enrollDialog = window.locator('[role="dialog"]').filter({ hasText: "添加远端项目" });
	await expect(enrollDialog).toBeVisible();
	await expect(enrollDialog.locator("#remote-enroll-host")).not.toBeEmpty();
	await chooseRemoteDirectory(window, projectPath);
	await enrollDialog.getByRole("button", { name: "解析并确认" }).click();
	const confirmDialog = window.locator('[role="dialog"]').filter({ hasText: "确认远端项目目录" });
	await expect(confirmDialog).toBeVisible({ timeout: limits.helperMs });
	await expect(confirmDialog.getByText(projectPath, { exact: false }).first()).toBeVisible();
	await confirmDialog.getByRole("button", { name: "添加项目" }).click();
	const enrolledDialog = window.locator('[role="dialog"]').filter({ hasText: "已添加远端项目" });
	await expect(enrolledDialog).toBeVisible({ timeout: limits.helperMs });
	await enrolledDialog.getByRole("button", { name: "完成" }).click();
	await expect(projectRow(window, projectPath.split("/").pop() ?? "")).toBeVisible();
}

/**
 * 在该远端项目里新建会话并确认会话视图可用，返回会话 id。
 *
 * 入口在侧栏项目行的操作浮层（`createRemoteSessionInProject`，见 remote-fixtures）：远端项目的中间
 * 空态是**只读**面板，没有新建入口。入口不存在时这里会红——那是首要发现，不允许用 IPC 直调绕过。
 */
async function createRemoteSessionAndReadId(window: Page, projectName: string, limits: RemoteAcceptanceTimeouts): Promise<string> {
	await createRemoteSessionInProject(window, projectName);
	const tabs = window.locator('[role="tab"][data-session-id]');
	await expect(tabs, "新建会话必须登记一个会话 Tab").toHaveCount(1, { timeout: limits.helperMs });
	const sessionId = (await tabs.first().getAttribute("data-session-id")) ?? "";
	expect(sessionId, "会话 Tab 必须带稳定 sessionId").not.toBe("");
	// 合成器属于这条会话（不是复用别的会话的输入框），而且可输入。
	await expect(window.locator('.composer[data-session-id="' + sessionId + '"]')).toBeVisible({ timeout: limits.helperMs });
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: limits.helperMs });
	await expect(window.locator(".message-timeline"), "远端会话必须有时间线").toBeVisible({ timeout: limits.helperMs });
	return sessionId;
}

/**
 * 主进程日志留档（**收尾时无条件**调用）：隔离 userData 会被夹具删掉，真机失败的根因往往只写在这里。
 * 只读本地文件、只打印/另存，不参与任何断言，也不会成为新的失败源。
 */
function preserveAppLogs(userDataRoot: string, runId: string): void {
	const source = join(userDataRoot, "profile", "logs");
	const dest = join(tmpdir(), "p42-app-logs-" + runId);
	try {
		if (!existsSync(source)) {
			console.log("[p42-acceptance] app logs: " + source + " does not exist (nothing written?)");
			return;
		}
		cpSync(source, dest, { recursive: true });
		for (const file of readdirSync(dest).filter((name) => name.startsWith("app-"))) {
			const lines = readFileSync(join(dest, file), "utf8")
				.split("\n")
				.filter((line) => /agent|remote|session-perf|runtime/i.test(line));
			console.log("[p42-acceptance] app log tail (" + file + ", " + lines.length + " matching lines):\n" + lines.slice(-40).join("\n"));
		}
		console.log("[p42-acceptance] app logs preserved at " + dest);
	} catch (error) {
		console.warn("[p42-acceptance] app log preservation failed: " + (error instanceof Error ? error.message : String(error)));
	}
}

/** 收尾：停掉会话（第 1 个 test 已通过界面「关闭 Agent」做到）后删掉本次运行的远端目录，并留档远端会话文件内容。 */
async function cleanupRemoteRun(credentials: RemoteAcceptanceCredentials, paths: RemoteRunPaths, evidence: string): Promise<void> {
	if (evidence !== "") console.log("[p42-acceptance] remote session file evidence:\n" + evidence);
	// 只删**本次 runId 命名**的 e2e 根目录与**由本项目路径编码折出**的会话目录（两处都过了上面的归属自检），
	// 不通配、不碰会话根目录本身、不碰用户既有数据。
	const cleanup = "rm -rf " + paths.e2eRoot + " " + paths.sessionEvidenceDir + "; test ! -e " + paths.e2eRoot + " && test ! -e " + paths.sessionEvidenceDir + " && echo CLEANUP_OK";
	await runRemoteCommand(credentials, cleanup, 60_000)
		.then((result) => console.log("[p42-acceptance] cleanup " + result.stdout.trim()))
		.catch((error: unknown) => {
			// 清理失败不掩盖被测结论，但必须留下痕迹（日志/trace 里能查到）。
			console.warn("[p42-acceptance] cleanup failed: " + (error instanceof Error ? error.message : String(error)));
		});
}

test.describe("远端会话功能级验收（真机 · Phase 4 P4.2）", () => {
	// 真机套件受宿主网络抖动影响：每轮 10 个 Git 用例里会随机有 1 个在「加主机」的 SSH 探针上
	// 撞到 SSH_HOST_COMMAND_TIMEOUT（产品已把稳定码显示出来）。这里允许一次重试，让验收衡量功能
	// 而不是网速；Playwright 会把「重试后通过」单独标成 flaky，不会把真失败洗成通过。
	test.describe.configure({ retries: 1 });
	// 无凭据整体 skip：在 fixture setup 之前生效，所以既不会建临时 userData，也不会启动 Electron。
	test.skip(credentials === undefined, HELP_TEXT);

	test("远端会话产品路：新建 → 发 prompt 出正文 → 关闭 Agent → 重开历史仍在", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		// 远端 bootstrap + 远端 pi 拉起 + 一次真实模型调用 + 关闭/重开：给足预算；超时是失败，不是挂起。
		test.setTimeout(1_200_000);
		const creds = credentials;
		if (creds === undefined) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const window = remoteWindow;
		// 渲染层控制台错误原样留证据（报告要能贴出来）；只收集前 20 条，避免刷屏。
		const consoleErrors: string[] = [];
		window.on("console", (message) => {
			if (message.type() === "error" && consoleErrors.length < 20) consoleErrors.push(message.text());
		});
		await dismissOnboarding(window, 8_000);
		const paths = await createRemoteRunPaths(creds);
		let sessionId = "";
		let remoteSessionEvidence = "";
		console.log("[p42-acceptance] chain run=" + paths.runId + " host=" + creds.host);
		try {
			await test.step("远端前置：项目目录（唯一命名，结束清理）", async () => {
				await createRemoteProjectDirectory(creds, paths);
			});
			await test.step("设置页加主机 pin → 连接 ready", async () => {
				await addVerifiedRemoteHostAndConnect(window, creds, timeouts, remoteUserDataRoot);
			});
			await test.step("侧栏登记远端项目（canonical 确认 + 立即选中）", async () => {
				await enrollRemoteProjectInSidebar(window, paths.projectPath, timeouts);
				// 空态默认输入页；文件浏览是次入口（59a1fb351 起）。
				await expect(window.getByRole("button", { name: "浏览远端文件" })).toBeVisible({ timeout: timeouts.helperMs });
			});
			await test.step("在该远端项目里新建会话（项目行 + →「普通会话」）", async () => {
				sessionId = await createRemoteSessionAndReadId(window, paths.projectName, timeouts);
			});
			await test.step("发送最小 prompt → 时间线出现 assistant 正文（不是只出现卡片），随后回合结束", async () => {
				const composer = window.locator(".composer .rich-input");
				await composer.click();
				await window.keyboard.type(PROMPT);
				// 输入即「发送意图」：ComposerArea 首键就 activateRuntime（远端 runtime 在这里起来）。
				await expect(window.locator('.composer[data-session-id="' + sessionId + '"]')).toContainText(PROMPT);
				await window.keyboard.press("Enter");
				const timeline = window.locator(".message-timeline");
				await expect(timeline.locator(".user-turn-text").filter({ hasText: PROMPT }), "用户消息必须进时间线").toBeVisible({ timeout: timeouts.helperMs });
				const assistant = timeline.locator(".assistant-text");
				await expect(assistant.first(), "远端 pi 必须回出 assistant 卡片").toBeVisible({ timeout: timeouts.helperMs });
				// 正文必须真的有字：只出现卡片（流式开始但空正文/报错）不算证据。
				await expect.poll(async () => (await assistant.allInnerTexts()).join(" ").trim().length, { timeout: timeouts.helperMs, message: "assistant 正文不能是空串" }).toBeGreaterThan(0);
				// 回合结束（发送钮回归）再进「停止会话」：这一条验的是会话停止，不是流式中途中断。
				await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: timeouts.helperMs });
			});
			await test.step("远端模型目录：设置 → 模型 → ssh 目标 → 拉取实时目录（非空 provider 列表）", async () => {
				// 该步骤刻意放在 runtime 还活着的时候：v1 的“测试连接”= 目标主机上运行中的远端 pi 返回目录，
				// 逐供应商合成 HTTP 探测与用量查询仍按 v1 契约禁用（轮询的 helper 不参与）。
				await verifyRemoteModelCatalog({ window, credentials: creds, timeoutMs: timeouts.helperMs });
			});
			await test.step("运行中的远端会话拒绝归档，记录保留并显示先停 Agent 的提示", async () => {
				const dialog = await openRemoteSessionManager(window, paths.projectName);
				await dialog.getByRole("button", { name: "归档", exact: true }).click();
				await expect(window.getByText(/该会话正在运行：请先停止它的 Agent/)).toBeVisible({ timeout: timeouts.helperMs });
				await expect(dialog.getByRole("button", { name: "归档", exact: true })).toHaveCount(1);
				await dialog.getByRole("button", { name: "关闭", exact: true }).click();
			});
			await test.step("⋯ →「关闭 Agent」停止会话：主控文案回到「启动 Agent」（可重启）", async () => {
				await openTabsActionMenu(window);
				await expect(window.getByRole("menuitem", { name: "关闭 Agent", exact: true }), "运行控制菜单必须有「关闭 Agent」").toBeVisible();
				await window.getByRole("menuitem", { name: "关闭 Agent", exact: true }).click();
				// 关掉后进程已解绑：菜单主控项必须从「重启」变成「启动 Agent」——这是产品自己的运行能力策略
				// （getSessionRunCapabilities：closed → primaryAction=start）在 UI 上的结论，也是「可重启」的落点。
				await expect(window.getByRole("menuitem", { name: "启动 Agent", exact: true })).toHaveCount(0);
				await openTabsActionMenu(window);
				await expect(window.getByRole("menuitem", { name: "启动 Agent", exact: true }), "关闭 Agent 之后必须还能再启动").toBeVisible({ timeout: timeouts.helperMs });
				await window.keyboard.press("Escape");
				await expect(window.getByRole("menuitem", { name: "启动 Agent", exact: true })).toHaveCount(0);
			});
			await test.step("关掉标签页再点开该会话 → 历史仍在，且远端会话文件确有这份历史", async () => {
				// 「点开该会话」＝关掉 Tab 再回侧栏点开（切走再切回在原地就已是同一视图，不是重开）。
				await window.locator('[role="tab"][data-session-id="' + sessionId + '"] button[role="tab-close"]').click();
				await expect(window.locator('[role="tab"][data-session-id]')).toHaveCount(0, { timeout: timeouts.helperMs });
				await expect(window.locator('.composer[data-session-id="' + sessionId + '"]')).toHaveCount(0);
				const group = projectRow(window, paths.projectName);
				// 侧栏项目组折叠时不渲染会话行（真机失败快照实测：失败时刻该组旁是「展开」按钮
				// ⇒ 行根本不在 DOM 里，`.session-row` 恒为 0）——先确保展开再计数。
				const expander = group.getByRole("button", { name: "展开", exact: true });
				if ((await expander.count()) > 0) await expander.first().click();
				const rows = group.locator(".session-row");
				await expect(rows, "远端项目下必须恰好一条会话行").toHaveCount(1, { timeout: timeouts.helperMs });
				await rows.first().click();
				await expect(window.locator('[role="tab"][data-session-id="' + sessionId + '"]'), "点开会话必须重新登记 Tab").toHaveCount(1, { timeout: timeouts.helperMs });
				const timeline = window.locator(".message-timeline");
				await expect(timeline.locator(".user-turn-text").filter({ hasText: PROMPT }), "重开后必须还能看到刚才的 prompt").toBeVisible({ timeout: timeouts.helperMs });
				const reply = timeline.locator(".assistant-text");
				await expect(reply.first(), "重开后必须还能看到刚才的回复卡片").toBeVisible({ timeout: timeouts.helperMs });
				await expect.poll(async () => (await reply.allInnerTexts()).join(" ").trim().length).toBeGreaterThan(0);
				// 独立佐证：历史真的在**远端 pi 自己写的会话文件**里（不是渲染层内存残影）。
				// 通配符按本项目编码目录限定（唯一）；命令末尾 `true` 保证「查不到」也回得到 stdout 而不是非零退出。
				remoteSessionEvidence = (await runRemoteCommand(creds, "ls -1 " + paths.sessionEvidenceDir + " 2>/dev/null; wc -l " + paths.sessionEvidenceDir + "/*.jsonl 2>/dev/null; true", 30_000)).stdout;
				// 按**每个文件的行数求和**，不要认 `total` 行：`wc -l` 只在给出 ≥2 个文件时才打 `total`，
				// 单个会话文件时永远没有它——曾经因此恒为 0，把「远端文件里明明有 5 行（一问一答都在）」
				// 误报成产品缺口（真机实测）。求和同时覆盖多文件情形，判据仍然「≥2 行＝至少一问一答」。
			});
			// 破坏性演练（默认关闭）：进程被杀后的恢复路径。刻意**不**断言「自动接回」——产品的自动重连只覆盖
			// 两个窄窗口（abort 窗口内退出 / code===0 的干净退出），kill -9 不在其中；真实恢复动作是「启动/重启 Agent」。
			// 这里验的是：被杀后不卡在假运行态、能接回**同一个远端会话**（不是新开的空会话）、历史仍在、且还能继续对话。
			if (process.env[REATTACH_DRILL_ENV] === "1") {
				await test.step("演练：杀掉该会话自己的远端 pi → 启动/重启接回同一远端会话（历史仍在 + 还能对话）", async () => {
					const timeline = window.locator(".message-timeline");
					// 0) 在一个**正在进行的回合**里杀进程（崩溃的真实场景，且这时进程必然活着）：
					//    先发一条要长回复的 prompt，等 assistant 卡片一出现（= 首包已回、pi 正在跑）就动手。
					//    回合结束后再找进程是不行的——空闲释放会把 runtime 收掉（前两次演练都栽在这里：候选表为空）。
					await window.locator(".composer .rich-input").click();
					await window.keyboard.type(FOLLOW_UP);
					await window.keyboard.press("Enter");
					await expect(timeline.locator(".user-turn-text").filter({ hasText: FOLLOW_UP }), "演练前置：prompt 必须进时间线").toBeVisible({ timeout: timeouts.stepMs });
					//    注意不能只等「assistant 卡片可见」——重开后历史里本来就有旧回复，那会在 runtime 还没起来时立刻通过
					//    （前一次演练就是这样空转的）。要等**本轮真正结束**：发送钮从「停止」回到「发送」。
					await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: timeouts.helperMs });
					// 2) 定位并杀进程：不用 `ps` 猜命令行——runner（承载 pi 的进程）的参数走 stdin，命令行里根本没有会话路径，
					//    用 `ps | grep <会话名>` 永远为空（前几次演练就是这么空转的）。runner 自己会写**lease**：
					//    `<home>/.pideck/remote-host/leases/<nonce>.json`，里面有它 spawn 的 pi 的 `pid`/`pgid`（契约文档明写）。
					//    按 lease 拿 pgid 并杀掉**整个进程组**：runner + pi 一起没，才是真实的崩溃形态（只杀 pi 会被 runner 收拾掉）。
					//    runner 写 lease 有延迟 ⇒ **重试式**读（最多 ~10s，一次 ssh 往返里循环），否则会读到空目录。
					const leaseCommand = 'for i in $(seq 1 10); do f=$(ls -1t $HOME/.pideck/remote-host/leases/*.json 2>/dev/null | head -1); if [ -n "$f" ]; then cat "$f"; exit 0; fi; sleep 1; done; true';
					// 判别性证据：重启后的新回合必须**追加到同一个远端会话文件**里（否则「历史还在」可能只是远端 reader 画出来的旧文件）。
					// 取**绝对路径**：证据里 `ls -1` 那行只有文件名，只有 `wc -l` 那行带绝对路径（要求以 / 开头）。
					const evidenceFile = (remoteSessionEvidence.match(/(\/\S+\.jsonl)/) ?? [])[1];
					const countEvidenceLines = async () => Number(((await runRemoteCommand(creds, "wc -l < '" + evidenceFile + "'", 20_000)).stdout.match(/(\d+)/) ?? [])[1] ?? 0);
					const linesBeforeKill = await countEvidenceLines();
					const leaseOutput = (await runRemoteCommand(creds, leaseCommand, 20_000)).stdout.trim();
					const leasePid = (leaseOutput.match(/"pid"\s*:\s*(\d+)/) ?? [])[1];
					const leasePgid = (leaseOutput.match(/"pgid"\s*:\s*(\d+)/) ?? [])[1];
					// 诊断用（失败时才看）：最新几个 lease + runner/pi 进程，帮助判断「有没有在跑 / 是谁在跑」。
					const psCandidates = (await runRemoteCommand(creds, "ls -1t $HOME/.pideck/remote-host/leases/*.json 2>/dev/null | head -3; ps -eo pid,ppid,pgid,args --no-headers | grep -E 'runner|pi-coding' | grep -v grep | head -5", 20_000)).stdout.trim();
					// 先断言「lease 里确实有 pid」而不是直接 toMatch：toMatch 收到 undefined 会吞掉诊断信息。
					expect(leaseOutput, "runner lease 必须存在且含 pid（lease 目录内容与进程候选如下）。lease 内容：\n" + leaseOutput + "\nlease 目录/进程候选：\n" + psCandidates).toContain('"pid"');
					await runRemoteCommand(creds, "kill -9 -" + (leasePgid ?? leasePid) + " 2>/dev/null; true", 20_000);
					// 2) 被杀后主控项必须回到可启动/可重启态（不能假装还在运行）。
					await openTabsActionMenu(window);
					const primary = window.getByRole("menuitem", { name: /^(启动 Agent|重启)$/ });
					await expect(primary, "远端 pi 被杀后必须回到可启动/可重启态").toBeVisible({ timeout: timeouts.helperMs });
					await primary.click();
					// 3) 接回的必须是同一个远端会话：重启前的两条 prompt 都还在（新开会话会是空的）。
					await expect(timeline.locator(".user-turn-text").filter({ hasText: PROMPT }), "重启后必须仍看到重启前那条 prompt（同一会话）").toBeVisible({ timeout: timeouts.helperMs });
					await expect(timeline.locator(".user-turn-text").filter({ hasText: FOLLOW_UP }), "重启后必须仍看到演练前置那条 prompt（同一会话）").toBeVisible({ timeout: timeouts.helperMs });
					// 4) 还能继续对话（证明接回来的是活的 runtime，不是只把历史画出来）。
					await window.locator(".composer .rich-input").click();
					await window.keyboard.type(FOLLOW_UP_AFTER);
					await window.keyboard.press("Enter");
					await expect(timeline.locator(".user-turn-text").filter({ hasText: FOLLOW_UP_AFTER }), "重启后必须能再发一条并进时间线").toBeVisible({ timeout: timeouts.stepMs });
					const assistant = timeline.locator(".assistant-text");
					await expect(assistant.first(), "重启后必须还能出 assistant 卡片").toBeVisible({ timeout: timeouts.helperMs });
					await expect.poll(async () => (await assistant.allInnerTexts()).join(" ").trim().length, { timeout: timeouts.helperMs, message: "重启后的回复必须真的有正文" }).toBeGreaterThan(0);
					await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: timeouts.helperMs });
					// 同一会话的硬证据：新回合把消息追加进了**同一个**远端会话文件（行数增长）。
					// pi 可能延迟落盘 ⇒ 轮询；失败时把该目录**全部** jsonl 的行数打出来（能区分「延迟」与「另开了新文件」）。
					let grew = false;
					for (let i = 0; i < 10 && !grew; i += 1) {
						if ((await countEvidenceLines()) > linesBeforeKill) {
							grew = true;
							break;
						}
						await new Promise((resolve) => setTimeout(resolve, 1500));
					}
					if (!grew) {
						const listing = (await runRemoteCommand(creds, "wc -l " + paths.sessionEvidenceDir + "/*.jsonl 2>/dev/null; true", 20_000)).stdout.trim();
						expect(grew, "重启后的回合必须往同一远端会话文件追加（行数增长）。目录现状：\n" + listing + "\n计划里用的就是：" + evidenceFile).toBe(true);
					}
				});
			}
			await test.step("⋯ →「重新加载会话」后历史仍在（无存活 runtime 的远端正文读取）", async () => {
				// 默认门禁的一部分（见文件头）：这条走的是「应用侧从远端会话文件读回正文」，与上面的
				// 「重开标签页」不同——后者可能仍靠 runtime 内存消息，覆盖不到读页分支。
				await openTabsActionMenu(window);
				await expect(window.getByRole("menuitem", { name: "从磁盘重新加载消息", exact: true }), "无进程时「重新加载会话」必须可用").toBeVisible({ timeout: timeouts.helperMs });
				await window.getByRole("menuitem", { name: "从磁盘重新加载消息", exact: true }).click();
				const timeline = window.locator(".message-timeline");
				// 时间线现状原样记进日志（证据不只来自失败信息）。
				console.log("[p42-acceptance] after reload: userTurns=" + (await timeline.locator(".user-turn-text").count()) + " assistant=" + (await timeline.locator(".assistant-text").count()) + " textLength=" + (await timeline.innerText()).trim().length);
				await expect(timeline.locator(".user-turn-text").filter({ hasText: PROMPT }), "重载后必须仍能看到 prompt（远端正文读取）").toBeVisible({ timeout: timeouts.helperMs });
				await expect(timeline.locator(".assistant-text").first(), "重载后必须仍能看到回复正文（远端正文读取）").toBeVisible({ timeout: timeouts.helperMs });
			});
			await test.step("远端归档 → 归档弹窗可见（恢复 + 删除（永久））→ 按 ID 恢复 → 文件与历史原样返回", async () => {
				const evidenceFile = (remoteSessionEvidence.match(/(\/\S+\.jsonl)/) ?? [])[1];
				expect(evidenceFile, "归档前必须定位到本次会话的远端文件").toBeTruthy();
				if (!evidenceFile) throw new Error("REMOTE_ARCHIVE_EVIDENCE_FILE_MISSING");
				const archiveFile = evidenceFile.replace(/\/([^/]+)$/, "/.pideck-archive/$1");
				const checksum = async (path: string) => (await runRemoteCommand(creds, "sha256sum '" + path + "'", 20_000)).stdout.trim().split(/\s+/)[0];
				const before = await checksum(evidenceFile);
				let dialog = await openRemoteSessionManager(window, paths.projectName);
				const activeRow = dialog.locator("tbody tr").filter({ has: window.getByRole("button", { name: "归档", exact: true }) });
				await expect(activeRow, "远端会话必须出现在普通管理列表").toHaveCount(1);
				await activeRow.getByRole("button", { name: "归档", exact: true }).click();
				// 现行产品：归档成功后弹窗保持打开，方便连续清理/切到归档视图核对。
				await expect(activeRow).toHaveCount(0, { timeout: timeouts.helperMs });
				expect((await runRemoteCommand(creds, "[ ! -e '" + evidenceFile + "' ] && [ -f '" + archiveFile + "' ] && printf moved", 20_000)).stdout.trim()).toBe("moved");
				expect(await checksum(archiveFile)).toBe(before);
				await dialog.getByRole("button", { name: "已归档", exact: true }).click();
				const archivedRow = dialog.locator("tbody tr").filter({ has: window.getByRole("button", { name: "恢复", exact: true }) });
				await expect(archivedRow).toHaveCount(1, { timeout: timeouts.helperMs });
				// 远端行不进入本机回收站链路（“删除”精确名不存在），但必须有显式永久删除入口。
				await expect(archivedRow.getByRole("button", { name: "删除", exact: true })).toHaveCount(0);
				await expect(archivedRow.getByTestId("remote-archived-delete"), "远端归档行必须有显式永久删除入口").toBeVisible();
				await expect(archivedRow.getByRole("checkbox")).toBeDisabled();
				await expect(dialog.getByRole("checkbox").first()).toBeDisabled();
				await archivedRow.getByRole("button", { name: "恢复", exact: true }).click();
				await expect(archivedRow).toHaveCount(0, { timeout: timeouts.helperMs });
				expect((await runRemoteCommand(creds, "[ -f '" + evidenceFile + "' ] && [ ! -e '" + archiveFile + "' ] && printf restored", 20_000)).stdout.trim()).toBe("restored");
				expect(await checksum(evidenceFile)).toBe(before);
				await dialog.getByRole("button", { name: "已归档", exact: true }).click();
				await expect(dialog.getByRole("button", { name: "归档", exact: true })).toHaveCount(1, { timeout: timeouts.helperMs });
				await dialog.getByRole("button", { name: "关闭", exact: true }).click();
				// 恢复后立刻关闭时，Radix 偶发收不到这次点击（真机 trace 复现）；Escape 是同一受控关闭路径。
				if (await dialog.isVisible().catch(() => false)) await window.keyboard.press("Escape");
				await expect(dialog).toHaveCount(0, { timeout: timeouts.helperMs });
				const rows = projectRow(window, paths.projectName).locator(".session-row");
				await expect(rows).toHaveCount(1, { timeout: timeouts.helperMs });
				await rows.first().click();
				await expect(window.locator(".message-timeline .user-turn-text").filter({ hasText: PROMPT }), "恢复后必须重新从远端读回 prompt").toBeVisible({ timeout: timeouts.helperMs });
				await expect(window.locator(".message-timeline .assistant-text").first()).toBeVisible({ timeout: timeouts.helperMs });
			});
			// 远端 live fork（**默认门禁的一部分**，2026-10-12 真机跑通 `2 passed (2.0m)`）：
			// pi 的 `fork` 立刻把 `get_state.sessionFile` 换成新路径，但该**文件懒创建**（要等该会话首次追加消息才落盘；
			// 协议级探针实测：fork 成功后 `ls` 无新文件，连 `set_session_name` 成功也不落盘）⇒ 判据是可达成的三条：
			//   ① 换绑到新记录（composer 的 session id 变化 + 侧栏该远端项目两条记录）；
			//   ② **原文件字节不变**（fork 不得就地改写 origin）；
			//   ③ 原会话仍能从远端文件读回历史（换绑后它已无 runtime ⇒ 走远端读页路径）。
			// 真机证据：originShaUnchanged=true newFiles=[] rowsAfterFork=2 + 新 session id。
			await test.step("时间线「Fork」→ 应用换绑新记录，旧会话与旧文件不动", async () => {
				// 文件懒创建：断言换绑、旧文件字节不变、旧会话仍能读回历史；不要求新文件立即存在。
				const originFile = (remoteSessionEvidence.match(/(\/\S+\.jsonl)/) ?? [])[1];
				expect(originFile, "Fork 前必须定位到本次会话的远端文件").toBeTruthy();
				if (!originFile) throw new Error("REMOTE_FORK_EVIDENCE_FILE_MISSING");
				const listFiles = async () =>
					(await runRemoteCommand(creds, "ls -1 " + paths.sessionEvidenceDir + "/*.jsonl 2>/dev/null; true", 20_000)).stdout
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean);
				const beforeFiles = await listFiles();
				const sha256 = async (path: string) => (await runRemoteCommand(creds, "sha256sum '" + path + "'", 20_000)).stdout.trim().split(/\s+/)[0];
				const shaBefore = await sha256(originFile);
				// 消息动作按钮平时只在 hover 时可点（与本地同一组件），先 hover 再点。
				const preForkSessionId = await window.locator(".composer[data-session-id]").first().getAttribute("data-session-id");
				expect(preForkSessionId, "Fork 前必须能读到当前会话 id").toBeTruthy();

				const userMessage = window.locator(".message-timeline article").filter({ hasText: PROMPT }).first();
				await userMessage.hover();
				await userMessage.getByRole("button", { name: "Fork", exact: true }).click();
				// 先等**产品侧**换绑完成（点 Fork 会先激活远端 runtime，约 20s+，再发 RPC；这期间远端目录当然还没文件）。
				// 换绑成功证明主进程从 fresh get_state 拿到新身份；不代表懒创建的文件已经落盘。
				const forkedSessionId = await expect
					.poll(async () => window.locator(".composer[data-session-id]").first().getAttribute("data-session-id"), { timeout: timeouts.helperMs, message: "Fork 后必须换绑到一条新记录" })
					.not.toBe(preForkSessionId)
					.then(() => window.locator(".composer[data-session-id]").first().getAttribute("data-session-id"));
				expect(forkedSessionId, "Fork 后必须能读到新记录的 session id").toBeTruthy();
				if (!forkedSessionId) throw new Error("REMOTE_FORK_SESSION_ID_MISSING");
				// 已知缺口（2026-10-12 真机实测，记入 docs）：fork 点文本**没有**回填到新会话的输入框
				// （渲染层 useSessionHistoryMutations 的草稿回填，本步只断言"新记录的视图已打开"）。
				// 这里**不**断言草稿内容：那会把一个渲染层草稿问题伪装成真机失败，也会掩盖身份链的结论。
				await expect(window.locator('.composer[data-session-id="' + forkedSessionId + '"]'), "必须已打开 fork 出来的新记录").toBeVisible({ timeout: timeouts.helperMs });
				// 先看**原文件是否被改写**：fork 必须派生出新文件，而不是就地改写旧文件。
				const shaAfterFork = await sha256(originFile);
				console.log(
					"[p42-acceptance] fork probe: originSha unchanged=" + String(shaAfterFork === shaBefore) + " rows=" + String(await projectRow(window, paths.projectName).locator(".session-row").count()) + " titles=" + JSON.stringify(await projectRow(window, paths.projectName).locator(".session-row").allInnerTexts()),
				);
				// pi 的 fork **懒创建**文件（要等该会话首次追加消息才落盘）⇒ 这里**不**断言"立刻多出一个文件"，
				// 那是我最初写错的期望（真机实测：fork 成功后远端没有任何新文件、原文件 sha256 未变）。
				// 本步骤的判据是可达成的三条：① 已换绑到新记录（上面的 poll + 侧栏两条记录）② 原文件字节不变
				// ③ 原会话仍能从远端文件读回历史（它已无 runtime ⇒ 走读页路径）。新文件只作**观察**记进日志。
				let observedNewFiles: string[] = [];
				for (let attempt = 0; attempt < 15; attempt += 1) {
					observedNewFiles = (await listFiles()).filter((path) => !beforeFiles.includes(path));
					if (observedNewFiles.length > 0) break;
					await window.waitForTimeout(2000);
				}
				const rowCountAfterFork = await projectRow(window, paths.projectName).locator(".session-row").count();
				console.log("[p42-acceptance] fork: originShaUnchanged=" + String((await sha256(originFile)) === shaBefore) + " newFiles=" + JSON.stringify(observedNewFiles) + " rowsAfterFork=" + String(rowCountAfterFork));
				expect(await sha256(originFile), "Fork 不得改写原会话文件").toBe(shaBefore);
				// 侧栏该远端项目下现在有两条会话行：新记录 + 原记录（原记录没有被吸收、也没有被改名成新文件）。
				const group = projectRow(window, paths.projectName);
				const expander = group.getByRole("button", { name: "展开", exact: true });
				if ((await expander.count()) > 0) await expander.first().click();
				await expect(group.locator(".session-row"), "Fork 后必须同时存在原会话与新会话两条记录").toHaveCount(2, { timeout: timeouts.helperMs });
				// 旧记录仍然可打开、且历史来自远端文件（此时它没有 runtime，走读页路径）。
				// 精确锚定**原**会话：fork 行的标题是「<原名> (fork)」也含 PROMPT ⇒ 必须排除它，
				// 否则会点到那条"文件还没落盘"的新记录上，读回历史自然为空（第一次真机跑就是这么假失败的）。
				await group.locator(".session-row").filter({ hasText: PROMPT }).filter({ hasNotText: "(fork)" }).first().click();
				const timeline = window.locator(".message-timeline");
				await expect(timeline.locator(".user-turn-text").filter({ hasText: PROMPT }), "原会话必须仍能从远端文件读回 prompt").toBeVisible({ timeout: timeouts.helperMs });
				await expect(timeline.locator(".assistant-text").first(), "原会话必须仍能从远端文件读回回复").toBeVisible({ timeout: timeouts.helperMs });
				console.log("[p42-acceptance] fork: newSessionId=" + forkedSessionId + " origin=" + originFile);
			});
			const mutationFile = (remoteSessionEvidence.match(/(\/\S+\.jsonl)/) ?? [])[1];
			if (!mutationFile) throw new Error("REMOTE_MUTATION_EVIDENCE_FILE_MISSING");
			await verifyRemoteHistoryMutations({ window, credentials: creds, evidenceFile: mutationFile, evidenceDirectory: paths.sessionEvidenceDir, prompt: PROMPT, timeoutMs: timeouts.helperMs, testInfo });
			await test.step("远端归档的永久删除：行内不可恢复确认 → 远端文件真正消失 → 归档行消失", async () => {
				const evidenceFile = (remoteSessionEvidence.match(/(\/\S+\.jsonl)/) ?? [])[1];
				expect(evidenceFile, "永久删除前必须定位到本次会话的远端文件").toBeTruthy();
				if (!evidenceFile) throw new Error("REMOTE_DELETE_EVIDENCE_FILE_MISSING");
				const archiveFile = evidenceFile.replace(/\/([^/]+)$/, "/.pideck-archive/$1");
				// 再次归档（上一步最后已恢复并打开会话，运行中的会话会被主进程拒绝归档 ⇒ 先停 Agent）。
				const dialog = await openRemoteSessionManager(window, paths.projectName);
				const activeRow = dialog
					.locator("tbody tr")
					.filter({ has: window.getByRole("button", { name: "归档", exact: true }) })
					.filter({ hasText: PROMPT })
					.filter({ hasNotText: "(fork)" });
				await expect(activeRow, "再次归档前会话必须回到普通管理列表").toHaveCount(1);
				await activeRow.getByRole("button", { name: "归档", exact: true }).click();
				// 归档成功后弹窗保持打开（现行产品语义）：同一弹窗切到归档视图，不重复打开。
				await expect(activeRow).toHaveCount(0, { timeout: timeouts.helperMs });
				expect((await runRemoteCommand(creds, "[ -f '" + archiveFile + "' ] && printf archived", 20_000)).stdout.trim()).toBe("archived");
				const archivedDialog = dialog;
				await archivedDialog.getByRole("button", { name: "已归档", exact: true }).click();
				const archivedRow = archivedDialog.locator("tbody tr").filter({ has: window.getByRole("button", { name: "恢复", exact: true }) });
				await expect(archivedRow).toHaveCount(1, { timeout: timeouts.helperMs });
				// 本机归档/DSH 行的删除入口不出现；远端行显示「删除（永久）」。
				await expect(archivedRow.getByRole("button", { name: "删除", exact: true })).toHaveCount(0);
				await archivedRow.getByTestId("remote-archived-delete").click();
				const confirmBar = window.getByTestId("remote-archived-delete-confirm");
				await expect(confirmBar).toBeVisible();
				// 文案必须明说不可恢复，不能只显示“删除”。
				await expect(confirmBar).toContainText("无法恢复");
				await expect(archivedRow.getByTestId("remote-archived-delete-confirm-action")).toBeEnabled();
				await archivedRow.getByTestId("remote-archived-delete-confirm-action").click();
				await expect(archivedRow).toHaveCount(0, { timeout: timeouts.helperMs });
				// 主进程有界 rm 真的删掉了远端文件；不是只移除本机索引。
				expect((await runRemoteCommand(creds, "[ ! -e '" + archiveFile + "' ] && printf deleted", 20_000)).stdout.trim()).toBe("deleted");
				// 成功路径不得留下“结果未确认”提示（未确认是另一条独立分支）。
				await expect(archivedDialog.getByTestId("remote-archived-delete-unconfirmed")).toHaveCount(0);
				await archivedDialog.getByRole("button", { name: "关闭", exact: true }).click();
			});
		} finally {
			if (consoleErrors.length > 0) console.log("[p42-acceptance] renderer console errors:\n" + consoleErrors.join("\n"));
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await cleanupRemoteRun(creds, paths, remoteSessionEvidence);
		}
	});

	test("远端代码文件：UI编辑保存 → 外部冲突保留草稿 → 双项目隔离 → Agent真实运行测试", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(1_200_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const window = remoteWindow;
		const paths = await createRemoteRunPaths(creds);
		const neighborPath = paths.e2eRoot + "/neighbor-" + paths.runId;
		let started = false;
		try {
			await dismissOnboarding(window, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteCodeFixture(creds, paths.projectPath);
			await runRemoteCommand(creds, "mkdir -p '" + neighborPath + "'; umask 077; printf '%s' '" + Buffer.from("module.exports = { value: 101 };\n").toString("base64") + "' | base64 -d > '" + neighborPath + "/calc.cjs'", 20_000);
			await addVerifiedRemoteHostAndConnect(window, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(window, paths.projectPath, timeouts);
			await verifyRemoteCodeEditing({ window, credentials: creds, projectPath: paths.projectPath, testInfo, timeoutMs: timeouts.helperMs });
			await enrollRemoteProjectInSidebar(window, neighborPath, timeouts);
			await verifyRemoteCodeIsolation(window, creds, paths.projectPath, neighborPath, timeouts.helperMs);
			await verifyRemoteCodeDisconnect(window, creds, paths.projectPath, timeouts.helperMs);
			await createRemoteSessionAndReadId(window, paths.projectName, timeouts);
			started = true;
			// 会话已打开时走文件抽屉，不只证明无会话空态能编辑。
			await window.locator(".header-drawer-toggle").first().click();
			await expect(window.getByTestId("drawer-rail-files")).toHaveAttribute("aria-selected", "true");
			await window.getByRole("button", { name: "calc.cjs", exact: false }).click();
			await expect(window.getByRole("region", { name: "远端文件编辑器" }).locator(".cm-content")).toContainText("value: 2", { timeout: timeouts.helperMs });
			await test.step("文件抽屉内容搜索：输入夹具正文标记 → 出现内容命中分区（新 helper 能力，全链路无错误）", async () => {
				// 能力来自 helper hello（1.25.0 声明 fs.searchContent）；真机无法回退 helper 版本模拟旧能力，
				// 所以本用例覆盖新 helper 命中，并断言「仅文件名」能力提示不出现——不能把能力缺失静默吞掉。
				await window.getByRole("button", { name: "搜索文件名" }).click();
				await window.getByRole("textbox", { name: "搜索文件名" }).fill("中文保存验收");
				await window.getByRole("button", { name: "搜索", exact: true }).click();
				const contentSection = window.locator(".file-search-content");
				await expect(contentSection, "内容命中分区必须出现（helper 1.25 声明 fs.searchContent）").toBeVisible({ timeout: timeouts.helperMs });
				const hit = contentSection.locator(".file-node-row").filter({ hasText: "calc.cjs" });
				await expect(hit, "内容命中行必须指向夹具文件 calc.cjs").toBeVisible({ timeout: timeouts.helperMs });
				// 命中行 title 是「项目相对路径:行号」，正文片段必须带出 fixture 里的中文标记。
				await expect(hit).toHaveAttribute("title", /^calc\.cjs:\d+$/);
				await expect(hit, "命中行必须带出夹具正文片段").toContainText("中文保存验收");
				await expect(window.getByTestId("file-search-name-only-hint"), "新 helper 下不得显示「仅文件名」提示").toHaveCount(0);
				// 收尾：清空搜索回到文件树，后续步骤仍按原路径操作抽屉。
				await window.getByRole("button", { name: "清除搜索结果" }).click();
				await expect(contentSection).toHaveCount(0);
			});
			// 抽屉打开后开关并入抽屉（.header-drawer-toggle 只在关闭态渲染，见 SessionTabsBar）：用抽屉自己的
			// 关闭入口，再断言开关回到会话 Tab 栏 —— 与旧断言同一个可观察契约「抽屉已关」，只是点对了控件。
			await window.getByRole("button", { name: "关闭右侧边栏" }).first().click();
			await expect(window.locator(".header-drawer-toggle").first(), "关闭抽屉后开关必须回到会话 Tab 栏").toBeVisible({ timeout: timeouts.helperMs });
			console.log("[remote-file-acceptance] activeSessionFileDrawer=true");
			const prompt = "请读取 calc.cjs 和 test.cjs，然后用 bash 执行 node test.cjs。不要修改任何文件，必须真实运行测试，测试通过后回复 REMOTE_FILE_TEST_OK。";
			await window.locator(".composer .rich-input").click();
			await window.keyboard.insertText(prompt);
			await window.keyboard.press("Enter");
			await expect(window.locator(".message-timeline .assistant-text").filter({ hasText: "REMOTE_FILE_TEST_OK" })).toBeVisible({ timeout: timeouts.helperMs });
			await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: timeouts.helperMs });
			await openTabsActionMenu(window);
			await window.getByRole("menuitem", { name: "关闭 Agent", exact: true }).click();
			started = false;
			const file = (await runRemoteCommand(creds, "find '" + paths.sessionEvidenceDir + "' -maxdepth 1 -name '*.jsonl' -print", 20_000)).stdout.trim();
			expect(file.split("\n")).toHaveLength(1);
			expect(file.startsWith(paths.sessionEvidenceDir + "/")).toBe(true);
			const bounded = await runRemoteCommand(creds, "test $(wc -c < '" + file + "') -le 262144 && cat -- '" + file + "'", 20_000);
			await testInfo.attach("remote-code-agent-tool-evidence", { body: Buffer.from(bounded.stdout), contentType: "application/jsonl" });
			assertRemoteNodeTestExecuted(bounded.stdout);
			console.log("[remote-file-acceptance] agentReadAndNodeTest=true");
		} finally {
			if (started) {
				try {
					await window.keyboard.press("Escape");
					await openTabsActionMenu(window);
					await window.getByRole("menuitem", { name: "关闭 Agent", exact: true }).click();
				} catch (error) {
					console.warn("[remote-file-acceptance] cleanup stop was not confirmed", error instanceof Error ? error.message : String(error));
				}
			}
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G1：只读SCM与差异 → 双项目隔离 → 断开不重连 → Git字节不变", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const neighbor = paths.e2eRoot + "/git-neighbor-" + paths.runId;
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteGitFixture(creds, paths.projectPath, neighbor);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, neighbor, timeouts);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			// A draft exposes shared workspace chrome, without starting pi or relying on model quota.
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitRead({ window: remoteWindow, credentials: creds, root: paths.projectPath, neighbor, timeoutMs: 40_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G2a/G2b：精确暂存取消 → 提交已确认暂存区 → 拒绝面 → unborn与工作区不变", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(660_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const neighbor = paths.e2eRoot + "/git-index-neighbor-" + paths.runId;
		const unborn = paths.e2eRoot + "/git-unborn-" + paths.runId;
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteGitFixture(creds, paths.projectPath, neighbor);
			await initializeRemoteUnbornGitFixture(creds, unborn);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, unborn, timeouts);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitIndex({ window: remoteWindow, credentials: creds, root: paths.projectPath, unborn, timeoutMs: 40_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G3a：只读历史分页与详情 → 引用 → 两版本差异 → 仓库字节不变", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteGitHistoryFixture(creds, paths.projectPath);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitHistory({ window: remoteWindow, credentials: creds, root: paths.projectPath, timeoutMs: 40_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G3b：新建分支 → 切换 → 工作区冲突拒绝不丢文件 → 只多一个 ref", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteGitBranchFixture(creds, paths.projectPath);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitBranch({ window: remoteWindow, credentials: creds, root: paths.projectPath, timeoutMs: 40_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G4a：丢弃工作区改动 → 删除未跟踪文件 → 先备份后可恢复 → 仓库其余部分不变", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteGitDiscardFixture(creds, paths.projectPath);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitDiscard({ window: remoteWindow, credentials: creds, root: paths.projectPath, timeoutMs: 40_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G4b：丢弃留快照 → 恢复区列出 → 一键还原字节一致 → 确认后删除快照", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteGitRecoveryFixture(creds, paths.projectPath);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitRecovery({ window: remoteWindow, credentials: creds, root: paths.projectPath, timeoutMs: 40_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G5a：获取更新远端跟踪引用 → 拉取快进 → 脏工作区拒绝 → 确认后推送远端前进", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			const sync = await initializeRemoteGitSyncFixture(creds, paths.projectPath, paths.e2eRoot);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitSync({ window: remoteWindow, credentials: creds, root: paths.projectPath, origin: sync.origin, other: sync.other, timeoutMs: 60_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G5b：引用对比与原生 diff 一致 → 逐文件两侧内容 → 可见时轮询 → 收起后不轮询", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			// The G3a fixture already has two tags, a second commit with a rename, and a decoy branch: exactly the
			// refs a compare and a polling observation need, without a second fixture shape.
			await initializeRemoteGitHistoryFixture(creds, paths.projectPath);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitCompare({ window: remoteWindow, credentials: creds, root: paths.projectPath, timeoutMs: 40_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G5c：非仓库根显式初始化 → 原生 .git 出现 → 文件成为未跟踪改动 → 初始化入口消失", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			// A genuinely non-repository project root: the directory and its files are created without Git, and the
			// panel must offer only the explicit init action - never an automatic one.
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteGitInitFixture(creds, paths.projectPath);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitInit({ window: remoteWindow, credentials: creds, root: paths.projectPath, timeoutMs: 40_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端文件管理 v1：新建空项目 → 新建/改名/移动/删除+回收站还原/清空 → 同名再建", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		// 新建空项目的目标必须是本次 runId 的唯一 e2eRoot：create-only 语义要求它此刻不存在。
		const createPath = paths.e2eRoot;
		const consoleErrors: string[] = [];
		remoteWindow.on("console", (message) => {
			if (message.type() === "error" && consoleErrors.length < 20) consoleErrors.push(message.text());
		});
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await createEmptyRemoteProjectInSidebar(remoteWindow, createPath, timeouts);
			// 产品之外的第一方佐证：目录存在、为空，且不是用 -p 递归造出来的父链。
			const created = await runRemoteCommand(creds, "test -d '" + createPath + "' && [ -z \"$(ls -A '" + createPath + "')\" ] && echo CREATED_EMPTY", 60_000);
			expect(created.stdout.trim(), "新建空项目必须真的创建一个空目录").toBe("CREATED_EMPTY");
			await verifyRemoteFileManagement({ window: remoteWindow, credentials: creds, projectPath: createPath, testInfo, timeoutMs: timeouts.helperMs });
			await test.step("远端配置：目标选择器 → 脱敏读取（version/密钥徽标）→ 一次非密钥 patch → 认证页禁用副本", async () => {
				await verifyRemoteConfig({ window: remoteWindow, credentials: creds, runId: paths.runId, timeoutMs: timeouts.helperMs });
			});
			expect(consoleErrors, "文件管理链路不应出现渲染层 console error").toEqual([]);
			await runRemoteCommand(creds, "rm -rf " + createPath + "; test ! -e " + createPath + " && echo CLEANUP_OK", 60_000);
			await runRemoteCommand(creds, "test ! -e " + paths.e2eRoot + " && echo CLEANUP_OK", 30_000);
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端 Git G5d/G5e：仓库发现与 scope → 嵌套读取匹配原生 → 嵌套写控件可用并真实暂存 → 切回根恢复", async ({ remoteWindow, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const localControl = await createLocalGitReadControl();
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			// A root repository plus a nested one, each with its own untracked change and an own branch name.
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteGitReposFixture(creds, paths.projectPath);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
			await verifyRemoteGitRepos({ window: remoteWindow, credentials: creds, root: paths.projectPath, timeoutMs: 60_000, testInfo });
			await localControl.verify();
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await localControl.dispose();
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test.describe("G6b opt-in real SSH soak", () => {
		const mode = readRemoteGitSoakMode(process.env);
		test.skip(mode === undefined || process.platform !== "linux", "set PIDECK_E2E_REMOTE_GIT_SOAK=hour (or smoke for a separate 3-minute check); Linux only");
		// Invoke with --trace off: hour-long action traces distort resource measurements; persist JSONL instead.
		test("远端 Git G6b：真实SSH长稳 → 连接中断恢复不重放 → 退出回收", async ({ remoteWindow, remoteApp, remoteUserDataRoot }, testInfo) => {
			if (!credentials || !mode) throw new Error("REMOTE_SOAK_GATE_NOT_APPLIED");
			expect(testInfo.project.use.trace, "run the opt-in soak with --trace off").toBe("off");
			test.setTimeout(mode.durationMs + 900_000);
			const paths = await createRemoteRunPaths(credentials),
				neighbor = paths.e2eRoot + "/Git 中文 空格 soak";
			const localControl = await createLocalGitReadControl();
			try {
				await dismissOnboarding(remoteWindow, 8_000);
				await createRemoteProjectDirectory(credentials, paths);
				await initializeRemoteGitFixture(credentials, paths.projectPath, neighbor);
				await addVerifiedRemoteHostAndConnect(remoteWindow, credentials, timeouts, remoteUserDataRoot);
				await enrollRemoteProjectInSidebar(remoteWindow, neighbor, timeouts);
				await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
				await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
				await verifyRemoteGitSoak({ window: remoteWindow, app: remoteApp, credentials, roots: [paths.projectPath, neighbor], userDataRoot: remoteUserDataRoot, mode, testInfo });
				await localControl.verify();
			} finally {
				await remoteApp.close();
				preserveAppLogs(remoteUserDataRoot, paths.runId);
				await localControl.dispose();
				await cleanupRemoteRun(credentials, paths, "");
				await runRemoteCommand(credentials, "test ! -e " + quoteSoakArgument(paths.e2eRoot), 20_000);
			}
		});
	});

	test("远端终端：项目隔离 → 已保存代码测试 → resize → 关闭/断开/退出清理", async ({ remoteWindow, remoteApp, remoteUserDataRoot }, testInfo) => {
		test.setTimeout(1_200_000);
		const creds = credentials;
		if (!creds) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const paths = await createRemoteRunPaths(creds);
		const neighborPath = paths.e2eRoot + "/terminal-neighbor-" + paths.runId;
		try {
			await dismissOnboarding(remoteWindow, 8_000);
			await createRemoteProjectDirectory(creds, paths);
			await initializeRemoteCodeFixture(creds, paths.projectPath);
			await runRemoteCommand(creds, "mkdir -p '" + neighborPath + "'", 20_000);
			await addVerifiedRemoteHostAndConnect(remoteWindow, creds, timeouts, remoteUserDataRoot);
			await enrollRemoteProjectInSidebar(remoteWindow, paths.projectPath, timeouts);
			await verifyRemoteCodeEditing({ window: remoteWindow, credentials: creds, projectPath: paths.projectPath, testInfo, timeoutMs: timeouts.helperMs });
			await enrollRemoteProjectInSidebar(remoteWindow, neighborPath, timeouts);
			await verifyRemoteTerminals({
				window: remoteWindow,
				app: remoteApp,
				credentials: creds,
				projectPath: paths.projectPath,
				neighborPath,
				timeoutMs: timeouts.helperMs,
				testInfo,
				activateAgent: async () => {
					await createRemoteSessionAndReadId(remoteWindow, paths.projectName, timeouts);
					// dev 的空白草稿不再在首键预热 runtime（standby 池在首次发送时才认领），所以「输入首键」
					// 不再是活 Agent 的信号。这里显式走 Tab 菜单「启动 Agent」：既保持「有 live runtime」的验收语义，
					// 也不发 prompt（终端隔离测试不该依赖模型调用）。trust 提示只搭 runtime tab 快照，激活后应可见。
					await openTabsActionMenu(remoteWindow);
					await remoteWindow.getByRole("menuitem", { name: "启动 Agent", exact: true }).click();
					await expect(remoteWindow.getByTestId("remote-session-trust-notice")).toBeVisible({ timeout: timeouts.helperMs });
				},
				stopAgent: async () => {
					await openTabsActionMenu(remoteWindow);
					await remoteWindow.getByRole("menuitem", { name: "关闭 Agent", exact: true }).click();
				},
			});
		} finally {
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await cleanupRemoteRun(creds, paths, "");
		}
	});

	test("远端会话的 trust 提示（远端项目资源未加载）在 runtime 起来后可见", async ({ remoteWindow, remoteUserDataRoot }) => {
		test.setTimeout(1_200_000);
		const creds = credentials;
		if (creds === undefined) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const window = remoteWindow;
		const consoleErrors: string[] = [];
		window.on("console", (message) => {
			if (message.type() === "error" && consoleErrors.length < 20) consoleErrors.push(message.text());
		});
		await dismissOnboarding(window, 8_000);
		const paths = await createRemoteRunPaths(creds);
		let sessionId = "";
		console.log("[p42-acceptance] trust run=" + paths.runId + " host=" + creds.host);
		try {
			await test.step("远端前置：项目目录（唯一命名，结束清理）", async () => {
				await createRemoteProjectDirectory(creds, paths);
			});
			await test.step("设置页加主机 pin → 连接 ready", async () => {
				await addVerifiedRemoteHostAndConnect(window, creds, timeouts, remoteUserDataRoot);
			});
			await test.step("侧栏登记远端项目并新建会话", async () => {
				await enrollRemoteProjectInSidebar(window, paths.projectPath, timeouts);
				sessionId = await createRemoteSessionAndReadId(window, paths.projectName, timeouts);
			});
			await test.step("草稿输入 + 显式启动 Agent → 远端 trust 提示可见", async () => {
				const composer = window.locator(".composer .rich-input");
				await composer.click();
				await window.keyboard.type(PROMPT);
				// dev 的空白草稿不在首键预热 runtime（standby 池在首次发送时认领），而 trust 标记只搭 runtime
				// tab 快照。显式从 Tab 菜单启动 Agent（不发送），保持「runtime 起来后才提示」的原验收语义。
				await openTabsActionMenu(window);
				await window.getByRole("menuitem", { name: "启动 Agent", exact: true }).click();
				const notice = window.getByTestId("remote-session-trust-notice");
				await expect(notice, "远端会话必须如实提示「远端项目资源未加载」").toBeVisible({ timeout: timeouts.helperMs });
				await expect(notice).toContainText(TRUST_TITLE);
				// 此刻**还没发送**：prompt 仍留在输入框里（提示可见不是发送后的错误态凑出来的）。
				await expect(window.locator('.composer[data-session-id="' + sessionId + '"]')).toContainText(PROMPT);
			});
			await test.step("trust 决策落到下一次 spawn 的 args（真机：未决策零 flag → 信任后 --approve）", async () => {
				const argsNow = () => readLatestPlanArgs(remoteUserDataRoot);
				// 提示条 locator 就地取一次：上一个 step 里的同名变量在它自己的块作用域里（不能跨 step 复用）。
				const notice = window.getByTestId("remote-session-trust-notice");
				// 前置：runtime 已经起过一次（args 日志出现），否则下面读到的空串分不清「没起」与「没带 flag」。
				await expect.poll(argsNow, { timeout: timeouts.helperMs, message: "runtime 必须先起来（args 日志出现）" }).toContain("--mode rpc");
				const undecided = await argsNow();
				expect(undecided, "未决策时不得带任何 trust flag（零行为变更）").not.toContain("--approve");
				expect(undecided, "未决策时不得带任何 trust flag（零行为变更）").not.toContain("--no-approve");
				// 用户从提示条点「信任该项目」：决策落盘，**下一次 spawn** 才生效（当前进程不会换参数）。
				await notice.getByRole("button", { name: "信任该项目", exact: true }).click();
				await expect(notice).toContainText("已信任远端项目", { timeout: timeouts.helperMs });
				await openTabsActionMenu(window);
				await expect(window.getByRole("menuitem", { name: "关闭 Agent", exact: true })).toBeVisible({ timeout: timeouts.helperMs });
				await window.getByRole("menuitem", { name: "关闭 Agent", exact: true }).click();
				await openTabsActionMenu(window);
				const startItem = window.getByRole("menuitem", { name: /^(启动 Agent|重启)$/ });
				await expect(startItem).toBeVisible({ timeout: timeouts.helperMs });
				await startItem.click();
				// 判据：新的那条 plan 记录必须带 --approve，且只带一次（禁止重复追加）。
				await expect.poll(argsNow, { timeout: timeouts.helperMs, message: "信任后下一次 spawn 的 args 必须带 --approve" }).toContain("--approve");
				const approved = await argsNow();
				expect(approved.split("--approve").length - 1, "--approve 只允许出现一次").toBe(1);
				expect(approved, "信任时不得同时带 --no-approve").not.toContain("--no-approve");
			});
		} finally {
			if (consoleErrors.length > 0) console.log("[p42-acceptance] renderer console errors:\n" + consoleErrors.join("\n"));
			// runtime 可能仍活着（提示缺失很可能就是预热没走完）：**先按界面入口停掉它**再删夹具目录，
			// 否则会在远端留下一个还在跑的 pi。预热完成前菜单里还没有「关闭 Agent」，所以给几轮窗口。
			let closed = false;
			for (let attempt = 0; attempt < 3 && !closed; attempt += 1) {
				try {
					if (attempt > 0) await window.waitForTimeout(20_000);
					await window.keyboard.press("Escape").catch(() => undefined);
					await openTabsActionMenu(window);
					const closeItem = window.getByRole("menuitem", { name: "关闭 Agent", exact: true });
					await closeItem.waitFor({ state: "visible", timeout: 10_000 });
					await closeItem.click();
					closed = true;
				} catch {
					// 菜单/菜单项还没出现：下一轮再试（此处不掩盖失败结论，只留一条日志）。
				}
			}
			console.log("[p42-acceptance] trust run: agent closed through the UI = " + closed);
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await cleanupRemoteRun(creds, paths, "");
		}
	});
});
