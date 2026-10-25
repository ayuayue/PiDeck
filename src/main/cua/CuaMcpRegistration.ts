/**
 * CUA MCP registration helper.
 *
 * Writes/updates the `pideck-cua` entry in ~/.pi/agent/mcp.json so pi's
 * **built-in** MCP extension (pi 0.99+) connects to the CUA MCP server.
 *
 * Plan A (T7 decision): the CUA MCP server runs inside the PiDeck main process
 * and is exposed over Streamable HTTP on 127.0.0.1. We therefore register a
 * `url` entry (not a stdio `command`).
 *
 * ⚠️ 字段必须按 pi 0.99 内置 MCP 的 schema 写（dist/extensions/mcp 的
 * `validateMcpServerConfig`）：社区 pi-mcp-adapter 时代的 `auth` /
 * `bearerToken` / `lifecycle` **不再被识别，会被静默忽略**，HTTP 鉴权只有
 * `headers`（支持 `${ENV}` / `!command` 替换）与 `oauth` 两条路。写错的表现
 * 不是报错，而是 CuaMcpHttpHost 对无 Authorization 的请求回 401、pi 侧只显示
 * "disconnected"——所以这里用 `headers.Authorization` 直写 bearer。
 *
 * `exposure: "direct"` 同样必需：内置 MCP 的默认 exposure 是 `codemode`
 * （工具只从 codemode 脚本可达、不声明给模型），CUA 是桌面操作能力，
 * 必须让模型直接看到并调用。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CUA_SERVER_NAME = "pideck-cua";

export type CuaMcpRegistration = {
	/** MCP Streamable HTTP endpoint, e.g. http://127.0.0.1:31415/mcp. */
	url: string;
	/** Static bearer token required by the host. */
	bearerToken: string;
};

/**
 * Ensure the CUA MCP server is registered in ~/.pi/agent/mcp.json.
 * Does NOT clobber other servers. Idempotent.
 */
export function ensureCuaMcpRegistered(registration: CuaMcpRegistration): { written: boolean; path: string } {
	const piAgentDir = join(homedir(), ".pi", "agent");
	const mcpJsonPath = join(piAgentDir, "mcp.json");

	let config: { mcpServers?: Record<string, unknown> } = {};

	if (existsSync(mcpJsonPath)) {
		try {
			config = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
		} catch {
			// Corrupt file; start fresh.
			config = {};
		}
	}

	if (!config.mcpServers) {
		config.mcpServers = {};
	}

	const newDef = {
		url: registration.url,
		// pi 0.99 内置 MCP：HTTP 鉴权走 headers（字面值，不经 shell/环境展开，
		// token 是 randomBytes(32).toString("hex")，不含 ${...} 形态不会被误替换）。
		headers: { Authorization: `Bearer ${registration.bearerToken}` },
		// 默认 codemode exposure 下工具不声明给模型，CUA 会「连上但不可见」。
		exposure: "direct" as const,
	};

	const existing = config.mcpServers[CUA_SERVER_NAME];
	if (existing && JSON.stringify(existing) === JSON.stringify(newDef)) {
		return { written: false, path: mcpJsonPath };
	}

	config.mcpServers[CUA_SERVER_NAME] = newDef;

	if (!existsSync(piAgentDir)) {
		mkdirSync(piAgentDir, { recursive: true });
	}

	writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), "utf8");
	return { written: true, path: mcpJsonPath };
}

/**
 * Remove the CUA MCP server registration from mcp.json.
 */
export function unregisterCuaMcp(): { removed: boolean; path: string } {
	const mcpJsonPath = join(homedir(), ".pi", "agent", "mcp.json");

	if (!existsSync(mcpJsonPath)) {
		return { removed: false, path: mcpJsonPath };
	}

	let config: { mcpServers?: Record<string, unknown> };
	try {
		config = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
	} catch {
		return { removed: false, path: mcpJsonPath };
	}

	if (!config.mcpServers || !config.mcpServers[CUA_SERVER_NAME]) {
		return { removed: false, path: mcpJsonPath };
	}

	delete config.mcpServers[CUA_SERVER_NAME];
	writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), "utf8");
	return { removed: true, path: mcpJsonPath };
}
