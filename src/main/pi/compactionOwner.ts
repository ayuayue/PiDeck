import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSettingsObject, readStringArray } from "../resourceWhitelist";

/**
 * 「谁在管这个会话的上下文窗口」——手动压缩要不要、能不能发 pi 的 compact RPC。
 *
 * 背景（2026-09-16 源码核查）：
 * - pi 的压缩在 `session_before_compact` 钩子处可被任何扩展 `return { cancel: true }` 否掉。
 *   手动压缩（RPC `compact`）与自动压缩（threshold/overflow）走同一个钩子，所以被接管后
 *   PiDeck 的圆环按钮 / `/compact` 只会拿到一条 `Compaction cancelled`。
 * - Magic Context（`@cortexkit/pi-magic-context`，0.42.5 实测）默认接管：
 *   `if (!compactionOff) return { cancel: true }`，其中 `compactionOff = config.compaction?.enabled === false`
 *   （**缺省即接管**；且它只认用户级配置，项目级 `compaction.enabled` 被它主动忽略以防克隆仓库劫持）。
 *   **接管与 historian 是否配好模型无关**——没配 historian.pi.model 时它照样 cancel，
 *   此时「pi 压不了 + 它自己也压不了」= 上下文只增不减，这是最需要提示用户的状态。
 * - 它的手动入口是扩展命令 `/ctx-wrapup [messages_to_keep]`（pi 的 `prompt` 会直接执行扩展命令，
 *   不进 agent run；见 dist/core/agent-session.js 的 `_tryExecuteExtensionCommand`）。
 * - billion-context-pi 同样 `cancel: true` 且**没有**手动命令，因此只能提示、不能改写动作。
 */

export type PiCompactionOwnerId = "magic-context" | "billion-context";

/** 识别用的 npm 包名（settings.json packages 里是 `npm:<名>[@版本]`）。 */
const OWNER_PACKAGE_NAMES: Record<PiCompactionOwnerId, string> = {
	"magic-context": "@cortexkit/pi-magic-context",
	"billion-context": "billion-context-pi",
};

/** Magic Context 的手动压缩命令（`pi registerCommand("ctx-wrapup")`）。 */
export const MAGIC_CONTEXT_WRAPUP_COMMAND = "/ctx-wrapup";

/** Magic Context 用户级配置（项目级 compaction.enabled 会被 MC 自己忽略，故只读这一个）。 */
export const MAGIC_CONTEXT_CONFIG_RELATIVE_PATH = join(".config", "cortexkit", "magic-context.jsonc");

/** billion-context-pi 的开关（`~/.pi/acp.json`，`enabled:false` 时不注册钩子）。 */
export const BILLION_CONTEXT_CONFIG_RELATIVE_PATH = join(".pi", "acp.json");

export type PiCompactionOwnership = {
	/** 会 cancel pi 压缩的扩展（按固定顺序，便于测试与日志比对）。 */
	owners: PiCompactionOwnerId[];
	/** 同时装了多个接管者：它们互相覆盖同一份消息列表，属已知危险配置。 */
	conflicted: boolean;
	/** pi 自身的自动压缩开关（settings.json compaction.enabled，缺省 true）。 */
	piAutoCompactionEnabled: boolean;
	/** 接管者自己的手动压缩命令（目前只有 magic-context 提供）。 */
	manualCommand?: string;
	/** 接管者是否具备压缩能力（MC：historian 模型已配；BC：恒 true，靠模型工具压缩）。 */
	ownerReady: boolean;
	/** 面向日志/提示的说明片段（已按需拼好，便于直接展示）。 */
	notes: string[];
};

