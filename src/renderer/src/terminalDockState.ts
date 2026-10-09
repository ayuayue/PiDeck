/**
 * 终端 Dock UI 状态（open / collapsed）按 owner 隔离：
 * - 有 activeAgent 时挂 agent
 * - 空项目引导页（无 agent）时挂 project
 *
 * 高度是全局一份，单独落 localStorage；open/collapsed 仅会话内记忆，
 * 避免 agents 刷新时被错误 prune 导致流式输出中途自动隐藏。
 */

import type { TerminalTarget } from "../../shared/types";
import type { TerminalConfirmCloseMode } from "../../shared/types/settings";

export type TerminalDockOwnerKind = "agent" | "project";

export type TerminalDockOwner = {
	kind: TerminalDockOwnerKind;
	id: string;
};

export type TerminalDockState = {
	open: boolean;
	collapsed: boolean;
};

/** key 形如 `agent:<id>` / `project:<id>`，避免 agentId 与 projectId 撞车 */
export type TerminalDockStateByOwner = Record<string, TerminalDockState>;

export const TERMINAL_HEIGHT_STORAGE_KEY = "pid:terminal-dock-height";
export const TERMINAL_HEIGHT_MIN = 120;

/**
 * 渲染层回放缓冲上界（字符数）：与主进程 MAX_TERMINAL_REPLAY_BUFFER
 * （TerminalSessionManager.ts，200_000）对齐——主进程回放缓冲已按此截尾，
 * 渲染层若不截尾，长跑终端会把整段历史在 buffersRef 里无限常驻。
 * 同步修改时两侧必须一起改（tests/terminalDataBatching.test.mjs 有守卫）。
 */
export const TERMINAL_REPLAY_MAX_CHARS = 200_000;

/**
 * 渲染层回放缓冲追加（纯函数，可单测）：xterm 实例在切 tab / 折叠 / 主题切换时
 * 销毁重建，buffersRef 是重建时的回放源。按字符上限截尾——重建后回放最近
 * 200K 字符（约 2500 行，xterm scrollback 5000 行本来就装不下更早的内容，
 * 且主进程 ensure() 快照同样只给最近 200K，行为两侧一致）。
 */
export function appendTerminalReplayBuffer(current: string, data: string): string {
	const next = current + data;
	return next.length > TERMINAL_REPLAY_MAX_CHARS ? next.slice(next.length - TERMINAL_REPLAY_MAX_CHARS) : next;
}

export function terminalOwnerKey(owner: TerminalDockOwner): string {
	return `${owner.kind}:${owner.id}`;
}

/**
 * 单按钮双作用域：有 agent 优先挂 agent，否则挂当前项目。
 * 与「项目空引导页也能开终端」的产品规则对齐。
 */
export function resolveTerminalOwner(activeAgentId: string | undefined, activeProjectId: string | undefined): TerminalDockOwner | undefined {
	// pending-* 只是渲染层占位 id，主进程 agents map 里还不存在。
	// 若把 Dock 挂到 pending owner 上，ensure/create 会立刻抛 Agent not found。
	if (activeAgentId && !activeAgentId.startsWith("pending-")) {
		return { kind: "agent", id: activeAgentId };
	}
	if (activeProjectId) return { kind: "project", id: activeProjectId };
	return undefined;
}

export function parseTerminalOwnerKey(key: string): TerminalDockOwner | undefined {
	const agentPrefix = "agent:";
	const projectPrefix = "project:";
	if (key.startsWith(agentPrefix)) {
		const id = key.slice(agentPrefix.length);
		return id ? { kind: "agent", id } : undefined;
	}
	if (key.startsWith(projectPrefix)) {
		const id = key.slice(projectPrefix.length);
		return id ? { kind: "project", id } : undefined;
	}
	return undefined;
}

export function setTerminalDockOpen(current: TerminalDockStateByOwner, ownerKey: string, open: boolean): TerminalDockStateByOwner {
	return {
		...current,
		[ownerKey]: {
			open,
			collapsed: current[ownerKey]?.collapsed ?? false,
		},
	};
}

export function setTerminalDockCollapsed(current: TerminalDockStateByOwner, ownerKey: string, collapsed: boolean): TerminalDockStateByOwner {
	return {
		...current,
		[ownerKey]: {
			// 折叠默认仍视为「已打开的 Dock」，避免 collapsed 写入把 open 冲成 false
			open: current[ownerKey]?.open ?? true,
			collapsed,
		},
	};
}

