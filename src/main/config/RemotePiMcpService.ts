import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { REMOTE_MCP_CODES as C, type RemoteMcpRequest, type RemoteMcpResult } from "../../shared/types/remotePiManagement";
import type { McpCliListResult, McpConfigFile, McpConfigSnapshot } from "../../shared/types/mcp";
import { REMOTE_CONFIG_CODES } from "../../shared/piConfig";
import { isMcpServerName, mergeMcpServersWithErrors, validateMcpConfigFile } from "./mcpConfig";
import { parseMcpListOutput } from "../pi/piMcpCli";
import { quotePosixArgument } from "../remote/RemoteBootstrapContract";
import { getAppLogger } from "../logging/sharedLogger";
import type { RemotePiConfigBackend } from "./RemotePiConfigBackend";

/**
 * 远端 MCP：配置快照与保存，加上主机上的 `pi mcp list --json` / `pi mcp logout <server>`。
 *
 * 为什么在 main 侧拼快照而不是渲染层：MCP 的合并/校验（`mergeMcpServersWithErrors`、
 * `validateMcpConfigFile`）是主进程的纯函数，渲染层复刻一份就有两套口径。
 *
 * 只做固定动词，argv 里没有渲染层能影响的自由文本（server 名先过 `isMcpServerName`）。
 * 登录（`mcp.login`）例外地走 helper 请求而不是 pinned 短命令：授权 URL 要在通话还没结束时回来，
 * 所以 helper 用无 id 的事件帧按 requestId 回报，主进程再只推给发起它的那个窗口。
 */

export type RemotePiMcpFacts = { piPath: string; nodePath: string; version: string; home: string };

