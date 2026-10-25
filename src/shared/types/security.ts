/**
 * PiDeck 安全管理契约（shared/types/security.ts）
 *
 * 安全门 = 「桌面端安全配置」 + 「pi-deck-security-gate 扩展」 两端协作：
 * - 本文件定义两端共享的数据结构（等级配置 / 策略快照）；
 * - 配置持久化在 AppSettings.securityConfig（settings.json）；
 * - 主进程每次变更后把「策略快照」写入 userData/security-policy.json，
 *   扩展通过 PIDECK_SECURITY_CONFIG 环境变量拿到快照路径，PIDECK_SESSION_ID 拿到会话身份。
 *
 * 设计原则：
 * 1. 默认启用安全门（enabled=true），默认等级 off（完全放行）：老用户零感知，开箱即用；
 * 2. 等级（Level）是一等公民：内置 off/standard/strict 三档 + 用户自定义；
 * 3. 每个等级独立声明「工具动作」「bash 危险命令」「文件目录边界」「兜底动作」；
 * 4. 会话级覆盖：sessionId → levelId，输入框切换即时生效（快照重读）。
 */

/** 受管控的内置工具全集（pi 内置 7 个 + PiDeck 提问工具） */
export type SecurityToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls" | "ask_question";

export const SECURITY_TOOLS: readonly SecurityToolName[] = ["read", "write", "edit", "bash", "grep", "find", "ls", "ask_question"];

/** 文件/目录访问边界模式 */
export type SecurityPathPolicy = "unrestricted" | "workspace" | "custom";

/** 命中规则后的动作 */
export type SecurityAction = "allow" | "ask" | "deny";

/** 内置等级 id（不可删除；custom 等级由用户创建） */
export type BuiltinSecurityLevelId = "off" | "standard" | "strict";

/** 单个等级配置。id 全局唯一（内置 3 个 + 用户自定义）。 */
export type SecurityLevelConfig = {
	id: string;
	name: string;
	description: string;
	/** 内置等级不允许删除/改 id */
	builtin?: boolean;
	/**
	 * 工具级动作表：tool → allow/ask/deny。
	 * 未列出的工具默认「放行」——但 bash 例外：
	 * bash 命中 denyBashPatterns 时，行为取 toolActions.bash ?? defaultAction（拒绝优先）。
	 */
	toolActions: Partial<Record<SecurityToolName, SecurityAction>>;
	/**
	 * bash 危险命令正则（正则源字符串，扩展侧 new RegExp）。
	 * 命中后动作 = toolActions.bash 若为 deny/ask 则取之，否则 defaultAction。
	 * 为空数组表示该等级不拦截任何 bash 命令。
	 */
	denyBashPatterns: string[];
	/** 文件访问边界：workspace=仅工作目录；custom=工作目录 + customAllowDirs；unrestricted=不限制 */
	pathPolicy: SecurityPathPolicy;
	/** pathPolicy=custom 时的附加允许目录（绝对路径；相对路径视为相对工作目录） */
	customAllowDirs: string[];
	/** 始终禁止访问的目录（黑名单，优先级高于一切 allow 判定） */
	denyDirs: string[];
	/** 敏感文件保护：.env / .git / 密钥文件等始终拒绝读取与写入 */
	protectSensitivePaths: boolean;
	/** 未命中任何规则时的兜底动作（严格等级=deny，标准=allow） */
	defaultAction: SecurityAction;
};

/** 完整安全配置（持久化于 AppSettings.securityConfig） */
export type SecurityConfig = {
	/** 总开关：false 时扩展完全放行（等价于未安装扩展），且不读快照 */
	enabled: boolean;
	/** 全局默认等级 id，未设置会话级覆盖时使用 */
	defaultLevelId: string;
	/** 等级列表（内置 3 个 + 自定义） */
	levels: SecurityLevelConfig[];
	/** 会话级覆盖：会话文件路径(sessionId) → 等级 id */
	sessionOverrides: Record<string, string>;
};

