/**
 * PiDeck Security Gate Extension
 *
 * 安全门执行器：按桌面端写入的策略快照（PIDECK_SECURITY_CONFIG 指向的 JSON）
 * 在 tool_call 事件上执行拦截/确认。
 *
 * 设计约束：
 * - 本文件必须自包含：只能依赖 @earendil-works/pi-coding-agent 与 node 内置模块，
 *   不允许 import PiDeck 源码（扩展在 pi 进程内加载，不共享打包产物）。
 * - 与主进程的契约 = 策略快照 schema（src/shared/types/security.ts 的
 *   SecurityPolicySnapshot）。schemaVersion 不匹配时本扩展保守降级：fail-safe 放行
 *   还是拒绝由配置语义决定——enabled=false 放行；快照不可读时放行并记日志。
 * - 运行时热更新：每次 tool_call 前 stat 快照文件，mtime 变化即重读（带节流），
 *   因此输入框切换会话等级无需重启 agent 即可生效。
 *
 * 动作语义（与主进程 policy.ts 保持一致）：
 * - 工具动作：level.toolActions[tool] ?? level.defaultAction
 * - 危险 bash 命令（命中 denyBashPatterns）：
 *   toolActions.bash === "allow" → 放行；defaultAction === "deny" → 直接拒绝；
 *   其余 → 弹窗询问（先确认再放行）。
 * - 文件访问：denyDirs 黑名单 > 敏感文件保护 > pathPolicy 目录边界，命中即拒绝。
 * - 只管控内置工具（read/write/edit/bash/grep/find/ls）+ ask_question，
 *   其它自定义工具（web_search/todo 等）不受影响，避免破坏用户其它扩展。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

// ── 快照 schema（与 shared/types/security.ts 对齐；扩展侧自包含副本） ──

type SecurityAction = "allow" | "ask" | "deny";
type SecurityPathPolicy = "unrestricted" | "workspace" | "custom";

type SecurityLevelConfig = {
	id: string;
	name: string;
	description: string;
	builtin?: boolean;
	toolActions: Partial<Record<string, SecurityAction>>;
	denyBashPatterns: string[];
	pathPolicy: SecurityPathPolicy;
	customAllowDirs: string[];
	denyDirs: string[];
	protectSensitivePaths: boolean;
	defaultAction: SecurityAction;
};

type SecurityPolicySnapshot = {
	schemaVersion: number;
	enabled: boolean;
	defaultLevelId: string;
	levels: SecurityLevelConfig[];
	sessionLevels: Record<string, string>;
};

// ── 常量 ──

const SCHEMA_VERSION = 1;
/** 受管控的内置工具（其它自定义工具一律放行） */
const MANAGED_TOOLS = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	"ask_question",
]);
/** 敏感路径模式（与主进程 DEFAULT_SENSITIVE_PATH_PATTERNS 对齐） */
const SENSITIVE_PATH_PATTERNS = [
	"(^|[\\\\/])\\.env([.$]|$)",
	"(^|[\\\\/])\\.git([\\\\/]|$)",
	"(^|[\\\\/])(id_rsa|id_ed25519|id_ecdsa)(\\.pub)?$",
	"(^|[\\\\/])\\.(npmrc|yarnrc|pnpm-workspace)([.$]|$)",
	"(\\.pem|\\.key|\\.p12)$",
];

// ── 快照加载（带 mtime 热更新） ──

let snapshot: SecurityPolicySnapshot | null = null;
let snapshotPath = "";
let sessionId = "";
let lastLoadedAt = 0;
let lastLoadedMtime = 0;
/** 节流窗口：快照文件小，stat 每 2s 最多一次，避免高频工具调用时反复读盘 */
const RELOAD_THROTTLE_MS = 2000;

/**
 * 加载策略快照：
 * - 2s 内且 mtime 未变 → 用缓存（每次 tool_call 只做一次 stat）；
 * - mtime 变化 → 立即重读（会话等级切换 ≤2s 生效）；
 * - 文件缺失 / schema 不匹配 / 解析失败 → 返回 null（调用方按 fail-safe 处理）。
 */
