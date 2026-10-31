import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isRemoteProject } from "../../../shared/projectLocation";
import type { Project } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import type { ProjectServices } from "../services/projectServiceContracts";
import { createProjectServiceRuntime } from "../services/projectServiceRuntime";

/**
 * 按项目提供服务（S 检查点）：runtime 拥有事实、连接代与订阅生命周期，hook 只做 React 接线。
 *
 * F/G 只消费返回的 ProjectServices：身份已绑定，不再从“当前项目”补参数；
 * 连接代变化后 runtime 会返回新实例，旧实例的迟到结果抛 PROJECT_SERVICE_GENERATION_STALE。
 */
export function useProjectServices(project: Project): ProjectServices {
	const hostId = isRemoteProject(project) ? project.locator.hostId : "";
	const remotePath = isRemoteProject(project) ? project.locator.remotePath : "";
	// project 对象其余字段（名称/排序）不参与服务身份；id/host/root 变化必须换 runtime。
	const runtime = useMemo(() => createProjectServiceRuntime(project, desktopApi), [project.id, hostId, remotePath]);
	useEffect(() => runtime.start(), [runtime]);
	return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
}
