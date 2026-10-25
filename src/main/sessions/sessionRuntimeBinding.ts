/**
 * 会话运行时绑定网关 —— 主进程内部模块（IM 桥接、自动化等）与 pi 会话链路之间的唯一接口。
 *
 * 原先这个接口内联在 FeishuBridge 里。微信桥接成为第二个消费者后抽出来：桥接域只该
 * 依赖「契约」而不是「另一个桥接域」，否则加第三条通道就要照抄一遍、改动一处忘一处。
 * 实现仍在 main/index.ts 装配处（那里同时握着 sessionCatalog / sessionRuntimeCoordinator /
 * AgentManager），本模块只有类型，没有运行时依赖。
 */

import type { AgentRuntimeState, AgentTab, AvailableModel, ChatMessage, ImageContent, ImChannelBackend, SessionChannel } from "../../shared/types";
import type { SessionRunOutcome, SessionRunWaitInput } from "./sessionRunWaiter";

export interface SessionRuntimeBindingGateway {
	ensureSession(input: {
		projectId: string;
		title: string;
		existingSessionId?: string;
		sessionPath?: string;
		/**
		 * 新建会话用哪个后端（缺省 pi）。只对「新建」生效：existingSessionId/sessionPath
		 * 命中已有会话时以既有会话的后端为准——换引擎会让历史与模型目录都对不上。
		 */
		backend?: ImChannelBackend;
		/**
		 * 外部连接渠道（微信/飞书桥建的会话）：落库后侧栏显示渠道标志。
		 */
		channel?: SessionChannel;
		/**
		 * 开放自动命名：会话标题不归 IM 桥所有，等 pi 侧自动命名（扩展模型标题）来领。
		 * 缺省（false）= 桥给的标题是权威名（titleOrigin: "manual"），自动命名不得覆盖。
		 */
		autoTitle?: boolean;
	}): Promise<{ sessionId: string }>;
	activateRuntime(sessionId: string): Promise<AgentTab>;
	bindRuntime(input: { projectId: string; agent: AgentTab; existingSessionId?: string }): Promise<{ sessionId: string }>;
	sendPrompt(input: { sessionId: string; message: string; agentMessage?: string; images?: ImageContent[] }): Promise<void>;
	abortRuntime(sessionId: string): Promise<void>;
	/**
	 * 按 runtime id 找活跃 AgentTab（全后端：pi/DSH/ACP 统一）。
	 * 桥接原先只查 pi 的 AgentManager.list()，DSH 会话永远找不到句柄。
	 */
	findRuntimeAgent(agentId: string): AgentTab | undefined;
	/** 会话当前 runtime 的消息（无 runtime 返回空数组）。按会话身份取，避免旧 runtime 的迟到结果串台。 */
	getRuntimeMessages(sessionId: string): ChatMessage[];
	/** 等一个回合收口（后端无差别，契约见 sessionRunWaiter）：必须在提交 prompt 之前登记。 */
	waitForRunEnd(input: SessionRunWaitInput): Promise<SessionRunOutcome>;
	listRuntimeModels(sessionId: string): Promise<AvailableModel[]>;
	getRuntimeState(sessionId: string): Promise<AgentRuntimeState | undefined>;
	setRuntimeModel(sessionId: string, provider: string, modelId: string): Promise<void>;
	/** 切会话思考档位（微信等 IM 通道的 run 一律关思考）。 */
	setRuntimeThinking(sessionId: string, level: string): Promise<void>;
	/** 把 ask/confirm 等扩展 UI 的答案写回 pi（与桌面端弹窗回答同一条链路）。 */
	sendUIResponse(agentId: string, requestId: string, response: { value?: string | boolean; confirmed?: boolean; cancelled?: boolean }): void;
}