function loadSnapshot(): SecurityPolicySnapshot | null {
	const now = Date.now();
	try {
		if (!snapshotPath || !existsSync(snapshotPath)) {
			snapshot = null;
			return null;
		}
		const mtime = statSync(snapshotPath).mtimeMs;
		if (snapshot && mtime === lastLoadedMtime && now - lastLoadedAt < RELOAD_THROTTLE_MS) {
			return snapshot;
		}
		lastLoadedAt = now;
		lastLoadedMtime = mtime;
		const raw = readFileSync(snapshotPath, "utf8");
		const parsed = JSON.parse(raw) as SecurityPolicySnapshot;
		if (parsed.schemaVersion !== SCHEMA_VERSION) {
			// schema 升级：旧快照不再可信，fail-safe 放行（配置语义由主进程迁移保证）
			snapshot = null;
			return null;
		}
		snapshot = parsed;
		return snapshot;
	} catch {
		snapshot = null;
		return null;
	}
}

// ── 纯规则求值（与主进程 src/main/security/policy.ts 语义一致） ──

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathInsideRoot(target: string, root: string): boolean {
	const t = normalizePath(target).toLowerCase();
	const r = normalizePath(root).toLowerCase();
	if (!r || r === "/") return true;
	if (t === r) return true;
	return t.startsWith(r + "/");
}

function matchesSensitivePath(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	return SENSITIVE_PATH_PATTERNS.some((pattern) => {
		try {
			return new RegExp(pattern).test(normalized);
		} catch {
			return false;
		}
	});
}

function resolveLevel(config: SecurityPolicySnapshot, levelId: string): SecurityLevelConfig | null {
	return (
		config.levels.find((level) => level.id === levelId) ??
		config.levels.find((level) => level.id === "standard") ??
		config.levels[0] ??
		null
	);
}

/** 文件访问边界求值：命中黑名单/敏感/越界 → deny；否则 null（交给工具动作决定） */
function evaluatePathAction(
	level: SecurityLevelConfig,
	filePath: string,
	cwd: string,
): SecurityAction | null {
	for (const dir of level.denyDirs) {
		if (isPathInsideRoot(filePath, dir)) return "deny";
	}
	if (level.protectSensitivePaths && matchesSensitivePath(filePath)) return "deny";
	if (level.pathPolicy === "unrestricted") return null;
	if (cwd && isPathInsideRoot(filePath, cwd)) return null;
	if (level.pathPolicy === "custom") {
		for (const dir of level.customAllowDirs) {
			if (isPathInsideRoot(filePath, dir)) return null;
		}
	}
	return "deny";
}

/** bash 危险命令求值：命中返回 true（动作组合见 filePolicy 注释 / 下方 bashAction） */
function matchesBashDeny(level: SecurityLevelConfig, command: string): boolean {
	return level.denyBashPatterns.some((pattern) => {
		try {
			return new RegExp(pattern).test(command);
		} catch {
			return false;
		}
	});
}

/** 计算 bash 命令最终动作 */
function bashAction(level: SecurityLevelConfig, command: string): SecurityAction {
	const dangerous = matchesBashDeny(level, command);
	const toolAction = level.toolActions["bash"] ?? level.defaultAction;
	if (!dangerous) return toolAction;
	// 危险命令：显式放行 bash → 放行；严格兜底(deny) → 直接拒绝；其余 → 先确认
	if (toolAction === "allow") return "allow";
	if (level.defaultAction === "deny") return "deny";
	return "ask";
}

/** 计算文件工具最终动作：路径边界优先，其次工具动作 */
function fileToolAction(
	level: SecurityLevelConfig,
	tool: string,
	filePath: string | undefined,
	cwd: string,
): SecurityAction {
	if (filePath) {
		const pathAction = evaluatePathAction(level, filePath, cwd);
		if (pathAction) return pathAction;
	}
	return level.toolActions[tool] ?? level.defaultAction;
}

