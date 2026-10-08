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
import type { AvailableModel, AgentBackend, ChatMessage, SessionCommandResult, SessionFileChange, SessionLaunchPreferences, SessionMessagePage, SessionRuntimeTarget, SessionTargetedValue, SessionTodoSnapshot, UpdateSessionRecordInput } from "../../../shared/types";
import type { CommitEntry, GitBranchInfo, GitResourceGroups, ImageContent, PiExtensionSummary, PiSkillLocation, PiSkillSummary, PiSubagentEntry, YaoPromptCategory } from "../../../shared/types";
import type { AgentUiResponse } from "../../../shared/types";
import type { WebContextUsage, WebFileNodeLite, WebState } from "./webTypes";

// Web 服务令牌：与 browserApi 同型（同一 localStorage key），从二维码/分享链接的 ?token= 读取一次并持久化。
// 之后所有请求统一带 Authorization: Bearer；环回绑定服务端不校验，无令牌时照常工作。
export const WEB_TOKEN_STORAGE_KEY = "pideck-web-token";
// Node 测试（loadTsCommonJs 无 window）不执行捕获；浏览器加载时从 ?token= 读取一次并持久化。
let webToken: string | null = null;
if (typeof window !== "undefined") {
	const tokenFromUrl = new URLSearchParams(window.location.search).get("token");
	if (tokenFromUrl) window.localStorage.setItem(WEB_TOKEN_STORAGE_KEY, tokenFromUrl);
	webToken = window.localStorage.getItem(WEB_TOKEN_STORAGE_KEY);
}

/** 请求注入用的鉴权头；无令牌时返回空对象（环回绑定不校验，省略即可）。 */
export function getWebAuthHeaders(): Record<string, string> {
	return webToken ? { authorization: `Bearer ${webToken}` } : {};
}

/** 当前令牌（SSE 类连接用：EventSource 无法携带 Authorization header，只能拼 query）。 */
export function getWebToken(): string | null {
	return webToken;
}

/** 统一出口：合并鉴权头后转发给 fetch；调用方原有 headers 优先。 */
function apiFetch(input: string, init?: RequestInit): Promise<Response> {
	return fetch(input, {
		...init,
		headers: { ...getWebAuthHeaders(), ...init?.headers },
	});
}

/** 轮询 /api/state 拿项目/会话/运行态（低频兜底，主数据流走 useChat）。 */
export async function fetchState(): Promise<WebState> {
	const res = await apiFetch("/api/state");
	if (!res.ok) throw new Error(`state ${res.status}`);
	return res.json();
}

/** 从 Web 端注册一个本地项目路径，返回项目记录。 */
export async function createProject(path: string): Promise<WebState["projects"][number]> {
	const res = await apiFetch("/api/projects", {
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
	const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/delete`, { method: "POST" });
	if (!res.ok) throw new Error(`delete project ${res.status}`);
}

/** 读取 pi 当前可用模型，草稿会话也可以先选模型再发送第一条消息。
 * force：绕过服务端模型列表缓存（对应选择器刷新按钮）。 */
export async function fetchModels(force = false): Promise<AvailableModel[]> {
	const res = await apiFetch(force ? "/api/models?force=1" : "/api/models");
	if (!res.ok) throw new Error(`models ${res.status}`);
	const result = (await res.json()) as { models?: AvailableModel[] };
	return result.models ?? [];
}

/** 按项目新建会话（对应桌面端「新建 Agent」入口）。返回新会话 id。 */
/**
 * 新建会话草稿；preferences 携带启动前选择的模型/思考级别/后端（首页直发场景），
 * 无偏好时保持后端默认（pi 配置默认值）。backend 对应 CreateSessionDraftInput.backend。
 */
export async function createSession(projectId: string, preferences?: SessionLaunchPreferences & { backend?: AgentBackend }): Promise<string> {
	const res = await apiFetch("/api/sessions", {
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
export async function updateSessionRecord(sessionId: string, patch: UpdateSessionRecordInput): Promise<void> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/update`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) throw new Error(`update session ${res.status}`);
}

async function callRuntimeCommand<T>(sessionId: string, target: SessionRuntimeTarget, action: string, body: Record<string, unknown> = {}): Promise<T> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/runtime/${action}`, {
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
export function setRuntimeModel(target: SessionRuntimeTarget, provider: string, modelId: string, modelName?: string): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "model", { provider, modelId, modelName });
}

/** 运行中的思考级别切换会立即发送给 pi，并由主进程同步会话记录。 */
export function setRuntimeThinking(target: SessionRuntimeTarget, level: string): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "thinking", { level });
}

/** 运行中的 DSH 权限切换走 runtime 命令，避免 `/permission` 进入普通消息流。 */
export function setRuntimePermission(target: SessionRuntimeTarget, preset: string): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "permission", { preset });
}

/** 手机/Web 端回答 ask_question / confirm / input。 */
export async function respondToUi(input: { sessionId: string; requestId: string; agentId: string; runtimeGeneration: number; response: AgentUiResponse }): Promise<void> {
	const res = await apiFetch("/api/ui-response", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) throw new Error(`ui-response ${res.status}`);
}

export async function fetchMessagePage(sessionId: string, before?: number, pageSize?: number): Promise<SessionMessagePage> {
	const params = new URLSearchParams();
	if (before != null) params.set("before", String(before));
	if (pageSize != null) params.set("pageSize", String(pageSize));
	const qs = params.toString();
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages/page${qs ? `?${qs}` : ""}`);
	if (!res.ok) throw new Error(`messages ${res.status}`);
	return (await res.json()) as SessionMessagePage;
}

