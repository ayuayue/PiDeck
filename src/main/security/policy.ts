/**
 * 安全策略纯函数（src/main/security/policy.ts）
 *
 * 主进程侧的规则求值/校验，供 SecurityStore、IPC 校验与单测使用。
 * pi-deck-security-gate 扩展内有一份自包含的等价实现（扩展不允许 import 本项目源码），
 * 两者以 SecurityPolicySnapshot 为契约：本模块负责「生成快照 + 校验快照」，
 * 扩展负责「按快照拦截」。
 */

import type {
	SecurityAction,
	SecurityConfig,
	SecurityLevelConfig,
	SecurityPolicySnapshot,
} from "../../shared/types/security";

/**
 * 敏感路径模式（本地副本，与 shared/types/security.ts 的 DEFAULT_SENSITIVE_PATH_PATTERNS
 * 及扩展内置列表对齐；保持无运行时依赖，便于 node --test 直接 import 本模块）。
 */
const SENSITIVE_PATH_PATTERNS: string[] = [
	"(^|[\\\\/])\\.env([.$]|$)",
	"(^|[\\\\/])\\.git([\\\\/]|$)",
	"(^|[\\\\/])(id_rsa|id_ed25519|id_ecdsa)(\\.pub)?$",
	"(^|[\\\\/])\\.(npmrc|yarnrc|pnpm-workspace)([.$]|$)",
	"(\\.pem|\\.key|\\.p12)$",
];

/** 路径分隔符归一化：Windows 反斜杠 → 正斜杠，便于统一比较 */
export function normalizePathForCompare(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 清洗等级内的行列表配置（denyBashPatterns / denyDirs / customAllowDirs）：
 * 逐行去首尾空白、丢弃空串。空串必须拦在持久化前——空 denyDirs 会被
 * isPathInsideRoot 当作「根为 /」从而匹配一切路径（全部 deny），
 * 空 denyBashPatterns 的 RegExp("") 匹配一切命令（全部 deny）。
 * 渲染层输入框允许保留空行（否则尾随回车被受控回填吞掉），空行在此收敛。
 */
export function sanitizeLineList(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((line) => (typeof line === "string" ? line.trim() : ""))
		.filter((line) => line !== "");
}

/** 判断 target 是否位于 root 目录之内（含等于）。Windows 忽略盘符大小写。 */
export function isPathInsideRoot(target: string, root: string): boolean {
	const t = normalizePathForCompare(target).toLowerCase();
	const r = normalizePathForCompare(root).toLowerCase();
	if (!r || r === "/") return true;
	if (t === r) return true;
	return t.startsWith(r + "/");
}

/**
 * 判断文件路径是否命中敏感文件规则。
 * 匹配规则是「文件名模式」：允许匹配完整路径任意一段（如 .env、.git 目录、密钥文件）。
 */
export function matchesSensitivePath(filePath: string): boolean {
	const normalized = normalizePathForCompare(filePath);
	return SENSITIVE_PATH_PATTERNS.some((pattern) => {
		try {
			return new RegExp(pattern).test(normalized);
		} catch {
			return false;
		}
	});
}

/**
 * 解析某会话实际生效的等级 id：
 * 会话级覆盖优先，其次全局默认，兜底内置 standard（配置损坏时保证可用）。
 */
export function resolveLevelId(config: SecurityConfig, sessionId?: string): string {
	const override = sessionId ? config.sessionOverrides[sessionId] : undefined;
	if (override) return override;
	if (config.defaultLevelId) return config.defaultLevelId;
	return "standard";
}

/** 按 id 取等级配置；找不到时回退 standard，仍无则取第一个等级（极端损坏兜底）。 */
export function resolveLevel(
	config: SecurityConfig,
	levelId: string,
): SecurityLevelConfig {
	const found = config.levels.find((level) => level.id === levelId);
	if (found) return found;
	const standard = config.levels.find((level) => level.id === "standard");
	return standard ?? config.levels[0];
}

/**
 * 校验安全配置，返回错误信息列表（空数组 = 合法）。
 * 校验点：等级 id 唯一、默认等级存在、工具动作表键合法、危险命令正则可编译。
 */
export function validateSecurityConfig(config: SecurityConfig): string[] {
	const errors: string[] = [];
	if (!Array.isArray(config.levels) || config.levels.length === 0) {
		errors.push("levels 不能为空");
		return errors;
	}
	const seen = new Set<string>();
	for (const level of config.levels) {
		if (!level.id || seen.has(level.id)) {
			errors.push(`等级 id 重复或为空: ${level.id ?? "(空)"}`);
		}
		seen.add(level.id);
		if (level.builtin && level.id !== "off" && level.id !== "standard" && level.id !== "strict") {
			errors.push(`内置等级 id 非法: ${level.id}`);
		}
		for (const [tool, action] of Object.entries(level.toolActions)) {
			if (!["read", "write", "edit", "bash", "grep", "find", "ls", "ask_question"].includes(tool)) {
				errors.push(`等级 ${level.id} 包含未知工具: ${tool}`);
			}
			if (action !== "allow" && action !== "ask" && action !== "deny") {
				errors.push(`等级 ${level.id} 工具 ${tool} 动作非法: ${action}`);
			}
		}
		for (const pattern of level.denyBashPatterns) {
			try {
				new RegExp(pattern);
			} catch {
				errors.push(`等级 ${level.id} 危险命令正则无法编译: ${pattern}`);
			}
		}
	}
	if (!config.defaultLevelId || !seen.has(config.defaultLevelId)) {
		errors.push(`默认等级不存在: ${config.defaultLevelId ?? "(空)"}`);
	}
	return errors;
}

/** 生成扩展消费的策略快照（写入 userData/security-policy.json）。 */
export function buildSnapshot(config: SecurityConfig): SecurityPolicySnapshot {
	return {
		schemaVersion: 1,
		enabled: config.enabled,
		defaultLevelId: resolveLevelId(config),
		levels: config.levels,
		sessionLevels: config.sessionOverrides,
	};
}

/**
 * 求值 bash 命令：命中危险模式 → 返回命中动作（denyBash 逻辑由调用方组合）；
 * 返回 null 表示未命中任何危险模式。
 */
export function matchBashDenyPatterns(
	level: SecurityLevelConfig,
	command: string,
): string | null {
	for (const pattern of level.denyBashPatterns) {
		try {
			if (new RegExp(pattern).test(command)) return pattern;
		} catch {
			// 非法正则已在校验阶段拦截；这里静默跳过保证扩展不因配置崩溃
		}
	}
	return null;
}

/** 求值文件访问动作：黑名单/敏感文件 → deny；目录边界外的写 → deny（读放行降级）；否则 null 由工具动作决定 */
export function evaluatePathAction(
	level: SecurityLevelConfig,
	filePath: string,
	cwd: string,
): SecurityAction | null {
	for (const dir of level.denyDirs) {
		if (isPathInsideRoot(filePath, dir)) return "deny";
	}
	if (level.protectSensitivePaths && matchesSensitivePath(filePath)) return "deny";
	if (level.pathPolicy === "unrestricted") return null;
	// workspace / custom：允许工作目录本身；custom 额外允许自定义目录
	if (cwd && isPathInsideRoot(filePath, cwd)) return null;
	if (level.pathPolicy === "custom") {
		for (const dir of level.customAllowDirs) {
			if (isPathInsideRoot(filePath, dir)) return null;
		}
	}
	return "deny";
}