export type PiCompactionOwnershipInput = {
	/** settings.json 的 packages（原样传，兼容 `npm:x@1` 与 `{source}` 两种写法）。 */
	packages?: unknown;
	/**
	 * 本次会话**实际会加载**的接管者名单（由扩展白名单解析出的路径反推，见
	 * `ownerNamesLoadedInPaths`）。给了它就以它为准——PiDeck 扩展管理里禁用的扩展
	 * 不会出现在这个名单里，此时磁盘 packages 里的记录不能当作「已接管」。
	 */
	loadedOwnerNames?: string[];
	/** settings.json 的 disabledExtensions（pi 侧禁用名单，命中的包不参与接管）。 */
	disabledExtensions?: unknown;
	/** settings.json 的 compaction 对象（pi 自身压缩设置）。 */
	piCompaction?: unknown;
	/** 用户级 Magic Context 配置（解析后的对象；缺失/坏文件传 null）。 */
	magicContextConfig?: unknown;
	/** `~/.pi/acp.json`（billion-context-pi）。 */
	billionContextConfig?: unknown;
	/** 已安装扩展的 npm 包名（settings.json packages 解析结果，直接传可跳过 package 解析）。 */
	installedPackageNames?: string[];
	/** 运行中会话 `get_commands` 返回的扩展命令名（可选：用于确认手动命令本次真的可用）。 */
	sessionCommandNames?: string[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** `npm:@cortexkit/pi-magic-context@0.42.5` / `@cortexkit/pi-magic-context` → 包名。 */
export function packageNameFromSource(source: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	const withoutPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
	if (withoutPrefix.startsWith("@")) {
		const slash = withoutPrefix.indexOf("/");
		if (slash < 0) return undefined;
		const at = withoutPrefix.indexOf("@", slash);
		return at < 0 ? withoutPrefix : withoutPrefix.slice(0, at);
	}
	const at = withoutPrefix.indexOf("@");
	return at <= 0 ? withoutPrefix : withoutPrefix.slice(0, at);
}

/** 从 settings.json 的 packages 数组收集包名（字符串与 `{source}` 两种形态）。 */
export function collectPackageNames(packages: unknown): string[] {
	if (!Array.isArray(packages)) return [];
	const names: string[] = [];
	for (const entry of packages) {
		const source = typeof entry === "string" ? entry : nonEmptyString(asRecord(entry)?.source);
		if (!source) continue;
		const name = packageNameFromSource(source);
		if (name) names.push(name);
	}
	return names;
}

/**
 * 从「本次会话实际会加载的扩展入口路径」反推接管者。
 *
 * 路径列表缺失（null/undefined，如拿不到项目 cwd）时返回 undefined 让调用方退回
 * packages 推导；否则**以路径为准**：被原生规则（或旧禁用记录）停用的扩展不会出现
 * 在路径集合里，磁盘 packages 的残留记录不能算「已接管」。
 */
export function ownerNamesLoadedInPaths(paths: string[] | null): string[] | undefined {
	if (paths === null) return undefined;
	const normalized = paths.map((path) => path.split("\\").join("/").toLowerCase());
	const owners: string[] = [];
	for (const [id, name] of Object.entries(OWNER_PACKAGE_NAMES)) {
		const needle = `/${name.toLowerCase()}/`;
		if (normalized.some((path) => path.includes(needle))) owners.push(id as PiCompactionOwnerId);
	}
	return owners;
}

function historianModelConfigured(config: unknown): boolean {
	const root = asRecord(config);
	if (!root) return false;
	const historian = asRecord(root.historian);
	if (!historian) return false;
	for (const harness of ["pi", "omp"] as const) {
		const block = asRecord(historian[harness]);
		if (block && (nonEmptyString(block.model) || Array.isArray(block.fallback_models))) return true;
	}
	// 兼容早期把 model 写在 historian 顶层的配置（MC 会就地迁移，但读到时仍应识别）。
	return nonEmptyString(historian.model) !== undefined;
}

/**
 * 纯函数：由「已安装包 + 各自配置 + 会话命令」推出接管状态。
 * 不碰文件系统，便于对配置矩阵做穷举测试。
 */
export function resolvePiCompactionOwnership(input: PiCompactionOwnershipInput): PiCompactionOwnership {
	const installed = new Set((input.installedPackageNames ?? collectPackageNames(input.packages)).map((name) => name.trim()));
	const disabled = new Set((Array.isArray(input.disabledExtensions) ? input.disabledExtensions : []).filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()));
	const hasPackage = (id: PiCompactionOwnerId) => {
		const name = OWNER_PACKAGE_NAMES[id];
		return installed.has(name) && !disabled.has(name);
	};

	const magicConfig = asRecord(input.magicContextConfig);
	const magicGloballyEnabled = magicConfig?.enabled !== false;
	const magicOwnsCompaction = magicConfig?.compaction == null ? true : asRecord(magicConfig.compaction)?.enabled !== false;
	// loadedOwnerNames（会话实际加载名单）优先于磁盘 packages：扩展管理里禁用的
	// 扩展不会出现在加载名单里，此时不能按「装了=接管」判定。
	const magicInstalled = input.loadedOwnerNames !== undefined ? input.loadedOwnerNames.includes("magic-context") : hasPackage("magic-context");
	const magicActive = magicInstalled && magicGloballyEnabled && magicOwnsCompaction;

	const billionConfig = asRecord(input.billionContextConfig);
	const billionInstalled = input.loadedOwnerNames !== undefined ? input.loadedOwnerNames.includes("billion-context") : hasPackage("billion-context");
	const billionActive = billionInstalled && billionConfig?.enabled !== false;

	const owners: PiCompactionOwnerId[] = [];
	if (magicActive) owners.push("magic-context");
	if (billionActive) owners.push("billion-context");

	const sessionCommands = input.sessionCommandNames ? new Set(input.sessionCommandNames.map((name) => name.replace(/^\//, "").trim())) : undefined;
	const manualCommandAvailable = magicActive && (sessionCommands === undefined || sessionCommands.has(MAGIC_CONTEXT_WRAPUP_COMMAND.slice(1)));

	const historianReady = historianModelConfigured(magicConfig);
	const piAutoCompactionEnabled = asRecord(input.piCompaction)?.enabled !== false;

	const notes: string[] = [];
	if (magicActive && !historianReady) {
		notes.push("Magic Context 接管了上下文窗口，但没有配置 historian 模型：它既会取消 pi 的压缩，自己也无法压缩（上下文只增不减）");
	}
	if (magicActive && !manualCommandAvailable) {
		notes.push("本次会话未注册 /ctx-wrapup，无法改用它压缩");
	}
	if (owners.length > 1) {
		notes.push("同时安装了多个会取消 pi 压缩的扩展：它们会互相覆盖同一份上下文，建议只保留一个");
	}
	if (owners.length > 0 && piAutoCompactionEnabled) {
		notes.push("pi 设置里 compaction.enabled=true，但自动压缩会被接管者取消");
	}

	return {
		owners,
		conflicted: owners.length > 1,
		piAutoCompactionEnabled,
		manualCommand: manualCommandAvailable ? MAGIC_CONTEXT_WRAPUP_COMMAND : undefined,
		ownerReady: owners.length === 0 ? true : owners.every((id) => (id === "magic-context" ? historianReady : true)),
		notes,
	};
}

/**
 * 容错 JSONC 解析：Magic Context 的配置是 `.jsonc`（允许注释与尾随逗号），
 * 直接用 JSON.parse 会失败并把「已接管」误判成「没接管」。
 */
export function parseJsonc(text: string): unknown {
	const stripped = stripJsonComments(text)
		.replace(/,(\s*[}\]])/g, "$1")
		.replace(/^\uFEFF/, "");
	try {
		return JSON.parse(stripped);
	} catch {
		return null;
	}
}

/** 去掉字符串外的 `//` 与 `/* *​/` 注释（保留字符串内的内容与转义）。 */
function stripJsonComments(text: string): string {
	let result = "";
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const next = text[index + 1];
		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				result += char;
			}
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				index += 1;
			}
			continue;
		}
		if (inString) {
			result += char;
			if (char === "\\") {
				result += next ?? "";
				index += 1;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			result += char;
			continue;
		}
		if (char === "/" && next === "/") {
			inLineComment = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			index += 1;
			continue;
		}
		result += char;
	}
	return result;
}