/**
 * 历史 ChatMessage 列表 → useChat 的 UIMessage[]。
 * - text/thinking：同前（正文 + reasoning part）。
 * - P2：用户消息 images → file part（data URL），工具消息（role="tool"，meta 携带
 *   toolName/args/result/detailText）→ `tool-${name}` part（output-available/error），
 *   历史会话也能展开工具卡片；流式期间的实时工具由 SSE 构建，不与此重叠。
 */
export function chatMessagesToUiMessages(messages: ChatMessage[]): UIMessage[] {
	const result: UIMessage[] = [];
	for (const message of messages) {
		const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "assistant";
		const parts: UIMessage["parts"] = [];
		if (message.role === "tool") {
			const meta = message.meta as Record<string, unknown> | undefined;
			const toolName = typeof meta?.toolName === "string" && meta.toolName ? meta.toolName : "";
			if (toolName) {
				const isError = meta?.isError === true || message.text.startsWith("✗");
				let input: unknown = meta?.args;
				if (typeof input === "string" && input) {
					try {
						input = JSON.parse(input);
					} catch {
						// 已是截断的非 JSON 字符串时原样展示
					}
				}
				// 动态工具 part 名是运行期拼的（`tool-${name}`），ai SDK 静态类型覆盖不了；
				// 与 WebTimeline:151 对 SSE part 的同型转换保持一致。
				const toolPart = {
					type: `tool-${toolName}` as `tool-${string}`,
					toolCallId: `hist-${message.id}`,
					state: isError ? "output-error" : "output-available",
					input,
					output: meta?.result,
					errorText: isError ? (typeof meta?.detailText === "string" ? meta.detailText : message.text) : undefined,
				};
				parts.push(toolPart as unknown as UIMessage["parts"][number]);
			} else if (message.text) {
				parts.push({ type: "text", text: message.text });
			}
			result.push({ id: message.id ?? `hist-${message.timestamp ?? Math.random()}`, role: "assistant", parts });
			continue;
		}
		if (message.thinking) {
			parts.push({ type: "reasoning", text: message.thinking });
		}
		if (message.text) {
			parts.push({ type: "text", text: message.text });
		}
		// P2：历史用户图片 → file part（data URL）。超大数据防护：单张 >4MB 直接跳过
		// （页端已有界，这里只防异常大图拖垮渲染层）。
		if (role === "user" && Array.isArray(message.images)) {
			for (const image of message.images) {
				if (image?.type !== "image" || typeof image.mimeType !== "string" || typeof image.data !== "string") continue;
				if (image.data.length > 4 * 1024 * 1024) continue;
				parts.push({ type: "file", mediaType: image.mimeType, data: `data:${image.mimeType};base64,${image.data}` } as unknown as UIMessage["parts"][number]);
			}
		}
		result.push({
			id: message.id ?? `hist-${message.timestamp ?? Math.random()}`,
			role,
			parts,
		});
	}
	return result;
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
	const res = await apiFetch(path);
	if (!res.ok) return fallback;
	return (await res.json()) as T;
}

