/**
 * rewind checkpoint 常量（移植自 pi-rewind core.ts，MIT）。
 *
 * 与 pi-rewind 保持一致：ref 命名空间、过滤阈值、忽略目录全部对齐，
 * 保证 PiDeck 与 pi CLI 场景下创建的 checkpoint 互相可读——同一仓库里
 * 谁打的点都能被另一方列出/恢复，这是 refs 存储（而非内存存储）的收益。
 */

/** 空树/无 HEAD 时的占位 SHA（git 空树对象固定哈希）。 */
export const ZEROS = "0".repeat(40);

/** checkpoint 的 git ref 命名空间（refs/pi-checkpoints/<id>）。 */
export const REF_BASE = "refs/pi-checkpoints";

/**
 * 未跟踪文件快照大小上限：>10MiB 跳过。
 * 为什么设上限：大文件（模型权重、日志、二进制产物）进 git 对象库会让
 * checkout 与 GC 变慢，且恢复时也可能被 git clean 误删（见 safeClean 的保护逻辑）。
 */
export const MAX_UNTRACKED_FILE_SIZE = 10 * 1024 * 1024;

/**
 * 未跟踪文件快照「总字节预算」：单次打点纳入 index 的未跟踪文件总量超过该值后，
 * 剩余未跟踪文件整体跳过（记入 skippedOverBudgetFiles，恢复时受保护）。
 *
 * 为什么要有：单文件 10MiB + 同目录 200 文件两道闸门挡不住「很多小文件」——
 * 实测 .runs/ 类产物目录 5609 个 1–3MB 文件（共 1.1GB）每个都同时低于两道阈值，
 * 每次打点都要全部读出来算 blob 哈希（临时 index 无缓存可复用），磁盘被读满整机卡死
 * （2026-09-13 用户报告，Kernel-Power 41 两次强关）。64MiB 在「正常源码/小产物」
 * 与「打点开销」之间取平衡：一次打点额外 I/O 上限 ≈ 预算值。
 */
export const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * 未跟踪目录文件数上限：>=200 个文件跳过整目录。
 * 目录级跳过是为了避免 node_modules 之类的巨型目录被逐文件 add 拖垮快照。
 */
export const MAX_UNTRACKED_DIR_FILES = 200;

/**
 * 相邻两次自动打点的最小间隔（按会话计；间隔内的打点请求合并为一次 trailing 快照）。
 * 文件类工具（write/edit/bash）每个动作结束都会请求打点，高频 bash 循环下实测
 * 中位间隔只有 6.3s（峰值 13 次/分钟）——与字节预算一起构成双重防线：
 * 预算限「单次多贵」，间隔限「单位时间打几次」。8s 对「回滚粒度」影响可忽略
 * （连续工具流中间态本来就不是有价值的回滚点）。
 */
export const MIN_CHECKPOINT_INTERVAL_MS = 8_000;

/** 单会话 checkpoint 保留上限，超出裁剪最旧（before-restore 安全网除外）。 */
export const DEFAULT_MAX_CHECKPOINTS = 50;

/**
 * 当前会话裁剪的最小间隔：打点成功后触发 pruneCheckpoints，但不必每次都全量扫
 * refs（for-each-ref + cat-file --batch），60s 一次足够把超限部分削掉。
 */
export const PRUNE_CURRENT_MIN_INTERVAL_MS = 60_000;

/**
 * 旧会话清理的最小间隔（per 仓库）：会话首轮 run 时触发 pruneOldSessions，
 * 顺带消化历史积压 ref；10 分钟一次已覆盖会话切换频率。
 */
export const PRUNE_OLD_SESSIONS_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * 快照忽略目录（匹配路径任意段）。
 * 前半部分与 pi-rewind 同源（node_modules/env/dist 等），保证两边创建的快照
 * 语义一致；`.runs`/`out`/`target`/`shots` 是 PiDeck 侧扩展（2026-09-13 用户
 * 报告的产物目录类型）：这些目录即使没被 .gitignore 覆盖也几乎必然是产物，
 * 纳入快照只会制造 I/O 风暴，不会带来可用的回滚价值。ref 里的元数据自描述，
 * 忽略名单差异不影响两端互相读取对方创建的 checkpoint。
 */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	".venv",
	"venv",
	"env",
	".env",
	"dist",
	"build",
	".pytest_cache",
	".mypy_cache",
	".cache",
	".tox",
	"__pycache__",
	// PiDeck 侧扩展：常见产物/运行时输出目录
	".runs",
	"out",
	"target",
	"shots",
]);

/** 会改动文件系统、值得打 checkpoint 的工具（对齐 pi-rewind）。 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash"]);
