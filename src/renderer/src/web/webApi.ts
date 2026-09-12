/**
 * webApi — Web 端与主进程 WebServiceManager 的 HTTP 数据访问层。
 *
 * 覆盖范围（与桌面端对齐但收窄）：
 * - /api/state：项目/会话/运行态轮询
 * - /api/sessions（POST）：按项目新建会话
 * - /api/sessions/:id/messages/page：历史完整轮次分页（URL 保持兼容）
 * - 发送消息走 useChat（/api/chat 流式），不在此处重复实现
 */
import type { UIMessage } from "ai";
import type {
	AvailableModel,
	ChatMessage,
	SessionCommandResult,
	SessionLaunchPreferences,
	SessionMessagePage,
	SessionRuntimeTarget,
	SessionTargetedValue,
	UpdateSessionRecordInput,
} from "../../../shared/types";
import type { AgentUiResponse } from "../../../shared/types";
import type { WebState } from "./webTypes";

/** 轮询 /api/state 拿项目/会话/运行态（低频兜底，主数据流走 useChat）。 */
export async function fetchState(): Promise<WebState> {
	const res = await fetch("/api/state");
	if (!res.ok) throw new Error(`state ${res.status}`);
	return res.json();
}

/** 从 Web 端注册一个本地项目路径，返回项目记录。 */
export async function createProject(path: string): Promise<WebState["projects"][number]> {
	const res = await fetch("/api/projects", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path }),
	});
	if (!res.ok) throw new Error(`create project ${res.status}`);
	const result = (await res.json()) as { project?: WebState["projects"][number] };
	if (!result.project) throw new Error("create project: missing project");
	return result.project;
}

/** 删除项目登记记录；不会删除项目目录或工作区文件。 */
export async function deleteProject(projectId: string): Promise<void> {
	const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/delete`, { method: "POST" });
	if (!res.ok) throw new Error(`delete project ${res.status}`);
}

/** 读取 pi 当前可用模型，草稿会话也可以先选模型再发送第一条消息。
 * force：绕过服务端模型列表缓存（对应选择器刷新按钮）。 */
export async function fetchModels(force = false): Promise<AvailableModel[]> {
	const res = await fetch(force ? "/api/models?force=1" : "/api/models");
	if (!res.ok) throw new Error(`models ${res.status}`);
	const result = (await res.json()) as { models?: AvailableModel[] };
	return result.models ?? [];
}

/** 按项目新建会话（对应桌面端「新建 Agent」入口）。返回新会话 id。 */
/**
 * 新建会话草稿；preferences 携带启动前选择的模型/思考级别（首页直发场景），
 * 无偏好时保持后端默认（pi 配置默认值）。
 */
export async function createSession(
	projectId: string,
	preferences?: SessionLaunchPreferences,
): Promise<string> {
	const res = await fetch("/api/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId, ...preferences }),
	});
	if (!res.ok) throw new Error(`create session ${res.status}`);
	const result = (await res.json()) as { session?: { id?: string } };
	const id = result.session?.id;
	if (!id) throw new Error("create session: missing session id");
	return id;
}

/** 拉历史消息页（分页），供注入 useChat / 展示。 */
/** 更新尚未启动 runtime 的会话偏好；运行中的会话由 runtime 命令即时应用。 */
export async function updateSessionRecord(
	sessionId: string,
	patch: UpdateSessionRecordInput,
): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/update`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) throw new Error(`update session ${res.status}`);
}

async function callRuntimeCommand<T>(
	sessionId: string,
	target: SessionRuntimeTarget,
	action: string,
	body: Record<string, unknown> = {},
): Promise<T> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runtime/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target, ...body }),
	});
	if (!res.ok) throw new Error(`runtime ${action} ${res.status}`);
	const payload = (await res.json()) as { result?: SessionCommandResult<SessionTargetedValue<T>> };
	const result = payload.result;
	if (!result || !result.ok) {
		throw new Error(result?.error.code ?? `runtime ${action} failed`);
	}
	return result.value.value;
}

/** 运行中的模型切换会立即发送给 pi，并由主进程同步会话记录。 */
export function setRuntimeModel(
	target: SessionRuntimeTarget,
	provider: string,
	modelId: string,
): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "model", { provider, modelId });
}

/** 运行中的思考级别切换会立即发送给 pi，并由主进程同步会话记录。 */
export function setRuntimeThinking(
	target: SessionRuntimeTarget,
	level: string,
): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "thinking", { level });
}

/** 运行中的 DSH 权限切换走 runtime 命令，避免 `/permission` 进入普通消息流。 */
export function setRuntimePermission(
	target: SessionRuntimeTarget,
	preset: string,
): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "permission", { preset });
}

/** 手机/Web 端回答 ask_question / confirm / input。 */
export async function respondToUi(input: {
	sessionId: string;
	requestId: string;
	agentId: string;
	runtimeGeneration: number;
	response: AgentUiResponse;
}): Promise<void> {
	const res = await fetch("/api/ui-response", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) throw new Error(`ui-response ${res.status}`);
}

