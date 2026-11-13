import { createSessionModelPreference } from "../../../shared/modelDisplayName";
import type { SessionModelPreference, SessionRuntimeModelSelection } from "../../../shared/types";
import type { SessionCatalogEntry } from "../SessionCatalog";
import type { SessionAgentGateway, SessionCatalogGateway, SessionRuntimeLogger } from "./sessionRuntimeGateways";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** catalog 里会在激活后被用户改写的偏好；lastApplied 用这份快照判断要不要再 setModel。 */
export type AppliedSessionPreferences = {
	model?: SessionModelPreference;
	thinkingLevel?: string;
	permissionPreset?: string;
};

export function snapshotPreferences(entry: SessionCatalogEntry): AppliedSessionPreferences {
	return {
		...(entry.model ? { model: createSessionModelPreference(entry.model.provider, entry.model.modelId, entry.model.modelName) } : {}),
		...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
		...(entry.permissionPreset ? { permissionPreset: entry.permissionPreset } : {}),
	};
}

function sameAppliedPreferences(a: AppliedSessionPreferences | undefined, b: AppliedSessionPreferences): boolean {
	if (!a) return false;
	const aModel = a.model;
	const bModel = b.model;
	if (Boolean(aModel) !== Boolean(bModel)) return false;
	if (aModel && bModel && (aModel.provider !== bModel.provider || aModel.modelId !== bModel.modelId)) {
		return false;
	}
	return a.thinkingLevel === b.thinkingLevel && a.permissionPreset === b.permissionPreset;
}

/**
 * 会话偏好（模型 / 思考档 / 权限预设）的重放与降级。
 *
 * 为什么独立成协作对象：这段逻辑只依赖「catalog 里的最新偏好 + 运行实例 id」，
 * 与协调器的激活/绑定状态机无关；`lastAppliedBySession` 这类去重记账仍留在宿主
 *（激活、重启、换绑、解绑都要动它），这里按注入的窄接口读取。
 */
export class SessionRuntimePreferences {
	constructor(
		private readonly catalog: Pick<SessionCatalogGateway, "get" | "update">,
		private readonly agents: Pick<SessionAgentGateway, "setModel" | "setThinking" | "getRuntimeModelThinkingState" | "setPermission" | "notifyModelPreferenceIgnored">,
		private readonly logger: SessionRuntimeLogger | undefined,
		/** 宿主判定（含 ssh locator / 远端项目草稿），见 `SessionRuntimeCoordinator.isRemoteSession`。 */
		private readonly isRemoteSession: (sessionId: string) => boolean,
		private readonly lastAppliedBySession: Map<string, { agentId: string; preferences: AppliedSessionPreferences }>,
		private readonly lastRequestedThinkingBySession: Map<string, { agentId: string; level: string }>,
	) {}

	/**
	 * 重读 catalog 再应用偏好。activate 开头的 entry 是 clone，等待期间用户改模型
	 * 不能再用那份快照。lastApplied 按 agentId+prefs 去重，避免每次 send 都 setModel。
	 * @returns 是否真正调用了 applyPreferences（绑定路径据此决定要不要再 publish）。
	 */
	async applyLatestPreferences(sessionId: string, agentId: string): Promise<boolean> {
		const latest = this.catalog.get(sessionId);
		if (!latest) throw new Error(`Session not found: ${sessionId}`);
		const preferences = snapshotPreferences(latest);
		const last = this.lastAppliedBySession.get(sessionId);
		if (last?.agentId === agentId && sameAppliedPreferences(last.preferences, preferences)) {
			return false;
		}
		await this.applyPreferences(latest, agentId);
		// 降级路径（远端/DSH 采纳宿主模型）会在 applyPreferences 内部改写 catalog：
		// 这里必须重读，否则会把「采纳前的旧快照」记成已应用，下次激活又重试同一个必然失败的 set_model。
		const applied = this.catalog.get(sessionId) ?? latest;
		this.lastAppliedBySession.set(sessionId, { agentId, preferences: snapshotPreferences(applied) });
		this.lastRequestedThinkingBySession.delete(sessionId);
		return true;
	}