export type PiCompactionOwnershipPaths = {
	agentDir: string;
	agentSettingsFile: string;
	magicContextConfigFile: string;
	billionContextConfigFile: string;
};

export function resolvePiCompactionOwnershipPaths(agentHomeDir?: string): PiCompactionOwnershipPaths {
	const home = agentHomeDir?.trim() || homedir();
	const agentDir = join(home, ".pi", "agent");
	return {
		agentDir,
		agentSettingsFile: join(agentDir, "settings.json"),
		magicContextConfigFile: join(home, MAGIC_CONTEXT_CONFIG_RELATIVE_PATH),
		billionContextConfigFile: join(home, BILLION_CONTEXT_CONFIG_RELATIVE_PATH),
	};
}

function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function readJsoncFile(file: string): unknown {
	try {
		return parseJsonc(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** 小文件（settings.json / 两个配置）按 (mtime,size) 缓存，压缩点击路径上不做多余 IO。 */
const fileCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

function readCached(file: string, read: (path: string) => unknown): unknown {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(file);
	} catch {
		fileCache.delete(file);
		return null;
	}
	const cached = fileCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
	const value = read(file);
	fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
	return value;
}

/** 清空缓存（配置刚被写盘 / 测试隔离用）。 */
export function invalidatePiCompactionOwnershipCache(): void {
	fileCache.clear();
}

/**
 * 从磁盘读接管状态。
 * @param sessionCommandNames 运行中会话 `get_commands` 的扩展命令名；给了才能确认 /ctx-wrapup 本次可用。
 * @param loadedExtensionPaths 本次会话实际会加载的扩展入口路径（`resolveEnabledExtensionPaths()` 的
 *   结果；null=无白名单全量加载，undefined=解析器不可用）。给了就以它判定「装了且启用」，
 *   PiDeck 扩展管理里禁用的扩展不会误判成接管者。
 * @param projectCwd 项目根（project 级 settings.json 也能加包；MC 的 compaction.enabled 项目级仍被忽略）。
 */
export function readPiCompactionOwnership(options: { agentHomeDir?: string; projectCwd?: string; sessionCommandNames?: string[]; loadedExtensionPaths?: string[] | null } = {}): PiCompactionOwnership {
	const paths = resolvePiCompactionOwnershipPaths(options.agentHomeDir);
	const agentSettings = asRecord(readCached(paths.agentSettingsFile, readJsonFile)) ?? {};
	const projectSettings = options.projectCwd ? (asRecord(readCached(join(options.projectCwd, ".pi", "settings.json"), readJsonFile)) ?? {}) : {};
	const packages = [...collectPackageNames(agentSettings.packages), ...collectPackageNames(projectSettings.packages)];
	const disabledExtensions = [...readStringArray(agentSettings, "disabledExtensions"), ...readStringArray(projectSettings, "disabledExtensions")];
	return resolvePiCompactionOwnership({
		installedPackageNames: packages,
		loadedOwnerNames: options.loadedExtensionPaths === undefined ? undefined : ownerNamesLoadedInPaths(options.loadedExtensionPaths ?? null),
		disabledExtensions,
		piCompaction: agentSettings.compaction ?? projectSettings.compaction,
		magicContextConfig: existsSync(paths.magicContextConfigFile) ? readCached(paths.magicContextConfigFile, readJsoncFile) : null,
		billionContextConfig: existsSync(paths.billionContextConfigFile) ? readCached(paths.billionContextConfigFile, readJsonFile) : null,
		sessionCommandNames: options.sessionCommandNames,
	});
}
