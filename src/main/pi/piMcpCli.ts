/**
 * `pi mcp` CLI 封装：连接状态检测与 OAuth 登录/登出。
 *
 * 决策（docs/pi-0.99-mcp-codemode-plan.md M2/M3）：
 * - PiDeck 统一 spawn `pi mcp`，不依赖某个 agent 是否在跑，也不走 RPC。
 * - `list/login/logout` **不接受** `-l`：作用域由 cwd + agentDir + 已保存的项目信任决定。
 *   全局：用不构成项目的可写工作目录；项目：所选项目 runtime 路径（须已信任）。
 * - `pi mcp list --json` 在存在 enabled 未连接项时以 exit 1 结束，但 stdout 仍是合法报告；
 *   超时/信号/退出码异常/spawn 失败不能被一段 JSON 覆盖成成功。
 * - OAuth：pi 自动开浏览器；WSL 下常打不开，因此把授权 URL 透出给 UI 内嵌展示
 *   （不弹 toast、不代开浏览器）。stdout 按行增量解析，避免累积半截文本重复命中。
 * - 0.99.2 的 CLI 连接路径没有 providerToken 回调：`auth.provider` 服务器的认证
 *   结论不代表会话内结果，调用方需据此降级（见 7.4）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpCliListResult } from "../../shared/types/mcp";
import type { PiLocator } from "./PiLocator";
import type { AppSettings } from "../../shared/types";

export type McpCliServerReport = import("../../shared/types/mcp").McpCliServerReport;

/** 登录/登出结果（output 为 stderr+stdout 尾部，供 UI 展示）。 */
export type McpCliActionOk = {
	ok: true;
	output: string;
};

export type McpCliActionFail = {
	ok: false;
	output: string;
};

export type McpCliActionResult = McpCliActionOk | McpCliActionFail;

/**
 * 授权 URL 行：pi 固定输出 `Sign in to MCP server "<name>" in your browser:\n<url>`；
 * URL 在下一行。同时容忍 URL 与提示同一行（其它 pi 版本/包装器）。
 * 只允许 http/https。
 */
export const MCP_LOGIN_URL_RE = /in your browser:\s*(\S*)/;

/** 把候选 token 转成合法授权 URL；非 http(s) 或解析失败返回 undefined。 */
export function normalizeAuthorizationUrl(candidate: string | undefined): string | undefined {
	const trimmed = candidate?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 逐行扫描授权 URL：支持「提示行 + 下一行 URL」与「同一行」两种输出，
 * 避免把日志里其它无关 URL 误当授权链接推送。
 */
export function createAuthorizationUrlScanner(): (line: string) => string | undefined {
	let expectNextLine = false;
	return (line: string) => {
		const match = MCP_LOGIN_URL_RE.exec(line);
		if (match) {
			const sameLine = normalizeAuthorizationUrl(match[1]);
			// `in your browser:` 后面没有内容时，URL 在下一行。
			expectNextLine = sameLine === undefined;
			return sameLine;
		}
		if (expectNextLine) {
			expectNextLine = false;
			return normalizeAuthorizationUrl(line);
		}
		return undefined;
	};
}

/** 输出尾部缓冲上限：错误信息够用即可，避免长登录输出无限堆积。 */
const OUTPUT_TAIL_CHARS = 4_000;
const LIST_MAX_BUFFER = 4 * 1024 * 1024;

export type McpCliScope = { scope: "global" } | { scope: "project"; projectId: string };

type PiMcpCliDeps = {
	locator: PiLocator;
	getSettings: () => AppSettings;
	/** 项目作用域：把注册 projectId 解析成 runtime cwd 并验证已保存信任。 */
	resolveProjectScope?: (projectId: string) => Promise<{ cwd: string; trusted: boolean } | null>;
	/** WSL 会映射 cwd/home；与 ExtensionManager 同一套环境。 */
	wslEnvironment?: { distro: string; user?: string } | null;
	/** 测试注入：不真正写临时目录。 */
	createGlobalCwd?: () => { path: string; cleanup: () => void };
};

type Invocation = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string; options: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 解析 `pi mcp list --json` stdout；返回 null 表示形状不完整（调用方转为失败）。 */
export function parseMcpListOutput(raw: string): McpCliListResult | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	// 报告必须含 servers 数组：只有 JSON 形状而没有报告字段的输出不能当作成功。
	if (!Array.isArray(parsed.servers)) return null;
	const servers: McpCliServerReport[] = [];
	for (const entry of parsed.servers) {
		if (!isRecord(entry)) continue;
		servers.push({
			name: typeof entry.name === "string" ? entry.name : "",
			scope: typeof entry.scope === "string" ? entry.scope : "global",
			source: typeof entry.source === "string" ? entry.source : "",
			enabled: entry.enabled !== false,
			exposure: typeof entry.exposure === "string" ? entry.exposure : "codemode",
			transport: typeof entry.transport === "string" ? entry.transport : "",
			state: typeof entry.state === "string" ? entry.state : "disconnected",
			tools: asStringArray(entry.tools),
			toolExposure: isRecord(entry.toolExposure) ? Object.fromEntries(Object.entries(entry.toolExposure).filter((entry2): entry2 is [string, string] => typeof entry2[1] === "string")) : undefined,
			// pi 1.1 给资源数量（number），pi 1.2 起改成 `resources: true`（见上游 CHANGELOG 1.2.0），
			// 两种形态都收，否则新 pi 下会静默丢字段。
			resources: typeof entry.resources === "number" || typeof entry.resources === "boolean" ? entry.resources : undefined,
			resourceTemplates: typeof entry.resourceTemplates === "number" ? entry.resourceTemplates : undefined,
			error: typeof entry.error === "string" ? entry.error : undefined,
		});
	}
	return {
		servers,
		errors: asStringArray(parsed.errors),
		note: typeof parsed.note === "string" ? parsed.note : undefined,
	};
}

