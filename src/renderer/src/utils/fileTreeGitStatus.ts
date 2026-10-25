import { GitStatus, type GitResource, type GitResourceGroups } from "../../../shared/types";

/**
 * 文件树行的 Git 状态着色（IDEA 风格）：
 * - modified：已跟踪且有工作区改动（含暂存修改/重命名/类型变更/删除）→ 蓝（--color-info）
 * - added：已暂存的新文件（含 intent-to-add）→ 绿（--color-success）
 * - untracked：未纳入 git 管理 → 琥珀/棕（--color-warning；IDEA 的 unversioned 就是棕色
 *   #993300 而非报警红，用户核心诉求是「一眼分辨」，不是「看着像出错」）
 * - conflict：合并冲突 → 红（--color-danger；红留给真正要处理的问题）
 * 与 Git 抽屉的 `--git-*` 色（SCM 只染状态字母、modified 走琥珀）是刻意分歧：
 * 文件树按用户要求沿用 IDEA 的行名语义，两处表面各用各的色语言。
 */
export type FileTreeGitStatus = "modified" | "added" | "untracked" | "conflict";

/**
 * 查表命中：`muted` 表示这是「只有更深处才有变化」的祖先目录（IDEA 的 Have changed descendants 那一档）。
 * 直接父目录与文件本身是实色档，更远的祖先用同色洗淡——保留折叠目录的提示能力，又不把整条路径喊响。
 */
export type FileTreeGitStatusHit = { status: FileTreeGitStatus; muted: boolean };

/** 文件行优先级：同一文件可同时进 index 与 workingTree（先暂存后又改），取信息量最大的状态。 */
const FILE_STATUS_RANK: Record<FileTreeGitStatus, number> = { conflict: 4, added: 3, modified: 2, untracked: 1 };

/** 目录行优先级：子树里有未跟踪文件时优先标成「未跟踪」色——「这个目录有东西没进 git」比「有已跟踪改动」更值得提醒。 */
const DIR_STATUS_RANK: Record<FileTreeGitStatus, number> = { conflict: 4, untracked: 3, added: 2, modified: 1 };

/** GitStatus → 文件树着色状态；返回 undefined 表示这一条不参与着色。 */
export function fileTreeGitStatusOf(status: GitStatus): FileTreeGitStatus | undefined {
	switch (status) {
		case GitStatus.UNTRACKED:
			return "untracked";
		case GitStatus.INDEX_ADDED:
		case GitStatus.INTENT_TO_ADD:
			return "added";
		case GitStatus.ADDED_BY_US:
		case GitStatus.ADDED_BY_THEM:
		case GitStatus.DELETED_BY_US:
		case GitStatus.DELETED_BY_THEM:
		case GitStatus.BOTH_ADDED:
		case GitStatus.BOTH_DELETED:
		case GitStatus.BOTH_MODIFIED:
			return "conflict";
		// 被忽略的文件既不是「没进管理」也不是「有改动」，显式不染色：默认 status 未带 --ignored
		// 拿不到 IGNORED，这里是护栏——将来打开该开关时不会落进 default 被当成已修改染成蓝色。
		case GitStatus.IGNORED:
			return undefined;
		default:
			return "modified";
	}
}

/**
 * 着色状态 → 行名文本色 utility（Tailwind + 语义 token，不写死色值）：每个状态两档。
 * - strong：文件本身与**直接**父目录（这一层就有变化）；
 * - muted：只有更深后代才有变化的祖先目录，用同色 65% 洗淡（IDEA 的两档做法）。
 *   洗淡必须保留色相——洗成灰色就分不出「未跟踪 vs 已修改」了；65% 是按
 *   tests/themeContrast 的 2.5:1 过程层地板在 21 套色板里定出来的（55% 最差只有 2.24）。
 * 注意：两档类名都必须写成整串字面量——Tailwind 扫描器按字面量生成 utility，
 * 用 strong + "/65" 拼出来的类不会被生成，颜色会整体失效。
 */
const CLASS_BY_STATUS: Record<FileTreeGitStatus, { strong: string; muted: string }> = {
	modified: { strong: "text-info", muted: "text-info/65" },
	added: { strong: "text-success", muted: "text-success/65" },
	untracked: { strong: "text-warning", muted: "text-warning/65" },
	conflict: { strong: "text-danger", muted: "text-danger/65" },
};

/** 查表命中 → 行名着色类（未命中 = 干净文件 / 不在 git 里 = 不上色）。 */
export function fileTreeGitStatusClass(hit: FileTreeGitStatusHit | undefined): string | undefined {
	if (!hit) return undefined;
	return hit.muted ? CLASS_BY_STATUS[hit.status].muted : CLASS_BY_STATUS[hit.status].strong;
}

