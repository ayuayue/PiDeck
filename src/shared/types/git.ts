// ── Git 基础类型 ──────────────────────────────────────────────────────

export type GitBranchInfo = {
	current: string | null;
	branches: string[];
};

/**
 * 项目目录内发现的独立 Git 仓库（含根仓库与嵌套仓库）。
 * 侧栏按此项切换 cwd，避免把整棵工作区当成单一仓库。
 */
export type GitRepoInfo = {
	/** 仓库工作区绝对路径，作为后续 git 命令的 cwd */
	path: string;
	/** 展示名：根仓库用项目文件夹名，嵌套仓库用该目录名 */
	name: string;
	/** 相对项目根的 posix 路径；根仓库为空串 */
	relativePath: string;
};

/** AI 生成提交摘要的结果：结构化错误码供渲染层区分“未配置/忙碌/超时”，避免透传 pi 英文错误。 */
export type GitGenerateCommitMessageResult =
	| { ok: true; message: string }
	| {
			ok: false;
			/** 渲染层据此决定提示形态（如未配置时带“去设置”按钮） */
			code: "GIT_COMMIT_MODEL_REQUIRED" | "GIT_COMMIT_BUSY" | "GIT_COMMIT_TIMEOUT" | "GIT_COMMIT_GENERATE_FAILED";
			message: string;
	  };

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed";

export type GitChangedFile = {
	path: string;
	status: GitFileStatus;
	/** 重命名文件在父提交中的原始路径；其他状态不设置。 */
	originalPath?: string;
};

/** git worktree --porcelain 输出解析出的单条工作树信息 */
export type WorktreeEntry = {
	path: string;
	branch: string;
};

// ── VS Code 风格 Git Status 系统 ─────────────────────────────────────

/** Git 文件状态枚举，对应 VS Code Status enum（非 const，用于运行时映射） */
export enum GitStatus {
	INDEX_MODIFIED,
	INDEX_ADDED,
	INDEX_DELETED,
	INDEX_RENAMED,
	INDEX_COPIED,
	MODIFIED,
	DELETED,
	UNTRACKED,
	IGNORED,
	INTENT_TO_ADD,
	INTENT_TO_RENAME,
	TYPE_CHANGED,
	ADDED_BY_US,
	ADDED_BY_THEM,
	DELETED_BY_US,
	DELETED_BY_THEM,
	BOTH_ADDED,
	BOTH_DELETED,
	BOTH_MODIFIED,
	/** 追加在末尾以保持既有 GitStatus 数值稳定。 */
	INDEX_TYPE_CHANGED,
}

/** Git 资源组类型，对应 VS Code ResourceGroupType */
export type GitResourceGroupType = "merge" | "index" | "workingTree" | "untracked";

/** 单个 Git 变更资源，对应 VS Code Resource 类 */
export type GitResource = {
	/** 文件绝对路径 */
	path: string;
	/** Git 状态 */
	status: GitStatus;
	/** 状态字母 (M/A/D/R/U/!/T) */
	letter: string;
	/** 重命名/拷贝的原始路径 */
	oldPath?: string;
};

/** 按组分类的 Git 资源 */
export type GitResourceGroups = {
	merge: GitResource[];
	index: GitResource[];
	workingTree: GitResource[];
	untracked: GitResource[];
};

/** 批量回滚时保留资源组，避免同一目录中的 tracked/untracked 文件混淆。 */
export type GitDiscardResource = {
	group: "workingTree" | "untracked";
	path: string;
};

/** Git Changes 各资源组打开 Diff 时的比较上下文。 */
export type GitWorkspaceDiffGroup = GitResourceGroupType;

/**
 * Git 工作区单文件 Diff 的两侧快照。内容只在用户点击资源行时读取，
 * 不随 status 轮询返回，避免在常驻 Git 抽屉中缓存所有变更文件内容。
 */
