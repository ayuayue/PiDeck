/**
 * `git:remote-watch-refs` / `git:remote-unwatch-refs` 的 IPC 边界。
 *
 * 这里只做三件事，判断都在 `RemoteGitRefWatch` 里：
 * 1. 入参边界（项目身份、仓库 scope、额外参数一律拒绝）——渲染层的入参不可信；
 * 2. 窗口生命周期（sender `destroyed` → 退掉这个窗口的全部订阅）；
 * 3. 把 helper 事件 / 主机断开 / root 退休 / 项目关闭转发给登记表。
 *
 * 返回形状与其它远端 Git 通道一致：`{ ok: true, watchId }` / `{ ok: false, code }`，稳定码不夹文案。
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { codeOf } from "../../shared/op";
import { ipcChannels } from "../../shared/ipc";
import { remoteGitRepoScope, type RemoteGitLocator } from "../git/RemoteGitService";
import type { RemoteFactsHub } from "../remote/RemoteFactsNotifications";
import { createRemoteGitRefWatch, type GitRefWatchHelperEvent, type GitRefWatchService } from "../remote/RemoteGitRefWatch";

export type RemoteGitRefWatchIpcResult = { ok: true; watchId: string } | { ok: false; code: string };
export type RemoteGitRefUnwatchIpcResult = { ok: true } | { ok: false; code: string };

export type RemoteGitRefWatchIpcOptions = {
	enabled: boolean;
	locator(projectId: string): RemoteGitLocator | undefined;
	trusted(target: RemoteGitLocator): Promise<boolean>;
	service(): GitRefWatchService | undefined | Promise<GitRefWatchService | undefined>;
	factsEvents?: Pick<RemoteFactsHub, "publish">;
};

export type RemoteGitRefWatchIpc = {
	onHelperEvent(entry: GitRefWatchHelperEvent): void;
	forgetHost(hostId: string): void;
	forgetSession(hostId: string, sessionKey: string): void;
	pruneClosed(): Promise<void>;
	/** 诊断/测试：当前登记了几个仓库订阅。 */
	size(): number;
	/** 进程退出：清掉 sender 监听并成对退订。 */
	dispose(): Promise<void>;
};

const PROJECT_ID_CONTROL = /[\x00-\x1f\x7f]/;

/** 项目身份判据与 Git 读边界逐字相同：不可信入参先在这里被拒，再谈远端。 */
function projectIdOf(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256 || PROJECT_ID_CONTROL.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}

export function registerRemoteGitRefWatchIpc(input: RemoteGitRefWatchIpcOptions): RemoteGitRefWatchIpc {
	const watch = createRemoteGitRefWatch({
		enabled: input.enabled,
		locator: input.locator,
		trusted: input.trusted,
		service: input.service,
		...(input.factsEvents === undefined ? {} : { factsEvents: input.factsEvents }),
	});
	/** senderId → destroyed 监听：窗口销毁时它名下的订阅必须一起消失，否则登记会留到应用退出。 */
	const senders = new Map<number, { sender: IpcMainInvokeEvent["sender"]; destroy: () => void }>();

	function watchSender(sender: IpcMainInvokeEvent["sender"]): void {
		if (senders.has(sender.id)) return;
		const destroy = () => {
			senders.delete(sender.id);
			// 退订是尽力而为：helper 已死时失败不影响登记已经摘掉。
			void watch.forgetSender(sender.id);
		};
		senders.set(sender.id, { sender, destroy });
		sender.once("destroyed", destroy);
	}

	/** 窗口销毁时立刻退掉它名下的订阅（sender 已销毁则不发请求，只丢登记）。 */
	function releaseSenderNow(sender: IpcMainInvokeEvent["sender"]): void {
		const registered = senders.get(sender.id);
		if (registered !== undefined) {
			sender.removeListener("destroyed", registered.destroy);
			senders.delete(sender.id);
		}
		void watch.forgetSender(sender.id);
	}

	ipcMain.handle(ipcChannels.gitRemoteWatchRefs, async (event, projectId: unknown, repo?: unknown, ...extra: unknown[]): Promise<RemoteGitRefWatchIpcResult> => {
		try {
			// 额外参数不是适配点：多一个入参意味着调用方在猜协议。
			if (extra.length > 0) throw new Error("GIT_RESULT_INVALID");
			const id = projectIdOf(projectId);
			if (!Number.isSafeInteger(event.sender.id) || event.sender.id < 1) throw new Error("GIT_RESULT_INVALID");
			// 已销毁的窗口是「取消」，不是「入参非法」（与 Git 读边界同一判据）。
			if (event.sender.isDestroyed()) throw new Error("REQUEST_CANCELLED");
			const repoPath = remoteGitRepoScope(id, repo);
			const outcome = await watch.watch({ projectId: id, repoPath, senderId: event.sender.id });
			if (!outcome.ok) return outcome;
			// 订阅在途期间窗口销毁：这条登记没有主人，立刻退掉，不把 watchId 交给一个死窗口。
			if (event.sender.isDestroyed()) {
				releaseSenderNow(event.sender);
				return { ok: false, code: "REQUEST_CANCELLED" };
			}
			watchSender(event.sender);
			return outcome;
		} catch (error) {
			return { ok: false, code: codeOf(error, "GIT_REF_WATCH_FAILED") };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteUnwatchRefs, async (event, watchId: unknown, ...extra: unknown[]): Promise<RemoteGitRefUnwatchIpcResult> => {
		try {
			if (extra.length > 0) throw new Error("GIT_RESULT_INVALID");
			// 入参不可信：只接受非空且有界的字符串；未知 watchId 由登记表静默忽略（重复退订安全）。
			if (typeof watchId !== "string" || watchId === "" || watchId.length > 128) throw new Error("GIT_RESULT_INVALID");
			if (!Number.isSafeInteger(event.sender.id) || event.sender.id < 1) throw new Error("GIT_RESULT_INVALID");
			await watch.unwatch(watchId, event.sender.id);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: codeOf(error, "GIT_REF_WATCH_FAILED") };
		}
	});

	return {
		onHelperEvent: (entry) => watch.onHelperEvent(entry),
		forgetHost: (hostId) => watch.forgetHost(hostId),
		forgetSession: (hostId, sessionKey) => watch.forgetSession(hostId, sessionKey),
		pruneClosed: () => watch.pruneClosed(),
		size: () => watch.size(),
		async dispose() {
			for (const { sender, destroy } of senders.values()) sender.removeListener("destroyed", destroy);
			senders.clear();
			await watch.dispose();
		},
	};
}
