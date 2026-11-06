import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * 脏工作区切分支时产品先弹确认条（未提交更改会随切换带过去），干净工作区不打扰。
 * 交互从「点一下就切」变成「点一下 → 需要时确认」，验收跟着走，但断言不变。
 */
async function confirmBranchSwitchIfAsked(panel: Locator): Promise<void> {
	const confirm = panel.getByTestId("remote-git-switch-confirm");
	await confirm.waitFor({ state: "visible", timeout: 1_000 }).catch(() => undefined);
	if ((await confirm.count()) > 0) await confirm.click();
}

/**
 * Only a newly allocated run-owned directory is initialized: a baseline commit, one branch that differs in a
 * tracked file so a real switch has something to change, and an untracked file the user owns.
 */
export async function initializeRemoteGitBranchFixture(credentials: RemoteAcceptanceCredentials, root: string) {
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
			"printf 'BRANCH_BASE\\n' > tracked.txt",
			"printf 'keep me\\n' > keep.txt",
			"git add -- .",
			"git commit -qm baseline",
			"git branch feature",
			"git checkout -q feature",
			"printf 'BRANCH_FEATURE\\n' > tracked.txt",
			"git add -- tracked.txt",
			"git commit -qm 'feature work'",
			"git checkout -q master",
			"printf 'user untracked\\n' > user-note.txt",
		].join("; "),
		30_000,
	);
}