export type RemotePiMcpPorts = {
	config: () => RemotePiConfigBackend | undefined;
	resolveFacts(hostId: string): Promise<RemotePiMcpFacts>;
	/** helper 请求通道：登录要按 requestId 接住 auth-url 事件，所以必须带回调而不是只等结果。 */
	request(hostId: string, method: string, params: unknown, options?: { timeoutMs?: number; onAuthUrl?: (url: string) => void }): Promise<unknown>;
	run(input: { hostId: string; remoteCommand: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr?: string }>;
};

const HEX64 = /^[0-9a-f]{64}$/;
const OUTPUT_TAIL = 4096;
const MCP_FILE = "mcp" as const;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `pi` 用主机上同一套已验证的 Node 运行：不带登录 shell，也不从 PATH 里挑可执行文件。 */
function remotePiCommand(facts: RemotePiMcpFacts, args: string[]): string {
	const nodeDir = facts.nodePath.slice(0, facts.nodePath.lastIndexOf("/"));
	return "cd " + quotePosixArgument(facts.home) + " && PATH=" + quotePosixArgument(nodeDir) + ':"$PATH" ' + [facts.nodePath, facts.piPath, ...args].map(quotePosixArgument).join(" ");
}

/** 远端文件只可能是 HOME 下的那一层：项目层 .pi/mcp.json 不在远端配置作用域里。 */
function fileOf(data: Record<string, unknown>): McpConfigFile {
	const servers = data.mcpServers;
	return { ...data, mcpServers: record(servers) ? servers : {} } as McpConfigFile;
}

function tail(value: string): string {
	return value.length > OUTPUT_TAIL ? value.slice(-OUTPUT_TAIL) : value;
}

export function createRemotePiMcpService(ports: RemotePiMcpPorts) {
	function backend(): RemotePiConfigBackend {
		const config = ports.config();
		if (config === undefined) throw new Error(C.unavailable);
		return config;
	}

	async function snapshot(hostId: string): Promise<McpConfigSnapshot> {
		const [remote, facts] = await Promise.all([backend().read({ hostId, file: MCP_FILE }), ports.resolveFacts(hostId)]);
		const path = facts.home + "/.pi/agent/mcp.json";
		const writableFile = fileOf(remote.data);
		const merged = mergeMcpServersWithErrors([{ path, kind: "pi-agent", file: writableFile }], path);
		return {
			writablePath: path,
			writableFile,
			// 远端只拿到脱敏后的数据（密钥值是 configured/missing 哨兵），原文按同一份数据重排
			// 而不是假装是文件字节：源文件页在远端走的是另一条读取路径。
			writableRaw: `${JSON.stringify(remote.data, null, 2)}\n`,
			revision: remote.version,
			layers: [{ kind: "pi-agent", path, exists: true, writable: true }],
			servers: merged.servers,
			invalidServers: merged.invalidServers,
			/** 单层：没有更下层可回退，也就不存在「回退为继承」。 */
			lowerLayerNames: [],
			/** mcp-auth.json 不在远端可读清单里；OAuth 状态以 `pi mcp list` 的 state 为准。 */
			oauthCredentialNames: [],
		};
	}

	async function save(hostId: string, file: unknown, expectedVersion: unknown): Promise<{ valid: boolean; error?: string; conflict?: boolean; revision?: string }> {
		if (!record(file)) return { valid: false, error: C.fileInvalid };
		if (expectedVersion !== undefined && (typeof expectedVersion !== "string" || !HEX64.test(expectedVersion))) return { valid: false, error: C.conflict, conflict: true };
		const config = fileOf(file);
		const invalid = validateMcpConfigFile(config);
		if (invalid) return { valid: false, error: invalid };
		const version = typeof expectedVersion === "string" ? expectedVersion : (await backend().read({ hostId, file: MCP_FILE })).version;
		try {
			const receipt = await backend().replace({ hostId, file: MCP_FILE, expectedVersion: version, data: config as Record<string, unknown>, secretSources: [] });
			return { valid: true, revision: receipt.version };
		} catch (error) {
			const code = error instanceof Error ? error.message : String(error);
			if (code === REMOTE_CONFIG_CODES.versionConflict) return { valid: false, error: code, conflict: true };
			getAppLogger()?.warn("remoteMcp", "Remote MCP save failed", { hostId, code });
			throw error;
		}
	}

	async function list(hostId: string): Promise<McpCliListResult> {
		const facts = await ports.resolveFacts(hostId);
		const result = await ports.run({ hostId, remoteCommand: remotePiCommand(facts, ["mcp", "list", "--json"]), timeoutMs: 60_000 });
		// pi 在「有 enabled 但未连接」时以 exit 1 结束，stdout 仍是合法报告：只有形状不成立才算失败。
		const report = parseMcpListOutput(result.stdout);
		if (report === null) {
			getAppLogger()?.warn("remoteMcp", "pi mcp list output unusable", { hostId, exitCode: result.exitCode, stderr: tail(result.stderr ?? "") });
			throw new Error(C.commandFailed);
		}
		return report;
	}

	async function logout(hostId: string, server: unknown): Promise<{ ok: boolean; output: string }> {
		if (typeof server !== "string" || server.length > 128 || !isMcpServerName(server)) throw new Error(C.invalid);
		const facts = await ports.resolveFacts(hostId);
		const result = await ports.run({ hostId, remoteCommand: remotePiCommand(facts, ["mcp", "logout", server.trim()]), timeoutMs: 30_000 });
		return { ok: result.exitCode === 0, output: tail(result.stderr?.trim() || result.stdout.trim()) };
	}

	/**
	 * 远端 OAuth 登录：helper 侧跑 `pi mcp login <server>`，授权 URL 以事件帧实时回到这次请求。
	 * 结果只报告退出码与尾部输出；URL 走 emit，绝不出现在返回值里（返回值会进日志/UI 的通用错误位）。
	 */
	async function login(hostId: string, server: unknown, timeoutSec: unknown, operationId: unknown, emit?: (payload: { server: string; operationId?: string; url: string }) => void): Promise<{ ok: boolean; output: string }> {
		if (typeof server !== "string" || server.length > 128 || !isMcpServerName(server)) throw new Error(C.invalid);
		const seconds = typeof timeoutSec === "number" && Number.isInteger(timeoutSec) && timeoutSec > 0 ? Math.min(timeoutSec, 600) : 240;
		const operation = typeof operationId === "string" && operationId.length > 0 && operationId.length <= 128 ? operationId : undefined;
		const name = server.trim();
		const facts = await ports.resolveFacts(hostId);
		for (const value of [facts.home, facts.piPath, facts.nodePath]) if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || /[\u0000-\u001f]/.test(value)) throw new Error(C.unavailable);
		const result = await ports.request(
			hostId,
			"mcp.login",
			{ home: facts.home, nodePath: facts.nodePath, piPath: facts.piPath, server: name, timeoutSec: seconds },
			{
				timeoutMs: (seconds + 60) * 1000,
				onAuthUrl: (url) => {
					if (emit === undefined) return;
					emit({ server: name, ...(operation === undefined ? {} : { operationId: operation }), url });
				},
			},
		);
		if (!record(result) || typeof result.ok !== "boolean") throw new Error(C.unconfirmed);
		const output = typeof result.output === "string" ? tail(result.output) : "";
		const reason = typeof result.reason === "string" ? result.reason : "";
		// 超时/取消过的主机上可能仍有子进程在等授权，明确告诉调用方而不是报「失败」了事。
		return { ok: result.ok, output: reason === "" || result.ok ? output : `${reason}: ${output}` };
	}

	async function facts(hostId: string): Promise<{ home: string; piVersion: string }> {
		const resolved = await ports.resolveFacts(hostId);
		return { home: resolved.home, piVersion: resolved.version };
	}

	return {
		async execute(hostId: unknown, input: unknown, emit?: (payload: { server: string; operationId?: string; url: string }) => void): Promise<RemoteMcpResult> {
			if (typeof hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(hostId) || !record(input) || typeof input.action !== "string") throw new Error(C.invalid);
			const action = input.action as RemoteMcpRequest["action"];
			const shapes: Record<string, ReadonlyArray<string>> = {
				facts: ["action"],
				snapshot: ["action"],
				list: ["action"],
				logout: ["action", "server"],
				login: ["action", "operationId", "server", "timeoutSec"],
				save: ["action", "expectedVersion", "file"],
			};
			if (!Object.hasOwn(shapes, action)) throw new Error(C.invalid);
			if (Object.keys(input).some((key) => !shapes[action].includes(key))) throw new Error(C.invalid);
			if (action === "facts") return { action, ...(await facts(hostId)) };
			if (action === "snapshot") return { action, snapshot: await snapshot(hostId) };
			if (action === "save") return { action, ...(await save(hostId, input.file, input.expectedVersion)) };
			if (action === "list") return { action, report: await list(hostId) };
			if (action === "login") return { action: "login", ...(await login(hostId, input.server, input.timeoutSec, input.operationId, emit)) };
			return { action: "logout", ...(await logout(hostId, input.server)) };
		},
	};
}

export type RemotePiMcpService = ReturnType<typeof createRemotePiMcpService>;
