import { useStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailableModel, ModelListReport, SessionRuntimeModelSelection, SessionRuntimeTarget } from "../../../shared/types";
import { createSessionModelPreference } from "../../../shared/modelDisplayName";
import { currentSessionIdAtom, sessionFocusedByIdAtomFamily, sessionRuntimeByIdAtom } from "../atoms";
import { useSessionPreferenceState } from "./useSessionPreferenceState";
import { usePendingModelApply } from "./usePendingModelApply";
import { useSessionPaneServices } from "../components/session/SessionPaneServices";
import type { ThinkingPickerLevel } from "../components/session/sessionPickerOptions";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { t } from "../i18n";
import { SessionCommandFailure, requireSessionCommand, sessionCommandFailureToast, toSessionRuntimeTarget } from "../utils/sessionCommands";
import { resolveComposerLiveModel } from "../utils/modelPendingDisplay";
import { modelKey, pickCycleModel, pickCycleThinkingLevel, resolveFavoriteCycleCandidates, type CycleDirection } from "../utils/preferenceCycle";
import { WELCOME_DSH_MODEL_KEY, WELCOME_MODEL_KEY, WELCOME_THINKING_KEY } from "../utils/chatSessionBootstrap";

/** 目录加载前的按键意图仍属于发起栏及绑定，不能转交随后呈现的会话/后端。 */
type PendingCycle = {
	kind: "model" | "thinking";
	isDshSession: boolean;
	isCurrent: () => boolean;
};

/** 重启授权同时绑定原会话、运行时代次与栏生命周期，不能只保存可重绑的 Agent ID。 */
type ModelRestartIntent = {
	handle: SessionRuntimeTarget;
	isCurrent: () => boolean;
	provider: string;
	modelId: string;
	modelName: string;
};

export type SessionPreferenceController = {
	/** 会话后端（DSH 的目录/档位来自 host catalog）：选择器与循环共用 */
	isDshSession: boolean;
	/** 模型目录（capability cache 数据源） */
	models: AvailableModel[];
	report: ModelListReport | null;
	catalogLoading: boolean;
	refreshing: boolean;
	reloadCatalog: (force?: boolean) => void;
	/** 当前选择模型（SessionRecord / 引导页偏好） */
	currentModel: { provider?: string; modelId?: string; modelName?: string };
	/** 当前模型可用档位（与思考选择器同一份，含 runtime RPC 兜底） */
	thinkingLevels: ThinkingPickerLevel[];
	/** 当前选择档位（SessionRecord / 引导页偏好） */
	currentThinkingLevel: string | undefined;
	/** 收藏 / 最近 / 隐藏供应商 / 隐藏模型：选择器展示 + 循环候选 */
	favoriteModels: string[];
	recentProviders: string[];
	/** 供应商自定义顺序（模型页排序结果）：选择器严格按此展示分组，DSH 与 Pi 分开。 */
	providerOrder: string[];
	dshProviderOrder: string[];
	hiddenProviders: string[];
	hiddenModels: string[];
	/** 技能选择器需要的会话身份（避免组件再订一次 record/runtime 原子） */
	projectId: string | undefined;
	agentId: string | undefined;
	toggleFavorite: (provider: string, modelId: string) => Promise<void>;
	toggleHideModel: (provider: string, modelId: string) => Promise<void>;
	/** 选择器选中：应用模型（含 busy 排队 / 需重启引导 / 降级写记录） */
	applyModel: (model: AvailableModel) => Promise<void>;
	/** 仅清除引导页 / 未启动草稿的预选，不向运行中 Agent 发送空模型。 */
	canClearModel: boolean;
	clearModel: () => Promise<void>;
	/** 选择器选中：应用思考档位 */
	applyThinking: (level: string) => Promise<void>;
	/** 快捷键：收藏内环绕切换模型 */
	cycleModel: (direction?: CycleDirection) => Promise<void>;
	/** 快捷键：当前模型可用档位内环绕切换思考强度 */
	cycleThinking: (direction?: CycleDirection) => Promise<void>;
	/** 需要重启 Agent 才能生效的模型（选择器/循环共用确认弹窗） */
	restartTarget: { handle: SessionRuntimeTarget; model: string } | null;
	restarting: boolean;
	confirmRestart: () => Promise<void>;
	cancelRestart: () => void;
};

