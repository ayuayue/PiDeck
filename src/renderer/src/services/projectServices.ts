import type { Project } from "../../../shared/types";
import { isRemoteProject } from "../../../shared/projectLocation";
import { createLocalProjectFileService, createRemoteProjectFileService } from "./projectFileService";
import { createLocalProjectGitService, createRemoteProjectGitService } from "./projectGitService";
import { LOCAL_PROJECT_SERVICE_METHODS, REMOTE_PROJECT_SERVICE_METHODS, resolveProjectServiceCapabilities } from "./projectServiceCapabilities";
import { PROJECT_SERVICE_CODES, ProjectServiceError, isProjectServiceCurrent, type ProjectServiceFacts, type ProjectServiceFence, type ProjectServiceFenceSlot, type ProjectServices, type ProjectServicesApi } from "./projectServiceContracts";

export { PROJECT_SERVICE_CODES, ProjectServiceError } from "./projectServiceContracts";
export type { ProjectServiceFacts, ProjectServices } from "./projectServiceContracts";

/** 本机项目事实：本机没有远端连接代，generation 固定，watch/contentSearch 由本机能力决定。 */
export function localProjectServiceFacts(project: Project): ProjectServiceFacts {
	return {
		projectId: project.id,
		locationKind: "local",
		hostState: "local",
		...(project.environment === undefined ? {} : { environment: project.environment }),
		rootStatus: "ok",
		trust: "none",
		generation: "local",
	};
}

/** 远端项目在事实尚未取得时：没有事实就不宣称任何能力（不是“默认 ready”）。 */
export function unprovisionedRemoteProjectServiceFacts(project: Project): ProjectServiceFacts {
	if (!isRemoteProject(project)) throw new ProjectServiceError(PROJECT_SERVICE_CODES.projectMismatch, "rejected", "expected a remote project");
	return {
		projectId: project.id,
		locationKind: "ssh",
		hostId: project.locator.hostId,
		hostState: "disconnected",
		rootStatus: "unknown",
		trust: "unknown",
		generation: "ssh:" + project.locator.hostId + ":unprovisioned",
	};
}

export type CreateProjectServicesInput = {
	/** 事实快照；缺省只对本机项目成立（远端缺省 = 无能力，不猜 ready）。 */
	facts?: ProjectServiceFacts;
	/** runtime 持有的代数槽；缺省按 facts.generation 固定（仅本机/测试用）。 */
	fence?: ProjectServiceFenceSlot;
	/** 只读事实重采集（trust 决策没有推送事件）；缺省 no-op。 */
	refresh?: () => Promise<void>;
};

/**
 * 按项目位置组装面板服务。这是 UI 唯一允许知道“本地/远端”的地方：
 * 组件只消费 ProjectServices，不再自己判断 isRemoteProject 去选通道。
 *
 * projectId 是服务身份的一部分：facts/target 与它不一致时在构造/调用边界拒绝。
 */
export function createProjectServices(project: Project, api: ProjectServicesApi, input: CreateProjectServicesInput = {}): ProjectServices {
	const remote = isRemoteProject(project);
	const facts = input.facts ?? (remote ? unprovisionedRemoteProjectServiceFacts(project) : localProjectServiceFacts(project));
	if (facts.projectId !== project.id) throw new ProjectServiceError(PROJECT_SERVICE_CODES.projectMismatch, "rejected", "facts projectId does not match the project");
	if (remote && facts.locationKind !== "ssh") throw new ProjectServiceError(PROJECT_SERVICE_CODES.projectMismatch, "rejected", "remote project cannot use local facts");
	if (!remote && facts.locationKind !== "local") throw new ProjectServiceError(PROJECT_SERVICE_CODES.projectMismatch, "rejected", "local project cannot use ssh facts");
	if (remote && facts.hostId !== project.locator.hostId) throw new ProjectServiceError(PROJECT_SERVICE_CODES.projectMismatch, "rejected", "facts hostId does not match the project locator");
	const slot = input.fence ?? { current: facts.generation };
	const fence: ProjectServiceFence = { generation: facts.generation, slot };
	const methods = remote ? REMOTE_PROJECT_SERVICE_METHODS : LOCAL_PROJECT_SERVICE_METHODS;
	const capabilities = resolveProjectServiceCapabilities(facts, methods);
	const files = remote ? createRemoteProjectFileService(project.id, api, fence) : createLocalProjectFileService(project.id, api, fence);
	const git = remote ? createRemoteProjectGitService(project.id, api, fence) : createLocalProjectGitService(project.id, api, fence);
	return {
		projectId: project.id,
		kind: remote ? "remote" : "local",
		generation: facts.generation,
		facts,
		files,
		git,
		capabilities,
		isCurrent: () => isProjectServiceCurrent(fence),
		refresh: input.refresh ?? (async () => undefined),
	};
}
