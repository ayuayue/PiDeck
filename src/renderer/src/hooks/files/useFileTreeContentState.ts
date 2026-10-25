import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { FileTreeNode } from "../../../../shared/types";

/** 文件树 owner 状态：节点树与「内容代次」同源，代次随 setFiles 的引用判定同步前进。 */
type FileTreeContentState = { nodes: FileTreeNode[]; revision: number };

export type FileTreeContentStateHandle = {
	files: FileTreeNode[];
	/** 单调递增的内容代次：setFiles 返回同一引用＝不变；返回新数组（哪怕内容等价）就 +1。 */
	fileTreeContentRevision: number;
	setFiles: Dispatch<SetStateAction<FileTreeNode[]>>;
};

/**
 * 文件树 owner 状态：节点树 + 内容代次（文件抽屉按代次防抖重拉 Git 着色）。
 *
 * 为什么要有显式代次：不能靠渲染层自己比较 `props.files` 引用，否则展开/收起、
 * 定时器的无关重渲染都可能被当成内容变化；判据收敛成一条：
 * **setFiles 的更新函数返回同一引用 = 没变**（无变化的纯变换必须返回 current，见
 * fileTreeLazy 的 mergeFileTreeChildren / markFileTreeLoadFailed）；返回新数组 = 推进一代——
 * 懒加载新目录的 children 是新节点、需要着色，必须推进代次。
 *
 * 边界（刻意不做深等价比较）：判据只认引用，所以「等价重载」也会推进一代——
 * 例如 useProjectSync.refreshFiles 每次都 setFiles(next)，即使扫回来的树与旧树内容等价。
 * 代价只是多一轮 listRepos + 每仓 `git status -uall`（与引入代次之前的行为一致，不是回归）；
 * 换深度比较会在每次 setFiles 上同步遍历整棵树，大仓库下比多拉一次更贵。
 *
 * 代次与 nodes 放同一个 state：一次更新只产生一次渲染，且代次与内容永远同步（不会出现
 * 「节点换了、代次没换」的中间态）。updater 里只算新 state，不加额外副作用——同一份 updater
 * 被 StrictMode 跑两次得到的仍是同一结果。
 */
export function useFileTreeContentState(): FileTreeContentStateHandle {
	const [state, setState] = useState<FileTreeContentState>(() => ({ nodes: [], revision: 0 }));
	const setFiles = useCallback<Dispatch<SetStateAction<FileTreeNode[]>>>((next) => {
		setState((current) => {
			const resolved = typeof next === "function" ? next(current.nodes) : next;
			if (resolved === current.nodes) return current;
			return { nodes: resolved, revision: current.revision + 1 };
		});
	}, []);
	return { files: state.nodes, fileTreeContentRevision: state.revision, setFiles };
}