export type GitWorkspaceFileDiff = {
	/** 当前工作区文件绝对路径，供只读 Diff Viewer 识别语言和标签。 */
	path: string;
	originalContent: string;
	modifiedContent: string;
};

// ── Git 增强：提交历史 / 分支对比 / Graph ──────────────────────────────

/** 单个 Git 提交记录，对应 git log 一行输出 */
export type CommitEntry = {
	hash: string;          // 完整 SHA
	shortHash: string;     // 短 SHA（前 7 位）
	message: string;       // 提交信息首行（subject）
	authorName: string;
	authorEmail: string;
	authorDate: number;    // unix timestamp
	parents: string[];     // 父提交 hash 列表
	refNames: string[];    // 关联的 ref 名称（如 HEAD -> main, origin/main）
	/** git log --graph 输出的 ASCII 图谱行（等宽字体渲染即得分支图） */
	graph: string[];
	/** 完整提交信息；历史列表仍使用 message 作为单行 subject。 */
	fullMessage?: string;
	/** 改动的文件统计（仅 getCommitDetail 填充，getCommitLog 不包含） */
	shortStat?: { files: number; insertions: number; deletions: number };
};

/** 单个提交的按需详情，对应 VS Code SCM History 的 resolve + changes。 */
export type CommitDetail = {
	commit: CommitEntry;
	files: GitChangedFile[];
};

/** 提交历史中单个文件相对第一父提交的两侧内容，供 Monaco Diff Viewer 展示。 */
export type GitCommitFileDiff = {
	path: string;
	originalPath?: string;
	originalContent: string;
	modifiedContent: string;
};

/** Git 引用（分支 / 远程分支 / Tag） */
export type GitRef = {
	name: string;          // 短名称（如 main, v1.0）
	fullName: string;      // 完整 ref（如 refs/heads/main）
	hash: string;          // 对象 SHA
	type: "head" | "remote" | "tag";
};

/** 两个分支之间的差异概要 */
/** 当前分支相对其上游（@{upstream}）的提交差距；无上游/非仓库时为 null。 */
export type GitAheadBehind = {
	/** 本地领先上游的提交数（push 可送出） */
	ahead: number;
	/** 本地落后上游的提交数（pull 可拉入） */
	behind: number;
};

export type BranchDiffResult = {
	/** 变更的文件列表（base...target 三点语法 symmetric difference） */
	files: GitChangedFile[];
	ahead: number;   // target 比 base 多几个 commit
	behind: number;  // target 比 base 少几个 commit（等于 0 时 base 是 target 的子集）
};

// ── Git 可执行文件探测（设置页「Git 可执行文件」行契约）────────────────

/** 探测结果的来源，决定设置页展示文案与是否提示用户干预。 */
export type GitExecutableSource = "configured" | "path" | "known-location" | "not-found";

/** 一次成功探测的结论：绝对路径 + 版本号。 */
export type GitExecutableProbe = {
	resolvedPath: string;
	version: string;
};

/** 系统自动探测结论（忽略用户配置），带来源以便区分「PATH 命中」与「按安装位置找到」。 */
export type GitSystemProbe = GitExecutableProbe & {
	source: Exclude<GitExecutableSource, "configured" | "not-found">;
};

/** git:detect-executable 的返回值。 */
export type GitExecutableInfo = {
	/** 当前实际会生效的来源 */
	source: GitExecutableSource;
	/** 实际会 spawn 的命令：用户配置路径，或字面量 "git"（走 PATH） */
	executable: string;
	/** 解析出的绝对路径；PATH 模式下由 where/which 得出，失败为空 */
	resolvedPath: string;
	/** 形如 "2.53.0"；探测失败为空 */
	version: string;
	/** 失败原因，成功时为 null */
	error: string | null;
	/** 系统自动探测结果：配置为空时展示占位，配置无效时提供一键填入的备选 */
	system: GitSystemProbe | null;
};