	private async applyPreferences(entry: SessionCatalogEntry, agentId: string): Promise<void> {
		// DSH 草稿的 entry.model 可能来自 pi 的 models.json（引导页/欢迎页选型在
		// 创建时不知道后端，或用户切了默认后端）；host 目录没有该 provider/模型时
		// selectModel 会拒绝。降级为「应用宿主默认模型」并告警，不让整个激活失败
		// （否则每次重试都新建一个 host 会话 = 孤儿堆积）。pi 保持严格（模型应在 models.json）。
		const isDsh = entry.backend === "dsh";
		// 远端会话的偏好可能来自本机目录（引导页默认/旧版本留下的本机选择）——远端 pi 不认识这些模型
		// 属于预期错配，不是「模型被删」。若按本机 pi 的严格语义抛错，远端会话会直接无法激活；
		// 若弹「偏好被忽略」，用户会以为自己选错了。统一静默降级 + 把远端真实模型写回 catalog。
		const isRemote = !isDsh && this.isRemoteSession(entry.id);
		// DSH 的 session/selectModel 除改会话选择外，还会把选择保存成部署默认模型
		// （host 侧 agentDefaultModel.saveSelection）。Coordinator 每次激活/重启都会重放
		// catalog 偏好；不加判断时，「打开/切换 DSH 会话」就会悄悄改写全局默认——新建
		// DSH 会话（以及 dsh CLI/web）继承最后一次打开会话的模型/档位。这里先读 host
		// 会话当前选择（投影 next ?? lastUsed），已经一致的字段不再下发；真正变化
		// （草稿期改选、host 里被外部改过）仍照常应用。pi 不读：set_model/set_thinking
		// 的持久化与幂等由 AgentManager + lastAppliedBySession 既有链路负责。
		//
		// 远端不读这份 runtimeSelection：远端会话每次激活都可能是新主机上的新进程，
		// 「已应用」由 lastAppliedBySession 与下面的降级分支各自负责，多读一次只增加
		// 一次跨 ssh RPC 往返；DSH 才有「重放偏好会改全局默认」这个问题。
		let runtimeSelection: SessionRuntimeModelSelection | undefined;
		if (isDsh && (entry.model || entry.thinkingLevel)) {
			try {
				runtimeSelection = await this.agents.getRuntimeModelThinkingState?.(agentId);
			} catch {
				// 读取失败按「未知」处理：宁可照旧应用偏好，也不静默跳过用户选择。
				runtimeSelection = undefined;
			}
		}
		const modelAlreadyApplied = Boolean(runtimeSelection && entry.model && runtimeSelection.provider === entry.model.provider && runtimeSelection.modelId === entry.model.modelId);
		const thinkingAlreadyApplied = runtimeSelection?.thinkingLevel !== undefined && runtimeSelection.thinkingLevel === entry.thinkingLevel;
		if (entry.model && !modelAlreadyApplied) {
			try {
				await this.agents.setModel(agentId, entry.model.provider, entry.model.modelId);
			} catch (error) {
				if (isRemote) {
					// 只有「远端确实不认识这个模型」才采纳宿主机当前模型。RPC 超时/远端进程刚退出是
					// **瞬时故障**：那时拿 get_state 去覆盖 catalog 等于把用户显式选择的偏好静默销毁，
					// 而用户看不到任何提示。瞬时故障保留偏好、下次激活自然重试。
					if (/model not found/i.test(errorMessage(error))) {
						await this.adoptRuntimeModelAfterRejection(entry.id, agentId, error);
					} else {
						void this.logger?.warn("session-runtime", "remote model preference deferred: runtime error", {
							sessionId: entry.id,
							provider: entry.model.provider,
							modelId: entry.model.modelId,
							error: errorMessage(error),
						});
					}
				} else {
					// pi 后端：模型既不在本地 models.json 也不在 pi 目录（AgentManager 不带
					// needsRestart 标记地抛 "Model not found"）= 模型已被重命名/删除。与 DSH
					// 同语义降级：保留 catalog 偏好、沿用 runtime 当前模型并给会话内系统提示，
					// 不让整个激活/发送失败——否则每次发送都被 "Failed to apply session
					// preferences" 挡死（2026-09 用户反馈：models.json 重命名模型后旧会话
					// 无法再发送，报 Model not found: nacho/gpt-5.6-sol）。
					// 带 needsRestart 的失败（模型存在但运行中 Agent 快照过期）不降级——
					// 渲染层会引导用户重启 Agent 加载新配置。
					// 走到这里 isRemote 恒为 false（远端分支在前面就分走了），所以这里只区分 pi / DSH。
					const modelGoneOnPi = !isDsh && this.isModelGoneError(error);
					if (!isDsh && !modelGoneOnPi) throw error;
					void this.logger?.warn("session-runtime", modelGoneOnPi ? "pi model preference ignored: model no longer exists" : "DSH model preference ignored", {
						sessionId: entry.id,
						provider: entry.model.provider,
						modelId: entry.model.modelId,
						error: errorMessage(error),
					});
					// 降级路径两侧行为一致：保留 catalog 偏好、沿用当前模型，并**告知用户**。
					// DSH 不提示的话，引导页点选（已作为显式 model 带入，issue #253）会在 host
					// 拒绝时静默失效——底栏显示用户选的模型，实际跑的是部署默认。pi 侧本来就有
					// 会话内系统消息；DSH 的 gateway 实现走 agentsNotice toast。
					if (modelGoneOnPi || isDsh) {
						this.agents.notifyModelPreferenceIgnored?.(agentId, entry.model.provider, entry.model.modelId);
					}
				}
			}
		}
		if (entry.thinkingLevel && !thinkingAlreadyApplied) {
			try {
				await this.agents.setThinking(agentId, entry.thinkingLevel);
			} catch (error) {
				// 远端会话与 DSH 同语义：档位能力由后端裁决，本机偏好带到远端可能整体不适用，
				// 降级为「沿用 runtime 当前档位」，不阻断激活。
				if (!isDsh && !isRemote) throw error;
				const message = errorMessage(error);
				void this.logger?.warn("session-runtime", isDsh ? "DSH thinking preference ignored" : "remote thinking preference ignored", {
					sessionId: entry.id,
					thinkingLevel: entry.thinkingLevel,
					error: message,
				});
				// 后端是档位能力的最终裁决者。即使本次 host 拒绝，也保留用户偏好：
				// 目录配置、provider 或模型在之后变化时仍可重新应用，不能由 PiDeck
				// 根据一条当前错误擅自清空用户选择。
			}
		}
		// DSH 权限预设（草稿期预选 / 会话内切换回写）：激活时经 /permission 命令应用
		if (entry.permissionPreset && this.agents.setPermission) {
			await this.agents.setPermission(agentId, entry.permissionPreset);
		}
	}