/** 内置默认等级（工厂函数：每次返回全新副本，避免共享引用被 UI 修改） */
export function createDefaultSecurityLevels(): SecurityLevelConfig[] {
	return [
		{
			id: "off",
			name: "关闭",
			description: "完全放行所有工具调用，等同未启用安全管理。",
			builtin: true,
			toolActions: {},
			denyBashPatterns: [],
			pathPolicy: "unrestricted",
			customAllowDirs: [],
			denyDirs: [],
			protectSensitivePaths: false,
			defaultAction: "allow",
		},
		{
			id: "standard",
			name: "标准",
			description: "危险命令先确认，敏感文件受保护，目录不限制。",
			builtin: true,
			toolActions: { bash: "ask" },
			denyBashPatterns: DEFAULT_DENY_BASH_PATTERNS,
			pathPolicy: "unrestricted",
			customAllowDirs: [],
			denyDirs: [],
			protectSensitivePaths: true,
			defaultAction: "allow",
		},
		{
			id: "strict",
			name: "严格",
			description: "只读为主，写操作逐一确认；危险命令直接拒绝；文件访问仅限工作目录。",
			builtin: true,
			toolActions: {
				read: "allow",
				grep: "allow",
				find: "allow",
				ls: "allow",
				write: "ask",
				edit: "ask",
				bash: "ask",
				ask_question: "allow",
			},
			denyBashPatterns: DEFAULT_DENY_BASH_PATTERNS,
			pathPolicy: "workspace",
			customAllowDirs: [],
			denyDirs: [],
			protectSensitivePaths: true,
			defaultAction: "deny",
		},
	];
}

/** 默认危险 bash 命令模式（正则源字符串；与 plan-mode 的 DESTRUCTIVE_PATTERNS 同源扩展） */
export const DEFAULT_DENY_BASH_PATTERNS: string[] = [
	"\\brm\\s+-[a-z]*[rf]",
	"\\brmdir\\b",
	"\\bmv\\b",
	"\\bcp\\b",
	"\\bchmod\\b",
	"\\bchown\\b",
	"\\btee\\b",
	"\\btruncate\\b",
	"(^|[^<])>(?!>)",
	">>",
	"\\bnpm\\s+(install|uninstall|update|ci|link|publish)",
	"\\byarn\\s+(add|remove|install|publish)",
	"\\bpnpm\\s+(add|remove|install|publish)",
	"\\bpip\\s+(install|uninstall)",
	"\\bgit\\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)",
	"\\bsudo\\b",
	"\\bkill\\b",
	"(vim|nano|emacs|code|subl)\\b",
];

/** 默认敏感路径（相对文件名匹配；保护 .env / 密钥 / git 元数据） */
export const DEFAULT_SENSITIVE_PATH_PATTERNS: string[] = ["(^|[\\\\/])\\.env([.$]|$)", "(^|[\\\\/])\\.git([\\\\/]|$)", "(^|[\\\\/])(id_rsa|id_ed25519|id_ecdsa)(\\.pub)?$", "(^|[\\\\/])\\.(npmrc|yarnrc|pnpm-workspace)([.$]|$)", "(\\.pem|\\.key|\\.p12)$"];

/** 默认配置工厂：enabled=true（安全门默认启用）+ 默认等级 off（完全放行，行为零干预） */
export function createDefaultSecurityConfig(): SecurityConfig {
	return {
		enabled: true,
		defaultLevelId: "off",
		levels: createDefaultSecurityLevels(),
		sessionOverrides: {},
	};
}

/**
 * 策略快照：主进程写给扩展的只读契约（userData/security-policy.json）。
 * 扩展不 import 本文件（扩展必须自包含），schemaVersion 用于双向校验。
 */
export type SecurityPolicySnapshot = {
	schemaVersion: 1;
	enabled: boolean;
	defaultLevelId: string;
	levels: SecurityLevelConfig[];
	/** 会话级覆盖：会话文件路径 → 等级 id */
	sessionLevels: Record<string, string>;
};

/** 扩展通过环境变量读取的键名 */
export const SECURITY_ENV_CONFIG_PATH = "PIDECK_SECURITY_CONFIG";
export const SECURITY_ENV_SESSION_ID = "PIDECK_SESSION_ID";

/** 工具中文名（渲染层展示用；i18n key 见 security.*） */
export const SECURITY_TOOL_LABELS: Record<SecurityToolName, string> = {
	read: "读取文件",
	write: "写入文件",
	edit: "编辑文件",
	bash: "执行命令",
	grep: "搜索内容",
	find: "查找文件",
	ls: "列目录",
	ask_question: "提问用户",
};
