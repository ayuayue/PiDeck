import { expect, type Locator, type Page } from "@playwright/test";
import type { PiDesktopApi } from "../src/preload";
import { REMOTE_ACCEPTANCE_ENV, readRemoteAcceptanceCredentials, readRemoteAcceptanceTimeouts, runRemoteCommand, test } from "./remote-fixtures";
import { addAndConnectHost, dismissOnboarding, enrollRemoteProject, openProjectPanel, q, remote, removeProject } from "./remote-sftp-helpers";

/**
 * 远端文件树「目录页 Git ignore 修饰」的真机验收（T6 收尾的可见效果）。
 *
 * 断言对象是**用户看到的那一行**：项目根里被 `.gitignore` 命中的条目（目录与文件各一条）在远端文件树里
 * 置灰，同目录未命中的条目照常全亮。判定依据分两段，互不替代：
 * 1) 后端契约：`files.directoryPage` 只给命中的条目标 `ignored: true`（字段缺失＝没判定，不能填 false 冒充）；
 * 2) 渲染结果：`.file-node-name` 带 `opacity-60` **且** computed opacity < 1（文件行与目录行在
 *    FileTreeRows 里是两处独立代码，所以两条都断言）。
 * 另有 SSH 侧 `git check-ignore` 作第三方口径对照——那是产品之外的事实，不是产品自证。
 *
 * 两个前置不写下来就会被当成产品缺陷：
 * - 项目必须是**已信任**的远端项目：目录页的 ignore 判定走 git 读边界（`GIT_TRUST_REQUIRED`），未授权时
 *   产品按契约「不修饰」。本用例先用 `remoteTrust.set` 记一条 approve 决策（与设置页/Git 面板同一落盘点）。
 * - 远端 helper 必须声明 `git.checkIgnore`（当前 helper 已声明），否则修饰按能力门控整页省略。
 *
 * 若「后端契约」通过而「渲染结果」不通过：先查远端树自己的条目映射有没有把 `entry.ignored` 传给
 * `FileTreeNode`（远端面板用的不是本机那份 `directoryPageNode`）。那是渲染链路的缺口，不是后端没判定。
 *
 * 隔离：远端只建本 run 独有的临时目录（`~/.pideck-e2e-<runId>/file-ignore`），结束时整目录 rm -rf；
 * userData 由 `remote-fixtures.remoteApp` 的临时 profile 承担；凭据只来自环境变量，缺失即整个 describe skip。
 */
const credentials = readRemoteAcceptanceCredentials(process.env);
const timeouts = readRemoteAcceptanceTimeouts(process.env);
const HELP_TEXT = "set " + [REMOTE_ACCEPTANCE_ENV.host, REMOTE_ACCEPTANCE_ENV.user, REMOTE_ACCEPTANCE_ENV.fingerprint].join(" / ") + " to run the real-host acceptance test";

/** 根层某一条目的名字元素（行是 `.file-node`，名字是 `.file-node-name`，与 remote-file-management 同款锚点）。 */
function entryName(window: Page, name: string): Locator {
	const exactName = new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
	return window
		.locator(".file-node")
		.filter({ has: window.locator(".file-node-name", { hasText: exactName }) })
		.last()
		.locator(".file-node-name");
}

/** 被忽略的条目：行名带 `opacity-60`，且这个 class 真的生效（computed opacity < 1）。 */
async function expectIgnoredGrey(window: Page, name: string): Promise<void> {
	const label = entryName(window, name);
	await expect(label, name + " 行必须出现在根层").toBeVisible({ timeout: timeouts.helperMs });
	await expect(label, name + " 被 .gitignore 命中：行名必须带 opacity-60（FileTreeRows 的 ignored 修饰）").toHaveClass(/opacity-60/);
	const opacity = Number(await label.evaluate((element) => getComputedStyle(element).opacity));
	expect(opacity, name + " 的 computed opacity 必须 < 1（class 要真的生效，而不只是出现在 markup 里）").toBeLessThan(1);
}

/** 未忽略的条目：不带修饰 class，computed opacity 保持 1。 */
async function expectNotGrey(window: Page, name: string): Promise<void> {
	const label = entryName(window, name);
	await expect(label, name + " 行必须出现在根层").toBeVisible({ timeout: timeouts.helperMs });
	await expect(label, name + " 未被忽略：行名不得带 opacity-60").not.toHaveClass(/opacity-60/);
	const opacity = Number(await label.evaluate((element) => getComputedStyle(element).opacity));
	expect(opacity, name + " 未被忽略：computed opacity 必须保持 1").toBe(1);
}