/**
 * 从工具入参中提取文件路径（read/write/edit 有路径字段；grep/find/ls 可选 path）。
 *
 * 注意 pi 各工具的文件字段名不一致：read 与 write/edit 一样用 filePath（见
 * main/feishu 对真实工具事件的解析 toolInputPreview / toolInputSummary），
 * 不是 path。这里做白名单 + 多字段兑底：漏提取 = 目录边界策略被跳过 =
 * 工作目录外的读写被放行（严格等级形同虚设）。
 */
function extractFilePath(tool: string, input: Record<string, unknown>): string | undefined {
	const firstString = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = input[key];
			if (typeof value === "string" && value.length > 0) return value;
		}
		return undefined;
	};
	switch (tool) {
		case "read":
			return firstString("filePath", "path", "file");
		case "write":
		case "edit":
			return firstString("filePath", "path", "file");
		case "grep":
		case "find":
		case "ls":
			// grep/find/ls 的目录字段为 path（可选，缺省搜工作目录）
			return firstString("path", "directory", "filePath");
		default:
			return undefined;
	}
}

/** 绝对路径化：相对路径基于 cwd 解析（与 pi 工具语义一致） */
function absolutize(p: string, cwd: string): string {
	if (isAbsolute(p)) return p;
	return resolve(cwd, p);
}

// ── UI 确认 ──

const UI_ALLOW = "允许执行";
const UI_DENY = "拒绝";
/**
 * 桌面端识别安全确认请求的标题前缀：渲染层据此渲染专用确认卡（工具名 + 等级 +
 * 详情 + 允许/拒绝），而不是把它当成普通 ask 摘要折叠。前缀后跟 JSON 负载
 * {tool, level, detail}，避免详情里的换行/竖线干扰解析。
 */
const SECURITY_CONFIRM_MARKER = "[PI_DECK_SECURITY_CONFIRM]";

/**
 * 弹窗确认。RPC 模式下取消/无 UI 一律拒绝（fail-safe）。
 * 返回 true = 放行。
 * 结构化负载（非拼接多行字符串）：桌面端能把「审批什么」展开成独立详情区，
 * 而不是被两行摘要吞掉；旧版/非桌面客户端仍能用 options 兜底。
 */
async function confirmAction(
	ctx: ExtensionContext,
	tool: string,
	detail: string,
	levelName: string,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	try {
		const payload = JSON.stringify({
			tool,
			level: levelName,
			detail: detail.slice(0, 2000),
		});
		const choice = await ctx.ui.select(`${SECURITY_CONFIRM_MARKER}${payload}`, [
			UI_ALLOW,
			UI_DENY,
		]);
		return choice === UI_ALLOW;
	} catch {
		// UI 通道异常（如桌面端已关闭弹窗）→ 拒绝，宁可错杀不可放过
		return false;
	}
}

// ── 系统提示注入：让 agent 提前知道边界，减少无效尝试 ──

function buildSecurityHint(level: SecurityLevelConfig): string | undefined {
	if (level.id === "off") return undefined;
	const lines: string[] = [
		"当前会话启用了桌面端安全管理（等级: " + level.name + "）。",
	];
	if (level.pathPolicy === "workspace" || level.pathPolicy === "custom") {
		lines.push("文件读写仅限工作目录" + (level.pathPolicy === "custom" ? "及显式允许的目录" : "") + "，工作目录之外的文件访问会被拒绝。");
	}
	if (level.denyBashPatterns.length > 0) {
		lines.push("部分危险命令（如 rm -rf、chmod 777、sudo、git push 等）会被拦截或要求用户确认。");
	}
	if (level.protectSensitivePaths) {
		lines.push(".env / .git / 密钥文件等敏感路径受保护，读写会被拒绝。");
	}
	return lines.join("\n");
}

type SystemPromptSections = Record<string, string>;

