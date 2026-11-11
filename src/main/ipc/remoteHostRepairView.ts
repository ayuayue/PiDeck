/**
 * 远主机「修复诊断」的视图整形（从 remoteHostIpc.ts 拆出）。
 *
 * 为什么单独一个文件：remoteHostIpc 触到了 600 行红线，而这三块（三个白名单常量 +
 * 两个投影函数）都是纯数据整形，跟 IPC 装配无关；并且 repairSummary 与 findingFrom
 * 本来是同一段白名单逻辑写了两遍，放一起才看得出可以共用一个 hostIds 过滤。
 *
 * 契约不变：只放行稳定码与合法 id，repair 命令、pin 路径、信任元数据一律不进渲染层。
 */

import type { RemoteHostRepairFinding, RemoteHostRepairSummary } from "../../shared/types/remoteHost";
import type { RemoteHostCatalogView } from "../remote/RemoteHostCatalogView";
import { HOST_ID } from "./remoteHostInputValidation";

export const REPAIR_REASON = /^REMOTE_HOST_[A-Z0-9_]{1,64}$/;
export const REPAIR_CLASSIFICATIONS: ReadonlySet<string> = new Set(["orphan-pin", "anchor-invalid", "lock", "snapshot", "write-uncertain", "unknown"]);
export const REPAIR_ACTIONS: ReadonlySet<string> = new Set(["complete-activation-from-pin", "discard-orphan-pin", "clear-stale-lock", "clear-rebind-lock", "forget-trust-anchor"]);

/** 两个投影共用的 id 白名单：只留合法 id，且上限 2000 条。 */
const projectHostIds = (hostIds: readonly string[]) => hostIds.filter((id) => HOST_ID.test(id)).slice(0, 2000);

/** Expose only stable codes and valid ids; no repair commands, pin paths or trust metadata cross IPC. */
export function repairSummary(view: RemoteHostCatalogView): RemoteHostRepairSummary[] {
	return view.findings.map((finding) => ({
		reason: REPAIR_REASON.test(finding.reason) ? finding.reason : "REMOTE_HOST_DIAGNOSTIC_UNKNOWN",
		classification: REPAIR_CLASSIFICATIONS.has(finding.classification) ? finding.classification : "unknown",
		hostIds: projectHostIds(finding.hostIds),
	}));
}

/** Project a diagnosis finding onto the renderer contract, dropping anything not on the allowlist. */
export function findingFrom(finding: { reason: string; classification: string; hostIds: readonly string[]; actions: readonly string[] }): RemoteHostRepairFinding {
	return {
		reason: REPAIR_REASON.test(finding.reason) ? finding.reason : "REMOTE_HOST_DIAGNOSTIC_UNKNOWN",
		classification: REPAIR_CLASSIFICATIONS.has(finding.classification) ? (finding.classification as RemoteHostRepairFinding["classification"]) : "unknown",
		hostIds: projectHostIds(finding.hostIds),
		actions: finding.actions.filter((action) => REPAIR_ACTIONS.has(action)) as RemoteHostRepairFinding["actions"],
	};
}
