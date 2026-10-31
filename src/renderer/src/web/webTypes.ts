/**
 * Web 端（A2 React）状态类型。
 *
 * 与后端 /api/state 返回结构对齐（WebServiceManager.getState），
 * 由 webApi.ts 轮询填充。会话/运行态只读展示用，不持有桌面端 atoms。
 */

import type { AgentUiBatchQuestion, SessionModelPreference, WebSecurityState } from "../../../shared/types";

export type WebProject = {
	id: string;
	name: string;
	path: string;
	kind?: "chat";
	/** 最近打开时间（毫秒时间戳），Web 端项目列表按此降序展示 */
	lastOpenedAt?: number;
	pinned?: boolean;
	sortOrder?: number;
};

export type WebSession = {
	id: string;
	projectId: string;
	title: string;
	status: string;
	projectPath?: string;
	model?: SessionModelPreference;
	thinkingLevel?: string;
	/** 运行时后端（pi/dsh；缺省 pi），侧栏/头部徽标展示用 */
	backend?: import("../../../shared/types").AgentBackend;
	/** ACP 工具 id（AcpToolConfig.id）：acp 会话的后端选择器要回填具体 CLI */
	acpToolId?: string;
	/** 最近活动时间（毫秒时间戳），Web 端会话列表按此降序展示（最新在上） */
	updatedAt?: number;
	/**
	 * 父会话 id：子代理/嵌套子会话由服务端按目录 parentSessionPath 解析后下发，
	 * 侧栏据此折叠到父行下（父行不在同一项目/同一搜索结果里时按顶层展示）。
	 */
	parentSessionId?: string;
	/** 是否为 fork 产物（身份标记，不参与侧栏折叠） */
	forked?: boolean;
	createdAt?: number;
	/** DSH 权限预设（P1；与 SessionRecord 同名，state 原样投影）。 */
	permissionPreset?: string;
};

export type WebRuntime = {
	sessionId: string;
	agentId: string;
	status: string;
	cwd?: string;
	runtimeGeneration?: number;
};

export type WebPendingUiRequest = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
	requestId: string;
	method: string;
	title: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	allowOther?: boolean;
	batchQuestions?: AgentUiBatchQuestion[];
	batchReview?: boolean;
};

export type WebState = {
	projects: WebProject[];
	sessions: WebSession[];
	runtimes: WebRuntime[];
	pendingUiRequests?: WebPendingUiRequest[];
	/** 可选的 ACP 工具（id/name；空/缺失=本机未开启 ACP，后端选择器不列 ACP 入口） */
	acpTools?: WebAcpTool[];
	/** Pi 会话安全等级（全局默认 + 会话覆盖）；缺失=服务端未装配安全管理，不渲染入口 */
	security?: WebSecurityState;
	/** 宿主应用版本号（侧栏底栏展示）；缺失=服务端未下发，不渲染版本位 */
	version?: string;
};

/** /api/state 下发的 ACP 工具条目（command/args/env 不外发）。 */
export type WebAcpTool = { id: string; name: string };

/** 上下文用量环（P2）：来自 runtime state 轮询，字段与 AgentManager 聚合同名。 */
export type WebContextUsage = {
	contextTokens?: number;
	contextWindow?: number;
	contextPercent?: number;
	contextOverflow?: boolean;
	inputTokens?: number;
	outputTokens?: number;
	/** DSH 权限预设（runtime state 直出，与桌面 DshPermissionMenu 同一数据源）。
	 *  头部盾牌图标以它为准；会话记录里的 permissionPreset 只做无 runtime 时兜底——
	 *  乐观切换会被 /api/state 轮询冲掉，单信会话记录会让图标切完又弹回去。 */
	permissionPreset?: string;
	/** 当前模型的供应商名（runtime state 直出，AgentManager 由 model.provider 归一）。
	 *  头部额度区块靠它查用量探针；会话记录的 model.provider 只在无 runtime 时兜底。 */
	provider?: string;
};

/** 文件抽屉节点（P3）：后端已剥离绝对路径，只留项目内相对信息。 */
export type WebFileNodeLite = {
	name: string;
	relativePath: string;
	type: "file" | "directory";
	hasChildren?: boolean;
};
