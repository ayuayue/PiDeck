import { expect, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { dismissRemoteConnectionProgress, openRemoteProjectFiles, openSessionRunMenu, remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

/** All terminal interaction goes through xterm's real keyboard entry; SSH only corroborates process identity. */
async function command(window: Page, text: string): Promise<void> {
	const screen = window.locator(".terminal-dock .xterm-screen").first();
	await expect(screen).toBeVisible();
	await screen.click();
	await window.keyboard.type(text);
	await window.keyboard.press("Enter");
}

async function open(window: Page, timeoutMs: number): Promise<void> {
	// 有会话时入口在运行菜单；无会话空态在远端文件面板头部（先点「浏览远端文件」）。
	const runMenu = window.getByRole("button", { name: "更多运行操作" }).first();
	if ((await runMenu.count()) > 0 && (await runMenu.isVisible().catch(() => false))) {
		await openSessionRunMenu(window);
		await window.getByRole("menuitem", { name: "终端", exact: true }).click();
	} else {
		await openRemoteProjectFiles(window);
		await window.getByRole("button", { name: "终端", exact: true }).first().click();
	}
	await expect(window.locator(".terminal-dock")).toBeVisible();
	expect(await window.locator(".terminal-dock").getByTitle("选择 Shell").count(), "SSH target must hide native shells even before its first tab is ready").toBe(0);
	// Fail fast on the actual product error instead of losing its short-lived toast to a four-minute wait.
	const sshTab = window.locator(".terminal-tab-label").filter({ hasText: "SSH" });
	await expect
		.poll(
			async () => {
				const failures = await window.locator('[data-sonner-toast][data-type="error"]').allTextContents();
				if (failures.length) throw new Error("Remote terminal startup UI: " + failures.join(" | "));
				return sshTab.first().isVisible();
			},
			{ timeout: Math.min(timeoutMs, 120_000) },
		)
		.toBe(true);
	await expect(window.locator(".terminal-dock").getByTitle("选择 Shell")).toHaveCount(0);
}

async function pid(window: Page, tag: string): Promise<number> {
	await command(window, `printf '\\n${tag}_PID=%s\\n' "$$"`);
	let value = 0;
	await expect
		.poll(async () => {
			const text = await window.locator(".terminal-dock .xterm-rows").innerText();
			value = Number(new RegExp("(?:^|\\n)" + tag + "_PID=([0-9]+)(?:\\n|$)").exec(text)?.[1]);
			return value;
		})
		.toBeGreaterThan(1);
	return value;
}

/** Two unique fixture projects: cwd/IO isolation, saved code execution, native resize and remote cleanup. */
export async function verifyRemoteTerminals(input: { window: Page; app: ElectronApplication; credentials: RemoteAcceptanceCredentials; projectPath: string; neighborPath: string; timeoutMs: number; testInfo: TestInfo; activateAgent: () => Promise<void>; stopAgent: () => Promise<void> }): Promise<void> {
	const { window, app, credentials, projectPath, neighborPath, timeoutMs, testInfo } = input;
	const projectName = projectPath.split("/").pop() ?? "";
	const neighborName = neighborPath.split("/").pop() ?? "";
	const select = async (name: string) => remoteProjectRow(window, name).locator(".conversation-title").first().click();
	const rows = window.locator(".terminal-dock .xterm-rows");
	// Remote shells are reaped by the host after the PTY closes; under a loaded host that can take longer than the
	// close IPC returns, so wait for the eventual fact (still a hard assertion: the process must be gone).
	const gone = async (id: number) => expect.poll(async () => (await runRemoteCommand(credentials, `if kill -0 ${id} 2>/dev/null; then printf alive; else printf gone; fi`, 20_000)).stdout.trim(), { timeout: 60_000 }).toBe("gone");

	await select(projectName);
	await open(window, timeoutMs);
	await command(window, "printf '\\nPROJECT_CWD=%s\\n' \"$PWD\"; node test.cjs; printf '\\nTEST_RC=%s\\n' \"$?\"");
	await expect(rows).toContainText("PROJECT_CWD=" + projectPath, { timeout: timeoutMs });
	await expect(rows).toContainText("REMOTE_FILE_TEST_OK");
	await expect(rows).toContainText("TEST_RC=0");
	const one = await pid(window, "ONE");
	const readSize = async (tag: string): Promise<string> => {
		await command(window, `set -- $(stty size); printf '\\n${tag}=%sx%s\\n' "$1" "$2"`);
		let value = "";
		await expect
			.poll(async () => {
				value = new RegExp("(?:^|\\n)" + tag + "=([0-9]+x[0-9]+)(?:\\n|$)").exec(await rows.innerText())?.[1] ?? "";
				return value;
			})
			.toMatch(/^[1-9][0-9]*x[1-9][0-9]*$/);
		return value;
	};
	const before = await readSize("SIZE_BEFORE");
	const viewport = window.viewportSize();
	await window.setViewportSize({ width: 1100, height: 820 });
	const after = await readSize("SIZE_AFTER");
	expect(after).not.toBe(before);
	// 恢复到足够大的视口：短视口会把后续 PID/命令输出滚出 xterm 可见区。
	await window.setViewportSize({ width: Math.max(viewport?.width ?? 0, 1500), height: Math.max(viewport?.height ?? 0, 1000) });
	await testInfo.attach("remote-terminal-one", { body: Buffer.from(await rows.innerText()), contentType: "text/plain" });

	await select(neighborName);
	await open(window, timeoutMs);
	await command(window, "printf '\\nNEIGHBOR_CWD=%s\\n' \"$PWD\"; printf '\\nNEIGHBOR_ONLY\\n'");
	await expect(rows).toContainText("NEIGHBOR_CWD=" + neighborPath, { timeout: timeoutMs });
	const two = await pid(window, "TWO");
	expect(two).not.toBe(one);
	await expect(rows).not.toContainText("PROJECT_CWD=" + projectPath);
	await select(projectName);
	// The short xterm viewport legitimately scrolled past the original cwd/PID lines after resize.
	// Prove replay with the old, independently observed PID; then re-prove cwd on the same live shell.
	expect(await pid(window, "BACK")).toBe(one);
	await command(window, "printf '\\nBACK_CWD=%s\\n' \"$PWD\"");
	await expect(rows).toContainText("BACK_CWD=" + projectPath);
	await window.locator(".terminal-tab-close").click();
	await gone(one);
	await open(window, timeoutMs);
	const reopened = await pid(window, "REOPENED");
	expect(reopened).not.toBe(one);
	await input.activateAgent();
	expect(await pid(window, "ACTIVE_AGENT")).toBe(reopened);
	await input.stopAgent();
	// 不靠 xterm 可见区重新解析 PID（停 Agent 后终端高度变化会滚出输出）：直接查远端进程仍是同一个。
	expect((await runRemoteCommand(credentials, "kill -0 " + reopened + " 2>/dev/null && printf alive", 20_000)).stdout.trim()).toBe("alive");
	await expect(window.locator(".terminal-dock")).toBeVisible();

	await dismissRemoteConnectionProgress(window);
	await window.getByRole("button", { name: /^设置/ }).click();
	const modal = window.locator(".settings-modal");
	await modal.getByRole("tab", { name: "连接", exact: true }).click();
	const disconnectedAlready = await modal.getByRole("button", { name: "连接", exact: true }).count();
	if (disconnectedAlready) {
		await modal.getByRole("button", { name: "连接", exact: true }).first().click();
		await expect(modal.getByText("已连接").first()).toBeVisible({ timeout: timeoutMs });
		await dismissRemoteConnectionProgress(window);
	}
	await modal.getByRole("button", { name: "断开", exact: true }).first().click();
	await expect(modal.getByRole("button", { name: "连接", exact: true }).first()).toBeVisible({ timeout: timeoutMs });
	await dismissRemoteConnectionProgress(window);
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(window.locator(".terminal-tab-label")).toContainText("已退出");
	await gone(reopened);
	await gone(two);
	// exact：dock 里还有一个 title="以相同 shell 与目录新建终端" 的重开入口，前缀匹配会撞 strict mode。
	await window.locator(".terminal-dock").getByTitle("新建终端", { exact: true }).click();
	// 断开后新建终端必须明确失败并说明原因（不静默重连、不重放）：产品走全局 notice，文案可能带稳定码
	// （SSH_HOST_DISCONNECTED）或翻译后的远端断开文案；两者都算「用户被告知」，但不能完全无反馈。
	await expect(
		window
			.locator("[data-sonner-toast]")
			.filter({ hasText: /SSH_HOST_DISCONNECTED|SSH_HOST_NOT_READY|远端终端已断开/ })
			.first(),
		"断开后新建终端必须给出明确失败提示",
	).toBeVisible();
	await expect(window.locator(".terminal-tab-label")).toHaveCount(1);
	await window.getByRole("button", { name: /^设置/ }).click();
	await modal.getByRole("tab", { name: "连接", exact: true }).click();
	await modal.getByRole("button", { name: "连接", exact: true }).first().click();
	await expect(modal.getByText("已连接").first()).toBeVisible({ timeout: timeoutMs });
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(window.locator(".terminal-tab-label")).toHaveCount(1); // explicit connection alone never creates/replays a terminal
	// exact：dock 里还有一个 title="以相同 shell 与目录新建终端" 的重开入口，前缀匹配会撞 strict mode。
	await window.locator(".terminal-dock").getByTitle("新建终端", { exact: true }).click();
	await expect(window.locator(".terminal-tab-label")).toHaveCount(2, { timeout: timeoutMs });
	const exiting = await pid(window, "APP_EXIT");
	await app.close();
	await gone(exiting);
	console.log("[remote-terminal-acceptance] cwdAndIoIsolation=true savedCodeTest=true resize=" + before + "->" + after + " closeKillsRemoteShell=true disconnectKillsBoth=true agentLifecyclePreservesProjectTerminal=true noImplicitReconnectOrReplay=true appExitKillsRemoteShell=true");
}
