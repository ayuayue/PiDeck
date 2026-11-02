/**
 * Agent 记忆（pideck-agent-memory）的挂载描述。
 *
 * 记忆能力不常驻主进程：真正的实现是 `resources/agent-memory/` 下的一个 stdio MCP 服务器，
 * 由**各 Agent 子进程自己**拉起（pi 走 `mcp.json`，ACP 走 `session/new` 的 `mcpServers`）。
 * 这样做的好处是：三种后端共用一份实现、PiDeck 主进程不持有额外连接、服务器离开 PiDeck 也能用。
 *
 * 这里只做纯计算（路径 / env / JSON 合并计划），不碰 fs 与 Electron API，
 * 便于单测直接在 Node 里跑。
 */

import { join } from "node:path";

import type { AcpMcpServer } from "../acp/acpProtocol";

/** mcp.json 里的名字；pi 会把它转成工具命名空间，改名等于换一套工具名。 */
export const AGENT_MEMORY_SERVER_NAME = "pideck-agent-memory";

/** 传给服务器的环境变量名。服务器只认这几个，不读任何配置文件。 */
export const AGENT_MEMORY_ENV = {
	/** 记忆根目录（必填，缺失时服务器拒绝启动）。 */
	dir: "PIDECK_AGENT_MEMORY_DIR",
	/** 会话来源数组的 JSON（backend + dir + 项目名）。 */
	sources: "PIDECK_AGENT_MEMORY_SOURCES",
	/** 当前会话工作目录：服务器据此推导项目作用域键（port 见 projectKeyFromPath）。 */
	cwd: "PIDECK_AGENT_MEMORY_CWD",
} as const;

/** 一条会话来源：只有 pi 的 JSONL 目录与 ACP 的归档目录能被索引。 */
export type AgentMemorySource = { backend: "pi" | "acp" | "dsh"; dir: string; project: string };

export type AgentMemoryMount = { command: string; args: string[]; env: Record<string, string> };

/** 记忆数据根：userData/memory（用户可见、可备份、跨版本稳定）。 */
export function resolveAgentMemoryDir(userDataPath: string): string {
	return join(userDataPath, "memory");
}

/**
 * 服务器脚本路径。打包后随 extraResources 落到 `resources/agent-memory/`，
 * 开发态在仓库的 `resources/agent-memory/`。
 */
export function resolveAgentMemoryServerPath(input: { isPackaged: boolean; appPath: string; resourcesPath: string }): string {
	return input.isPackaged ? join(input.resourcesPath, "agent-memory", "server.mjs") : join(input.appPath, "resources", "agent-memory", "server.mjs");
}

/** 空目录不挂：挂上去只会让 session_search 白跑一趟扫描。 */
export function buildAgentMemorySources(input: { piSessionsDir?: string; acpSessionsDir?: string; dshSessionsDir?: string; project?: string }): AgentMemorySource[] {
	const project = input.project ?? "";
	const sources: AgentMemorySource[] = [];
	if (input.piSessionsDir) sources.push({ backend: "pi", dir: input.piSessionsDir, project });
	if (input.acpSessionsDir) sources.push({ backend: "acp", dir: input.acpSessionsDir, project });
	if (input.dshSessionsDir) sources.push({ backend: "dsh", dir: input.dshSessionsDir, project });
	return sources;
}

/**
 * stdio 挂载描述。
 *
 * `command` 用本进程的 execPath 而不是 PATH 里的 `node`：Electron 应用不保证用户装了 Node，
 * `ELECTRON_RUN_AS_NODE=1` 让同一个二进制以纯 Node 身份运行服务器（`node:sqlite` 因此可用）。
 * `NODE_NO_WARNINGS=1` 只是压掉 node:sqlite 的实验性告警——MCP 客户端的 stderr 会进日志面板。
 */
export function buildAgentMemoryMount(input: {
	/** Electron 可执行文件路径（打包态为应用 exe）。 */
	execPath: string;
	scriptPath: string;
	memoryDir: string;
	sources?: AgentMemorySource[];
	/** 会话工作目录：服务器用它推导项目作用域键（项目记忆因此跨后端共享）。 */
	cwd?: string;
}): AgentMemoryMount {
	const env: Record<string, string> = {
		ELECTRON_RUN_AS_NODE: "1",
		NODE_NO_WARNINGS: "1",
		[AGENT_MEMORY_ENV.dir]: input.memoryDir,
	};
	// 空数组也要显式传：服务器靠「有没有 sources」区分「没配来源」和「来源都没内容」。
	env[AGENT_MEMORY_ENV.sources] = JSON.stringify(input.sources ?? []);
	if (input.cwd) env[AGENT_MEMORY_ENV.cwd] = input.cwd;
	return { command: input.execPath, args: [input.scriptPath], env };
}

