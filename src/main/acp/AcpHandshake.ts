/**
 * ACP 握手编排：initialize → session/new（或 session/load 恢复）。
 *
 * 从 AcpAgentManager 抽出的协作者。失败由调用方（create）清理进程；
 * 成功后 runtime 拥有 acpSessionId/agentInfo/title/configOptions 与播种后的投影。
 * 通知监听在握手前注册（部分 CLI 握手期即推 update），分发回 manager 的串行链。
 */
import type { ChatMessage } from "../../shared/types/session";
import type { AgentTab } from "../../shared/types/agent";
import type { AcpConfigOption, AcpAgentCapabilities, AcpMcpServer, AcpRpcNotification, AcpSessionLoadResult, AcpSessionSetupResult } from "./acpProtocol";
import { ACP_PROTOCOL_VERSION } from "./acpProtocol";
import type { AcpAgentRuntime } from "./acpAgentRuntime";
import type { AcpConnection } from "./AcpConnection";
import { initialAcpProjection, settleAcpTurn } from "./AcpEventProjector";

/** initialize/session-new/load 握手超时:CLI 冷启动(npm 包)可能要十几秒。 */
const HANDSHAKE_TIMEOUT_MS = 60_000;

export type AcpHandshakeDeps = {
	handshakeTimeoutMs?: number;
	logger?: { info(channel: string, message: string, meta?: Record<string, unknown>): void; warn(channel: string, message: string, meta?: Record<string, unknown>): void };
	/** 重入播种：load 失败回退 session/new 时的内存快照数据源（AcpMessageSnapshotStore）。 */
	seedMessages: (acpSessionId: string) => ChatMessage[];
	/** session/update 等通知的分发（manager 的串行链编排）。 */
	onNotification: (runtime: AcpAgentRuntime, notification: AcpRpcNotification) => void;
	/** configOptions 变更推送（settings 回调）。 */
	onConfigOptionsChanged?: (tab: AgentTab, options: AcpConfigOption[]) => void;
	/**
	 * 会话级 MCP 服务器（ACP v1 只有 stdio 形态）：PiDeck 用它把 `pideck-agent-memory`
	 * 挂进外部 CLI 会话，让 ACP 后端也有记忆工具。缺省不给工具（保持旧行为）。
	 * 传函数是为了每次握手现算：挂载内容依赖会话 cwd（项目记忆键）。
	 */
	mcpServers?: (cwd: string) => AcpMcpServer[];
};

/** load 失败回退 / 无 loadSession 能力时的播种:用本进程内快照保住显示连续性。 */
function seedProjectionFromSnapshot(runtime: AcpAgentRuntime, deps: Pick<AcpHandshakeDeps, "seedMessages">, resumeSessionId: string): void {
	runtime.projection = { ...initialAcpProjection(), messages: [...(deps.seedMessages(resumeSessionId) ?? [])] };
	runtime.title = undefined;
	runtime.configOptions = undefined;
}

