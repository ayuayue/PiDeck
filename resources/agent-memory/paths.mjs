/**
 * Agent 记忆的目录布局、文件名与预算常量。
 *
 * 设计要点（对齐 pi-hermes-memory 的经验，但落盘位置由 PiDeck 决定）：
 * - **Markdown 是唯一真值**：用户可以直接用编辑器改，SQLite 只是可随时重建的索引镜像。
 *   因此索引与文件不一致时以文件为准，写完文件后回灌索引即可「自愈」。
 * - 目录由 `PIDECK_AGENT_MEMORY_DIR` 显式传入（宿主进程解析 userData 后注入）。
 *   **没有默认值**：缺失时服务器直接拒绝启动，避免把记忆写进某个进程的 cwd。
 * - 全局作用域落在根目录；项目作用域落在 `projects/<projectId>/`，projectId 必须
 *   已在宿主侧校验过（这里再做一次路径逃逸检查，防止 `..` 拼出目录穿越）。
 */

import { readdirSync } from "node:fs";
import path from "node:path";

/** 条目分隔符：单条记忆内部可以有多行，条目之间用这个不可见的分节符隔开。 */
export const ENTRY_DELIMITER = "\n§\n";

/** 各 target 的文件名。`failure` 用独立文件，因为它和普通记忆是两条不同的注入路径。 */
export const TARGET_FILES = {
	memory: "MEMORY.md",
	user: "USER.md",
	standing: "STANDING.md",
	failure: "failures.md",
};

/**
 * 允许写入的 target 集合。
 *
 * - `memory` / `user` / `failure`：全局（或带 projectId 的项目）记忆
 * - `project`：按 cwd 派生键落 `projects/<key>/`，跨后端共享
 * - `device`：**只在这台机器上有意义**的记忆（本机路径、盘符、家目录约定），
 *   落 `devices/<设备键>/`，导出时默认不带，因此不会污染别的设备
 * - `standing`：不是写入 target，只由文件侧读取
 */
export const MEMORY_TARGETS = ["memory", "user", "project", "failure", "device"];

/** 设备作用域的 id 前缀：`device:<key>` 走 `devices/` 目录，与项目作用域共用文件层。 */
export const DEVICE_SCOPE_PREFIX = "device:";
export const FAILURE_CATEGORIES = ["failure", "correction", "insight", "preference", "convention", "tool-quirk"];

/**
 * 预算：超出后按「最老的先丢」裁剪。
 *
 * 记忆是**检索式读取**（Agent 用 memory_search/memory_get 主动查），不再整份塞进系统提示，
 * 所以这里不是「提示长度上限」而是「防止一次外部导入把单个文件写成图书馆」的闸门：
 * 32KB / 400 条足够装下从 pi-hermes / Claude 等外部工具导出的中型记忆库而不裁掉任何一条。
 * STANDING 是用户手写的备注文件，给得更紧。
 */
export const FILE_BUDGETS = {
	memory: { maxChars: 32000, maxEntries: 400 },
	user: { maxChars: 32000, maxEntries: 400 },
	standing: { maxChars: 4000, maxEntries: 40 },
	failure: { maxChars: 32000, maxEntries: 400 },
};

/** 单条内容上限：防止一次写入把整份文件挤空。 */
export const MAX_ENTRY_CHARS = 2000;

/** 会话索引：单条消息入库上限（工具结果动辄上万字符，只留可检索的开头）。 */
export const MAX_INDEXED_MESSAGE_CHARS = 4000;