function tail(value: string): string {
	return value.length > OUTPUT_TAIL_CHARS ? value.slice(-OUTPUT_TAIL_CHARS) : value;
}

/** 授权 URL 只接受 http/https，且必须是完整 token（不含空白/引号控制字符）。 */
export function extractAuthorizationUrl(line: string): string | undefined {
	const scanner = createAuthorizationUrlScanner();
	return scanner(line);
}

/** 逐行切分：跨 chunk 的残行留到下一次，完整 URL 只推送一次。 */
class LineBuffer {
	private pending = "";
	constructor(private readonly onLine: (line: string) => void) {}
	push(chunk: string): void {
		this.pending += chunk;
		let index = this.pending.indexOf("\n");
		while (index !== -1) {
			const line = this.pending.slice(0, index).replace(/\r$/, "");
			this.pending = this.pending.slice(index + 1);
			this.onLine(line);
			index = this.pending.indexOf("\n");
		}
	}
	flush(): void {
		if (this.pending) {
			this.onLine(this.pending.replace(/\r$/, ""));
			this.pending = "";
		}
	}
}

export class PiMcpCli {
	private projectScopedHash = 0;

	constructor(private readonly deps: PiMcpCliDeps) {}

	/** 当前环境是否走 WSL 命令（与 ExtensionManager 同判断）。 */
	private wslEnabled(): boolean {
		const settings = this.deps.getSettings();
		return Boolean(settings.wslEnabled && settings.wslDistro && settings.wslUser) || Boolean(this.deps.wslEnvironment);
	}