/**
 * 会话「模型 + 思考强度」域 controller（写侧）：应用命令 + 快捷键循环。
 *
 * 为什么单独成 hook：这些命令原本长在 ComposerPickerHost 组件里，而快捷键必须复用**同一条**
 * 应用链路（busy 排队 / needsRestart 引导重启 / runtime 不可用时降级写会话记录 /
 * 引导页写 localStorage 偏好）。复制一份必然漂移，抽出来让「选择器点击」与「快捷键循环」
 * 共用同一实现；组件只留渲染（见 ComposerPickerHost），读侧状态见 useSessionPreferenceState。
 *
 * 快捷键订阅放在这里而不是 App：命令依赖本栏的 record/runtime/目录，且要求「只有聚焦栏响应」
 * （分屏时两栏各挂一份 controller，靠 currentSessionIdAtom 比对去重）。
 */
export function useSessionPreferenceController(options: {
	sessionId: string;
	/** 选择器是否打开（模型目录加载开关之一） */
	pickerOpen: boolean;
	/** 思考选择器是否打开（决定要不要向运行中 Agent 校验精确档位） */
	thinkingPickerOpen: boolean;
	/** DSH 部署默认模型（草稿期高亮） */
	defaultModel?: { provider?: string; modelId?: string; modelName?: string };
	defaultThinkingLevel?: string;
	/** pi settings.modelThinkingLevels 快照：引导页按当前模型反查每模型默认档位用。 */
	modelThinkingLevels?: Record<string, string>;
	/** 应用成功后关闭选择器（选择器点击路径需要；快捷键路径幂等） */
	onApplied: () => void;
}): SessionPreferenceController {
	const { sessionId, onApplied } = options;
	const store = useStore();
	/** 快捷键首次按下才武装目录加载：避免每个会话栏开机就拉一次模型列表。 */
	const [cycleArmed, setCycleArmed] = useState(false);
	const [restartTarget, setRestartTarget] = useState<{
		handle: SessionRuntimeTarget;
		model: string;
	} | null>(null);
	const [restarting, setRestarting] = useState(false);
	const state = useSessionPreferenceState({
		sessionId,
		pickerOpen: options.pickerOpen,
		thinkingPickerOpen: options.thinkingPickerOpen,
		cycleArmed,
		defaultModel: options.defaultModel,
		defaultThinkingLevel: options.defaultThinkingLevel,
		modelThinkingLevels: options.modelThinkingLevels,
	});
	const { record, runtime, isDshSession, models, favoriteModels, favoritesLoaded, hiddenProviders, hiddenModels, modelPending, currentModel: resolvedLiveModel, thinkingLevels, currentThinkingLevel } = state;
	// 与 Tab 栏「重启」共用 App.restartActiveAgent：置 restartingAgentId，
	// SessionView overlay（loader + 文案）才会亮。这里自己调 restartRuntime
	// 能换进程，但不会驱动那套 UI 状态。
	const { restartActiveAgent } = useSessionPaneServices();
	// 不跟 restartTarget state 同步：ConfirmDialog 点确定会先 onOpenChange(false)
	// 走 onCancel 清掉 state；确认意图放 ref，避免当成取消后丢数据。
	const restartIntentRef = useRef<ModelRestartIntent | null>(null);
	// state 的重绘晚于同轮点击；同步记录本次 owner，防重复提交，也不让旧 finally 解掉新锁。
	const restartingIntentRef = useRef<ModelRestartIntent | null>(null);
	const recordRef = useRef(record);
	recordRef.current = record;
	// 按一次栏生命周期隔离请求；切走再回来也不能复活先前的选择结果。
	const selectionScopeRef = useRef({ sessionId, active: true });
	if (selectionScopeRef.current.sessionId !== sessionId) selectionScopeRef.current = { sessionId, active: true };
	useEffect(() => {
		const scope = selectionScopeRef.current;
		scope.active = true;
		return () => {
			scope.active = false;
		};
	}, [sessionId]);

	/** 保存请求的来源栏与绑定；store 实时检查覆盖换绑后尚未重绘的窗口。 */
	function captureSelection(handle: SessionRuntimeTarget | undefined) {
		const scope = selectionScopeRef.current;
		return () => {
			const current = currentHandle();
			return scope.sessionId === sessionId && selectionScopeRef.current === scope && scope.active && current?.agentId === handle?.agentId && current?.runtimeGeneration === handle?.runtimeGeneration;
		};
	}

	function writeSelectedModelToState(model: SessionRuntimeModelSelection) {
		const current = recordRef.current;
		if (!current) return;
		state.upsertSession({
			...current,
			model: createSessionModelPreference(model.provider, model.modelId, model.modelName),
			...(model.thinkingLevel !== undefined ? { thinkingLevel: model.thinkingLevel } : {}),
			updatedAt: Date.now(),
		});
	}

	function currentHandle() {
		return toSessionRuntimeTarget(sessionId, store.get(sessionRuntimeByIdAtom)[sessionId]);
	}

	/** 仅当前绑定不可用时保存下次启动偏好；CHANGED 是已退休请求，不能降级写记录。 */
	function isUnavailableRuntimeFailure(error: unknown): boolean {
		return error instanceof SessionCommandFailure && error.code === "SESSION_RUNTIME_UNAVAILABLE";
	}

	function selectedModelPreference(model: AvailableModel) {
		return createSessionModelPreference(model.provider, model.id, model.name);
	}

	async function applyModelToRecord(model: AvailableModel, isCurrent: () => boolean) {
		const updated = await desktopApi.sessions.updateRecord(sessionId, {
			model: selectedModelPreference(model),
		});
		if (isCurrent()) state.upsertSession(updated);
	}

	function currentLiveModel() {
		// pending「from」与底栏取同一份会话选择，不能被 runtime 的实际模型反向改写。
		return resolveComposerLiveModel({
			record: record?.model,
		});
	}

	function markModelPending(model: AvailableModel) {
		const live = currentLiveModel();
		const from = modelPending?.from ?? {
			provider: live.provider,
			modelId: live.modelId,
			modelName: live.modelName,
		};
		if (from.provider === model.provider && from.modelId === model.id) {
			state.setModelPending(undefined);
			return;
		}
		const selected = selectedModelPreference(model);
		state.setModelPending({
			from,
			to: selected,
		});
	}

	function offerModelRestart(handle: SessionRuntimeTarget, model: AvailableModel) {
		const isCurrent = captureSelection(handle);
		if (!isCurrent()) return;
		onApplied();
		const selected = selectedModelPreference(model);
		restartIntentRef.current = {
			handle,
			isCurrent,
			...selected,
		};
		setRestartTarget({
			handle,
			model: modelKey(model.provider, model.id),
		});
	}

	usePendingModelApply({
		sessionId,
		runtime,
		modelPending,
		applySelectedModel: (model) => writeSelectedModelToState(model),
		clearPending: () => state.setModelPending(undefined),
		offerRestart: offerModelRestart,
	});

	/**
	 * 后端明确返回 busy 时才排队模型切换；支持运行中选择的 Pi/DSH 会直接在当前 runtime
	 * 入口应用，已发出的请求继续使用原配置，后续 step 使用新配置。
	 */
	async function pickModelWhileBusy(handle: SessionRuntimeTarget, model: AvailableModel, isCurrent: () => boolean) {
		try {
			const listed = requireSessionCommand(await desktopApi.sessions.listRuntimeModels(handle));
			if (!isCurrent()) return;
			const snapshotHasModel = listed.value.some((item) => item.provider === model.provider && item.id === model.id);
			if (!snapshotHasModel) {
				offerModelRestart(handle, model);
				return;
			}
		} catch (error) {
			// 快照 busy/不可用不挡选择；明确的换绑拒绝不得包装成排队写入。
			if (error instanceof SessionCommandFailure && error.code === "SESSION_RUNTIME_CHANGED") throw error;
		}
		if (!isCurrent()) return;
		await applyModelToRecord(model, isCurrent);
		if (!isCurrent()) return;
		markModelPending(model);
		onApplied();
	}

	async function applyModel(model: AvailableModel) {
		// 欢迎页/未启动 Agent（无 record）：把选择存本地偏好，点「启动 Agent」创建会话时应用。
		// 后端各自独立存储（issue #253）：DSH 目录的 provider 是 host route 名（不在
		// models.json），写进 pi 的 WELCOME_MODEL_KEY 会被 launchDefaults 的存在性校验整条
		// 丢弃；pi 的 models.json 模型写进 DSH 偏好也会被 host catalog 拒绝。历史上 DSH 态
		// 直接 return（不写任何存储），点选因此完全丢失——用户表现为「切到 DSH 后模型换不了」。
		if (!record) {
			try {
				localStorage.setItem(isDshSession ? WELCOME_DSH_MODEL_KEY : WELCOME_MODEL_KEY, JSON.stringify(selectedModelPreference(model)));
			} catch {
				// localStorage 不可用时静默；创建会话回退到各后端自己的默认模型
			}
			onApplied();
			return;
		}
		const selected = selectedModelPreference(model);
		const handle = currentHandle();
		const isCurrent = captureSelection(handle);
		try {
			if (handle) {
				try {
					// Pi 返回的模型名与实际生效档位是运行态真值；旧档位不随 set_model 重发。
					const applied = requireSessionCommand(await desktopApi.sessions.setRuntimeModel(handle, selected.provider, selected.modelId, selected.modelName));
					if (!isCurrent()) return;
					writeSelectedModelToState(applied.value);
					state.setModelPending(undefined);
				} catch (error) {
					if (!isCurrent()) return;
					if (error instanceof SessionCommandFailure && error.code === "SESSION_RUNTIME_BUSY") {
						await pickModelWhileBusy(handle, model, isCurrent);
						return;
					}
					// 当前绑定确实不可用时仍允许「先选模型，后启动」。
					if (!isUnavailableRuntimeFailure(error)) throw error;
					await applyModelToRecord(model, isCurrent);
				}
			} else {
				await applyModelToRecord(model, isCurrent);
			}
			if (isCurrent()) onApplied();
		} catch (error) {
			if (!isCurrent()) return;
			// 模型在本地 models.json 存在但运行中 Agent 快照未加载（pi set_model 校验失败）：
			// 关闭选择器并提示用户重启 Agent 使新模型生效，而非直接报错。
			if (error instanceof SessionCommandFailure && error.needsRestart && handle) {
				offerModelRestart(handle, model);
				return;
			}
			// 附带 debugDetails：DSH selectModel 拒绝（如 reasoningEffort 不被模型支持）时
			// 把真实原因展示给用户，而不是只看到泛化的「会话操作失败，请重试。」
			showNotice(sessionCommandFailureToast(error), 4000);
		}
	}

	const canClearModel = (!record || record.status === "draft") && !runtime?.agentId;

	async function clearModel() {
		// 点击与异步保存回包都必须仍是原栏的未启动草稿；已发出的源记录保存可完成，但不能污染新栏。
		const ownsSelection = captureSelection(undefined);
		const isCurrent = () => ownsSelection() && (record ? recordRef.current?.status === "draft" : !recordRef.current);
		if (!isCurrent()) return;
		try {
			if (record) {
				const updated = await desktopApi.sessions.updateRecord(sessionId, { model: null });
				if (!isCurrent()) return;
				state.upsertSession(updated);
			} else {
				localStorage.removeItem(isDshSession ? WELCOME_DSH_MODEL_KEY : WELCOME_MODEL_KEY);
			}
			state.setModelPending(undefined);
			onApplied();
		} catch (error) {
			if (isCurrent()) showNotice(error instanceof Error ? error.message : String(error), 4000);
		}
	}

	async function applyThinking(level: string) {
		// 引导页只有 renderer-only 虚拟会话，尚无 catalog record 可更新。先保存本次
		// 显式选择，底栏关闭选择器后立即从同一偏好重绘；首次发送创建真实会话时再带入。
		if (!record) {
			try {
				localStorage.setItem(WELCOME_THINKING_KEY, level);
			} catch {
				// localStorage 不可用时静默；首次创建会话会回退到配置默认档位。
			}
			onApplied();
			return;
		}
		const handle = currentHandle();
		const isCurrent = captureSelection(handle);
		try {
			if (handle) {
				try {
					const applied = requireSessionCommand(await desktopApi.sessions.setRuntimeThinking(handle, level));
					if (!isCurrent()) return;
					const current = recordRef.current;
					if (current) {
						// Pi 可能规范化/钳制档位；记录与底栏统一采用实际生效值。
						state.upsertSession({ ...current, thinkingLevel: applied.value.thinkingLevel, updatedAt: Date.now() });
					}
				} catch (error) {
					if (!isCurrent()) return;
					// 与模型选择同一策略：仅当前绑定不可用时保存启动偏好。
					if (!isUnavailableRuntimeFailure(error)) throw error;
					const updated = await desktopApi.sessions.updateRecord(sessionId, {
						thinkingLevel: level,
					});
					if (isCurrent()) state.upsertSession(updated);
				}
			} else {
				const updated = await desktopApi.sessions.updateRecord(sessionId, {
					thinkingLevel: level,
				});
				if (isCurrent()) state.upsertSession(updated);
			}
			if (isCurrent()) onApplied();
		} catch (error) {
			if (!isCurrent()) return;
			// 附带 debugDetails：DSH setThinking 的 selectModel 被 host 拒绝（如当前模型
			// 不支持该档位）时，把真实原因展示给用户，而不是只看到「会话操作失败，请重试。」
			showNotice(sessionCommandFailureToast(error), 4000);
		}
	}

	// 快捷键回调持最新实现：监听器只注册一次，避免依赖变化反复退订/重订。
	const applyModelRef = useRef(applyModel);
	applyModelRef.current = applyModel;
	const applyThinkingRef = useRef(applyThinking);
	applyThinkingRef.current = applyThinking;

	/**
	 * 快捷键循环：只在「收藏」里换（pi 的 scoped models → PiDeck 的收藏）。
	 * 候选经目录/隐藏供应商过滤（resolveFavoriteCycleCandidates），无可切换目标时给提示而不是静默无反应。
	 */
	const cycleModel = useCallback(
		async (direction: CycleDirection = "forward") => {
			const currentKey = resolvedLiveModel.provider && resolvedLiveModel.modelId ? modelKey(resolvedLiveModel.provider, resolvedLiveModel.modelId) : undefined;
			const candidates = resolveFavoriteCycleCandidates({
				favorites: favoriteModels,
				models,
				hiddenProviders,
				hiddenModels,
				backend: isDshSession ? "dsh" : "pi",
			});
			if (candidates.length === 0) {
				showNotice(t("app.cycleModelEmpty"), 2500, "info", undefined, undefined, "preference-cycle");
				return;
			}
			if (candidates.length === 1) {
				const only = candidates[0];
				// 只有 1 个收藏时：不是当前模型就直接切过去（比 pi 的「Only one model in scope」更有用），
				// 已经是当前模型才提示用户多收藏几个。
				if (modelKey(only.provider, only.id) !== currentKey) await applyModelRef.current(only);
				else showNotice(t("app.cycleModelSingle"), 2500, "info", undefined, undefined, "preference-cycle");
				return;
			}
			const target = pickCycleModel({ candidates, currentKey, direction });
			if (target) await applyModelRef.current(target);
		},
		[resolvedLiveModel.provider, resolvedLiveModel.modelId, favoriteModels, models, hiddenProviders, hiddenModels, isDshSession],
	);

	/**
	 * 快捷键循环：在当前模型可用档位里环绕（档位表与思考选择器同源）。
	 * 应用后的档位由用户选择持久化；后端仅负责接受或拒绝命令，底栏不再使用回传值覆盖。
	 */
	const cycleThinking = useCallback(
		async (direction: CycleDirection = "forward") => {
			const next = pickCycleThinkingLevel({
				levels: thinkingLevels,
				current: currentThinkingLevel,
				direction,
			});
			if (!next) {
				showNotice(t("app.cycleThinkingUnsupported"), 2500, "info", undefined, undefined, "preference-cycle");
				return;
			}
			await applyThinkingRef.current(next);
		},
		[thinkingLevels, currentThinkingLevel],
	);

	const cycleModelRef = useRef(cycleModel);
	cycleModelRef.current = cycleModel;
	const cycleThinkingRef = useRef(cycleThinking);
	cycleThinkingRef.current = cycleThinking;

	/**
	 * 快捷键待执行队列：首次按键时目录/收藏可能还没加载（目录刻意懒加载），这里记下意图，
	 * 等 models + favorites 就绪后再执行；目录加载完成但仍为空则放弃并提示。
	 */
	const pendingCycleRef = useRef<PendingCycle | null>(null);
	useEffect(() => {
		// 仅订本栏焦点切片：离开时丢弃旧按键，即使回来前本栏没有重绘也不能复活。
		const focusedAtom = sessionFocusedByIdAtomFamily(sessionId);
		return store.sub(focusedAtom, () => {
			if (!store.get(focusedAtom)) pendingCycleRef.current = null;
		});
	}, [sessionId, store]);
	const catalogReady = models.length > 0;
	useEffect(() => {
		const pending = pendingCycleRef.current;
		if (!pending) return;
		// 先淘汰旧意图，再检查目录：换栏/换绑时立即丢弃，回来也不能复活旧按键或错误提示。
		if (!pending.isCurrent() || pending.isDshSession !== isDshSession || store.get(currentSessionIdAtom) !== sessionId) {
			pendingCycleRef.current = null;
			return;
		}
		if (!favoritesLoaded) return;
		if (!catalogReady) {
			if (state.report !== null && !state.catalogLoading) {
				pendingCycleRef.current = null;
				showNotice(t("app.cycleModelCatalogFailed"), 3000, "warning", undefined, undefined, "preference-cycle");
			}
			return;
		}
		pendingCycleRef.current = null;
		if (pending.kind === "model") void cycleModelRef.current("forward");
		else void cycleThinkingRef.current("forward");
	}, [sessionId, runtime?.agentId, runtime?.runtimeGeneration, isDshSession, store, favoritesLoaded, catalogReady, state.catalogLoading, state.report]);

	useEffect(() => {
		return desktopApi.app.onShortcutTriggered((id) => {
			if (id !== "cycleModel" && id !== "cycleThinking") return;
			// 只由聚焦栏响应：分屏时两个会话栏各挂一份 controller，不能让两栏都切一遍
			if (store.get(currentSessionIdAtom) !== sessionId) return;
			if (!catalogReady || !favoritesLoaded) {
				setCycleArmed(true);
				pendingCycleRef.current = {
					kind: id === "cycleModel" ? "model" : "thinking",
					isDshSession,
					isCurrent: captureSelection(currentHandle()),
				};
				return;
			}
			if (id === "cycleModel") void cycleModelRef.current("forward");
			else void cycleThinkingRef.current("forward");
		});
	}, [sessionId, store, catalogReady, favoritesLoaded, isDshSession]);

	// 确认/取消入口只授权本次呈现的意图，旧弹窗回调不能挪用随后出现的新模型授权。
	const confirmationIntent = restartIntentRef.current;

	async function confirmRestart() {
		const intent = confirmationIntent;
		if (!intent || restartIntentRef.current !== intent || intent.handle.sessionId !== sessionId || !intent.isCurrent() || restartingIntentRef.current?.isCurrent()) return;
		restartingIntentRef.current = intent;
		setRestarting(true);
		// 先关确认框，避免 AlertDialog 关闭动画盖住 overlay。
		setRestartTarget(null);
		try {
			const updated = await desktopApi.sessions.updateRecord(intent.handle.sessionId, {
				model: {
					provider: intent.provider,
					modelId: intent.modelId,
					modelName: intent.modelName,
				},
			});
			// 保存等待期间可能已切栏/换代，或有新确认意图；旧授权不能继续重启现在的进程。
			if (!intent.isCurrent() || restartIntentRef.current !== intent) return;
			state.upsertSession(updated);
			state.setModelPending(undefined);
			await restartActiveAgent(intent.handle.agentId);
		} catch (error) {
			if (intent.isCurrent()) showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			if (restartIntentRef.current === intent) restartIntentRef.current = null;
			if (restartingIntentRef.current === intent) {
				restartingIntentRef.current = null;
				setRestarting(false);
			}
		}
	}

	function cancelRestart() {
		// 只关框：点确定也会先走 onOpenChange(false)→onCancel。
		// 不能在这里清 restartIntentRef，否则确认路径读到空、重启不会发生。
		if (confirmationIntent && restartIntentRef.current === confirmationIntent && confirmationIntent.isCurrent()) setRestartTarget(null);
	}

	// 不做 memo：本 controller 只服务一个选择器宿主组件，缓存对象反而要靠 ref 兜住
	// 大量回调的最新闭包；直接返回当次渲染的引用更不容易出「点了没反应」的陈旧闭包。
	return {
		isDshSession,
		models,
		report: state.report,
		catalogLoading: state.catalogLoading,
		refreshing: state.refreshing,
		reloadCatalog: state.reloadCatalog,
		currentModel: resolvedLiveModel,
		thinkingLevels,
		currentThinkingLevel,
		favoriteModels,
		recentProviders: state.recentProviders,
		providerOrder: state.providerOrder,
		dshProviderOrder: state.dshProviderOrder,
		hiddenProviders,
		hiddenModels,
		projectId: state.projectId,
		agentId: state.agentId,
		toggleFavorite: state.toggleFavorite,
		toggleHideModel: state.toggleHideModel,
		applyModel: (model) => applyModelRef.current(model),
		canClearModel,
		clearModel,
		applyThinking: (level) => applyThinkingRef.current(level),
		cycleModel,
		cycleThinking,
		restartTarget: restartIntentRef.current?.isCurrent() ? restartTarget : null,
		restarting: restarting && Boolean(restartingIntentRef.current?.isCurrent()),
		confirmRestart,
		cancelRestart,
	};
}