/** The real panel's branch write face: create, switch, refuse a conflicting worktree, and never force anything. */
export async function verifyRemoteGitBranch(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; timeoutMs: number; testInfo: TestInfo }) {
	const { window, credentials, root, timeoutMs, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel");
	const command = async (script: string) => (await runRemoteCommand(credentials, "set -eu; cd " + quote(root) + "; " + script, 60_000)).stdout;
	const git = (script: string) => command("git --no-optional-locks " + script);
	const witness = async () => ({
		refs: await git("for-each-ref --format='%(refname) %(objectname)'"),
		head: (await git("rev-parse HEAD")).trim(),
		branch: (await git("symbolic-ref --short HEAD")).trim(),
		worktree: await command("find . -path './.git' -prune -o -type f -exec sha256sum {} + | sort"),
		index: await command("sha256sum .git/index"),
	});
	/** The refs section is a user-opened view: open it idempotently instead of toggling it shut by accident. */
	const openRefs = async () => {
		const header = panel.getByRole("button", { name: "引用", exact: true });
		if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
		await expect(panel.getByTestId("remote-git-ref-row").first()).toBeVisible({ timeout: timeoutMs });
	};
	const defaultBranch = (await git("symbolic-ref --short HEAD")).trim();
	const featureOid = (await git("rev-parse refs/heads/feature")).trim();
	const baseOid = (await git("rev-parse refs/heads/" + defaultBranch)).trim();
	const featureContent = await git("show refs/heads/feature:tracked.txt");
	const before = await witness();

	await test.step("信任并打开引用区（展开即手动加载）", async () => {
		await remoteProjectRow(window, root.split("/").pop() ?? "")
			.locator(".conversation-title")
			.first()
			.click();
		await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
		await window.getByTestId("drawer-rail-git").click();
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("alert")).toContainText("尚未明确授权", { timeout: timeoutMs });
		await panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true }).click();
		await expect(panel.getByTestId("remote-git-branch")).toContainText(defaultBranch, { timeout: timeoutMs });
		// The current branch is never offered as a switch target, and no destructive control exists at all.
		await openRefs();
		await expect(panel.getByTestId("remote-git-ref-row").filter({ hasText: defaultBranch })).toHaveCount(1, { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-ref-row").filter({ hasText: defaultBranch }).getByTestId("remote-git-switch-branch")).toHaveCount(0);
		await expect(panel.getByTestId("remote-git-ref-row").filter({ hasText: "feature" }).getByTestId("remote-git-switch-branch")).toBeVisible();
		await expect(panel.getByRole("button", { name: /^(丢弃|强制|force|删除分支|重命名)/ })).toHaveCount(0);
	});

	await test.step("新建分支：名字先本地校验，成功后引用列表出现该分支且 HEAD 未动", async () => {
		const name = panel.getByTestId("remote-git-branch-name");
		const create = panel.getByTestId("remote-git-create-branch");
		await expect(create).toBeDisabled();
		// A full ref name and a pseudo-ref are refused by the panel itself, so nothing is sent.
		await name.fill("refs/heads/nope");
		await expect(create).toBeDisabled();
		await name.fill("HEAD");
		await expect(create).toBeDisabled();
		await name.fill("ui-created");
		await expect(create).toBeEnabled();
		await create.click();
		await expect(panel.getByTestId("remote-git-ref-row").filter({ hasText: "ui-created" })).toBeVisible({ timeout: timeoutMs });
		expect((await git("rev-parse refs/heads/ui-created")).trim()).toBe(baseOid);
		expect((await git("symbolic-ref --short HEAD")).trim()).toBe(defaultBranch);
		expect((await git("for-each-ref --format='%(refname)' refs/heads/nope refs/heads/HEAD")).trim()).toBe("");
	});

	await test.step("切换分支：工作区变成目标分支的内容，未跟踪文件保留", async () => {
		await panel.getByTestId("remote-git-ref-row").filter({ hasText: "feature" }).getByTestId("remote-git-switch-branch").click();
		await confirmBranchSwitchIfAsked(panel);
		await expect(panel.getByTestId("remote-git-branch")).toContainText("feature", { timeout: timeoutMs });
		expect((await git("symbolic-ref --short HEAD")).trim()).toBe("feature");
		expect((await git("rev-parse HEAD")).trim()).toBe(featureOid);
		await expect.poll(async () => command("cat tracked.txt"), { timeout: timeoutMs }).toBe(featureContent);
		expect(await command("cat user-note.txt")).toBe("user untracked\n");
		expect(await command("cat keep.txt")).toBe("keep me\n");
	});

	await test.step("工作区冲突：拒绝切换并保留用户改动", async () => {
		// The user edits the same tracked file on both sides, exactly the case git itself refuses.
		await command("printf 'MY DIRTY WORK\\n' > tracked.txt");
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		await expect(panel.getByTestId("remote-git-workingTree")).toContainText("tracked.txt", { timeout: timeoutMs });
		await openRefs();
		await panel.getByTestId("remote-git-ref-row").filter({ hasText: defaultBranch }).getByTestId("remote-git-switch-branch").click();
		await confirmBranchSwitchIfAsked(panel);
		await expect(panel.getByRole("alert")).toContainText("工作区有未提交改动", { timeout: timeoutMs });
		// The refusal drops the panel's facts rather than showing a half-true state; the repository is unchanged.
		expect((await git("symbolic-ref --short HEAD")).trim()).toBe("feature");
		expect(await command("cat tracked.txt")).toBe("MY DIRTY WORK\n");
		await expect(panel.getByTestId("remote-git-branch")).toHaveCount(0);
		await expect(panel.getByTestId("remote-git-ref-row")).toHaveCount(0);
	});

	await test.step("手动刷新后事实重建，仓库只多了那一个分支", async () => {
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		await expect(panel.getByTestId("remote-git-branch")).toContainText("feature", { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-workingTree")).toContainText("tracked.txt", { timeout: timeoutMs });
		const after = await witness();
		expect(after.head).toBe(featureOid);
		expect(after.branch).toBe("feature");
		expect(after.worktree).not.toBe(before.worktree); // the checkout changed the tracked file
		expect(await command("cat tracked.txt")).toBe("MY DIRTY WORK\n");
		const lines = (value: string) => value.trim().split("\n").sort();
		expect(lines(after.refs)).toEqual(
			lines(before.refs)
				.concat("refs/heads/ui-created " + baseOid)
				.sort(),
		);
		expect(await command("find .git -maxdepth 1 -name 'index.lock' -o -maxdepth 1 -name 'pideck-index-*' | wc -l")).toBe("0\n");
	});

	await testInfo.attach("remote-git-branch-oracles", { body: Buffer.from(JSON.stringify({ defaultBranch, baseOid, featureOid, featureContent, before }, null, 2)), contentType: "application/json" });
}
