/**
 * 文件树深度/规模契约（主进程与渲染层共用，避免两侧魔数漂移）。
 *
 * 两套读取语义共用同一个上限：
 * - 抽屉默认浅层 listing：maxDepth 0 只拉根层，展开时逐层懒加载；
 * - composer @ 引用整树搜索需要较深深度，才能覆盖 src/main/java/… 这类
 *   深路径（Java/Maven 包层级可达 11+ 层）。渲染层请求、主进程 clamp 同一常量。
 */
export const DEFAULT_FILE_TREE_MAX_DEPTH = 8;
export const FILE_TREE_ABSOLUTE_MAX_DEPTH = 12;
/** 单层直接子项上限：超大目录（数万文件）一次 IPC 会拖垮渲染进程。 */
export const FILE_TREE_MAX_DIRECTORY_ENTRIES = 2000;

/** 文件名搜索上限：主进程找到这么多条即停止下钻，防止大仓库把 IPC/渲染层打爆。 */
export const FILE_SEARCH_MAX_RESULTS = 200;
/** 搜索请求超时（ms）：主进程扫盘最长等待时间，超时返回已收集结果而不是永远挂起。 */
export const FILE_SEARCH_TIMEOUT_MS = 8000;
/** 搜索中单目录子项上限：超过时跳过该目录（与文件树“单层过大拒绝”不同，搜索要继续走完，不能一拒了之）。 */
export const FILE_SEARCH_MAX_DIRECTORY_ENTRIES = 5000;
