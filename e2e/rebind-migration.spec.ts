import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { REMOTE_APP_DATA_DIR_NAME, readPinnedHostKeyFingerprint, runRemoteCommand, test, type RemoteAcceptanceCredentials } from "./remote-fixtures";

/**
 * 真实 rebind 迁移验收（隔离 profile · 同一测试机的两个主机条目）。
 *
 * 为什么两个条目：真实 rebind 会 disable + retire 来源主机并改写 projects/session 记录，必须有一台
 * 已验证 target。测试 profile 的 host store / projects.json / session-catalog.json 全部隔离在
 * `--user-data-dir` 里，所以「同一台物理机的两个条目」不会碰用户的真实数据。
 *
 * 断言以**落盘文件**为准（不只看返回值）：
 * 1. projects.json 里该项目 locator 的 hostId 变成 target；
 * 2. remote-hosts.json 里 source 进入 retiredHostIds，profiles 不再包含 source；
 * 3. 返回值是 COMMITTED，migratedProjects >= 1。
 */
const REBIND_TEST_PATH = "/tmp/pideck-rebind-e2e";

function profileDir(userDataRoot: string): string {
	return join(userDataRoot, REMOTE_APP_DATA_DIR_NAME);
}

function readJson<T>(path: string): T | undefined {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

/**
 * 用真实 ~/.ssh/config 别名添加两台主机条目（IPC 一步完成：createDraft → offerPin → confirmPin）。
 *
 * 为什么不走 UI 候选：AddHostDialog 会把已添加的主机从候选里去掉，同一台机的第二个条目在 UI 上
 * 不可达；而 `remote:add` 本身没有重复校验，两个条目是两个独立 hostId、各自 pin。别名来自用户的
 * ssh config（测试宿主的既有约定），因此不硬编码 IP 对应的私钥路径。
 */
function sshConfigAliasFor(host: string): string | undefined {
	const configPath = join(homedir(), ".ssh", "config");
	if (!existsSync(configPath)) return undefined;
	for (const block of readFileSync(configPath, "utf8")
		.split(/^Host\s+/m)
		.slice(1)) {
		const [aliasLine, ...lines] = block.split("\n");
		const hostName = lines
			.find((line) => /^\s*HostName\s+/i.test(line))
			?.trim()
			.split(/\s+/)[1];
		if (hostName === host) return aliasLine.trim().split(/\s+/)[0];
	}
	return undefined;
}

async function addHostViaIpc(window: Page, credentials: RemoteAcceptanceCredentials, label: string): Promise<string> {
	const alias = sshConfigAliasFor(credentials.host);
	const result = await window.evaluate(
		async ({ hostName, user, label: name }) => {
			const api = (window as unknown as { piDesktop: any }).piDesktop;
			return api.remoteHosts.add({ label: name, hostName, user });
		},
		{ hostName: alias ?? credentials.host, user: alias === undefined ? credentials.user : undefined, label },
	);
	expect(result?.ok, JSON.stringify(result)).toBe(true);
	return String(result.value?.hostId ?? result.hostId);
}

test.describe("rebind 真实迁移（隔离 profile）", () => {
	test("两个条目互迁：记录 hostId 改写、来源退役、目标保留", async ({ remoteWindow, remoteUserDataRoot, remoteCredentials }) => {
		// 远端目录必须先存在（enroll 会 canonical 化校验）。
		await runRemoteCommand(remoteCredentials, `mkdir -p ${REBIND_TEST_PATH}`, 30_000);

		const sourceHostId = await addHostViaIpc(remoteWindow, remoteCredentials, "e2e-rebind-src");
		const targetHostId = await addHostViaIpc(remoteWindow, remoteCredentials, "e2e-rebind-dst");

		const result = await remoteWindow.evaluate(
			async ({ path, sourceId, targetId }) => {
				const api = (window as unknown as { piDesktop: any }).piDesktop;
				const list = await api.remoteHosts.list();
				if (!list.ok) return { stage: "list", list };
				const hosts = (list.hosts as Array<{ id: string; verified: boolean; disabled: boolean }>).filter((host) => host.verified && !host.disabled);
				const src = hosts.find((host) => host.id === sourceId);
				const dst = hosts.find((host) => host.id === targetId);
				if (src === undefined || dst === undefined) return { stage: "need-two", hosts, sourceId, targetId };
				// 登记一个远端项目（两步确认：enroll → 推送 requestId → answer）。
				const confirm = new Promise<any>((resolve) => api.remoteHosts.onProjectEnrollConfirm((request: any) => resolve(request)));
				const enroll = await api.remoteHosts.enrollProject(src.id, path);
				if (!enroll.ok) return { stage: "enroll", enroll };
				const request = await confirm;
				const answered = await api.remoteHosts.answerProjectEnroll(request.requestId, "approve");
				if (!answered.ok || answered.value.enrolled !== true) return { stage: "enroll-answer", answered };
				const plan = await api.remoteHosts.planRebind(src.id, dst.id);
				if (!plan.ok) return { stage: "plan", plan, src: src.id, dst: dst.id };
				const run = await api.remoteHosts.answerRebind(plan.requestId, "approve");
				return { stage: "done", src: src.id, dst: dst.id, projectId: answered.value.projectId, plan, run, hosts: list.hosts };
			},
			{ path: REBIND_TEST_PATH, sourceId: sourceHostId, targetId: targetHostId },
		);

		expect(result.stage, JSON.stringify(result)).toBe("done");
		expect(result.run.ok, JSON.stringify(result.run)).toBe(true);
		expect(result.run.ran, JSON.stringify(result.run)).toBe(true);
		expect(result.run.outcome.code, JSON.stringify(result.run.outcome)).toBe("REMOTE_HOST_REBIND_COMMITTED");
		expect(result.run.outcome.migratedProjects).toBeGreaterThanOrEqual(1);

		// 1) 项目记录已指向 target。
		const projects = readJson<{ schemaVersion?: number; projects?: Array<{ id: string; locator?: { kind?: string; hostId?: string } }> }>(join(profileDir(remoteUserDataRoot), "projects.json"));
		expect(projects, "projects.json 必须存在").toBeTruthy();
		const migrated = (projects?.projects ?? []).find((project) => project.id === result.projectId);
		expect(migrated, "迁移的项目必须仍在 projects.json").toBeTruthy();
		expect(migrated?.locator?.kind).toBe("ssh");
		expect(migrated?.locator?.hostId).toBe(result.dst);

		// 2) 来源已被退役，目标仍在。
		const hostStore = readJson<{ profiles?: Array<{ id: string }>; retiredHostIds?: string[] }>(join(profileDir(remoteUserDataRoot), "remote-hosts.json"));
		expect(hostStore, "remote-hosts.json 必须存在").toBeTruthy();
		expect(hostStore?.retiredHostIds ?? []).toContain(result.src);
		expect((hostStore?.profiles ?? []).map((host) => host.id)).not.toContain(result.src);
		expect((hostStore?.profiles ?? []).map((host) => host.id)).toContain(result.dst);
	});
});