/**
 * pi 1.x 的 before_agent_start 事件带可变 systemPromptOptions.sections（后续 handler 能看见前面
 * 写入的内容）；旧宿主没有该字段，调用方要保留自己的回退路径。
 */
function readSystemPromptSections(event: { systemPromptOptions?: { sections?: SystemPromptSections } }): SystemPromptSections | undefined {
	const sections = event.systemPromptOptions?.sections;
	return sections && typeof sections === "object" ? sections : undefined;
}

// ── 入口 ──

export default async function securityGateExtension(pi: ExtensionAPI) {
	snapshotPath = process.env.PIDECK_SECURITY_CONFIG ?? "";
	sessionId = process.env.PIDECK_SESSION_ID ?? "";

	if (!snapshotPath) {
		// 桌面端未注入配置路径（旧版本 PiDeck / 独立 CLI 运行）：完全放行
		return;
	}

	pi.on("before_agent_start", (event, ctx) => {
		const config = loadSnapshot();
		if (!config?.enabled) return undefined;
		const levelId = config.sessionLevels[sessionId] ?? config.defaultLevelId;
		const level = resolveLevel(config, levelId);
		if (!level) return undefined;
		const hint = buildSecurityHint(level);
		if (!hint) return undefined;
		// 写系统提示 section：返回 systemPrompt 是 force 语义（整体替换本轮提示），会把提示定死成
		// 一整块字符串，排在后面的扩展（caveman / ptc-meter 等）对 sections 的写入全部丢失
		// （issue #365-08）。section 只在本次运行生效，等级关闭后自动消失，无需清理。
		const sections = readSystemPromptSections(event);
		if (sections) {
			sections["pi_deck_security"] = hint;
			return undefined;
		}
		// 旧宿主没有 sections：退回 force 追加。基准必须非空，否则会把整条系统提示覆盖成
		// 「只剩安全提示」（issue #357-04）。宁可不注入这条边界提示，也不能毁掉系统提示。
		const base = ctx.getSystemPrompt?.();
		if (!base) return undefined;
		return { systemPrompt: base + "\n\n" + hint };
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		// 热更新：快照 mtime 变化即重读（≤2s），会话等级切换无需重启
		const config = loadSnapshot();
		if (!config?.enabled) return undefined;

		const tool = event.toolName;
		// 只管控内置工具；自定义工具（web_search/todo/vision 等）放行，避免破坏用户扩展
		if (!MANAGED_TOOLS.has(tool)) return undefined;

		const levelId = config.sessionLevels[sessionId] ?? config.defaultLevelId;
		const level = resolveLevel(config, levelId);
		if (!level || level.id === "off") return undefined;

		const input = event.input as Record<string, unknown>;
		let action: SecurityAction;

		if (tool === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			action = bashAction(level, command);
		} else {
			const filePath = extractFilePath(tool, input);
			action = fileToolAction(
				level,
				tool,
				filePath ? absolutize(filePath, ctx.cwd) : undefined,
				ctx.cwd,
			);
		}

		if (action === "allow") return undefined;

		if (action === "deny") {
			const target = tool === "bash"
				? (typeof input.command === "string" ? input.command.slice(0, 200) : "")
				: (typeof input.filePath === "string" || typeof input.path === "string"
					? String(input.filePath ?? input.path)
					: "");
			return {
				block: true,
				reason: `[安全管理·${level.name}] ${tool} 调用被拒绝${target ? `: ${target}` : ""}`,
			};
		}

		// action === "ask"：弹窗确认
		const target = tool === "bash"
			? (typeof input.command === "string" ? input.command : "")
			: (typeof input.filePath === "string" || typeof input.path === "string"
				? String(input.filePath ?? input.path)
				: "");
		const allowed = await confirmAction(ctx, tool, target, level.name);
		if (allowed) return undefined;
		return {
			block: true,
			reason: `[安全管理·${level.name}] ${tool} 调用已被用户拒绝${target ? `: ${target}` : ""}`,
		};
	});
}
