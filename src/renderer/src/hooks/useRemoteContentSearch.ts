import { useCallback, useEffect, useRef, useState } from "react";
import type { FileContentSearchResult } from "../../../shared/types";
import type { ProjectServices } from "../services/projectServiceContracts";
import { shouldRunRemoteContentSearch } from "../utils/fileSearchCapability";

/**
 * 远端内容搜索的渲染层状态（Phase B）。
 *
 * 能力不再由这里自己问 rootStatus：S 的 `capabilities.files.contentSearch` 已经把
 * 连接状态、helper hello 声明（`fs.searchContent`）、root 复核与位置（WSL 无索引）合成唯一判据。
 * 组件只负责把 capability 传进来；这里只做提交式搜索、代次作废与失败回退 null
 * （失败/不可用一律只显示文件名结果，不把能力边界伪装成错误）。
 *
 * 与 `useFileSearch` 分开是有意的：那条 hook 服务本机抽屉的名字/内容检索，远端面板的提交语义
 * 与能力来源不同；两者都经 `ProjectFileService`，但状态机不合并。
 */
export type RemoteContentSearchHandle = {
	results: FileContentSearchResult | null;
	isSearching: boolean;
	/** 发起一次内容搜索；不支持/词太短时只清态，不发 IPC。 */
	run: (query: string) => Promise<void>;
	reset: () => void;
};

export function useRemoteContentSearch(options: { services: ProjectServices; supported: boolean }): RemoteContentSearchHandle {
	const [results, setResults] = useState<FileContentSearchResult | null>(null);
	const [isSearching, setIsSearching] = useState(false);
	const sequence = useRef(0);
	const { services, supported } = options;
	const projectId = services.projectId;

	const reset = useCallback(() => {
		sequence.current += 1;
		setResults(null);
		setIsSearching(false);
	}, []);

	// 能力关闭、切项目或连接换代：立刻丢掉上一位置的内容态，并作废在途请求。
	useEffect(() => {
		reset();
	}, [projectId, services.generation, supported, reset]);

	useEffect(
		() => () => {
			sequence.current += 1;
		},
		[],
	);

	const run = useCallback(
		async (query: string) => {
			const trimmed = query.trim();
			if (!shouldRunRemoteContentSearch(supported, query)) {
				reset();
				return;
			}
			const generation = ++sequence.current;
			setIsSearching(true);
			try {
				const value = await services.files.searchContent(trimmed);
				if (generation === sequence.current) setResults(value);
			} catch {
				// 服务层把“旧 helper / 不可用”折叠成 null；这里只兜真实失败，任何失败都不显示内容分区。
				if (generation === sequence.current) setResults(null);
			} finally {
				if (generation === sequence.current) setIsSearching(false);
			}
		},
		[services, supported, reset],
	);

	return { results, isSearching, run, reset };
}