	/**
	 * 构造一次调用：
	 * - 全局：cwd 指向一个不含 .pi 的临时目录，确保不会误读恰好位于应用 cwd 的项目配置；
	 * - 项目：cwd = 所选项目 runtime 路径（由调用方先验证信任）。
	 */
	private buildInvocation(scope: McpCliScope, args: string[], timeoutMs: number): Invocation {
		const settings = this.deps.getSettings();
		const command = this.deps.locator.resolveCommand(settings.customPiPath, this.wslEnabled(), settings.wslDistro, settings.wslUser);
		const invocation = this.deps.locator.createInvocation(command, args, {});
		const env = this.deps.locator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl);
		const options: Record<string, unknown> = {
			env,
			shell: invocation.shell,
			windowsHide: true,
			timeout: timeoutMs,
			encoding: "utf8",
			windowsVerbatimArguments: invocation.windowsVerbatimArguments,
			maxBuffer: LIST_MAX_BUFFER,
		};
		return { command: invocation.command, args: invocation.args, env, options };
	}

	/** 全局作用域的工作目录：不构成 pi 项目的临时目录（避免读到应用 cwd 的 .pi/mcp.json）。 */
	private globalCwd(): { path: string; cleanup: () => void } {
		if (this.deps.createGlobalCwd) return this.deps.createGlobalCwd();
		const path = mkdtempSync(join(tmpdir(), "pideck-mcp-global-"));
		return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
	}

	/**
	 * 项目作用域：解析 runtime cwd 并校验已保存信任。
	 * 未装配解析器或未信任时抛错——不要偷偷读未信任的项目配置。
	 */
	private async resolveProject(projectId: string): Promise<string> {
		if (!this.deps.resolveProjectScope) throw new Error("Project MCP commands are unavailable.");
		const resolved = await this.deps.resolveProjectScope(projectId);
		if (!resolved) throw new Error("Project not found.");
		if (!resolved.trusted) throw new Error("Project is not trusted.");
		return resolved.cwd;
	}

	/** 真实连接检测：`pi mcp list --json`。exit 0/1 + 合法报告才算成功。 */
	async list(scope: McpCliScope = { scope: "global" }, timeoutMs = 30_000): Promise<McpCliListResult> {
		if (this.wslEnabled()) await this.warmWsl();
		const cwd = scope.scope === "project" ? await this.resolveProject(scope.projectId) : undefined;
		const global = scope.scope === "global" ? this.globalCwd() : undefined;
		const { command, args, options } = this.buildInvocation(scope, ["mcp", "list", "--json"], timeoutMs);
		try {
			const output = await new Promise<string>((resolve, reject) => {
				execFile(
					command,
					args,
					{
						...options,
						...(cwd ? { cwd } : {}),
					} as Parameters<typeof execFile>[2],
					(error, stdout, stderr) => {
						const outText = typeof stdout === "string" ? stdout : (stdout?.toString("utf8") ?? "");
						const errText = typeof stderr === "string" ? stderr : (stderr?.toString("utf8") ?? "");
						// exit 0/1 都可能有报告；其他退出原因（超时/信号/崩溃）必须报错。
						const code = typeof error?.code === "number" ? error.code : error ? undefined : 0;
						if (!error || code === 1) {
							const parsed = parseMcpListOutput(outText);
							if (parsed) {
								resolve(outText);
								return;
							}
						}
						reject(new Error(tail(errText.trim() || outText.trim() || error?.message || "pi mcp list failed")));
					},
				);
			});
			const parsed = parseMcpListOutput(output);
			if (!parsed) throw new Error("pi mcp list returned an unexpected report.");
			return parsed;
		} finally {
			global?.cleanup();
		}
	}

	private async warmWsl(): Promise<void> {
		const settings = this.deps.getSettings();
		if (settings.wslDistro && settings.wslUser) {
			await this.deps.locator.warmWslCommand(settings.wslDistro, settings.wslUser).catch(() => undefined);
		}
	}

	/**
	 * OAuth 登录：`pi mcp login <server> --timeout <sec>`。
	 * pi 自己会开浏览器；这里只把逐行解析到的完整授权 URL 回调给 UI（内嵌兜底）。
	 */
	async login(scope: McpCliScope, server: string, timeoutSec: number, callbacks: { onUrl?: (url: string) => void; operationId?: string } = {}): Promise<McpCliActionResult> {
		if (this.wslEnabled()) await this.warmWsl();
		const cwd = scope.scope === "project" ? await this.resolveProject(scope.projectId) : undefined;
		const global = scope.scope === "global" ? this.globalCwd() : undefined;
		const { command, args, env, options } = this.buildInvocation(scope, ["mcp", "login", server, "--timeout", String(timeoutSec)], (timeoutSec + 30) * 1000);
		return new Promise<McpCliActionResult>((resolve) => {
			const spawnOptions = { ...options, env, ...(cwd ? { cwd } : {}), stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[] };
			delete (spawnOptions as Record<string, unknown>).encoding;
			delete (spawnOptions as Record<string, unknown>).timeout;
			const child = spawn(command, args, spawnOptions as Parameters<typeof spawn>[2]);
			let done = false;
			const seenUrls = new Set<string>();
			const settle = (result: McpCliActionResult) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				global?.cleanup();
				resolve(result);
			};
			let output = "";
			const collect = (chunk: string) => {
				output = tail(output + chunk);
			};
			/** stdout/stderr 各自一个扫描器：不互相跳过「URL 在下一行」的状态。去重后只推送合法 URL。 */
			const makeHandler = () => {
				const scanUrl = createAuthorizationUrlScanner();
				return (line: string) => {
					collect(`${line}\n`);
					const url = scanUrl(line);
					if (url && !seenUrls.has(url)) {
						seenUrls.add(url);
						callbacks.onUrl?.(url);
					}
				};
			};
			const stdoutLines = new LineBuffer(makeHandler());
			const stderrLines = new LineBuffer(makeHandler());
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => stdoutLines.push(chunk));
			child.stderr?.on("data", (chunk: string) => stderrLines.push(chunk));
			const timer = setTimeout(
				() => {
					child.kill("SIGTERM");
				},
				(timeoutSec + 30) * 1000,
			);
			child.on("error", (error) => {
				settle({ ok: false, output: tail(error.message + output) });
			});
			child.on("close", (code) => {
				stdoutLines.flush();
				stderrLines.flush();
				settle({ ok: code === 0, output: tail(output).trim() });
			});
		});
	}

	/** 删除已存凭据：`pi mcp logout <server>`。 */
	async logout(scope: McpCliScope, server: string): Promise<McpCliActionResult> {
		if (this.wslEnabled()) await this.warmWsl();
		const cwd = scope.scope === "project" ? await this.resolveProject(scope.projectId) : undefined;
		const global = scope.scope === "global" ? this.globalCwd() : undefined;
		const { command, args, options } = this.buildInvocation(scope, ["mcp", "logout", server], 15_000);
		try {
			const output = await new Promise<string>((resolve, reject) => {
				execFile(command, args, { ...options, ...(cwd ? { cwd } : {}) } as Parameters<typeof execFile>[2], (error, stdout, stderr) => {
					const outText = typeof stdout === "string" ? stdout : (stdout?.toString("utf8") ?? "");
					const errText = typeof stderr === "string" ? stderr : (stderr?.toString("utf8") ?? "");
					if (error) {
						reject(new Error(tail(errText.trim() || outText.trim() || error.message)));
						return;
					}
					resolve(outText || errText);
				});
			});
			return { ok: true, output: tail(output).trim() };
		} catch (error) {
			return { ok: false, output: tail(error instanceof Error ? error.message : String(error)) };
		} finally {
			global?.cleanup();
		}
	}
}
