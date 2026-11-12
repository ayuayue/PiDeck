/**
 * 会话运行 IPC：发送 / UI 应答 / 运行时列表与激活 / 聚焦与可见登记，
 * 以及运行时命令面（停止、重启、压缩、状态、命令与模板、模型/思考/权限、编辑删除重发、
 * rewind 检查点、fork/clone）。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */
import { ipcMain } from "electron";
import { agentEventTags, ipcChannels } from "../../shared/ipc";
import { isDshPermissionPreset } from "../../shared/types/agent";
import { isRewindRestoreScope } from "../../shared/types/rewind";
import { readRuntimePromptTemplateBodies } from "../prompts/runtimeTemplateBodies";
import type { SendSessionPromptInput, SessionUiResponseInput, SessionRuntimeTarget, SessionRecord, RewindCheckpointPageParams } from "../../shared/types";
import { composeAgentInstruction, shouldInjectAgentPersona } from "../agents/agentPersonaInstruction";
import type { SettingsStore } from "../settings/SettingsStore";
import { appendSessionForkSuffix } from "../sessions/sessionForkTitle";
import { handleSessionCommandResult } from "./sessionIpcInputGuards";
import type { SessionIpcDeps } from "./sessionIpc";

export type SessionRunIpcDeps = Pick<
	SessionIpcDeps,
	| "settingsStore"
	| "sessionCatalog"
	| "sessionRuntimeCoordinator"
	| "agentManager"
	| "appLogger"
	| "getMainWindow"
	| "visibleSessions"
	| "emitLiveSnapshot"
	| "emitSessionRuntimeEvent"
	| "emitSessionActivating"
	| "emitSessionActivationFailed"
	| "emitSessionActivationCancelled"
	| "emitReplacementState"
	| "resolveSessionAgentInstruction"
>;