export async function fetchMessagePage(
	sessionId: string,
	before?: number,
	pageSize?: number,
): Promise<SessionMessagePage> {
	const params = new URLSearchParams();
	if (before != null) params.set("before", String(before));
	if (pageSize != null) params.set("pageSize", String(pageSize));
	const qs = params.toString();
	const res = await fetch(
		`/api/sessions/${encodeURIComponent(sessionId)}/messages/page${qs ? `?${qs}` : ""}`,
	);
	if (!res.ok) throw new Error(`messages ${res.status}`);
	return (await res.json()) as SessionMessagePage;
}

/**
 * 历史 ChatMessage 列表 → useChat 的 UIMessage[]（text-only parts）。
 * 历史消息仅注入正文；流式思考/工具由 useChat 从 SSE 实时构建，避免与
 * 静态历史重复。ChatMessage.thinking 存在时一并注入 reasoning part，
 * 让历史会话也能折叠查看思考过程。
 */
export function chatMessagesToUiMessages(messages: ChatMessage[]): UIMessage[] {
	return messages.map((message) => {
		const role =
			message.role === "user"
				? "user"
				: message.role === "assistant"
					? "assistant"
					: "assistant";
		const parts: UIMessage["parts"] = [];
		if (message.thinking) {
			parts.push({ type: "reasoning", text: message.thinking });
		}
		if (message.text) {
			parts.push({ type: "text", text: message.text });
		}
		return {
			id: message.id ?? `hist-${message.timestamp ?? Math.random()}`,
			role,
			parts,
		};
	});
}

// ── DSH 工具面板（S6.3：goals/subagents/skills，走 REST，与桌面 IPC 同源）──

export type WebDshSubagent = {
	id: string;
	label?: string;
	activity: "running" | "inactive";
	hasChildren: boolean;
	mode: "one-shot" | "continuable";
	kind: "child" | "diagnostic";
};

export type WebDshSkill = {
	name: string;
	description: string;
	whenToUse?: string;
	modelInvocable: boolean;
};

export type WebDshGoal = {
	refId: string;
	revision: number;
	objective: string;
	phase: "active" | "paused" | "blocked" | "complete";
	maxGoalRounds: number;
	roundsStarted: number;
};

async function getJson<T>(path: string, fallback: T): Promise<T> {
	const res = await fetch(path);
	if (!res.ok) return fallback;
	return (await res.json()) as T;
}

/** 会话的子代理目录（需活跃 runtime；无则返回空）。 */
export function fetchDshSubagents(sessionId: string): Promise<{ subagents: WebDshSubagent[] }> {
	return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/subagents`, { subagents: [] });
}

/** 子代理只读 transcript（分页）。 */
export function fetchDshSubagentHistory(
	sessionId: string,
	childSessionId: string,
): Promise<{ messages: Array<{ role: string; text: string }>; hasMore: boolean }> {
	return getJson(
		`/api/sessions/${encodeURIComponent(sessionId)}/dsh/subagents/${encodeURIComponent(childSessionId)}/history`,
		{ messages: [], hasMore: false },
	);
}

/** 会话技能目录（skill.list 只读）。 */
export function fetchDshSkills(sessionId: string): Promise<{ skills: WebDshSkill[] }> {
	return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/skills`, { skills: [] });
}

/** 会话当前目标（runtime state 投影；无 runtime/无目标返回 null）。 */
export function fetchDshGoal(sessionId: string): Promise<{ goal: WebDshGoal | null }> {
	return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/goal`, { goal: null });
}

// ── DSH 插件（S6.5：动态 Cordis 插件，与桌面配置页同源）──────────────────

export type WebDshPluginPackage = {
	packageId: string;
	name: string;
	purpose: string;
	hasHostHalf: boolean;
	hasClientHalf: boolean;
};

export type WebDshPlugin = {
	pluginId: string;
	agentId: string;
	packages: WebDshPluginPackage[];
	currentPackageId?: string;
	nextPackageId?: string;
	activeRun?: { pluginRunId: string; packageId: string };
	status?: string;
	mode?: string;
	error?: string;
};

export type WebDshStaticPlugin = {
	entryId: string;
	moduleName: string;
	enabled: boolean;
	fiberPhase: string | null;
	/** 来源：user = $DSH_HOME/cordis.patch.yml 用户补丁层；缺省视为 builtin（旧 host 兼容）。 */
	origin?: "builtin" | "user";
};

/** 动态 + 静态插件清单（全局；install 需按会话归属）。 */
export function fetchDshPlugins(): Promise<{ dynamic: WebDshPlugin[]; static: WebDshStaticPlugin[] }> {
	return getJson("/api/dsh/plugins", { dynamic: [], static: [] });
}

/** 安装动态插件（define：定义源码包，不运行；hostCode 在 host 进程内执行——非安全边界）。 */
export async function installDshPlugin(input: {
	sessionId: string;
	idPrefix: string;
	name: string;
	purpose: string;
	hostCode: string;
}): Promise<unknown> {
	const res = await fetch("/api/dsh/plugins/install", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `install plugin ${res.status}`);
	}
	return (await res.json()) as unknown;
}

/** 动态插件生命周期（run/stop/uninstall；面板手势 requestId=null 无需审批）。 */
export async function dshPluginAction(
	pluginId: string,
	action: "run" | "stop" | "uninstall",
	input: { sessionId: string; packageId?: string },
): Promise<unknown> {
	const res = await fetch(`/api/dsh/plugins/${encodeURIComponent(pluginId)}/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `plugin ${action} ${res.status}`);
	}
	return (await res.json()) as unknown;
}
