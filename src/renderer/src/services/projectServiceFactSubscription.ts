import type { RemoteProject } from "../../../shared/types/project";
import type { RemoteHostStateChange, RemoteProjectFactsChange } from "../../../shared/types/remoteHost";
import type { ProjectServicesApi } from "./projectServiceContracts";

/**
 * 项目事实订阅的引用计数（同一 (api, project, host, root) 只向 preload 订阅一次）。
 *
 * 为什么需要：preload 的 onProjectFactsChanged 每次调用都会向 main subscribe、退订时直接 unsubscribe；
 * 同一窗口里文件抽屉与 Git 面板各持一个 runtime 时，先卸载的一方会退掉另一方的订阅。
 * 这里在 renderer 侧按项目身份共享订阅，最后一个消费者释放时才真正退订。
 *
 * 注意：这只修 service 内部的多消费者；其他直接调用 preload 的 hooks 仍应走同一个共享入口（交 I/P 决定）。
 */
export type ProjectFactHandlers = {
	onStateChange(change: RemoteHostStateChange): void;
	onFactsChange(change: RemoteProjectFactsChange): void;
};

type SubscriptionEntry = {
	refs: number;
	handlers: Set<ProjectFactHandlers>;
	stop: () => void;
};

const registries = new WeakMap<ProjectServicesApi, Map<string, SubscriptionEntry>>();

function registryFor(api: ProjectServicesApi): Map<string, SubscriptionEntry> {
	const existing = registries.get(api);
	if (existing !== undefined) return existing;
	const created = new Map<string, SubscriptionEntry>();
	registries.set(api, created);
	return created;
}

function subscriptionKey(project: RemoteProject): string {
	return [project.id, project.locator.hostId, project.locator.remotePath].join("\u0000");
}

/** 订阅该项目的 host 状态与事实变化；返回幂等的 release。 */
export function acquireProjectFactSubscription(project: RemoteProject, api: ProjectServicesApi, handlers: ProjectFactHandlers): () => void {
	const registry = registryFor(api);
	const key = subscriptionKey(project);
	const existing = registry.get(key);
	if (existing !== undefined) {
		existing.refs += 1;
		existing.handlers.add(handlers);
		return makeRelease(registry, key, existing, handlers);
	}
	const entry: SubscriptionEntry = { refs: 1, handlers: new Set([handlers]), stop: () => undefined };
	let stopState: (() => void) | undefined;
	let stopFacts: (() => void) | undefined;
	try {
		stopState = api.remoteHosts.onStateChange((change) => {
			for (const handler of entry.handlers) handler.onStateChange(change);
		});
		stopFacts = api.remoteHosts.onProjectFactsChanged(project.id, (change) => {
			for (const handler of entry.handlers) handler.onFactsChange(change);
		});
		entry.stop = () => {
			stopState?.();
			stopFacts?.();
		};
	} catch (error) {
		// 第二个订阅抛错时，第一个已经建立，必须显式收回，不能只靠初值 no-op。
		stopState?.();
		stopFacts?.();
		throw error;
	}
	registry.set(key, entry);
	return makeRelease(registry, key, entry, handlers);
}

function makeRelease(registry: Map<string, SubscriptionEntry>, key: string, entry: SubscriptionEntry, handlers: ProjectFactHandlers): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		entry.refs -= 1;
		entry.handlers.delete(handlers);
		if (entry.refs > 0) return;
		entry.stop();
		registry.delete(key);
	};
}