	/**
	 * 远端会话的模型偏好被运行时拒绝后的收尾：不抛错、不提示，把运行时**实际**生效的模型/档位
	 * 写回 catalog。
	 *
	 * 为什么必须回写：Preferences 失败分支不影响 runtime 启动，但底栏/选择器读的是 catalog
	 * 里的 `model`。不回写就会长期显示一个远端从未用过的模型名（用户报「显示的模型跟实际跑的
	 * 不是一回事」）。同时要刷新 lastAppliedBySession，否则之后每次激活都会重试同一个必然失败的
	 * set_model。
	 */
	private async adoptRuntimeModelAfterRejection(sessionId: string, agentId: string, error: unknown): Promise<void> {
		void this.logger?.info("session-runtime", "remote model preference not available on host; keeping host model", {
			sessionId,
			agentId,
			error: errorMessage(error),
		});
		try {
			const runtimeSelection = await this.agents.getRuntimeModelThinkingState?.(agentId);
			if (!runtimeSelection) return;
			const model = createSessionModelPreference(runtimeSelection.provider, runtimeSelection.modelId, runtimeSelection.modelName);
			const updated = await this.catalog.update(sessionId, {
				model,
				...(runtimeSelection.thinkingLevel !== undefined ? { thinkingLevel: runtimeSelection.thinkingLevel } : {}),
				updatedAt: Date.now(),
			});
			this.lastAppliedBySession.set(sessionId, { agentId, preferences: snapshotPreferences(updated) });
			this.lastRequestedThinkingBySession.delete(sessionId);
		} catch (adoptError) {
			// 回写失败不能连带激活失败：下次用户在会话内切模型会修正展示。
			void this.logger?.warn("session-runtime", "failed to adopt remote runtime model", {
				sessionId,
				agentId,
				error: errorMessage(adoptError),
			});
		}
	}

	/**
	 * set_model 失败是否为「模型已不存在」（被重命名/删除）：AgentManager.setModel
	 * 只有在本地 models.json 与 pi 模型目录都查不到该模型时才不带 needsRestart
	 * 标记地抛 "Model not found"。带 needsRestart 的失败（模型存在但运行中 Agent
	 * 启动快照过期）不算——那应引导重启 Agent 而非降级。
	 */
	private isModelGoneError(error: unknown): boolean {
		if ((error as { needsRestart?: unknown } | null)?.needsRestart === true) {
			return false;
		}
		return /model not found/i.test(errorMessage(error));
	}
}