export function registerSessionRunIpc(deps: SessionRunIpcDeps): void {
	const { settingsStore, sessionCatalog, sessionRuntimeCoordinator, agentManager, appLogger, getMainWindow, visibleSessions, emitLiveSnapshot, emitSessionRuntimeEvent, emitSessionActivating, emitSessionActivationFailed, emitSessionActivationCancelled, emitReplacementState, resolveSessionAgentInstruction } = deps;
	/**
	 * 已成功注入角色设定的会话（本进程内）：catalog 的 draft→active 是首条 prompt 被接受后
	 * 异步回写，这一小段窗口里再发一条不能重复注入；发送失败不记账，重试仍可补上。
	 */
	const personaInjectedSessions = new Set<string>();
	ipcMain.handle(ipcChannels.sessionsSendPrompt, async (_event, input: SendSessionPromptInput) => {
		const startedAt = Date.now();
		void appLogger.info("session", "Session prompt IPC received", {
			sessionId: input.sessionId,
			requestId: input.requestId,
			messageLength: input.message.length,
			imageCount: input.images?.length ?? 0,
		});
		try {
			// 绑定了智能体的会话：只在首轮注入角色设定。首条消息被接受后，角色设定已经
			// 随用户消息留在会话历史里，之后再拼会让模型上下文重复；绑定只经新会话「使用」
			// 流程建立，因此 draft = 还没成功发过首条消息。注入点是「发送前」的唯一收口，
			// 所有来源（桌面输入框/排队投递/Web）都经过这里，渲染层无需每个入口各拼一次。
			// 只改本轮载荷，不写会话文件：pi 的 agentMessage 对时间线不可见，dsh 退化为可见前缀。
			const persona = resolveSessionAgentInstruction?.(input.sessionId);
			const boundRecord = persona ? sessionCatalog.get(input.sessionId) : undefined;
			const injectPersona = Boolean(persona && boundRecord && shouldInjectAgentPersona({ sessionStatus: boundRecord.status, alreadyInjected: personaInjectedSessions.has(input.sessionId) }));
			let promptInput: SendSessionPromptInput = input;
			if (persona && boundRecord && injectPersona) {
				const composed = composeAgentInstruction({ persona, message: input.message, existingAgentMessage: input.agentMessage, backend: boundRecord.backend });
				promptInput = { ...input, message: composed.message };
				if (composed.agentMessage !== undefined) promptInput.agentMessage = composed.agentMessage;
				// 只记 id/后端/长度，角色设定是用户内容，不进日志。
				void appLogger.debug("session", "Bound agent persona injected", { sessionId: input.sessionId, backend: boundRecord.backend ?? "pi", personaChars: persona.length });
			}
			// dsh 分支没有隐藏载荷：首轮和后续轮次都要删掉调用方带的 agentMessage，否则 host 拒收整条 prompt。
			if (persona && boundRecord?.backend === "dsh") {
				if (promptInput === input) promptInput = { ...input };
				delete promptInput.agentMessage;
			}
			const result = await sessionRuntimeCoordinator.send(promptInput);
			// 只有被接受才算首轮已带上角色设定；失败/拒绝时下一次发送仍可补上。
			if (result.accepted && injectPersona) personaInjectedSessions.add(input.sessionId);
			if (result.agentId) {
				const tab = agentManager.list().find((candidate) => candidate.id === result.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, agentEventTags.agentsState, tab);
			}
			// 消息被接受才记「最后一次使用」（选而未发不算）：写入 desktop settings.lastUsedModel，
			// 新会话默认解析（launchDefaults）以它优先。fire-and-forget，不阻塞发送响应。
			// DSH 会话跳过：其模型归属 host 设置，不在 models.json 中，记录会污染 pi 侧解析。
			// 同时维护 recentProviders（最新在前，去重截断 8）：模型选择器按此优先排列供应商分组。
			if (result.accepted) {
				const record = sessionCatalog.get(input.sessionId);
				if (record?.backend !== "dsh" && record?.backend !== "acp" && record?.model?.provider && record?.model?.modelId) {
					const provider = record.model.provider;
					const current = settingsStore.get().recentProviders ?? [];
					// 当前供应商提到首位，其余保持原有相对顺序；SettingsStore 会做去重/截断/无变化早退。
					const recentProviders = [provider, ...current.filter((item) => item !== provider)];
					void settingsStore
						.update({
							lastUsedModel: {
								provider,
								modelId: record.model.modelId,
							},
							recentProviders,
						})
						.catch((error) => {
							void appLogger.warn("settings", "Failed to record lastUsedModel", {
								error: error instanceof Error ? error.message : String(error),
							});
						});
				}
			}
			void appLogger.info("session", "Session prompt IPC completed", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: result.agentId,
				accepted: result.accepted,
				delivery: "delivery" in result ? result.delivery : undefined,
				totalMs: Date.now() - startedAt,
			});
			return result;
		} catch (error) {
			void appLogger.warn("session", "Session prompt IPC failed", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.sessionsUiResponse, (_event, input: SessionUiResponseInput) => sessionRuntimeCoordinator.respondToUi(input));
	ipcMain.handle(ipcChannels.sessionsRuntimeList, () => sessionRuntimeCoordinator.listRuntimes());
	ipcMain.handle(ipcChannels.sessionsRuntimeActivate, async (_event, sessionId: string) => {
		const startedAt = Date.now();
		void appLogger.info("session-perf", "Runtime activation IPC started", { sessionId });
		// 审计发现 A：coordinator.activate 在 bind() 之前不转发任何状态事件（ACP 握手
		// 可达 ~8.5s）。激活前先发 session 级合成 starting，渲染层立即进入加载动画，
		// 不再静默空窗；已有活 runtime 时（预热复用/快速路径）不发，避免闪状态。
		if (!sessionRuntimeCoordinator.hasLiveRuntime(sessionId)) emitSessionActivating?.(sessionId);
		const result = await sessionRuntimeCoordinator.activateRuntime(sessionId);
		if (result.ok) {
			// 激活完成后立即补发完整 tab 状态 + 消息窗口：deckSessionId/backend 让侧栏
			// ACP 配对即时生效（否则要等首个 agents:state 事件，期间 agent 行与 catalog
			// 行双行并存）；播种快照历史直接进时间线，不等首个回合。
			emitReplacementState(result.value, true);
		} else if (!sessionRuntimeCoordinator.hasLiveRuntime(sessionId)) {
			if (sessionRuntimeCoordinator.isActivationCancelled(sessionId)) {
				// 被换后端/换 ACP 工具作废：这不是失败（用户已经放弃了它，合成 error 会把刚切好的
				// 会话画成「启动失败」），但也不能什么都不发——上面的合成 starting 没人抵消，
				// 侧栏会一直停在「启动中」。发 detach 把加载态收敛回未绑定。
				emitSessionActivationCancelled?.(sessionId);
			} else {
				// 失败且无活 runtime（spawn 失败/握手超时，binding 从未建立）：合成 error
				// 抵消上面的合成 starting，加载态收敛为可重试的静态引导。
				emitSessionActivationFailed?.(sessionId);
			}
		}
		void appLogger.info("session-perf", "Runtime activation IPC completed", {
			sessionId,
			ok: result.ok,
			activationMs: Date.now() - startedAt,
			// 失败时带错误详情（此前只记 ok:false，排障要翻渲染层 toast）
			...(result.ok
				? {}
				: {
						error: result.error?.debugDetails ?? JSON.stringify(result.error),
					}),
		});
		return result;
	});
	// 渲染层切换会话时汇报聚焦会话；主进程据此判断 Ask 类请求是否需要桌面通知
	ipcMain.handle(ipcChannels.sessionsSetFocusedSession, (_event, sessionId: unknown) => {
		sessionRuntimeCoordinator.setFocusedSession(typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined);
	});
	// 可见会话登记：决定哪些会话的 live 正文/思考值得跨进程推送（discussion #446）。
	// 只接受主窗口上报——极简浮窗是独立渲染进程，它显示的会话在主窗口不一定可见；
	// 新可见的会话立即补一帧全量 live，避免切回来先看到半截内容。
	ipcMain.handle(ipcChannels.sessionsSetVisibleSessions, (event, input: unknown) => {
		const window = getMainWindow();
		if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
		for (const sessionId of visibleSessions.update(input)) {
			const target = sessionRuntimeCoordinator.getTarget(sessionId);
			if (target) emitLiveSnapshot(target.agentId);
		}
	});
}

export type SessionRuntimeCommandIpcDeps = Pick<SessionIpcDeps, "sessionCatalog" | "sessionRuntimeCoordinator" | "agentManager" | "appLogger" | "terminalManager" | "mainCopy" | "emitSessionRuntimeEvent" | "emitSessionRuntimeDetach" | "stopSessionRuntime" | "emitReplacementState" | "sessionForkCommands">;

export function registerSessionRuntimeCommandIpc(deps: SessionRuntimeCommandIpcDeps): void {
	const { sessionCatalog, sessionRuntimeCoordinator, agentManager, appLogger, terminalManager, mainCopy, emitSessionRuntimeEvent, emitSessionRuntimeDetach, stopSessionRuntime, emitReplacementState } = deps;
	ipcMain.handle(ipcChannels.sessionsRuntimeStop, (_event, target: SessionRuntimeTarget) => stopSessionRuntime(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeAbort, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.abortRuntime(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeRestart, async (_event, target: SessionRuntimeTarget) => {
		terminalManager.closeAgent(target.agentId);
		const result = await sessionRuntimeCoordinator.restartRuntime(target);
		if (result.ok) {
			// A --no-session restart is a binding replacement, not a close. Its
			// higher generation state event clears old runtime UI without deleting
			// the transient SessionRecord from the renderer.
			if (!result.value.session.noSession) emitSessionRuntimeDetach(target);
			// 必须重下发消息窗口（含状态）：新 runtime 加载历史后的首次 flush 发生在
			// 绑定提交之前，emitSessionRuntimeEvent 的 getRuntimeBinding 会把它静默丢弃——
			// 若这里只补状态，渲染层会一直保留旧 runtime 的窗口/live 身份，
			// 重启后编辑/删除/重发会定位失败（MESSAGE_NOT_FOUND，2026-09 用户反馈）。
			// id 稳定性由 loadMessages 的会话级身份延续保证（stabilizeProjectedIdsFromIdentities），
			// 重下发不会触发整窗 remount/动画重放。
			emitReplacementState(result.value.runtime, true);
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeCompact, (_event, target: SessionRuntimeTarget, prompt?: string) => sessionRuntimeCoordinator.compactRuntime(target, prompt));
	ipcMain.handle(ipcChannels.sessionsRuntimeState, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.getRuntimeState(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeCommands, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.listRuntimeCommands(target));
	// 提示词模板正文：面板/气泡需要 `/<模板名>` 身份，而 pi 的 get_commands 只给路径。
	// 主进程按登记路径读回正文（含包带模板），渲染层据此在发送前本地展开并保留名字。
	// 读取失败/超限/非 prompt 来源一律跳过 → 渲染层退回「交给 pi 展开」（现状行为）。
	ipcMain.handle(ipcChannels.sessionsRuntimePromptTemplates, async (_event, target: SessionRuntimeTarget) => {
		const commands = await sessionRuntimeCoordinator.listRuntimeCommands(target);
		if (!commands.ok) return commands;
		const templates = await readRuntimePromptTemplateBodies(commands.value.value);
		return { ok: true as const, value: { target: commands.value.target, value: templates } };
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeReloadResources, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.reloadResources(target));
	// 草稿命令预览是只读提示增强：入参只有 projectId，非法值在 coordinator 层自然返回 null。
	ipcMain.handle(ipcChannels.sessionsDraftCommands, (_event, projectId: string) => {
		if (typeof projectId !== "string" || !projectId.trim()) return null;
		return sessionRuntimeCoordinator.draftCommands(projectId);
	});
	// 草稿会话的模板正文（尚无 runtime 时可用的同一份清单来源）。
	// 复用 standby 的命令预览借用：拿命令表 → 按 sourceInfo.path 读正文；离线/无池/失败返回 null，
	// 渲染层退回 prompts:list（旧行为）。这是「打开会话立刻发 /模板名」也能出 chip 的兜底。
	ipcMain.handle(ipcChannels.sessionsDraftPromptTemplates, async (_event, projectId: string) => {
		if (typeof projectId !== "string" || !projectId.trim()) return null;
		const commands = await sessionRuntimeCoordinator.draftCommands(projectId);
		if (!Array.isArray(commands) || commands.length === 0) return null;
		const templates = await readRuntimePromptTemplateBodies(commands);
		return templates.length > 0 ? templates : null;
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeListModels, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.listRuntimeModels(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeThinkingLevels, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.listRuntimeThinkingLevels(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeExportHtml, async (_event, target: SessionRuntimeTarget) => {
		const result = await sessionRuntimeCoordinator.exportRuntimeHtml(target);
		void appLogger.info("session", "Session exported (runtime HTML)", {
			sessionId: target.sessionId,
			ok: result.ok,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeEditMessage, (_event, target: SessionRuntimeTarget, messageId: string, newText: string) => handleSessionCommandResult(appLogger, "editRuntimeMessage", target, { messageId }, () => sessionRuntimeCoordinator.editRuntimeMessage(target, messageId, newText)));
	ipcMain.handle(ipcChannels.sessionsRuntimeDeleteMessage, (_event, target: SessionRuntimeTarget, messageId: string) => handleSessionCommandResult(appLogger, "deleteRuntimeMessage", target, { messageId }, () => sessionRuntimeCoordinator.deleteRuntimeMessage(target, messageId)));
	// rewind checkpoint：list/diff 是只读命令（同 sessionsRuntimeCommands 风格），
	// restore 是变更操作，走 handleSessionCommandResult 留日志。
	ipcMain.handle(ipcChannels.sessionsRewindList, (_event, target: SessionRuntimeTarget, params?: RewindCheckpointPageParams) => sessionRuntimeCoordinator.listRewindCheckpoints(target, params));
	ipcMain.handle(ipcChannels.sessionsRewindDiff, (_event, target: SessionRuntimeTarget, checkpointId: string) => sessionRuntimeCoordinator.getRewindCheckpointDiff(target, checkpointId));
	ipcMain.handle(ipcChannels.sessionsRewindRestore, (_event, target: SessionRuntimeTarget, checkpointId: string, scope: unknown) => {
		// 渲染层入参不可信：scope 必须在契约枚举内（校验前置到 coordinator 之外再挡一层）。
		if (!isRewindRestoreScope(scope)) {
			return handleSessionCommandResult(appLogger, "restoreRewindCheckpoint", target, { checkpointId, scope: String(scope) }, () =>
				Promise.resolve({
					ok: false,
					error: {
						code: "SESSION_COMMAND_FAILED",
						debugDetails: `Invalid rewind restore scope: ${String(scope)}`,
					},
				}),
			);
		}
		return handleSessionCommandResult(appLogger, "restoreRewindCheckpoint", target, { checkpointId, scope }, async () => {
			const result = await sessionRuntimeCoordinator.restoreRewindCheckpoint(target, checkpointId, scope);
			// conversation/all 会在检查点 fork 出新会话（runtime 已换绑新文件）：
			// 趁运行态拿到新 sessionPath，同步给 catalog 打 fork 标记（列表 (fork) 后缀），
			// 不依赖后续扫描才识别。fork 锚点解析失败时不会走到这一步。
			if (result.ok && scope !== "files") {
				const tab = agentManager.list().find((candidate) => candidate.id === target.agentId);
				if (tab?.sessionPath) {
					const environment = tab.sessionEnvironment ?? "native";
					const entry = sessionCatalog.findByFilePath(tab.sessionPath, environment);
					if (entry) {
						await sessionCatalog.update(entry.id, { forked: true });
						// (fork) 物理写进会话名（与 fork/clone 一致，见 appendSessionForkSuffix）：
						// 走 pi set_session_name RPC。注意 rewind 恢复不重建 runtime 绑定
						// （绑定仍指向原会话），rename 触发的标题回写会落到原条目标题上，
						// 因此记录原条目标题并在完成后恢复，避免「原会话被改名成 xxx (fork)」。
						const forkedTitle = appendSessionForkSuffix(entry.title, mainCopy("session.forkedSuffix"));
						if (forkedTitle !== entry.title) {
							const originBinding = sessionRuntimeCoordinator.getRuntimeBinding(target.agentId);
							const originSessionId = originBinding?.sessionId;
							const originTitle = originSessionId && originSessionId !== entry.id ? sessionCatalog.get(originSessionId)?.title : undefined;
							try {
								await agentManager.rename(target.agentId, forkedTitle);
								await sessionCatalog.update(entry.id, { title: forkedTitle });
								if (originSessionId && originTitle !== undefined) {
									await sessionCatalog.update(originSessionId, { title: originTitle });
								}
							} catch (error) {
								void appLogger.warn("session", "Rewind fork suffix rename failed", {
									sessionId: entry.id,
									agentId: target.agentId,
									title: entry.title,
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
					}
				}
			}
			return result;
		});
	});
	ipcMain.handle(ipcChannels.sessionsRuntimePrepareResend, (_event, target: SessionRuntimeTarget, messageId: string) => handleSessionCommandResult(appLogger, "prepareRuntimeResend", target, { messageId }, () => sessionRuntimeCoordinator.prepareRuntimeResend(target, messageId)));
	ipcMain.handle(ipcChannels.sessionsRuntimeSetModel, (_event, target: SessionRuntimeTarget, provider: unknown, modelId: unknown, modelName?: unknown) => {
		if (typeof provider !== "string" || typeof modelId !== "string" || (modelName !== undefined && typeof modelName !== "string") || !provider.trim() || !modelId.trim() || provider.length > 128 || modelId.length > 256 || (typeof modelName === "string" && modelName.length > 256)) {
			return Promise.resolve({
				ok: false as const,
				error: {
					code: "SESSION_COMMAND_FAILED" as const,
					debugDetails: "Invalid model selection",
				},
			});
		}
		return sessionRuntimeCoordinator.setRuntimeModel(target, provider.trim(), modelId.trim(), modelName);
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeSetThinking, (_event, target: SessionRuntimeTarget, level: string) => sessionRuntimeCoordinator.setRuntimeThinking(target, level));
	ipcMain.handle(ipcChannels.sessionsRuntimeSetPermission, (_event, target: SessionRuntimeTarget, preset: string) => {
		// Renderer input is untrusted: reject values outside DSH's finite preset
		// set before they can reach the backend or be persisted in the catalog.
		if (!isDshPermissionPreset(preset)) {
			return Promise.resolve({
				ok: false as const,
				error: {
					code: "SESSION_COMMAND_FAILED" as const,
					debugDetails: `Unsupported DSH permission preset: ${String(preset)}`,
				},
			});
		}
		return sessionRuntimeCoordinator.setRuntimePermission(target, preset);
	});
	// fork/clone 命令链已收口到 sessionForkCommands（与 Web HTTP 同源）：重发/编辑
	// fork 化（mutationFork/branchMode）、supersededBy 隐藏、DSH 分流、catalog 刷新广播
	// 都在那一层维护，两端行为必须一致（Web 重发后出现两个重复会话的教训）。
	// 命令失败一律经 handleSessionCommandResult 落 session-command 日志。fork 尤其不能静默：
	// 它前面可能刚花十几秒激活 runtime，失败后渲染层只弹一条 5s 就消失的 toast，
	// 现场（2026-10 真机）表现为「点了没反应 + 主进程零日志」。
	ipcMain.handle(ipcChannels.sessionsRuntimeClone, (_event, target: SessionRuntimeTarget) => handleSessionCommandResult(appLogger, "cloneRuntimeSession", target, {}, () => deps.sessionForkCommands.cloneRuntimeSession(target)));
	ipcMain.handle(ipcChannels.sessionsRuntimeGetForkMessages, (_event, target: SessionRuntimeTarget) => handleSessionCommandResult(appLogger, "getRuntimeForkMessages", target, {}, () => sessionRuntimeCoordinator.getRuntimeForkMessages(target)));
	ipcMain.handle(ipcChannels.sessionsRuntimeFork, (_event, target: SessionRuntimeTarget, entryId: string, options?: { mutationFork?: boolean; branchMode?: boolean }) =>
		handleSessionCommandResult(appLogger, "forkRuntimeSession", target, { entryId, mutationFork: options?.mutationFork === true, branchMode: options?.branchMode === true }, () => deps.sessionForkCommands.forkRuntimeSession(target, entryId, options)),
	);
}
