import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * A bare repository plus a second working copy, both inside this run's own directory: the remote side of the story
 * without any external network or credential. The project's `origin` points at it, and `sync-other` publishes the
 * way a teammate would, so the branch is one commit behind when the panel first reads the repository.
 */
export async function initializeRemoteGitSyncFixture(credentials: RemoteAcceptanceCredentials, root: string, runRoot: string) {
	const origin = runRoot + "/sync-origin.git";
	const other = runRoot + "/sync-other";
	await runRemoteCommand(
		credentials,
		[
			"set -eu",
			"umask 077",
			"mkdir -p " + quote(root),
			"cd " + quote(root),
			"git init -q",
			"git config user.name PiDeck-E2E",
			"git config user.email pideck-e2e@example.invalid",
			"printf 'SYNC_BASE\\n' > tracked.txt",
			"git add -- .",
			"git commit -qm baseline",
			"git init -q --bare " + quote(origin),
			"git remote add origin " + quote(origin),
			"git push -q -u origin HEAD",
			"git clone -q " + quote(origin) + " " + quote(other),
			"cd " + quote(other),
			"git config user.name Teammate",
			"git config user.email teammate@example.invalid",
			"printf 'FROM THE OTHER SIDE\\n' > incoming.txt",
			"git add -- .",
			"git commit -qm 'teammate commit'",
			"git push -q origin HEAD",
		].join("; "),
		60_000,
	);
	return { origin, other };
}