/** initialize + session/new(或 load);失败由调用方清理进程。 */
export async function performAcpHandshake(runtime: AcpAgentRuntime, resumeSessionId: string | undefined, cwd: string, spawnFailure: Promise<never>, deps: AcpHandshakeDeps): Promise<void> {
	const conn = runtime.conn;
	if (!conn) throw new Error("ACP connection missing");
	const timeoutMs = deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
	// 通知在握手后才有意义,但先注册分发(部分 CLI 握手期即可能推 update)。
	conn.on("notification", (notification: { method?: string }) => {
		// config_option_update:agent 主动推送配置变更(如限流降级模型),不进投影链,
		// 直接整表替换并通知渲染层(会话期可能无 in-flight set 请求,不能只在响应里更新)
		if (notification.method === "config_option_update") {
			const params = (notification as { params?: { sessionId?: string; configOptions?: AcpConfigOption[] } }).params;
			if (runtime.status !== "closed" && !runtime.reloading && params?.sessionId === runtime.acpSessionId && Array.isArray(params.configOptions)) {
				runtime.configOptions = params.configOptions;
				deps.onConfigOptionsChanged?.(runtime.tab, params.configOptions);
			}
			return;
		}
		deps.onNotification(runtime, notification as AcpRpcNotification);
	});
	conn.on("protocol-error", (line: unknown) => {
		// stdout 混入非 JSON(CLI banner/进度条):不致命,记录即可;ACP 规范允许 client 忽略。
		deps.logger?.warn("acp", `[${runtime.tool.name}] non-JSON stdout ignored: ${String(line).slice(0, 300)}`);
	});

	const initTask = conn.request(
		"initialize",
		{
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
				// CodeBuddy ≥2.178.1 用 initialize 的这条 vendor 扩展做 mainAgentOptIn 门控：
				// 不声明就不下发 toolMode（工具模式/PTC）、agent（Main Agent）、delegate，
				// 连 --agent ptc 与手写 codeMode 都会被拒（-32602，#447 实测）。
				// 键归属 CB 命名空间，其他 agent 按 ACP 规范忽略未知 _meta；PiDeck 的
				// configOptions 走通用渲染，声明后这些选项能直接落地，不需要按品牌分支。
				_meta: { "codebuddy.ai": { mainAgentSupport: true } },
			},
		},
		timeoutMs,
	);
	const initResult = (await Promise.race([initTask, spawnFailure])) as { protocolVersion?: unknown; agentCapabilities?: AcpAgentCapabilities; agentInfo?: { name?: unknown } | null } | null;
	if (initResult?.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocolVersion: ${String(initResult?.protocolVersion)}`);
	const agentCaps = initResult.agentCapabilities ?? {};
	runtime.agentInfo = {
		name: typeof initResult.agentInfo?.name === "string" ? initResult.agentInfo.name : undefined,
		capabilities: {
			loadSession: agentCaps.loadSession === true,
			agentThought: agentCaps.promptCapabilities?.agentThought === true,
			sessionList: typeof agentCaps.sessionCapabilities?.list === "object" && agentCaps.sessionCapabilities.list !== null,
			promptImage: agentCaps.promptCapabilities?.image === true,
		},
		protocolVersion: ACP_PROTOCOL_VERSION,
	};

	// session/new 或 session/load。load 失败(id 在 agent 侧已不存在)回退新建。
	// mcpServers 必传(哪怕是空数组): ACP v1 规范该字段必填, opencode 的 zod 校验缺它直接
	// -32602 Invalid params(实测), 会话创建即失败冒泡成首条消息发送失败。
	const mcpServers = deps.mcpServers?.(cwd) ?? [];
	let setup: AcpSessionLoadResult | undefined;
	if (resumeSessionId && runtime.agentInfo.capabilities.loadSession) {
		// ACP 规范:agent 先经 session/update 重放历史、再回 load 响应。重放期 client
		// 手里只有请求参数里的旧 sessionId,必须提前挂到 runtime 上,否则
		// handleSessionUpdate 的 sessionId 过滤会把整段重放历史全部丢弃。
		runtime.acpSessionId = resumeSessionId;
		runtime.reloading = true;
		try {
			const loaded = (await conn.request("session/load", { sessionId: resumeSessionId, cwd, mcpServers }, timeoutMs)) as AcpSessionLoadResult;
			await runtime.updateChain;
			// 标准 load 响应无 sessionId；保留请求身份。兼容明确回传身份的旧 CLI。
			setup = { ...loaded, sessionId: typeof loaded?.sessionId === "string" && loaded.sessionId ? loaded.sessionId : resumeSessionId };
			// 成功的 load 才标记：失败回退 session/new 时仍要重放工具级默认配置。
			runtime.loadedSession = true;
		} catch (error) {
			// 排空已经开始的物化再丢弃；否则在途旧快照能污染 session/new。
			runtime.acpSessionId = "";
			await runtime.updateChain;
			seedProjectionFromSnapshot(runtime, deps, resumeSessionId);
			deps.logger?.warn("acp", `session/load failed, falling back to session/new: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			runtime.reloading = false;
		}
	} else if (resumeSessionId) {
		// CLI 无 loadSession 能力:只能 session/new 新建(agent 侧上下文必然是空的),
		// 但显示层不能整段抹掉——与 load 失败回退同一处理,用内存快照播种投影
		// 保住连续性(重启按钮/重新激活都走这里)。播种消息 agent 侧并不存在,仅显示层连续。
		// 无快照才保持空:应用重启后 AcpAgentManager 会先把 userData/acp-sessions 的归档
		// 回灌进快照存储(#415),所以这里通常已经有内容,不再是「重启后必然空白」。
		seedProjectionFromSnapshot(runtime, deps, resumeSessionId);
	}
	if (!setup?.sessionId) {
		setup = (await conn.request("session/new", { cwd, mcpServers }, timeoutMs)) as AcpSessionSetupResult;
	}
	if (!setup?.sessionId || typeof setup.sessionId !== "string") throw new Error("ACP session/new returned no sessionId");
	runtime.acpSessionId = setup.sessionId;
	// tab.sessionId 镜像 agent 侧会话 id(与 DSH 的 tab.sessionId=host id 同契约):
	// SessionRuntimeCoordinator 的 buildAttachPatch / prompt dispatch / restart 都以
	// 它为键把 acpSessionId 落 catalog。缺失则 acpSessionId 永不持久化,重开历史
	// 会话只能 session/new 新建,历史全部丢失。
	runtime.tab.sessionId = setup.sessionId;
	if (typeof setup.title === "string" && setup.title.trim()) runtime.title = setup.title.trim();
	// configOptions 规范路径(取代旧 modes):模型/思考档/模式枚举,渲染层选择器数据源
	runtime.configOptions = Array.isArray(setup.configOptions) ? setup.configOptions : runtime.configOptions;
	await runtime.updateChain;
	runtime.projection = settleAcpTurn(runtime.projection, "end_turn");
}