/** 会话的子代理目录（需活跃 runtime；无则返回空）。 */
export function fetchDshSubagents(sessionId: string): Promise<{ subagents: WebDshSubagent[] }> {
	return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/subagents`, { subagents: [] });
}

/** 子代理只读 transcript（分页）。 */
export function fetchDshSubagentHistory(sessionId: string, childSessionId: string): Promise<{ messages: Array<{ role: string; text: string }>; hasMore: boolean }> {
	return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/subagents/${encodeURIComponent(childSessionId)}/history`, { messages: [], hasMore: false });
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
export async function installDshPlugin(input: { sessionId: string; idPrefix: string; name: string; purpose: string; hostCode: string }): Promise<unknown> {
	const res = await apiFetch("/api/dsh/plugins/install", {
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
export async function dshPluginAction(pluginId: string, action: "run" | "stop" | "uninstall", input: { sessionId: string; packageId?: string }): Promise<unknown> {
	const res = await apiFetch(`/api/dsh/plugins/${encodeURIComponent(pluginId)}/${action}`, {
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

// ── P0-P3 会话/运行时控制与工作区扩展 ──────────────────────────────────

/** P0：停止（优雅）当前 runtime。 */
export function stopRuntime(sessionId: string, target: SessionRuntimeTarget): Promise<unknown> {
	return callRuntimeCommand<unknown>(sessionId, target, "stop");
}

/** P0：打断（立即）当前 runtime——流式中停止按钮走这里，pi 会丢弃未完成回合。 */
export function abortRuntime(sessionId: string, target: SessionRuntimeTarget): Promise<unknown> {
	return callRuntimeCommand<unknown>(sessionId, target, "abort");
}

/** P1：重启会话进程（会话身份不变）。 */
export function restartRuntime(sessionId: string, target: SessionRuntimeTarget): Promise<unknown> {
	return callRuntimeCommand<unknown>(sessionId, target, "restart");
}

/** P1：压缩上下文（可选自定义 prompt）。 */
export function compactRuntime(sessionId: string, target: SessionRuntimeTarget, prompt?: string): Promise<unknown> {
	return callRuntimeCommand<unknown>(sessionId, target, "compact", prompt ? { prompt } : {});
}

/** P1：克隆会话（fork 标记；返回新会话记录，切换由调用方决定）。 */
export async function cloneRuntime(sessionId: string, target: SessionRuntimeTarget): Promise<{ session?: { id?: string } }> {
	return callRuntimeCommand<{ session?: { id?: string } }>(sessionId, target, "clone");
}

/** P1：重命名会话（走 catalog update，不需要 runtime）。 */
export async function renameSession(sessionId: string, title: string): Promise<void> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/update`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title }),
	});
	if (!res.ok) throw new Error(`rename session ${res.status}`);
}

/** P1：删除会话记录（含会话文件）。 */
export async function deleteSession(sessionId: string): Promise<void> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, { method: "POST" });
	if (!res.ok) throw new Error(`delete session ${res.status}`);
}

/** P1：复制会话（浅拷贝生成新会话记录）。 */
export async function copySession(sessionId: string): Promise<string | undefined> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/copy`, { method: "POST" });
	if (!res.ok) throw new Error(`copy session ${res.status}`);
	const payload = (await res.json()) as { result?: { session?: { id?: string } } };
	return payload.result?.session?.id;
}

/** P1/P3：导出会话 HTML 并在浏览器端触发下载（GET 附件流，鉴权头由 fetch 携带）。 */
export async function downloadSessionHtml(sessionId: string): Promise<void> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/export-html`);
	if (!res.ok) throw new Error(`export html ${res.status}`);
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = `pideck-session-${sessionId.replace(/[^\w.-]+/g, "_")}.html`;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/** P1：编辑历史用户消息（runtime 必须存活）。 */
export function editRuntimeMessage(sessionId: string, target: SessionRuntimeTarget, messageId: string, newText: string): Promise<void> {
	return callRuntimeCommand<void>(sessionId, target, "edit-message", { messageId, newText });
}

/** P1：删除单条历史消息。 */
export function deleteRuntimeMessage(sessionId: string, target: SessionRuntimeTarget, messageId: string): Promise<void> {
	return callRuntimeCommand<void>(sessionId, target, "delete-message", { messageId });
}

/** P1：准备重发——取回该消息文本（+图片），由调用方填入 composer。 */
export function prepareResend(sessionId: string, target: SessionRuntimeTarget, messageId: string): Promise<{ text: string; images?: ImageContent[] }> {
	return callRuntimeCommand<{ text: string; images?: ImageContent[] }>(sessionId, target, "prepare-resend", { messageId });
}

/** P2：上下文用量（runtime state 子集，供头部圆环轮询）。 */
export async function fetchRuntimeContextUsage(sessionId: string, target: SessionRuntimeTarget): Promise<WebContextUsage> {
	const usage = await callRuntimeCommand<WebContextUsage>(sessionId, target, "state");
	return usage ?? {};
}

/** P2：提示词库搜索（中文提示词精选）。 */
export async function fetchPrompts(search?: string, category?: string, page = 1, pageSize = 20): Promise<{ categories: YaoPromptCategory[]; prompts: Array<{ slug: string; title: string; category: string; subcategory: string; tags: string[]; description: string }>; total?: number }> {
	const params = new URLSearchParams();
	if (search) params.set("search", search);
	if (category) params.set("category", category);
	params.set("page", String(page));
	params.set("pageSize", String(pageSize));
	const res = await apiFetch(`/api/prompts?${params.toString()}`);
	if (!res.ok) throw new Error(`prompts ${res.status}`);
	return (await res.json()) as { categories: YaoPromptCategory[]; prompts: Array<{ slug: string; title: string; category: string; subcategory: string; tags: string[]; description: string }>; total?: number };
}

/** P2：提示词正文（插入 composer 用）。 */
export async function fetchPromptContent(slug: string, category: string): Promise<string> {
	const params = new URLSearchParams({ category });
	const res = await apiFetch(`/api/prompts/${encodeURIComponent(slug)}?${params.toString()}`);
	if (!res.ok) throw new Error(`prompt detail ${res.status}`);
	const payload = (await res.json()) as { detail?: { promptContent?: string } };
	return payload.detail?.promptContent ?? "";
}

/** P3：git 状态（非 git 仓库返回 {repo:false}）。 */
export async function fetchGitStatus(projectId: string): Promise<{ repo: false } | { repo: true; branch: GitBranchInfo; groups: GitResourceGroups }> {
	const res = await apiFetch(`/api/git/status?projectId=${encodeURIComponent(projectId)}`);
	if (!res.ok) throw new Error(`git status ${res.status}`);
	return (await res.json()) as { repo: false } | { repo: true; branch: GitBranchInfo; groups: GitResourceGroups };
}

/** P3：工作区文件 diff（组内文件路径）。 */
export async function fetchGitDiff(projectId: string, group: "merge" | "index" | "workingTree" | "untracked", path: string): Promise<{ originalContent: string; modifiedContent: string } | null> {
	const params = new URLSearchParams({ group, path });
	const res = await apiFetch(`/api/git/diff?projectId=${encodeURIComponent(projectId)}&${params.toString()}`);
	if (!res.ok) throw new Error(`git diff ${res.status}`);
	const payload = (await res.json()) as { diff?: { originalContent: string; modifiedContent: string } | null };
	return payload.diff ?? null;
}

/** P3：最近提交。 */
export async function fetchGitLog(projectId: string, limit = 15): Promise<CommitEntry[]> {
	const res = await apiFetch(`/api/git/log?projectId=${encodeURIComponent(projectId)}&limit=${limit}`);
	if (!res.ok) throw new Error(`git log ${res.status}`);
	const payload = (await res.json()) as { commits?: CommitEntry[] };
	return payload.commits ?? [];
}

/** P3：项目内目录列表（dir 为项目相对路径，空 = 根）。 */
export async function fetchFileList(projectId: string, dir?: string): Promise<WebFileNodeLite[]> {
	const params = new URLSearchParams();
	if (dir) params.set("dir", dir);
	const qs = params.toString();
	const res = await apiFetch(`/api/files?projectId=${encodeURIComponent(projectId)}${qs ? `&${qs}` : ""}`);
	if (!res.ok) throw new Error(`files ${res.status}`);
	const payload = (await res.json()) as { nodes?: WebFileNodeLite[] };
	return payload.nodes ?? [];
}

/** P3：文件内容（有界 512KB；二进制/超限时返回结构化标记）。 */
export async function fetchFileContent(projectId: string, path: string): Promise<{ content?: string; size?: number; tooLarge?: boolean; binary?: boolean }> {
	const params = new URLSearchParams({ path });
	const res = await apiFetch(`/api/file-content?projectId=${encodeURIComponent(projectId)}&${params.toString()}`);
	if (!res.ok) throw new Error(`file content ${res.status}`);
	return (await res.json()) as { content?: string; size?: number; tooLarge?: boolean; binary?: boolean };
}

// ── 第二批：会话活动监控 strips（文件变更/子代理/todo，与桌面端同源数据） ──

export async function fetchSessionFileChanges(sessionId: string): Promise<SessionFileChange[]> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/file-changes`);
	if (!res.ok) throw new Error(`file changes ${res.status}`);
	const payload = (await res.json()) as { changes?: SessionFileChange[] };
	return payload.changes ?? [];
}

export async function fetchSessionSubagents(sessionId: string): Promise<PiSubagentEntry[]> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
	if (!res.ok) throw new Error(`subagents ${res.status}`);
	const payload = (await res.json()) as { subagents?: PiSubagentEntry[] };
	return payload.subagents ?? [];
}

export async function fetchSessionTodo(sessionId: string): Promise<SessionTodoSnapshot | null> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/todo`);
	if (!res.ok) throw new Error(`todo ${res.status}`);
	const payload = (await res.json()) as { todo?: SessionTodoSnapshot | null };
	return payload.todo ?? null;
}

// ── 第二批：技能/扩展资产面板（后端剥离宿主路径，前端类型同步去字段） ──

export type WebSkillLocation = Omit<PiSkillLocation, "path">;
export type WebSkillSummary = Omit<PiSkillSummary, "path" | "dir">;
export type WebExtensionSummary = Omit<PiExtensionSummary, "path">;

export async function listWebSkills(): Promise<{ locations: WebSkillLocation[]; skills: WebSkillSummary[] }> {
	const res = await apiFetch("/api/skills");
	if (!res.ok) throw new Error(`skills ${res.status}`);
	return (await res.json()) as { locations: WebSkillLocation[]; skills: WebSkillSummary[] };
}

/** 开关走 name+sourceId（前端无宿主路径；持久化按 name 写 disabledSkills）。 */
export async function toggleWebSkill(name: string, sourceId: WebSkillSummary["sourceId"], enabled: boolean): Promise<WebSkillSummary> {
	const res = await apiFetch("/api/skills/toggle", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, sourceId, enabled }),
	});
	if (!res.ok) throw new Error(`skill toggle ${res.status}`);
	const payload = (await res.json()) as { skill?: WebSkillSummary };
	if (!payload.skill) throw new Error("skill toggle returned no skill");
	return payload.skill;
}

export async function listWebExtensions(): Promise<{ extensions: WebExtensionSummary[]; conflicts: { builtIn: string; thirdParty: string }[] }> {
	const res = await apiFetch("/api/extensions");
	if (!res.ok) throw new Error(`extensions ${res.status}`);
	const payload = (await res.json()) as { extensions?: WebExtensionSummary[]; conflicts?: { builtIn: string; thirdParty: string }[] };
	return { extensions: payload.extensions ?? [], conflicts: payload.conflicts ?? [] };
}

/** 扩展开关写入配置，重启会话后生效（UI 需提示）。 */
export async function toggleWebExtension(source: string, enabled: boolean, scope: "user" | "project" | "unknown"): Promise<void> {
	const res = await apiFetch("/api/extensions/toggle", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source, enabled, scope }),
	});
	if (!res.ok) throw new Error(`extension toggle ${res.status}`);
}
