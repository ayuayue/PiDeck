import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isRemoteProject } from "../../../shared/projectLocation";
import type { Project } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import type { ProjectServices } from "../services/projectServiceContracts";
import { createProjectServiceRuntime } from "../services/projectServiceRuntime";

/**
 * 按项目提供服务（S 检查点，F 起被 UI 消费）：runtime 拥有事实、连接代与订阅生命周期，
 * hook 只做 React 接线。
 *
 * - 传 Project：返回绑定该项目的 `ProjectServices`；
 * - 传 `Project | undefined`（调用方可能没有活动项目）：项目缺席时返回 null，不伪造服务、
 *   不建立任何订阅。重载让 App 这类“可能没有 activeProject”的调用点也能安全使用同一入口。
 *
 * F/G 只消费返回的 ProjectServices：身份已绑定，不再从“当前项目”补参数；
 * 连接代变化后 runtime 会返回新实例，旧实例的迟到结果抛 PROJECT_SERVICE_GENERATION_STALE。
 */
const NOOP_SUBSCRIBE = () => () => undefined;
const NO_PROJECT_SNAPSHOT = () => null;

export function useProjectServices(project: Project): ProjectServices;
export function useProjectServices(project: Project | undefined): ProjectServices | null;
export function useProjectServices(project: Project | undefined): ProjectServices | null {
	const hostId = project !== undefined && isRemoteProject(project) ? project.locator.hostId : "";
	const remotePath = project !== undefined && isRemoteProject(project) ? project.locator.remotePath : "";
	// project 对象其余字段（名称/排序）不参与服务身份；id/host/root 变化必须换 runtime。
	const runtime = useMemo(() => (project === undefined ? null : createProjectServiceRuntime(project, desktopApi)), [project?.id, hostId, remotePath]);
	useEffect(() => {
		if (runtime === null) return;
		return runtime.start();
	}, [runtime]);
	const getSnapshot = runtime?.getSnapshot ?? NO_PROJECT_SNAPSHOT;
	return useSyncExternalStore(runtime?.subscribe ?? NOOP_SUBSCRIBE, getSnapshot, getSnapshot);
}