/**
 * 从挂载描述里取回记忆根目录。
 *
 * 学习循环这类宿主侧行为需要与服务器**同一份**根目录，但记忆位置只应有一处定义
 * （`buildAgentMemoryMount`）。让调用方从 mount 反读，避免 index.ts 再拼一次路径。
 */
export function memoryDirOfMount(mount: AgentMemoryMount): string {
	return mount.env[AGENT_MEMORY_ENV.dir] ?? "";
}

/** 从挂载描述里取回会话索引来源（服务器与学习循环共用同一组来源）。 */
export function sourcesOfMount(mount: AgentMemoryMount): AgentMemorySource[] {
	const raw = mount.env[AGENT_MEMORY_ENV.sources];
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is AgentMemorySource => Boolean(item && typeof item === "object" && typeof (item as AgentMemorySource).dir === "string" && typeof (item as AgentMemorySource).backend === "string"));
	} catch {
		return [];
	}
}

/**
 * ACP `session/new` / `session/load` 的 mcpServers 项（ACP v1 只有 stdio 形态）。
 *
 * env 必须落成 `{name, value}` 数组：ACP 的 `McpServerStdio.env` 是数组，直接传对象
 * （`Record<string, string>`）会被 agent 的 schema 校验拒成 `-32602 Invalid params`，
 * 而且 session/load 与回退的 session/new 会一起失败——ACP 会话直接起不来。
 */
export function buildAcpMcpServers(mount: AgentMemoryMount): AcpMcpServer[] {
	return [
		{
			name: AGENT_MEMORY_SERVER_NAME,
			command: mount.command,
			args: [...mount.args],
			env: Object.entries(mount.env).map(([name, value]) => ({ name, value })),
		},
	];
}

/**
 * 主进程侧的挂载装配：把所有路径派生集中在一处，调用方（index.ts）不需要知道目录布局。
 *
 * 来源只收真实存在的目录：pi 的 JSONL 会话根、deck 自己的 ACP 归档、DSH 的 sessions 根。
 * DSH 只采根会话的 user/message + assistant 终态（解析器在 resources/agent-memory/sessions.mjs），
 * 不影响它自己的 session_query；目录不存在时服务器扫描自然返回空。
 */
export function buildAgentMemoryMountForApp(input: {
	userData: string;
	home: string;
	execPath: string;
	isPackaged: boolean;
	appPath: string;
	resourcesPath: string;
	/** 会话工作目录（ACP 握手时才有）；缺省不挂项目键。 */
	cwd?: string;
	/** DSH 的 sessions 根（`<dshHome>/sessions`）；未用 DSH 时不传。 */
	dshSessionsDir?: string;
}): AgentMemoryMount {
	return buildAgentMemoryMount({
		execPath: input.execPath,
		scriptPath: resolveAgentMemoryServerPath(input),
		memoryDir: resolveAgentMemoryDir(input.userData),
		sources: buildAgentMemorySources({
			piSessionsDir: join(input.home, ".pi", "agent", "sessions"),
			acpSessionsDir: join(input.userData, "acp-sessions"),
			dshSessionsDir: input.dshSessionsDir,
		}),
		cwd: input.cwd,
	});
}

/**
 * mcp.json 里的条目。
 *
 * `exposure: "direct"` 必需：pi 0.99 内置 MCP 的默认 exposure 是 `codemode`（工具只从 codemode
 * 脚本可达、不声明给模型）。记忆工具必须让模型直接看到，否则「装了但用不上」。
 */
export function buildPiMcpEntry(mount: AgentMemoryMount): Record<string, unknown> {
	return { command: mount.command, args: mount.args, env: mount.env, exposure: "direct", description: "PiDeck agent memory: memory_add/replace/remove/search/get/session_search/status" };
}

/**
 * 计算 mcp.json 的合并结果（纯函数：不读写盘，便于测试幂等性）。
 *
 * 规则：只动 `mcpServers["pideck-agent-memory"]` 这一项，其他服务器与其它顶层键原样保留；
 * 内容已经一致时返回 `changed: false`（避免每次启动都写一遍用户文件）；
 * `mcpServers` 不是对象时不抢修，交给调用方报错跳过（宁可记忆不可用，也不覆盖别人的配置）。
 */
export function planPiMcpRegistration(existing: unknown, entry: Record<string, unknown>): { next: Record<string, unknown>; changed: boolean } | { error: "invalid-config" } {
	const base = existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
	const servers = base.mcpServers;
	if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) return { error: "invalid-config" };
	const serverMap = (servers ?? {}) as Record<string, unknown>;
	const next = { ...base, mcpServers: { ...serverMap, [AGENT_MEMORY_SERVER_NAME]: entry } };
	return { next, changed: JSON.stringify(serverMap[AGENT_MEMORY_SERVER_NAME]) !== JSON.stringify(entry) };
}
