/**
 * 目录订阅的保活接线（池化专用端口）。
 *
 * 为什么单独成模块：登记表只认 sessionKey（`RemoteProjectSession.connectionId`），而池的空闲保温按
 * (hostId, canonicalRoot) 记账。把两者的对应关系与 keepAlive 适配器放在登记表旁边，项目域 IPC 就只剩
 * 「读目录 / 标脏」，而「保活必须成对」这条规则也只有一个实现点。
 *
 * keepAlive 端口必须**不抛**：登记表在内部订阅任务里调用它；抛错会让「watch 已登记、保活却丢了」，
 * 于是这条会话在池里变成可回收，监听静默失效。因此这里只做查表 + 一次服务调用，找不到归属就跳过
 * （池化关闭时服务侧本身是空操作）。
 */
import { createDirWatchRegistry, type DirWatchRegistry } from "../remote/RemoteDirWatchRegistry";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";

/** 一条项目会话的归属：它只在自己的 (host, root) 上保温。 */
export type ProjectWatchOwner = { service: RemoteHostConnectionService; hostId: string; root: string };

export type ProjectWatchKeepAlive = {
	/** 登记表本身：事件路由、退订与诊断都经它。 */
	readonly registry: DirWatchRegistry;
	/** 读面拿到 session 时登记归属；此后这条会话的 watcher 才能保温。 */
	noteSession(sessionKey: string, owner: ProjectWatchOwner): void;
	/** 一个 root 会话退休：丢掉这条会话的登记并归还保活（不发退订：helper 已经不在）。 */
	forgetSession(hostId: string, sessionKey: string): void;
	/** 主机断连：丢掉该主机的全部会话登记与归属。 */
	forgetHost(hostId: string): void;
};

export function createProjectWatchKeepAlive(): ProjectWatchKeepAlive {
	/** sessionKey → 归属。登记表只给 connectionId，保温需要 root。 */
	const owners = new Map<string, ProjectWatchOwner>();
	const registry = createDirWatchRegistry({
		keepAlive: {
			retain(sessionKey) {
				const owner = owners.get(sessionKey);
				owner?.service.retainProjectSessionWatch(owner.hostId, owner.root);
			},
			release(sessionKey) {
				const owner = owners.get(sessionKey);
				owner?.service.releaseProjectSessionWatch(owner.hostId, owner.root);
			},
		},
	});
	return {
		registry,
		noteSession(sessionKey, owner) {
			owners.set(sessionKey, owner);
		},
		forgetSession(hostId, sessionKey) {
			// 先清登记再忘归属：clearSession 要用归属去归还保活，顺序反了就漏一次 release。
			registry.clearSession(hostId, sessionKey);
			owners.delete(sessionKey);
		},
		forgetHost(hostId) {
			registry.clearHost(hostId);
			for (const [sessionKey, owner] of owners) if (owner.hostId === hostId) owners.delete(sessionKey);
		},
	};
}
