import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { ProjectFileAccessScope } from "../../../../shared/types";
import {
	getFilePathVerdict,
	requestFilePathVerdicts,
	subscribeFilePathVerdicts,
} from "../../utils/filePathVerdictStore";
import { resolveFileLinkPath } from "../../utils/filePathLinks";

type FileLinkBase = {
	baseDir?: string;
	projectRoot?: string;
	scope?: ProjectFileAccessScope;
};

/**
 * 文件路径链接的解析与授权上下文。
 *
 * 分屏时每个 SessionRuntimeInjector 都提供本栏自己的 cwd/project；App 层 Provider
 * 只作为非会话静态区域的兜底。存在性校验和点击打开因此始终使用同一栏的基准。
 */
const FileLinkBaseContext = createContext<FileLinkBase>({});

export function FileLinkBaseProvider(props: {
	baseDir: string | undefined;
	projectRoot?: string;
	projectId?: string;
	children: ReactNode;
}) {
	const value = useMemo<FileLinkBase>(
		() => ({
			baseDir: props.baseDir,
			projectRoot: props.projectRoot,
			scope: props.projectId ? { projectId: props.projectId } : undefined,
		}),
		[props.baseDir, props.projectId, props.projectRoot],
	);
	return (
		<FileLinkBaseContext.Provider value={value}>
			{props.children}
		</FileLinkBaseContext.Provider>
	);
}

export function useFileLinkBaseDir(): string | undefined {
	return useContext(FileLinkBaseContext).baseDir;
}

/**
 * 单个路径的存在性判定订阅：首次遇到未校验路径时登记批量请求（store 内部
 * 去抖合并 IPC），结果经缓存广播回来；undefined 表示未知/校验中。
 * 每个文件锚点独立订阅自己的键，避免一条长回复整体重渲染。
 */
export function useFilePathExists(rawPath: string | undefined): boolean | undefined {
	const { baseDir, projectRoot, scope } = useContext(FileLinkBaseContext);
	// resolveFileLinkPath 返回 null = 无法解析或越出本栏项目边界：
	// 不发 stat，更不能让主进程按进程 cwd 猜测相对路径。
	const absPath = rawPath === undefined
		? undefined
		: resolveFileLinkPath(rawPath, baseDir, projectRoot);
	const resolvable = typeof absPath === "string";
	useEffect(() => {
		if (!rawPath || !resolvable || absPath === undefined) return;
		requestFilePathVerdicts([absPath], scope);
	}, [absPath, rawPath, resolvable, scope]);
	return useSyncExternalStore(
		subscribeFilePathVerdicts,
		() => (resolvable ? getFilePathVerdict(absPath, scope) : undefined),
	);
}