/**
 * 着色状态 → 状态名 i18n key（行 title 与 aria-label 用）。
 * 颜色是唯一信号时色弱用户无从判断，必须有一条文字替代通道。
 */
export function fileTreeGitStatusLabelKey(status: FileTreeGitStatus | undefined): "drawer.gitStatus.modified" | "drawer.gitStatus.added" | "drawer.gitStatus.untracked" | "drawer.gitStatus.conflict" | undefined {
	switch (status) {
		case "modified":
			return "drawer.gitStatus.modified";
		case "added":
			return "drawer.gitStatus.added";
		case "untracked":
			return "drawer.gitStatus.untracked";
		case "conflict":
			return "drawer.gitStatus.conflict";
		default:
			return undefined;
	}
}

/**
 * 着色查找表键：统一 POSIX 分隔符 + 去尾部斜杠，**保留大小写**。
 * 大小写敏感文件系统（Linux/BSD，以及 macOS 的敏感卷）上 `Foo.ts` 与 `foo.ts` 是两个不同文件，
 * 一律折叠会让一个文件的状态染到另一个干净文件上；Windows 这类大小写不敏感平台需要折叠时，
 * 由查表在精确匹配落空后另行兜底（见 buildFileTreeGitStatusLookup）。
 */
export function fileTreeGitKey(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 当前平台的文件系统是否大小写不敏感（Windows / macOS 默认如此）：
 * 只有这种平台才需要「git 索引拼写与磁盘大小写不一致」的兜底。
 * 用 UA 判定而不是主进程 platform 参数：渲染层拿 platform 要过一次异步 IPC，
 * 而判定失败只是退回精确匹配（保守：最多少上一次色，不会误染）。
 */
export function isCaseInsensitiveFileSystem(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Windows|Macintosh|Mac OS X/i.test(navigator.userAgent);
}

/** 行级查询：命中返回「状态 + 档位」，未命中（干净文件 / 不在 git 里）返回 undefined。 */
export type FileTreeGitStatusLookup = (path: string) => FileTreeGitStatusHit | undefined;

/** 空查表：非 git 项目 / 加载失败时复用同一引用，避免渲染层无谓重建。 */
export const EMPTY_FILE_TREE_GIT_STATUS: FileTreeGitStatusLookup = () => undefined;

/**
 * 丢掉「嵌套仓库目录被外层仓报成未跟踪」的占位资源。
 * git 不递归进另一个仓库，只把该目录整个报成 untracked；而目录里的真实状态由嵌套仓自己的
 * status 提供（多仓项目已合并）。保留占位会得到「目录整个被标成未跟踪、内部文件各有各的颜色」的
 * 自相矛盾观感，颜色还会顺着祖先目录一路传上去。
 * 只丢未跟踪占位：已跟踪的子模块 gitlink（M）是有效信息，必须保留。
 */
export function dropNestedRepoUntrackedPlaceholders(groups: GitResourceGroups, repoRoots: readonly string[]): GitResourceGroups {
	if (repoRoots.length === 0) return groups;
	const roots = new Set(repoRoots.map(fileTreeGitKey));
	const keep = (resources: GitResource[]) => resources.filter((resource) => !(fileTreeGitStatusOf(resource.status) === "untracked" && roots.has(fileTreeGitKey(resource.path))));
	return { merge: keep(groups.merge), index: keep(groups.index), workingTree: keep(groups.workingTree), untracked: keep(groups.untracked) };
}

/**
 * 合并多个仓库的状态分组（多仓项目：文件树覆盖整个项目，每个仓库的状态都要算）。
 * 直接按组合并资源，让 buildFileTreeGitStatusLookup 统一套用优先级规则——
 * 「根仓把嵌套仓目录当未跟踪」与「嵌套仓自己报的改动」因此会按同一套 rank 收敛，
 * 不需要在这里为目录/文件分别合并（合并时机比合并规则更适合放在一处）。
 */
export function mergeGitResourceGroups(groupsList: readonly GitResourceGroups[]): GitResourceGroups {
	const merged: GitResourceGroups = { merge: [], index: [], workingTree: [], untracked: [] };
	for (const groups of groupsList) {
		merged.merge.push(...groups.merge);
		merged.index.push(...groups.index);
		merged.workingTree.push(...groups.workingTree);
		merged.untracked.push(...groups.untracked);
	}
	return merged;
}

/**
 * 把 GitResourceGroups 折成「文件树路径 → 着色命中」查表：
 * - 资源自身路径按文件语义取状态（同路径多组并存按 FILE_STATUS_RANK 决胜，如先暂存后又改）；
 * - 祖先目录逐级向上聚合子树状态（DIR_STATUS_RANK 决胜，档位见下）：子树里有未跟踪文件就
 *   标成未跟踪色，因为「这个目录有东西没进 git」比「有已跟踪改动」更值得提醒；
 * - 档位：直接父目录 = 实色（这一层就有变化），更远的祖先 = 洗淡（只有更深处才有变化）。
 *   与 IDEA 的「Have immediate changed children / Have changed descendants」两档同构。
 * 前提是 git 资源路径与文件树节点路径同源（都从 ProjectStore 的项目路径出发）；
 * WSL 项目的 UNC 形态不一致时只会上色失败（静默退化），不会误染。
 * 删除/重命名资源按新路径标记：文件本身已不在树上，着色落在父目录（目录确有变更，语义成立）。
 *
 * `caseInsensitiveFs` 缺省时按当前平台判定；Windows/macOS 上精确匹配落空后再忽略大小写兜底，
 * 折叠键有歧义（两个仅大小写不同的路径并存）时宁可不染色。
 */
export function buildFileTreeGitStatusLookup(groups: GitResourceGroups, projectRoot?: string, options?: { caseInsensitiveFs?: boolean }): FileTreeGitStatusLookup {
	// 两张表分开收集再合并：同一路径可能既是某仓的资源、又是另一仓文件的祖先目录
	// （典型是根仓把嵌套仓目录报成「未跟踪」，而嵌套仓自己已跟踪了一堆文件）。
	// 两张表的优先级表数值不可比，混在一张表里比较会得出随插入顺序变化的结果。
	const fileStatus = new Map<string, FileTreeGitStatus>();
	const dirStatus = new Map<string, FileTreeGitStatus>();
	// 有直接子资源的目录 = 实色档。只按「有没有直接子资源」判定档位：某目录同时有直接改动
	// 与更深改动时，两边都算「这层就有变化」，按实色展示（与 IDEA 的 immediate 档一致）。
	const dirWithDirectChild = new Set<string>();
	const put = (map: Map<string, FileTreeGitStatus>, key: string, status: FileTreeGitStatus, rank: Record<FileTreeGitStatus, number>) => {
		const prev = map.get(key);
		if (prev === undefined || rank[status] > rank[prev]) map.set(key, status);
	};
	const parentKeyOf = (key: string) => key.slice(0, key.lastIndexOf("/"));
	const rootKey = projectRoot ? fileTreeGitKey(projectRoot) : "";
	for (const group of [groups.merge, groups.index, groups.workingTree, groups.untracked]) {
		for (const resource of group) {
			const status = fileTreeGitStatusOf(resource.status);
			if (status === undefined) continue; // IGNORED 等显式不染色的资源直接跳过
			const fileKey = fileTreeGitKey(resource.path);
			put(fileStatus, fileKey, status, FILE_STATUS_RANK);
			// 祖先目录聚合：逐级上走；到项目根（项目根不是树节点）或盘符根即停。
			let dir = parentKeyOf(fileKey);
			let level = 1;
			while (dir && dir !== rootKey) {
				put(dirStatus, dir, status, DIR_STATUS_RANK);
				if (level === 1) dirWithDirectChild.add(dir);
				dir = parentKeyOf(dir);
				level += 1;
			}
		}
	}
	// 目录聚合后写入：路径能同时出现在两张表里说明它下面挂着资源（文件不可能有子路径），
	// 按目录语义展示更贴近文件树里实际看到的内容——否则嵌套仓目录会整块被标成未跟踪，
	// 与其内部每个文件的真实状态自相矛盾。
	const hits = new Map<string, FileTreeGitStatusHit>();
	for (const [key, status] of fileStatus) hits.set(key, { status, muted: false });
	for (const [key, status] of dirStatus) hits.set(key, { status, muted: !dirWithDirectChild.has(key) });
	if (!(options?.caseInsensitiveFs ?? isCaseInsensitiveFileSystem())) return (path) => hits.get(fileTreeGitKey(path));
	// 折叠索引：null 表示该折叠键有歧义（两个仅大小写不同的路径同时存在），查询时按未命中处理。
	const folded = new Map<string, FileTreeGitStatusHit | null>();
	for (const [key, hit] of hits) {
		const lower = key.toLowerCase();
		folded.set(lower, folded.has(lower) ? null : hit);
	}
	return (path) => {
		const key = fileTreeGitKey(path);
		return hits.get(key) ?? folded.get(key.toLowerCase()) ?? undefined;
	};
}
