#!/usr/bin/env node
/**
 * `pideck-agent-memory`：PiDeck 的记忆 MCP 服务器（stdio / MCP 2024-11-05）。
 *
 * 为什么是 stdio 而不是再开一个本地 HTTP 端点：
 * - pi 的内置 MCP 支持 stdio `command`，ACP 的 `session/new` 里 `mcpServers` 也只有 stdio 形态
 *   （`AcpMcpServer = {name, command, args?, env?}`），一份实现两个后端都能挂；
 * - 不需要监听端口、不需要令牌、不需要在 PiDeck 里多一个开关和一条 IPC；
 * - 同一份代码既能被 PiDeck 拉起，也能被用户手动挂到任何 MCP 客户端上（可分发）。
 *
 * 进程由宿主用 `ELECTRON_RUN_AS_NODE=1 <electron> server.mjs` 拉起，因此运行在 Node 24 上，
 * `node:sqlite`（FTS5）可用；不可用时工具仍能工作，只是检索退化为子串匹配。
 *
 * stdin/stdout 是协议通道，任何调试输出只能走 stderr。
 */

import { createInterface } from "node:readline";

import { closeDatabase } from "./db.mjs";
import { defaultProjectKey, resolveMemoryRoot } from "./paths.mjs";
import { addMemory, getMemories, MemoryToolError, memoryStatus, removeMemory, replaceMemory, searchMemory, searchSessions } from "./tools.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "pideck-agent-memory", version: "0.1.0" };

/** 会话来源：宿主用 JSON 传进来（后端 + 目录 + 项目归属），服务器自己不猜路径。 */
function readSources() {
	const raw = process.env.PIDECK_AGENT_MEMORY_SOURCES;
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((entry) => entry && typeof entry === "object" && (entry.backend === "pi" || entry.backend === "acp") && typeof entry.dir === "string" && entry.dir.length > 0)
			.map((entry) => ({ backend: entry.backend, dir: entry.dir, project: typeof entry.project === "string" ? entry.project : "" }));
	} catch {
		return []; // 环境变量坏了就当没有来源：会话检索报「没有来源」，不阻断记忆工具。
	}
}

/** 工具的 JSON Schema。每个工具只暴露自己需要的参数，模型不会被无关字段干扰。 */
const TOOL_DEFINITIONS = [
	{
		name: "memory_add",
		description: "Save one durable fact to long-term memory. Use for user preferences, project conventions, environment facts, and corrections you must not repeat. Do NOT use for task progress or temporary state.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", enum: ["memory", "user", "project", "failure", "device"], description: "memory=global notes, user=who the user is, project=this project only, failure=lesson learned, device=only true on this machine (drive letters, local paths)" },
				content: { type: "string", description: "One self-contained fact. Several sentences are fine; several unrelated facts are not." },
				category: { type: "string", enum: ["failure", "correction", "insight", "preference", "convention", "tool-quirk"], description: "Only for target=failure." },
				projectId: { type: "string", description: "Optional. Defaults to the current session's project (derived from its working directory); pass explicitly only to target another project." },
			},
			required: ["target", "content"],
		},
	},
	{
		name: "memory_replace",
		description: "Replace one existing memory entry. Locate it with oldContent (exact after whitespace normalization, or a unique substring). Use when a fact changed instead of adding a contradicting second entry.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", enum: ["memory", "user", "project", "failure", "device"] },
				oldContent: { type: "string", description: "Existing entry, or a substring that matches exactly one entry." },
				content: { type: "string", description: "Replacement content." },
				projectId: { type: "string" },
			},
			required: ["target", "oldContent", "content"],
		},
	},
	{
		name: "memory_remove",
		description: "Delete one memory entry that is wrong or obsolete. Prefer memory_replace when the fact merely changed.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", enum: ["memory", "user", "project", "failure", "device"] },
				content: { type: "string", description: "Existing entry, or a substring that matches exactly one entry." },
				projectId: { type: "string" },
			},
			required: ["target", "content"],
		},
	},
	{
		name: "memory_search",
		description: "Search saved memories (global + project + failure lessons) by full-text query. Call this before asking the user something they may already have told you.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				target: { type: "string", enum: ["memory", "user", "project", "failure", "device"], description: "Optional: restrict to one target." },
				projectId: { type: "string" },
				limit: { type: "integer", minimum: 1, maximum: 50 },
			},
			required: ["query"],
		},
	},
	{
		name: "memory_get",
		description: "List saved memory entries for one target (oldest first). Use memory_search to look up by content.",
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", enum: ["memory", "user", "project", "failure", "device"] },
				projectId: { type: "string" },
				offset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 200 },
			},
			required: ["target"],
		},
	},
	{
		name: "session_search",
		description: "Search past conversation transcripts (indexed from the sessions PiDeck is allowed to read) by full-text query. Use when the user refers to something discussed in an earlier session.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				project: { type: "string", description: "Optional: restrict results to one project name." },
				limit: { type: "integer", minimum: 1, maximum: 50 },
			},
			required: ["query"],
		},
	},
	{
		name: "memory_status",
		description: "Report memory budget usage and index size. Use to check whether the memory system is actually working.",
		inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
	},
];