/**
 * 只按对应集合裁剪：agent 键对照 liveAgentIds，project 键对照 liveProjectIds。
 * 旧版 hook 曾把 agentId 直接作为 key 写入；遇到仍存活的旧 key 时原地迁成
 * `agent:<id>`，避免热更新或升级中的流式事件把已打开终端直接清掉。
 */
export function pruneTerminalDockState(current: TerminalDockStateByOwner, liveAgentIds: Set<string>, liveProjectIds: Set<string>): TerminalDockStateByOwner {
	let next: TerminalDockStateByOwner | undefined;
	for (const [key, value] of Object.entries(current)) {
		const owner = parseTerminalOwnerKey(key);
		if (!owner) {
			if (!liveAgentIds.has(key)) {
				next ??= { ...current };
				delete next[key];
				continue;
			}
			const canonicalKey = terminalOwnerKey({ kind: "agent", id: key });
			next ??= { ...current };
			if (next[canonicalKey] === undefined) next[canonicalKey] = value;
			delete next[key];
			continue;
		}
		const live = owner.kind === "agent" ? liveAgentIds.has(owner.id) : liveProjectIds.has(owner.id);
		if (!live) {
			next ??= { ...current };
			delete next[key];
		}
	}
	return next ?? current;
}

/** pending agent → 真实 agent 时，把 UI 状态迁到新 id（与其它 agent 记录迁移一致） */
export function migrateTerminalDockAgentState(current: TerminalDockStateByOwner, replacementById: Map<string, string>, liveAgentIds: Set<string>): TerminalDockStateByOwner {
	const next: TerminalDockStateByOwner = {};
	for (const [key, value] of Object.entries(current)) {
		const owner = parseTerminalOwnerKey(key);
		if (!owner) continue;
		if (owner.kind === "project") {
			next[key] = value;
			continue;
		}
		const nextAgentId = replacementById.get(owner.id) ?? owner.id;
		if (!liveAgentIds.has(nextAgentId)) continue;
		next[terminalOwnerKey({ kind: "agent", id: nextAgentId })] = value;
	}
	return next;
}

/** 拖拽分隔条到该像素值及以下视为折叠（与终端面板 collapsedSize=34 配套的判定阈值） */
export const TERMINAL_COLLAPSE_THRESHOLD_PX = 35;

/**
 * 分屏下某会话栏是否挂载自己的终端面板（纯函数，可单测）。
 *
 * 业务规则：终端 open 状态按 owner（agent:<id> / project:<id>）隔离，分屏双栏各自
 * 解析自己会话的 owner 并独立取状态；唯一冲突点是「同一 owner 同时出现在两个栏」
 * （共享项目终端：同项目的两条历史会话都回退 project owner）——此时只允许聚焦栏挂载，
 * 避免同一 owner 的两个 TerminalDock 实例订阅同一 PTY 数据、双份回放同一缓冲区。
 *
 * - owner 未解析（无 agent 也无 project）→ 不挂载
 * - 该 owner 终端未打开 → 不挂载
 * - owner 与当前激活 owner 相同 → 仅聚焦栏挂载（随焦点走，仍是同一份终端）
 * - owner 与激活 owner 不同（分屏双栏各有自己的 agent）→ 不随焦点消失，持续显示
 */
export function shouldMountPaneTerminalDock(input: { ownerKey: string | undefined; activeOwnerKey: string | undefined; focused: boolean; open: boolean }): boolean {
	if (!input.ownerKey || !input.open) return false;
	if (input.ownerKey === input.activeOwnerKey) return input.focused;
	return true;
}

/**
 * 单栏视角的终端归属 + 目标解析（纯函数，可单测）：
 * 会话栏把自家会话的 runtime/record 喂进来，得到本栏自己的 owner 与 target，
 * 不再读取 App 级聚焦态（分屏双栏各挂各的 dock，焦点切换不清非聚焦栏终端）。
 * - agent runtime 可用 → agent 目标；绑定缺失 → 回退本会话项目的 cwd 目标。
 * - Chat 项目没有可落地的 cwd，不提供终端。
 * - owner 未解析（无 agent 也无 project）→ undefined。
 */