test.describe("远端文件树 Git ignore 修饰（真机）", () => {
	test.skip(credentials === undefined, HELP_TEXT);

	test("远端项目根：被 .gitignore 忽略的目录与文件行名置灰（opacity-60），同目录未忽略文件保持全亮", async ({ remoteWindow }, testInfo) => {
		test.setTimeout(600_000);
		const creds = credentials;
		if (creds === undefined) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const window = remoteWindow;
		const runId = "ignore-" + Date.now().toString(36);
		const home = await remote(creds, 'printf %s "$HOME"', 30_000);
		expect(home.startsWith("/"), "远端 $HOME 必须是绝对 POSIX 路径").toBe(true);
		expect(/\s/.test(home), "远端 $HOME 含空白：夹具与清理脚本按既有风格不做引用，先在这里拒绝").toBe(false);
		const e2eRoot = home + "/.pideck-e2e-" + runId;
		const projectPath = e2eRoot + "/file-ignore";
		let hostId: string | undefined;
		let projectId: string | undefined;

		try {
			await test.step("远端前置：本 run 独有目录里一个 .gitignore 仓库（忽略目录 + 忽略文件 + 对照文件）", async () => {
				await remote(
					creds,
					[
						"set -eu",
						"umask 077",
						"mkdir -p " + q(projectPath + "/ignored-dir"),
						"cd " + q(projectPath),
						"git init -q",
						"git config user.name PiDeck-E2E",
						"git config user.email pideck-e2e@example.invalid",
						"printf 'ignored-dir/\\nignored.log\\n' > .gitignore",
						"printf 'ignored child\\n' > ignored-dir/x.txt",
						"printf 'ignored log\\n' > ignored.log",
						"printf 'visible\\n' > visible.txt",
						"git add -- .gitignore visible.txt",
						"git commit -qm baseline",
					].join("; "),
					60_000,
				);
				// 第三方口径对照：SSH 侧 git 自己说这两条被忽略、对照文件不被忽略（产品之外的事实）。
				const ignoredByGit = (await remote(creds, "cd " + q(projectPath) + " && git check-ignore --no-index -- ignored-dir ignored.log | sort", 60_000)).split("\n").filter(Boolean);
				expect(ignoredByGit, "SSH 侧 git check-ignore 必须判定这两条被忽略").toEqual(["ignored-dir", "ignored.log"]);
				const visibleByGit = await remote(creds, "cd " + q(projectPath) + " && git check-ignore --no-index -- visible.txt .gitignore || true", 60_000);
				expect(visibleByGit, "对照：visible.txt 与 .gitignore 都不被忽略（否则后面的「不置灰」是空断言）").toBe("");
				await testInfo.attach("remote-file-ignore-ssh-oracle", { body: Buffer.from(JSON.stringify({ projectPath, ignoredByGit, visibleByGit }, null, 2)), contentType: "application/json" });
			});

			await test.step("加主机并连接（产品 IPC）→ 落一条 approve 决策（目录页 ignore 判定走 trust 边界）", async () => {
				await dismissOnboarding(window);
				hostId = await addAndConnectHost(window, creds);
				if (hostId === undefined) throw new Error("hostId missing after add+connect");
				const trust = (await window.evaluate(async (input) => (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.remoteTrust.set(input), { hostId, remoteRoot: projectPath, decision: "approve" as const })) as { ok: boolean; code?: string };
				expect(trust.ok, "approve 决策必须落盘: " + String(trust.code)).toBe(true);
			});

			await test.step("登记为远端项目（产品登记链路 + canonical 确认）", async () => {
				if (hostId === undefined) throw new Error("hostId missing before enrollment");
				projectId = await enrollRemoteProject(window, hostId, projectPath);
				// 直接走 IPC 登记不会刷新渲染层的项目清单；重载一次让侧栏消费主进程已落盘的项目
				// （与 remote-sftp-transfer 的同一处理，不新增通道）。
				await window.reload({ waitUntil: "domcontentloaded" });
				await window
					.locator("#boot-overlay")
					.waitFor({ state: "detached", timeout: 30_000 })
					.catch(() => undefined);
				await dismissOnboarding(window);
			});

			await test.step("后端契约：目录页只给命中的两条标 ignored:true，未命中条目不带该字段", async () => {
				if (projectId === undefined) throw new Error("projectId missing before the directory page probe");
				const page = (await window.evaluate(async (id) => (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.files.directoryPage({ projectId: id, relativePath: "" }), projectId)) as {
					ok: boolean;
					code?: string;
					value?: { entries?: Array<{ relativePath: string; ignored?: boolean }> };
				};
				expect(page.ok, "根目录页必须成功: " + String(page.code)).toBe(true);
				const entries = page.value?.entries ?? [];
				const names = new Set(entries.map((entry) => entry.relativePath));
				for (const name of [".gitignore", "ignored-dir", "ignored.log", "visible.txt"]) expect(names.has(name), name + " 必须在目录页里（否则对应的行断言是空断言）").toBe(true);
				const flagged = entries
					.filter((entry) => entry.ignored === true)
					.map((entry) => entry.relativePath)
					.sort();
				expect(flagged, "只允许被 .gitignore 命中的两条带 ignored（字段缺失＝没判定，false 不算）").toEqual(["ignored-dir", "ignored.log"]);
				await testInfo.attach("remote-file-ignore-directory-page", { body: Buffer.from(JSON.stringify(entries, null, 2)), contentType: "application/json" });
			});

			await test.step("UI：打开远端文件树 → 忽略条目行名置灰，未忽略文件保持全亮", async () => {
				if (projectId === undefined) throw new Error("projectId missing before opening the file tree");
				await openProjectPanel(window, projectId, timeouts.helperMs);
				// 目录行与文件行是 FileTreeRows 里两处独立的修饰点，各断言一条。
				await expectIgnoredGrey(window, "ignored-dir");
				await expectIgnoredGrey(window, "ignored.log");
				await expectNotGrey(window, "visible.txt");
			});
		} finally {
			try {
				if (projectId !== undefined) await removeProject(window, projectId);
			} catch {
				// 渲染层可能已在收尾阶段关闭；隔离 profile 保证没有残留引用。
			}
			if (hostId !== undefined) {
				try {
					await window.evaluate(async (id) => (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.remoteHosts.remove(id), hostId);
				} catch {
					// 收尾尽力而为，绝不用清理失败掩盖上面的断言结果。
				}
			}
			// 只删本 run 的临时目录：先用 realpath 自证路径就是它，再删并确认不存在。
			await runRemoteCommand(creds, ["set -eu", "target=$(realpath -m " + q(e2eRoot) + ")", 'test "$target" = ' + q(e2eRoot), 'rm -rf -- "$target"', 'test ! -e "$target"'].join("; "), 60_000);
		}
	});
});
