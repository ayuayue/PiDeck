import { isRemoteProject } from "../../../shared/projectLocation";
import type { HostConnectionStateLike } from "../../../shared/projectCapabilities";
import type { Project } from "../../../shared/types";
import type { RemoteProjectTrustEntry } from "../../../shared/types/remoteTrust";
import type { ProjectServiceFacts, ProjectServiceRootStatus, ProjectServiceTrust, ProjectServicesApi } from "./projectServiceContracts";

/** 不含 generation 的事实输入；generation 由 runtime 按项目/连接代统一分配。 */
export type ProjectServiceFactInput = Omit<ProjectServiceFacts, "generation">;

const HOST_STATES = new Set<HostConnectionStateLike>(["disconnected", "connecting", "probing", "bootstrapping", "ready", "degraded", "reconnecting", "offline", "needs-attention"]);
const CAPABILITY_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * rootStatus 的 renderer 侧收窄：只读 ok/needs-attention 与 hello 能力清单。
 * 读不懂 = unknown（不阻断读面，也不冒充 ok）；能力项非法 = 整份未知，宁缺勿猜。
 */
export function readRootStatusFacts(raw: unknown): { status: ProjectServiceRootStatus; helperCapabilities?: readonly string[] } {
	if (!isRecord(raw)) return { status: "unknown" };
	if (raw.ok === false) return { status: "unknown" };
	const payload: Record<string, unknown> = raw.ok === true && isRecord(raw.value) ? raw.value : raw;
	const capabilities: string[] = [];
	if (Array.isArray(payload.helperCapabilities)) {
		for (const entry of payload.helperCapabilities) {
			if (typeof entry !== "string" || !CAPABILITY_NAME.test(entry)) return { status: "unknown" };
			capabilities.push(entry);
		}
	}
	const helperCapabilities = Array.isArray(payload.helperCapabilities) ? capabilities : undefined;
	if (payload.status === "ok") return { status: "ok", ...(helperCapabilities === undefined ? {} : { helperCapabilities }) };
	if (payload.status === "needs-attention") return { status: "needs-attention", ...(helperCapabilities === undefined ? {} : { helperCapabilities }) };
	return { status: "unknown", ...(helperCapabilities === undefined ? {} : { helperCapabilities }) };
}

/** trust 只取当前 (hostId, canonicalRoot) 的有效决策；缺记录 = none，查询失败 = unknown。 */
function readTrust(entries: readonly RemoteProjectTrustEntry[], hostId: string, canonicalRoot: string): ProjectServiceTrust {
	const matches = entries.filter((entry) => entry.hostId === hostId && entry.canonicalRoot === canonicalRoot);
	if (matches.length === 0) return "none";
	const chosen = matches.find((entry) => entry.status === "active") ?? matches[0];
	if (chosen.status === "stale") return "stale";
	return chosen.decision === "approve" ? "approved" : "denied";
}

function readHostState(list: unknown, hostId: string): HostConnectionStateLike {
	if (!isRecord(list) || list.ok !== true) return "disconnected";
	const states = isRecord(list.states) ? list.states : undefined;
	const value = states?.[hostId];
	return typeof value === "string" && HOST_STATES.has(value as HostConnectionStateLike) ? (value as HostConnectionStateLike) : "disconnected";
}

/**
 * 采集项目事实：只读查询，不建 helper 会话、不改变任何状态。
 * 每个来源独立兜底：某一项失败只让该项保守（disconnected / unknown / none），不伪造 ready。
 */
export async function collectProjectServiceFacts(project: Project, api: ProjectServicesApi): Promise<ProjectServiceFactInput> {
	if (!isRemoteProject(project)) {
		return {
			projectId: project.id,
			locationKind: "local",
			hostState: "local",
			environment: project.environment === "wsl" ? "wsl" : "windows",
			rootStatus: "ok",
			trust: "none",
		};
	}
	const hostId = project.locator.hostId;
	const canonicalRoot = project.locator.remotePath;
	const [hostList, rootStatusRaw, trustList] = await Promise.all([api.remoteHosts.list().catch(() => undefined), api.remoteHosts.rootStatus(project.id).catch(() => undefined), api.remoteTrust.list().catch(() => undefined)]);
	const root = readRootStatusFacts(rootStatusRaw);
	const trust = trustList !== undefined && trustList.ok === true ? readTrust(trustList.value.entries, hostId, canonicalRoot) : "unknown";
	return {
		projectId: project.id,
		locationKind: "ssh",
		hostId,
		hostState: readHostState(hostList, hostId),
		rootStatus: root.status,
		...(root.helperCapabilities === undefined ? {} : { helperCapabilities: root.helperCapabilities }),
		trust,
	};
}