/** The real panel's sync bar against a run-owned remote: fetch, pull, a refusal, and a push behind a confirmation. */
export async function verifyRemoteGitSync(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; origin: string; other: string; timeoutMs: number; testInfo: TestInfo }) {
	const { window, credentials, root, origin, other, timeoutMs, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel");
	const command = async (script: string) => (await runRemoteCommand(credentials, "set -eu; cd " + quote(root) + "; " + script, 60_000)).stdout;
	const git = (script: string) => command("git --no-optional-locks " + script);
	const facts = panel.getByTestId("remote-git-sync-facts");
	const message = panel.getByTestId("remote-git-sync-message");
	const fetchButton = panel.getByTestId("remote-git-sync-fetch");
	const pushButton = panel.getByTestId("remote-git-sync-push");
	const pullButton = panel.getByTestId("remote-git-sync-pull");
	const remoteHead = async () => (await runRemoteCommand(credentials, "set -eu; git --no-optional-locks --git-dir=" + quote(origin) + " rev-parse HEAD", 60_000)).stdout.trim();
	/**
	 * The panel's buttons are enabled only once a snapshot has handed out that verb's grant, which happens after a
	 * repository read. Waiting for the button is therefore the sequencing this flow needs: a click can never race
	 * the read that would have authorized it.
	 */
	const refresh = async () => {
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		// 干净态改成与本机同一套文案后，按 testid 判「已结算」比按文字更稳（文案会随产品统一而变）。
		await expect(panel.getByTestId("remote-git-workingTree").or(panel.getByTestId("remote-git-clean")))
			.toBeVisible({ timeout: timeoutMs })
			.catch(async (error: unknown) => {
				const text = await panel.innerText();
				throw new Error(`the refresh did not settle; panel text: ${JSON.stringify(text.slice(0, 300))} (${String(error).split("\n")[0]})`);
			});
		await expect(fetchButton)
			.toBeEnabled({ timeout: timeoutMs })
			.catch(async (error: unknown) => {
				const text = await panel.innerText();
				throw new Error(`no fetch grant after the refresh; panel text: ${JSON.stringify(text.slice(0, 300))} (${String(error).split("\n")[0]})`);
			});
	};

	await test.step("同步条显示分支与上游全名，且从不显示远端路径", async () => {
		await remoteProjectRow(window, root.split("/").pop() ?? "")
			.locator(".conversation-title")
			.first()
			.click();
		await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
		await window.getByTestId("drawer-rail-git").click();
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("alert")).toContainText("尚未明确授权", { timeout: timeoutMs });
		await panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true }).click();
		await expect(facts).toContainText("refs/remotes/origin/", { timeout: timeoutMs });
		await expect(facts).not.toContainText("/sync-origin.git");
		// The counts compare against the remote-tracking ref, which only a fetch moves: nothing here goes to the network.
		await expect(facts).not.toContainText("落后");
		await expect(fetchButton).toBeEnabled({ timeout: timeoutMs });
		await expect(panel.getByRole("button", { name: /^(强制|--force|--set-upstream)/ })).toHaveCount(0);
	});

	await test.step("获取只更新远端跟踪引用：工作区与 HEAD 不动", async () => {
		const headBefore = (await git("rev-parse HEAD")).trim();
		await fetchButton.click();
		await expect(message).toContainText("已获取", { timeout: timeoutMs });
		await expect(facts).toContainText("落后 1", { timeout: timeoutMs });
		const branch = (await git("symbolic-ref --short HEAD")).trim();
		expect((await git("rev-parse refs/remotes/origin/" + branch)).trim()).toBe(await remoteHead());
		expect((await git("rev-parse HEAD")).trim()).toBe(headBefore);
		expect(await command("test -e incoming.txt && echo present || echo absent")).toBe("absent\n");
	});

	await test.step("拉取把远端提交快进到工作区", async () => {
		await expect(pullButton).toBeEnabled({ timeout: timeoutMs });
		await pullButton.click();
		// 同步文案只陈述已确认的完成事实（已获取/已推送/已拉取），不再报快进/合并等细节
		// （见 RemoteGitPanel.syncNoticeText 上的决策注释）；快进这个「效果」由下面两条断言证明。
		await expect(message).toContainText("已拉取", { timeout: timeoutMs });
		expect(await command("cat incoming.txt")).toBe("FROM THE OTHER SIDE\n");
		expect((await git("rev-parse HEAD")).trim()).toBe(await remoteHead());
	});

	await test.step("有已跟踪改动时拉取被拒绝，工作区不动", async () => {
		await command("printf 'MY WORK\\n' > tracked.txt");
		// The refresh confirms the dirty state, so the refusal can only come from the helper's own precondition.
		await refresh();
		await expect(panel.getByTestId("remote-git-workingTree")).toContainText("tracked.txt", { timeout: timeoutMs });
		await expect(pullButton).toBeEnabled({ timeout: timeoutMs });
		await pullButton.click();
		await expect(panel.getByRole("alert")).toContainText("需要干净的工作区", { timeout: timeoutMs });
		expect(await command("cat tracked.txt")).toBe("MY WORK\n");
		await command("git checkout -- tracked.txt");
	});

	await test.step("推送需要确认：取消不动远端，确认后远端引用前进", async () => {
		await command("printf 'LOCAL COMMIT\\n' > local.txt && git add -- local.txt && git -c user.name=PiDeck-E2E -c user.email=pideck-e2e@example.invalid commit -qm 'local commit'");
		await refresh();
		const localHead = (await git("rev-parse HEAD")).trim();
		expect(await remoteHead()).not.toBe(localHead);
		await expect(pushButton).toBeEnabled({ timeout: timeoutMs });
		await pushButton.click();
		await expect(panel.getByTestId("remote-git-sync-push-confirm-bar")).toBeVisible({ timeout: timeoutMs });
		await panel.getByTestId("remote-git-sync-push-cancel").click();
		await expect(panel.getByTestId("remote-git-sync-push-confirm-bar")).toHaveCount(0);
		expect(await remoteHead(), "a cancelled push must not move the remote").not.toBe(localHead);
		await pushButton.click();
		await panel.getByTestId("remote-git-sync-push-confirm").click();
		await expect(message).toContainText("已推送", { timeout: timeoutMs });
		await expect.poll(remoteHead, { timeout: timeoutMs }).toBe(localHead);
		// The push moved the remote and the remote-tracking ref; local history and the worktree are untouched.
		expect(await command("cat local.txt")).toBe("LOCAL COMMIT\n");
		expect(await command("find .git -maxdepth 1 -name 'index.lock' -o -maxdepth 1 -name 'pideck-index-*' | wc -l")).toBe("0\n");
	});

	await test.step("分叉且仓库自己配置了合并策略：拉取留下冲突并如实报码", async () => {
		// The strategy is the repository's own setting, written natively here: the helper never picks one.
		await command("git config pull.rebase false");
		await command("printf 'LOCAL SIDE\\n' > tracked.txt && git add -- tracked.txt && git -c user.name=PiDeck-E2E -c user.email=pideck-e2e@example.invalid commit -qm 'local side'");
		await runRemoteCommand(
			credentials,
			[
				"set -eu",
				"cd " + quote(other),
				"git fetch -q origin",
				"git reset -q --hard origin/" + "$(git symbolic-ref --short HEAD)",
				"printf 'REMOTE SIDE\\n' > tracked.txt",
				"git add -- tracked.txt",
				"git -c user.name=Teammate -c user.email=teammate@example.invalid commit -qm 'remote side'",
				"git push -q origin HEAD",
			].join("; "),
			30_000,
		);
		await refresh();
		await expect(pullButton).toBeEnabled({ timeout: timeoutMs });
		await pullButton.click();
		// A conflicted pull is reported, and the repository is deliberately left in that state for the user.
		await expect(panel.getByRole("alert")).toContainText("冲突", { timeout: timeoutMs });
		expect(await command("test -e .git/MERGE_HEAD && echo merging || echo clean")).toBe("merging\n");
		expect(await command("git status --porcelain=v1 --untracked-files=no")).toContain("UU tracked.txt");
		// Only the test's own fixture is cleaned up; the product never aborts a merge on its own.
		await command("git merge --abort");
	});

	await testInfo.attach("remote-git-sync-oracles", { body: Buffer.from(JSON.stringify({ head: await git("rev-parse HEAD"), remote: await remoteHead() }, null, 2)), contentType: "application/json" });
}