export function resolvePaneTerminal(input: {
	sessionId: string;
	runtime:
		| {
				agentId?: string;
				runtimeGeneration?: number;
				status?: string | null;
		  }
		| undefined;
	projectId?: string;
	project?: { id: string; path: string; kind?: string } | undefined;
}): { owner: TerminalDockOwner; target: TerminalTarget } | undefined {
	const owner = resolveTerminalOwner(input.runtime?.agentId, input.projectId);
	if (!owner) return undefined;
	if (owner.kind === "agent") {
		// 与 shared 层 toSessionRuntimeTarget 同构：target 只表达「会话→当前绑定运行实例」句柄
		const agentId = input.runtime?.agentId;
		const runtimeGeneration = input.runtime?.runtimeGeneration;
		if (agentId && runtimeGeneration !== undefined) {
			return {
				owner,
				target: {
					kind: "agent",
					sessionId: input.sessionId,
					agentId,
					runtimeGeneration,
				},
			};
		}
	}
	if (input.project && input.project.kind !== "chat") {
		return {
			owner,
			target: {
				kind: "project",
				projectId: input.project.id,
				cwd: input.project.path,
			},
		};
	}
	return undefined;
}

/**
 * 终端分屏面板 onResize 的统一裁决（纯函数，会话视图与引导页共用）。
 *
 * 业务规则：
 * - px ≤ 折叠阈值：用户把终端拖到了折叠条高度 → collapsed=true；已折叠则无变化
 * - px > 阈值：记录新高度（clamp 到 [TERMINAL_HEIGHT_MIN, maxHeight]），
 *   若此前处于折叠态则顺带展开
 *
 * 返回空对象表示状态无变化，调用方可跳过 setState。
 * 注意：程序化 setLayout 触发的 onResize 是否抑制折叠/展开转换，由调用方
 * （SessionView 有 composer 联动保护窗口）自行判断，本函数只做几何裁决。
 */
export function applyTerminalPanelResize(input: { px: number; collapsed: boolean; maxHeight: number }): { collapsed?: boolean; height?: number } {
	if (input.px <= TERMINAL_COLLAPSE_THRESHOLD_PX) {
		return input.collapsed ? {} : { collapsed: true };
	}
	const height = Math.max(TERMINAL_HEIGHT_MIN, Math.min(Math.round(input.px), Math.round(input.maxHeight)));
	return input.collapsed ? { collapsed: false, height } : { height };
}

/**
 * 无 agent 时 PTY 会话键按 cwd 隔离，避免多项目共用 `_project_` 串台。
 * Windows 路径统一为正斜杠 + 小写，降低盘符/分隔符差异导致的重复会话。
 */
export function projectTerminalSessionKey(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return `cwd:${normalized}`;
}

export function loadTerminalHeight(fallback: number): number {
	try {
		const raw = localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
		if (raw == null) return fallback;
		const value = Number(raw);
		if (!Number.isFinite(value) || value < TERMINAL_HEIGHT_MIN) return fallback;
		return value;
	} catch {
		// localStorage 不可用时退回默认高度，不影响主流程
		return fallback;
	}
}

export function saveTerminalHeight(height: number): void {
	try {
		localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(Math.max(TERMINAL_HEIGHT_MIN, Math.round(height))));
	} catch {
		// 配额/隐私模式失败时静默忽略；高度仍在本会话内存中有效
	}
}

/** 各 shell 的默认前台进程名：node-pty 的 process 在空闲提示符下返回 shell 自己 */
export const SHELL_DEFAULT_PROCESS: Record<string, string> = {
	pwsh: "pwsh",
	powershell: "powershell",
	cmd: "cmd",
	zsh: "zsh",
	bash: "bash",
	fish: "fish",
	sh: "sh",
	"git-bash": "bash",
	wsl: "wsl",
};

/** 取进程名 basename 并小写、去 Windows 可执行后缀：兼容 `C:\Windows\System32\cmd.exe` 与 `/bin/zsh` 两种上报格式。 */
function normalizeProcessName(value: string | undefined): string {
	const name = (value ?? "").trim().toLowerCase();
	if (!name) return "";
	const base = name.split(/[\\/]/).pop() ?? name;
	return base.replace(/\.(exe|cmd|bat|com)$/, "");
}

/**
 * 关闭终端标签是否需要确认（纯函数，可单测）。
 *
 * - never：从不确认（用户明确要求不打断）；
 * - always：总是确认；
 * - running：仅「前台进程不是该 shell 自己」时确认。判定刻意宽松——
 *   node-pty 的 process 在不同 shell/平台格式不一，宁可漏弹（不打断）也不要
 *   在空闲提示符上误弹；空进程名同样不弹（拿不到证据就不拦）。
 */
export function shouldConfirmTerminalClose(mode: TerminalConfirmCloseMode, frontProcess: string | undefined, shell: string): boolean {
	if (mode === "never") return false;
	if (mode === "always") return true;
	const name = normalizeProcessName(frontProcess);
	if (!name) return false;
	return name !== normalizeProcessName(SHELL_DEFAULT_PROCESS[shell] ?? shell);
}
