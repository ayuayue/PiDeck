/**
 * 把 `pideck-agent-memory` 写进 pi 的 `~/.pi/agent/mcp.json`。
 *
 * 为什么必须写文件：pi 0.99 的内置 MCP 只从 `mcp.json`（全局）与受信任项目的 `.pi/mcp.json`
 * 读服务器，没有 CLI 参数或环境变量可以注入。CUA 走的是同一个先例
 * （`src/main/cua/CuaMcpRegistration.ts`），这里沿用它的形态：只增改自己那一项、幂等、
 * 原子写、遇到损坏的 JSON 就放弃（绝不覆盖用户手写的配置）。
 *
 * 写的是全局文件，所以清理方式是 `pi mcp remove pideck-agent-memory`；`unregisterAgentMemoryMcp`
 * 只在需要时（用户关闭能力）调用，不在正常退出时删——pi 自己发起的会话同样需要这套工具。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { AGENT_MEMORY_SERVER_NAME, buildPiMcpEntry, planPiMcpRegistration, type AgentMemoryMount } from "./agentMemoryMounts";

export type AgentMemoryRegistrationResult = { written: boolean; path: string; skipped?: "invalid-config" | "unreadable" | "server-missing" };

/** mcp.json 的默认位置；测试可传 `agentDir` 指向临时目录。 */
export function resolvePiMcpConfigPath(agentDir?: string): string {
	return join(agentDir ?? join(homedir(), ".pi", "agent"), "mcp.json");
}

function readJson(path: string): { value?: unknown; unreadable?: true } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		// 文件不存在是正常情况（首次运行），其它 IO 错误按不可读处理。
		if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return {};
		return { unreadable: true };
	}
	try {
		return { value: JSON.parse(text.replace(/^\uFEFF/, "")) };
	} catch {
		return { unreadable: true };
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** 幂等注册：内容未变不写盘，用户手上的其它服务器不动。 */
export function ensureAgentMemoryMcpRegistered(mount: AgentMemoryMount, options?: { agentDir?: string }): AgentMemoryRegistrationResult {
	const path = resolvePiMcpConfigPath(options?.agentDir);
	// 脚本不存在就别留悬空条目：卸载/回滚后 mcp.json 里指着一个不存在的文件，
	// 会让 pi 每个会话都记一条 spawn 失败。宁可这次不注册，下次启动再试。
	if (!existsSync(mount.args[0] ?? "")) return { written: false, path, skipped: "server-missing" };
	const read = readJson(path);
	if (read.unreadable) return { written: false, path, skipped: "unreadable" };
	const plan = planPiMcpRegistration(read.value, buildPiMcpEntry(mount));
	if ("error" in plan) return { written: false, path, skipped: plan.error };
	if (!plan.changed) return { written: false, path };
	writeJsonAtomic(path, plan.next);
	return { written: true, path };
}

/** 只在用户显式关闭记忆能力时调用（正常退出不删，pi 自发的会话也需要工具）。 */
export function unregisterAgentMemoryMcp(options?: { agentDir?: string }): { removed: boolean; path: string } {
	const path = resolvePiMcpConfigPath(options?.agentDir);
	const read = readJson(path);
	if (read.unreadable || !read.value || typeof read.value !== "object") return { removed: false, path };
	const base = read.value as Record<string, unknown>;
	const servers = base.mcpServers;
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { removed: false, path };
	if (!(AGENT_MEMORY_SERVER_NAME in (servers as Record<string, unknown>))) return { removed: false, path };
	const nextServers = { ...(servers as Record<string, unknown>) };
	delete nextServers[AGENT_MEMORY_SERVER_NAME];
	writeJsonAtomic(path, { ...base, mcpServers: nextServers });
	return { removed: true, path };
}

/**
 * 把「设置开关」翻译成 mcp.json 的实际动作。
 *
 * 开启 → 幂等注册（内容没变不写盘）；关闭 → 只删自己那一项，别人的服务器与顶层键一律不动；
 * 关闭且本来就没注册 → 不碰文件（不因为一次无关的设置保存改写用户文件）。
 */
export type AgentMemorySyncAction = "registered" | "unchanged" | "unregistered" | "absent" | "unavailable";

export function syncAgentMemoryRegistration(input: { enabled: boolean; mount: AgentMemoryMount; agentDir?: string }): { action: AgentMemorySyncAction; path: string } {
	if (input.enabled) {
		const registered = ensureAgentMemoryMcpRegistered(input.mount, { agentDir: input.agentDir });
		if (registered.skipped) return { action: "unavailable", path: registered.path };
		return { action: registered.written ? "registered" : "unchanged", path: registered.path };
	}
	const removed = unregisterAgentMemoryMcp({ agentDir: input.agentDir });
	return { action: removed.removed ? "unregistered" : "absent", path: removed.path };
}
