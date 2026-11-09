import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { REMOTE_APP_DATA_DIR_NAME, test } from "./remote-fixtures";

/**
 * 重新绑定（rebind）设置页入口的真机验收（设计附 A 第 5 步的**无破坏性**子集）。
 *
 * 为什么不做真实迁移：一次真实 rebind 会 disable + retire 来源主机，并改写 projects.json /
 * session-catalog.json。那需要一个专属的第二台已验证主机，不是本机验收能安全造出来的状态。
 * 本 spec 只验「用户能到达、能看到正确状态、清理入口真的生效」这三件必须先成立的事：
 *
 * 1. 设置 → 连接里有唯一的重新绑定入口；没有可选目标时按钮禁用并给出原因；
 * 2. 残留的 rebind 事务锁能被诊断出来，并且「执行修复」之后真的消失（P1 的可达出口）；
 * 3. 残留 journal 会出现在横幅里；「继续收敛」失败时报稳定码，不崩、不假装完成。
 *
 * 三个用例都不写 host store、不连远端、不迁移任何记录。
 */
const REBIND_JOURNAL = "remote-host-rebind.json";
const REBIND_LOCK = "remote-host-rebind.lock";

function userDataDir(remoteUserDataRoot: string): string {
	return join(remoteUserDataRoot, REMOTE_APP_DATA_DIR_NAME);
}

async function openConnectionsTab(window: Page) {
	await window.getByRole("button", { name: "设置" }).click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	// 首次打开设置时 tab 列表是异步渲染的：先等 tab 本身出现，再点（否则会点到一个还不存在的节点）。
	const connectionsTab = modal.getByRole("tab", { name: "连接", exact: true });
	await expect(connectionsTab).toBeVisible({ timeout: 15_000 });
	await connectionsTab.click();
	await expect(modal.getByText("重新绑定主机引用")).toBeVisible();
	return modal;
}

test.afterEach(async ({ remoteUserDataRoot }) => {
	for (const name of [REBIND_JOURNAL, REBIND_LOCK]) {
		rmSync(join(userDataDir(remoteUserDataRoot), name), { force: true });
	}
});

test("重新绑定入口：没有可选目标时按钮禁用并说明原因", async ({ remoteWindow, remoteUserDataRoot }) => {
	const modal = await openConnectionsTab(remoteWindow);
	const entry = modal.getByRole("button", { name: "重新绑定", exact: true });
	await expect(entry).toBeVisible();
	// 全新 profile 里没有任何已完成指纹验证的主机：不给一个点不通的入口。
	await expect(entry).toBeDisabled();
	await expect(entry).toHaveAttribute("title", /没有可选目标/);
	await expect(remoteWindow.getByRole("dialog")).toHaveCount(0);
});

test("残留 rebind 锁：诊断给出清理动作，确认后锁文件消失", async ({ remoteWindow, remoteUserDataRoot }) => {
	const lockPath = join(userDataDir(remoteUserDataRoot), REBIND_LOCK);
	writeFileSync(lockPath, "");
	const past = new Date(Date.now() - 120_000);
	utimesSync(lockPath, past, past);

	const modal = await openConnectionsTab(remoteWindow);
	const clear = modal.getByRole("button", { name: "清理残留的重新绑定锁" });
	await expect(clear).toBeVisible({ timeout: 15_000 });
	await clear.click();

	const confirm = remoteWindow.getByRole("dialog").getByRole("button", { name: "执行修复" });
	await expect(confirm).toBeVisible();
	await confirm.click();

	await expect.poll(() => existsSync(lockPath), { timeout: 15_000 }).toBe(false);
});

test("残留 journal：横幅显示未完成事务，继续收敛失败时报稳定码", async ({ remoteWindow, remoteUserDataRoot }) => {
	const journalPath = join(userDataDir(remoteUserDataRoot), REBIND_JOURNAL);
	writeFileSync(
		journalPath,
		JSON.stringify({
			schemaVersion: 1,
			txId: "e2e-rebind-1",
			createdAt: new Date().toISOString(),
			stage: "prepared",
			source: { hostId: "11111111-1111-4111-8111-111111111111", endpointDigest: "", disabled: false },
			target: { hostId: "22222222-2222-4222-8222-222222222222", endpointDigest: "", knownHostsSha256: "" },
			expectedHostRevision: 0,
			records: [],
			referenceScan: { complete: true, count: 0 },
		}),
	);

	const modal = await openConnectionsTab(remoteWindow);
	await expect(modal.getByText(/有未完成的重新绑定/)).toBeVisible({ timeout: 15_000 });
	const resume = modal.getByRole("button", { name: "继续收敛" });
	await expect(resume).toBeVisible();
	await resume.click();

	// 目标主机在这个 profile 里不存在：main 返回 TARGET_MISSING，界面把稳定码原样呈现。
	await expect(modal.getByText(/REMOTE_HOST_REBIND_TARGET_MISSING/)).toBeVisible({ timeout: 20_000 });
});
