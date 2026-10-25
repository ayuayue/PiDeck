import { useEffect, useRef } from "react";

/**
 * 防抖窗口：一次展开/粘贴会连着 merge 多层目录（每层一次 setFiles），攒成一帧再拉，
 * 否则每次内容变化都要付一轮 listRepos + 每仓 `git status -uall`。
 */
export const FILE_TREE_GIT_STATUS_REFRESH_DEBOUNCE_MS = 400;

/**
 * 文件树内容变化 → 防抖重拉 Git 着色。
 *
 * 触发键只有内容代次（owner 在 useFileTreeContentState：setFiles 返回同一引用＝不变，
 * 换新数组就 +1；等价重载也会推进一次，代价只是一轮多拉）：
 * - 重渲染、引用变化不触发；展开/收起只改视图，不进依赖，因此不会像旧实现那样
 *   「内容变化后 400ms 内发生一次展开」就清掉待执行的刷新且永无补偿；
 * - refresh 走 ref 调用：调用方重建回调引用不进依赖，同样不会打断待执行的刷新。
 * 挂载首帧不拉：useFileTreeGitStatus 自己的 effect 已经把着色拉过一轮。
 */
export function useFileTreeGitStatusRefresh(contentRevision: number, refresh: () => void | Promise<void>): void {
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	// 已结算的代次：初值是挂载时的代次，首帧因此不会重复拉取。
	const appliedRevisionRef = useRef(contentRevision);
	useEffect(() => {
		if (contentRevision === appliedRevisionRef.current) return;
		appliedRevisionRef.current = contentRevision;
		const timer = window.setTimeout(() => void refreshRef.current(), FILE_TREE_GIT_STATUS_REFRESH_DEBOUNCE_MS);
		// 只清这一轮自己的定时器：下一次代次前进会重排，卸载则取消（不会留下野定时器）。
		return () => window.clearTimeout(timer);
	}, [contentRevision]);
}
