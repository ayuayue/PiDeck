import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRuntimeState, CreateAnonymousSessionInput, CreateSessionDraftInput, ImageContent, SendSessionPromptInput, SessionRuntimeTarget, SessionUiResponseInput, UpdateSessionRecordInput } from "../../shared/types";
import { buildAgentSessionTitle, type AgentProfile } from "../../shared/types/agentProfile";
import { readBoundedFile, WEB_CORS_HEADERS } from "./WebHttpResponders";
import { ifNoneMatchHits, stateEtag } from "./WebStateEtag";
import { toWebSecurityState } from "./WebSecurityProjection";
import type { WebServiceDependencies } from "./WebServiceManager";
import { extractChatImages, toWebAgentProjection, WebApiRouteContext } from "./WebApiRouteContext";

/** WebApiRuntime 组的路由：每条一个方法，条件由 WebApiRoutes 的调度表判。 */
export class WebApiRuntimeRoutes extends WebApiRouteContext {
	async routeSessionRuntime(match: RegExpMatchArray, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const sessionRuntimeMatch = match;
		const sessionId = decodeURIComponent(sessionRuntimeMatch[1]);
		const action = sessionRuntimeMatch[2];
		const body = await this.readJson<{
			target?: SessionRuntimeTarget;
			prompt?: string;
			messageId?: string;
			newText?: string;
			provider?: string;
			modelId?: string;
			modelName?: string;
			level?: string;
			preset?: string;
			checkpointId?: string;
			scope?: string;
			/** 检查点列表分页：每页条数 / 游标（rewind-list 用）。 */
			limit?: number;
			beforeTimestamp?: number;
			/** fork：从哪个历史轮次分叉（entryId 来自 get-fork-messages）。 */
			entryId?: string;
			/** fork 化重试标记（重发/编辑迁移用）：只认显式 true。mutationFork+非 branchMode = 尾部替换（旧会话隐藏）。 */
			mutationFork?: boolean;
			/** 分支模式：fork 锚点不是最后一条用户消息 → 旧会话保留可见。 */
			branchMode?: boolean;
		}>(request);
		const target = body.target;
		// activate 是唯一不要求 runtime target 的动作：冷会话（无 runtime）激活正是它的用途
		if (action === "activate") {
			if (!this.deps.activateSessionRuntime) {
				this.sendError(response, 503, "webError.runtimeUnavailable", "Session runtime activation is not available");
				return true;
			}
			this.sendJson(response, { result: await this.deps.activateSessionRuntime(sessionId) });
			return true;
		}
		if (!target || target.sessionId !== sessionId) {
			this.sendError(response, 400, "webError.runtimeTargetRequired", "A matching Session runtime target is required");
			return true;
		}
		let result: unknown;
		switch (action) {
			case "stop":
				result = await this.deps.stopSessionRuntime(target);
				break;
			case "abort":
				result = await this.deps.abortSessionRuntime(target);
				break;
			case "restart": {
				// 重启走专属链路：pending 期间每 2s 回心跳——重启 5~10s 期间浏览器不再只有一个
				// 转圈的黑盒，能持续确认请求活着。
				await this.executeRestartWithProgress(target, response);
				// 专属链路自己写完响应，通用壳不再二次写。
				return true;
			}
			case "compact":
				result = await this.deps.compactSessionRuntime(target, body.prompt);
				break;
			case "state":
				result = await this.deps.getSessionRuntimeState(target);
				break;
			case "commands":
				result = await this.deps.listSessionRuntimeCommands(target);
				break;
			case "models":
				result = await this.deps.listSessionRuntimeModels(target);
				break;
			case "export-html":
				result = await this.deps.exportSessionRuntimeHtml(target);
				break;
			case "edit-message":
				result = await this.deps.editSessionRuntimeMessage(target, body.messageId ?? "", body.newText ?? "");
				break;
			case "delete-message":
				result = await this.deps.deleteSessionRuntimeMessage(target, body.messageId ?? "");
				break;
			case "prepare-resend":
				result = await this.deps.prepareSessionRuntimeResend(target, body.messageId ?? "");
				break;
			case "model":
				result = await this.deps.setSessionRuntimeModel(target, typeof body.provider === "string" ? body.provider : "", typeof body.modelId === "string" ? body.modelId : "", typeof body.modelName === "string" ? body.modelName : undefined);
				break;
			case "thinking":
				result = await this.deps.setSessionRuntimeThinking(target, body.level ?? "");
				break;
			case "permission":
				result = await this.deps.setSessionRuntimePermission(target, body.preset ?? "");
				break;
			case "clone":
				result = await this.deps.cloneSessionRuntime(target);
				break;
			case "fork":
				result = await this.deps.forkRuntimeSession(target, typeof body.entryId === "string" ? body.entryId : "", {
					// 边界校验：只认显式 true，其余值（含恶意载荷）一律按 false 处理
					mutationFork: body.mutationFork === true,
					branchMode: body.branchMode === true,
				});
				break;
			case "get-fork-messages":
				result = await this.deps.getForkMessages(target);
				break;
			case "rewind-list":
				result = await this.deps.listRewindCheckpoints(target, {
					limit: typeof body.limit === "number" && Number.isFinite(body.limit) ? body.limit : undefined,
					beforeTimestamp: typeof body.beforeTimestamp === "number" && Number.isFinite(body.beforeTimestamp) ? body.beforeTimestamp : undefined,
				});
				break;
			case "rewind-diff":
				result = await this.deps.getRewindCheckpointDiff(target, body.checkpointId ?? "");
				break;
			case "rewind-restore":
				result = await this.deps.restoreRewindCheckpoint(target, body.checkpointId ?? "", body.scope === "files" ? "files" : body.scope === "conversation" ? "conversation" : "all");
				break;
		}
		this.sendJson(response, { result });
		return true;
	}
}
