import { isRemoteProject } from "../../../shared/projectLocation";
import type { Project } from "../../../shared/types";
import type { RemoteHostStateChange, RemoteProjectFactsChange } from "../../../shared/types/remoteHost";
import type { ProjectServiceFactInput } from "./projectServiceFacts";
import { collectProjectServiceFacts } from "./projectServiceFacts";
import { acquireProjectFactSubscription } from "./projectServiceFactSubscription";
import { createProjectServices, localProjectServiceFacts, unprovisionedRemoteProjectServiceFacts } from "./projectServices";
import type { ProjectServiceFacts, ProjectServiceFenceSlot, ProjectServices, ProjectServicesApi } from "./projectServiceContracts";

/**
 * 面板服务 runtime（非 React）：项目事实、连接代与订阅的唯一所有者。
 *
 * 生命周期：
 * - start()：订阅 host 状态与项目事实变化，并做一次只读事实采集；重复 start 幂等；
 * - dispose()：退订全部监听并作废在途采集（迟到结果不再发布）；可被 StrictMode 的再次 start 复用；
 * - 事实/代变化：先更新代数槽，再用新 facts 重新构造 services；旧 services 的 await 结果会抛 GENERATION_STALE。
 *
 * 代数单调：generation = ssh:host:epoch[:mainGeneration]。主进程 facts 事件的 generation 可能晚于
 * 状态事件到达；已退役的 generation 永不重新采纳，避免旧 services 因字符串回退而“复活”。
 */
export type ProjectServiceRuntime = {
	getSnapshot(): ProjectServices;
	subscribe(listener: () => void): () => void;
	start(): () => void;
	refresh(): Promise<void>;
	dispose(): void;
};

function sameFacts(a: ProjectServiceFacts, b: ProjectServiceFacts): boolean {
	return (
		a.projectId === b.projectId &&
		a.locationKind === b.locationKind &&
		a.hostId === b.hostId &&
		a.hostState === b.hostState &&
		a.environment === b.environment &&
		a.rootStatus === b.rootStatus &&
		a.trust === b.trust &&
		a.generation === b.generation &&
		JSON.stringify(a.helperCapabilities ?? null) === JSON.stringify(b.helperCapabilities ?? null)
	);
}

function withoutGeneration(facts: ProjectServiceFacts): ProjectServiceFactInput {
	const { generation: _generation, ...rest } = facts;
	return rest;
}

export function createProjectServiceRuntime(project: Project, api: ProjectServicesApi): ProjectServiceRuntime {
	const remoteProject = isRemoteProject(project) ? project : undefined;
	const hostId = remoteProject?.locator.hostId;
	let facts = remoteProject === undefined ? localProjectServiceFacts(project) : unprovisionedRemoteProjectServiceFacts(project);
	const slot: ProjectServiceFenceSlot = { current: facts.generation };
	let services = createProjectServices(project, api, { facts, fence: slot, refresh });
	let disposed = false;
	let started = false;
	let epoch = 0;
	let mainGeneration: string | undefined;
	const retiredGenerations = new Set<string>();
	let factsRevision = 0;
	let refreshSeq = 0;
	let unsubscribers: Array<() => void> = [];
	const listeners = new Set<() => void>();

	function retire(value: string | undefined): void {
		if (value !== undefined) retiredGenerations.add(value);
	}

	function generation(): string {
		if (remoteProject === undefined) return "local";
		return "ssh:" + String(hostId) + ":" + String(epoch) + ":" + (mainGeneration ?? "local");
	}

	/** 用事实输入重建 services；generation 统一从当前代数派生，旧实例经共享槽位变成 stale。 */
	function rebuild(input: ProjectServiceFactInput): boolean {
		const next: ProjectServiceFacts = { ...input, generation: generation() };
		const changed = !sameFacts(facts, next);
		if (changed) {
			facts = next;
			services = createProjectServices(project, api, { facts, fence: slot, refresh });
		}
		// 代数槽在每轮都对齐最新代：即使 facts 没变，旧实例也必须看到新槽值。
		slot.current = facts.generation;
		if (changed) for (const listener of listeners) listener();
		return changed;
	}

	function handleStateChange(change: RemoteHostStateChange): void {
		if (disposed || change.hostId !== hostId) return;
		factsRevision += 1;
		retire(mainGeneration);
		mainGeneration = undefined;
		epoch += 1;
		rebuild({ ...withoutGeneration(facts), hostState: change.state });
		void refresh();
	}

	function handleFactsChange(change: RemoteProjectFactsChange): void {
		if (disposed || change.projectId !== project.id) return;
		const candidate = typeof change.generation === "string" && change.generation.length > 0 ? change.generation : undefined;
		if (candidate === undefined) {
			// 主进程当时不持有稳定身份：仍按“这个项目有一次失效”换一代，旧结果一律丢弃。
			retire(mainGeneration);
			mainGeneration = undefined;
			epoch += 1;
		} else {
			if (candidate === mainGeneration || retiredGenerations.has(candidate)) return;
			retire(mainGeneration);
			mainGeneration = candidate;
		}
		factsRevision += 1;
		rebuild(withoutGeneration(facts));
	}

	async function refresh(): Promise<void> {
		if (remoteProject === undefined || disposed) return;
		const seq = ++refreshSeq;
		const revision = factsRevision;
		let collected: ProjectServiceFactInput;
		try {
			collected = await collectProjectServiceFacts(project, api);
		} catch {
			return;
		}
		// 采集期间发生状态/代事件：旧事实不得覆盖新状态（main 仍会拒绝，但能力不能谎报可写）。
		if (disposed || seq !== refreshSeq || revision !== factsRevision || collected.projectId !== project.id) return;
		if (facts.hostState !== collected.hostState) {
			retire(mainGeneration);
			mainGeneration = undefined;
			epoch += 1;
		}
		rebuild(collected);
	}

	function dispose(): void {
		disposed = true;
		started = false;
		refreshSeq += 1;
		const pending = unsubscribers;
		unsubscribers = [];
		for (const unsubscribe of pending) unsubscribe();
	}

	function start(): () => void {
		if (started && !disposed) return dispose;
		disposed = false;
		started = true;
		if (remoteProject !== undefined) {
			try {
				unsubscribers.push(acquireProjectFactSubscription(remoteProject, api, { onStateChange: handleStateChange, onFactsChange: handleFactsChange }));
			} catch {
				// 订阅不可用不阻塞只读事实采集；能力仍按 refresh 得到的事实判定。
			}
			void refresh();
		}
		return dispose;
	}

	return {
		getSnapshot: () => services,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		start,
		refresh,
		dispose,
	};
}
