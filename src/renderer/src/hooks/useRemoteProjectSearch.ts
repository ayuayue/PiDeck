import { useCallback, useEffect, useState } from "react";
import { createRemoteProjectSearchController, remoteSearchOutcomeFromService, type RemoteProjectSearchState, type RemoteSearchOutcome } from "../components/session/remoteProjectSearchState";
import type { ProjectServices } from "../services/projectServiceContracts";
import { normalizeProjectServiceError } from "../services/projectServiceFence";

/**
 * 远端项目文件名搜索（渲染层，Phase B）。
 *
 * 状态机在 `remoteProjectSearchState`（纯函数，可离开 React 单测）；这里只做三件事：
 * 把 S 冻结的 `ProjectFileService.searchFiles` 结果收窄成终态、按代次落地结果、
 * 在切项目/换代/卸载时作废在途结果。
 *
 * 不再做 preload 的“结构探测”：搜索入口由服务契约提供（远端 provider 内部走
 * `remoteHosts.searchProject`），F 层不直连通道，也不伪造“未接线”失败。服务异常统一归一成
 * 稳定码；`unknown` 只属于写路径，读搜索失败一律是 rejected。
 */
export type RemoteProjectSearchHandle = {
	state: RemoteProjectSearchState;
	/** 发起一次搜索（query 由主进程边界重新校验；这里只保证不发空查询）。 */
	run: (query: string) => Promise<void>;
	/** 清除结果并回到 idle。 */
	reset: () => void;
};

export function useRemoteProjectSearch(services: ProjectServices): RemoteProjectSearchHandle {
	const [controller] = useState(createRemoteProjectSearchController);
	const [state, setState] = useState<RemoteProjectSearchState>(() => controller.getState());
	const projectId = services.projectId;

	const run = useCallback(
		async (query: string) => {
			if (query.length === 0) return;
			const generation = controller.start(query);
			setState(controller.getState());
			let outcome: RemoteSearchOutcome;
			try {
				outcome = remoteSearchOutcomeFromService(await services.files.searchFiles(query));
			} catch (error) {
				// 服务层只抛稳定码（ProjectServiceError / 归一后的 IPC 失败）：这正是用户可以据以行动的失败。
				outcome = { kind: "failed", code: normalizeProjectServiceError(error).code };
			}
			// 代次已作废时整体丢弃：迟到的结果绝不能覆盖新查询或新项目。
			if (controller.settle(generation, outcome)) setState(controller.getState());
		},
		[controller, services],
	);

	const reset = useCallback(() => {
		controller.reset();
		setState(controller.getState());
	}, [controller]);

	// 切项目或连接换代：作废上一个位置/上一代连接的在途结果。
	useEffect(() => {
		reset();
	}, [projectId, services.generation, reset]);

	// 卸载：只作废，不再 setState。
	useEffect(
		() => () => {
			controller.reset();
		},
		[controller],
	);

	return { state, run, reset };
}