/** 项目 id 只允许这些字符；宿主侧同样有校验，这里是第二道闸。 */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** 路径规范化口径：Windows 大小写不敏感，同一个目录的不同大小写要落到同一个键。 */
function canonicalPath(cwd) {
	const resolved = path.resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 可读前缀：非 `[A-Za-z0-9._-]` 的字符段（也包括路径分隔符）统一折成 `-`。 */
function readableSlug(normalized) {
	return normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** 路径的 32 位哈希（8 位十六进制）：只用来给可读前缀去重，不承担密码学职责。 */
function pathHash(normalized) {
	let hash = 0;
	for (let index = 0; index < normalized.length; index += 1) hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
	return hash.toString(16).padStart(8, "0");
}

/**
 * 会话工作目录 → 项目作用域的键：`<可读前缀>-<路径哈希>`。
 *
 * 项目记忆刻意用**路径派生的稳定键**而不是 PiDeck 的 projectId：
 * - 同一个项目在 pi / ACP / 终端里 cwd 相同，三种后端自然共享一份项目记忆；
 * - 项目从 PiDeck 移除再加回来（id 会变）时记忆不丢；
 * - Agent 本来就知道自己的 cwd，不需要额外告诉它宿主侧的内部 id。
 *
 * 哈希后缀**始终存在**，不是只为超长路径：可读前缀把路径分隔符和字面 `-` 折成同一个字符，
 * 不带哈希时 `D:/a/b` 与 `D:/a-b`、`D:/项目一/T6` 与 `D:/项目二/T6` 会并成同一个键
 * （两个互不相干的项目共享一份记忆，用户看到的是「别的项目的规矩冒了出来」）。
 */
export function projectKeyFromPath(cwd) {
	if (typeof cwd !== "string" || !cwd.trim()) return "";
	const normalized = canonicalPath(cwd);
	const slug = readableSlug(normalized);
	if (slug.length === 0) return "";
	// 前缀留 80 字符保证人工可读，后缀固定 8 位哈希；总长 89 < 目录名上限。
	const key = `${slug.slice(0, 80)}-${pathHash(normalized)}`;
	return PROJECT_ID_PATTERN.test(key) ? key : "";
}

/**
 * v1.5.x 及更早的键算法（短路径不加哈希、长路径加哈希）。
 * 只用于把旧的 `projects/<旧键>/` 目录迁移到新键，不要再拿来派生新键。
 */
export function legacyProjectKeyFromPath(cwd) {
	if (typeof cwd !== "string" || !cwd.trim()) return "";
	const normalized = path.resolve(cwd);
	const slug = readableSlug(normalized);
	if (slug.length === 0) return "";
	if (slug.length <= 96) return PROJECT_ID_PATTERN.test(slug) ? slug : "";
	let hash = 0;
	for (let index = 0; index < normalized.length; index += 1) hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
	const key = `${slug.slice(0, 80)}-${hash.toString(16)}`;
	return PROJECT_ID_PATTERN.test(key) ? key : "";
}

/** 已存在的项目作用域键（`projects/` 下的目录名），按名字排序；读不到目录时返回空数组。 */
export function listProjectKeys(root, limit = 500) {
	try {
		return readdirSync(path.join(root, "projects"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && PROJECT_ID_PATTERN.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.slice(0, limit);
	} catch {
		return [];
	}
}

/** 省略 projectId 时的项目作用域键（由宿主注入的会话 cwd 推导）；没有 cwd 时返回空。 */
export function defaultProjectKey(env = process.env) {
	return projectKeyFromPath(env.PIDECK_AGENT_MEMORY_CWD);
}

/** 读取记忆根目录；缺失或非法直接抛错（调用方负责把错误转成工具错误）。 */
export function resolveMemoryRoot(env = process.env) {
	const root = env.PIDECK_AGENT_MEMORY_DIR;
	if (!root || typeof root !== "string") throw new Error("memory-dir-missing");
	if (!path.isAbsolute(root)) throw new Error("memory-dir-not-absolute");
	return path.resolve(root);
}

/**
 * 设备专属记忆的目录名。
 *
 * 用 `devices/<key>/` 而不是 `projects/`：两者生命周期不同（项目可移动/重建，设备是这台机器），
 * 混在一起会让「清空某项目记忆」误删本机事实。
 */
export function resolveDeviceDir(root, deviceKey) {
	if (typeof deviceKey !== "string" || !PROJECT_ID_PATTERN.test(deviceKey)) throw new Error("device-key-invalid");
	const dir = path.join(root, "devices", deviceKey);
	const normalized = path.resolve(dir);
	if (normalized !== dir || !normalized.startsWith(path.resolve(root) + path.sep)) throw new Error("device-key-invalid");
	return normalized;
}

/** `device:<key>` 形式的作用域 id → 设备键；不是设备作用域时返回空串。 */
export function deviceKeyFromScope(projectId) {
	if (typeof projectId !== "string" || !projectId.startsWith(DEVICE_SCOPE_PREFIX)) return "";
	const key = projectId.slice(DEVICE_SCOPE_PREFIX.length);
	return PROJECT_ID_PATTERN.test(key) ? key : "";
}

/** 项目子目录；projectId 非法时抛错而不是悄悄落到全局目录。 */
export function resolveProjectDir(root, projectId) {
	// 设备作用域复用同一套「id → 目录」逻辑，只是根目录不同。
	const deviceKey = deviceKeyFromScope(projectId);
	if (deviceKey) return resolveDeviceDir(root, deviceKey);
	if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) throw new Error("project-id-invalid");
	const dir = path.join(root, "projects", projectId);
	// 双保险：join 之后再规范化比较一次前缀，任何诡异的 id 都不允许逃出去。
	const normalized = path.resolve(dir);
	if (normalized !== dir || !normalized.startsWith(path.resolve(root) + path.sep)) throw new Error("project-id-invalid");
	return normalized;
}

/**
 * 设备档案：`{ id, name }`。
 *
 * `id` 在首次用到时随机生成并落盘，之后随导出包一起走，用来回答「这批记忆来自哪台设备」。
 * 不放进 `settings.json`：记忆目录要能单独拷走/备份，档案得跟着它自己走。
 */
export function deviceProfilePath(root) {
	return path.join(root, "device.json");
}

/**
 * 删除墓碑：导入时用来避免「在 A 机删掉的记忆被 B 机的旧包复活」。
 *
 * 只影响**导入**，不影响当场的 `memory_add`——用户/Agent 现在主动写一条，
 * 说明意图明确，不该被一条历史墓碑挡住。
 */
export function tombstonesPath(root) {
	return path.join(root, "tombstones.json");
}

/** 索引库路径（固定落根目录，项目作用域共用同一个库，靠 project_id 列区分）。 */
export function databasePath(root) {
	return path.join(root, "agent-memory.db");
}

/** target + projectId → 具体的 Markdown 文件路径。 */
export function targetFilePath(root, target, projectId) {
	const fileName = TARGET_FILES[target];
	if (!fileName) throw new Error("target-invalid");
	const dir = projectId ? resolveProjectDir(root, projectId) : root;
	return path.join(dir, fileName);
}