/** 参数里统一取 projectId：显式传入优先，其次由宿主注入的会话 cwd 推导项目键。 */
function projectOf(args) {
	const explicit = typeof args?.projectId === "string" ? args.projectId.trim() : "";
	if (explicit) return explicit;
	return defaultProjectKey();
}

/** 工具分发。所有实现都返回可 JSON 序列化的对象，由此统一包成 MCP 文本结果。 */
function dispatch(root, name, args) {
	const sources = readSources();
	switch (name) {
		case "memory_add":
			return addMemory(root, { target: args?.target, content: args?.content, category: args?.category, projectId: projectOf(args) });
		case "memory_replace":
			return replaceMemory(root, { target: args?.target, oldContent: args?.oldContent, content: args?.content, projectId: projectOf(args) });
		case "memory_remove":
			return removeMemory(root, { target: args?.target, content: args?.content, projectId: projectOf(args) });
		case "memory_search":
			return searchMemory(root, { query: args?.query, target: args?.target, projectId: projectOf(args), limit: args?.limit ?? 10 });
		case "memory_get":
			return getMemories(root, { target: args?.target, projectId: projectOf(args), offset: args?.offset ?? 0, limit: args?.limit ?? 50 });
		case "session_search":
			return searchSessions(root, { query: args?.query, project: args?.project, limit: args?.limit ?? 10, sources });
		case "memory_status":
			return memoryStatus(root, { projectId: projectOf(args), sources });
		default:
			throw new MemoryToolError("unknown-tool", name);
	}
}

function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** 单次工具调用的结果封装：业务错误走 `isError`，协议错误走 JSON-RPC error。 */
function callTool(root, name, args) {
	try {
		const result = dispatch(root, name, args);
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	} catch (error) {
		const code = error instanceof MemoryToolError ? error.code : "tool-failed";
		const detail = error instanceof MemoryToolError ? error.detail : error instanceof Error ? error.message : undefined;
		if (!(error instanceof MemoryToolError)) process.stderr.write(`[agent-memory] ${name} failed: ${detail ?? "unknown"}\n`);
		return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, ...(detail ? { detail } : {}) } }) }], isError: true };
	}
}

function handle(root, message) {
	const id = message.id;
	const isNotification = id === undefined || id === null;
	const respond = (result) => {
		if (!isNotification) write({ jsonrpc: "2.0", id, result });
	};
	const respondError = (code, message2) => {
		if (!isNotification) write({ jsonrpc: "2.0", id, error: { code, message: message2 } });
	};

	switch (message.method) {
		case "initialize":
			respond({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
			return;
		case "notifications/initialized":
		case "notifications/cancelled":
			return; // 通知不需要回复。
		case "ping":
			respond({});
			return;
		case "tools/list":
			respond({ tools: TOOL_DEFINITIONS });
			return;
		case "tools/call": {
			const params = message.params;
			if (!params || typeof params.name !== "string") {
				respondError(-32602, "invalid params: name required");
				return;
			}
			respond(callTool(root, params.name, params.arguments ?? {}));
			return;
		}
		default:
			respondError(-32601, `method not found: ${String(message.method)}`);
	}
}

function main() {
	let root;
	try {
		root = resolveMemoryRoot();
	} catch (error) {
		// 没有记忆目录就不启动：默认值会把它写到某个进程的 cwd 里，那是更坏的失败模式。
		process.stderr.write(`[agent-memory] refusing to start: ${error instanceof Error ? error.message : "memory-dir-missing"}\n`);
		process.exit(2);
	}

	const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	reader.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let message;
		try {
			message = JSON.parse(trimmed);
		} catch {
			write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
			return;
		}
		if (!message || typeof message !== "object" || typeof message.method !== "string") {
			write({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "invalid request" } });
			return;
		}
		try {
			handle(root, message);
		} catch (error) {
			// 单条请求的意外失败不能拖垮整个服务器（MCP 客户端会因此判定服务器已死）。
			process.stderr.write(`[agent-memory] dispatch failed: ${error instanceof Error ? error.message : "unknown"}\n`);
			if (message.id !== undefined && message.id !== null) write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "internal error" } });
		}
	});
	reader.on("close", () => {
		closeDatabase(root);
		process.exit(0);
	});
}

main();
