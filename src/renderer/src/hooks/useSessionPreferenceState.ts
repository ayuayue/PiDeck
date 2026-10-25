import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { AvailableModel } from "../../../shared/types";
import {
	beginPiRuntimeThinkingLevelsAtom,
	clearPiRuntimeThinkingLevelsAtom,
	matchesPiRuntimeThinkingLevelsTarget,
	modelPendingByIdAtom,
	piRuntimeThinkingLevelsBySessionIdAtomFamily,
	resolvePiRuntimeThinkingLevelsAtom,
	sessionRecordByIdAtomFamily,
	sessionRuntimeBySessionIdAtomFamily,
	upsertSessionAtom,
} from "../atoms";
import { desktopApi } from "../desktopApi";
import { useBackendModelCatalog } from "./useBackendModelCatalog";
import { resolveThinkingPickerLevels } from "../components/session/sessionPickerOptions";
import { showNotice } from "../utils/notice";
import { isLiveRuntimeStatus } from "../utils/sessionCommands";
import { resolveComposerLiveModel, resolveGuideDisplayModel, type ModelPending } from "../utils/modelPendingDisplay";
import { resolveComposerThinkingLevel } from "../utils/thinkingDisplay";
import { modelThinkingLevelOfMap } from "../../../shared/modelThinkingLevels";
import { modelKey } from "../utils/preferenceCycle";
import { GUIDE_BOOTSTRAP_SESSION_ID, WELCOME_DSH_MODEL_KEY, WELCOME_MODEL_KEY, isWelcomeModelLost, readWelcomeBackendPreference, readWelcomeDshModelPreference, readWelcomeModelPreference, readWelcomeThinkingPreference, shouldClearWelcomePreference } from "../utils/chatSessionBootstrap";

/**
 * 会话「模型 + 思考强度」的读侧状态：模型目录、收藏、当前模型与可用档位。
 *
 * 与 useSessionPreferenceController（写侧：应用命令 + 快捷键循环）拆开的原因：
 * 单文件塞下两侧会超过 600 行红线，而这条链路的读侧（目录/能力/欢迎页偏好校验）
 * 与写侧（busy 排队 / 待重启 / 降级）本来就是两个变化方向。
 */
export function useSessionPreferenceState(options: {
	sessionId: string;
	/** 选择器是否打开（模型目录加载开关之一；另一个是快捷键武装 cycleArmed） */
	pickerOpen: boolean;
	/** 思考选择器是否打开（决定要不要向运行中 Agent 校验精确档位） */
	thinkingPickerOpen: boolean;
	/** 快捷键首次按下已武装目录加载（写侧监听器设置） */
	cycleArmed: boolean;
	/** DSH 部署默认模型（草稿期高亮） */
	defaultModel?: { provider?: string; modelId?: string; modelName?: string };
	defaultThinkingLevel?: string;
	/** pi settings.modelThinkingLevels 快照（sessions.resolve-launch-defaults 回传）：
	 *  引导页改选模型后按当前模型反查每模型默认档位，与创建时的解析同序。 */
	modelThinkingLevels?: Record<string, string>;
}) {
	const { sessionId } = options;
	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const upsertSession = useSetAtom(upsertSessionAtom);
	const modelPending = useAtomValue(modelPendingByIdAtom)[sessionId];
	const setModelPendingMap = useSetAtom(modelPendingByIdAtom);
	const piRuntimeThinkingEntry = useAtomValue(piRuntimeThinkingLevelsBySessionIdAtomFamily(sessionId));
	const beginPiRuntimeThinkingLevels = useSetAtom(beginPiRuntimeThinkingLevelsAtom);
	const clearPiRuntimeThinkingLevels = useSetAtom(clearPiRuntimeThinkingLevelsAtom);
	const resolvePiRuntimeThinkingLevels = useSetAtom(resolvePiRuntimeThinkingLevelsAtom);
	const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
	const [favoritesLoaded, setFavoritesLoaded] = useState(false);
	/** 最近使用的供应商（最新在前）：模型选择器按此优先排列供应商分组。 */
	const [recentProviders, setRecentProviders] = useState<string[]>([]);
	/** Pi 供应商自定义顺序（模型页拖拽/上移下移写入）：模型选择器严格按此排列分组。 */
	const [providerOrder, setProviderOrder] = useState<string[]>([]);
	/** DSH 供应商自定义顺序（与 Pi 侧分开存放，避免两套配置互相污染）。 */
	const [dshProviderOrder, setDshProviderOrder] = useState<string[]>([]);
	/** 用户隐藏的供应商（Pi 模型页眼睛开关）：Pi 后端模型选择器与循环按 provider 过滤。 */
	const [hiddenProviders, setHiddenProviders] = useState<string[]>([]);
	/** 用户隐藏的模型（选择器内隐藏 / 已隐藏折叠区恢复）：循环候选同样排除。 */
	const [hiddenModels, setHiddenModels] = useState<string[]>([]);

	useEffect(() => {
		void desktopApi.settings
			.get()
			.then((settings) => {
				setFavoriteModels(settings.favoriteModels ?? []);
				setRecentProviders(settings.recentProviders ?? []);
				setProviderOrder(settings.providerOrder ?? []);
				setDshProviderOrder(settings.dshProviderOrder ?? []);
				setHiddenProviders(settings.hiddenProviders ?? []);
				setHiddenModels(settings.hiddenModels ?? []);
			})
			.catch(() => undefined)
			.finally(() => setFavoritesLoaded(true));
	}, []);

	// C19：模型目录数据源统一 hook——模型/思考选择器打开、或快捷键循环首次触发即加载
	//（不依赖 record：欢迎页/未启动 Agent 时 record 为 undefined，但模型列表是全量的）。
	// Pi 欢迎页也要加载，才能使用启动 capability snapshot 的精确 thinkingLevels；DSH 的
	// catalog 提供默认档位与当前模型信息（思考档位按当前模型 reasoningEfforts 裁剪，
	// 模型未知/未声明时回退全量，host 负责最终能力校验）。
	// 引导页虚拟会话没有 record，后端以前端显式切换偏好为准（与 changeBackend 的
	// 引导页分支同源），切到 dsh 后模型/思考选择器展示 DSH 目录而非 pi 目录。
	const isDshSession = record?.backend === "dsh" || runtime?.backend === "dsh" || (sessionId === GUIDE_BOOTSTRAP_SESSION_ID && readWelcomeBackendPreference() === "dsh");
	// 目录刻意懒加载：选择器打开、或快捷键首次按下（cycleArmed）才拉，避免每个会话栏开机各拉一次。
	const catalogEnabled = options.pickerOpen || options.cycleArmed;
	const {
		models,
		report,
		loading: catalogLoading,
		refreshing,
		reload,
	} = useBackendModelCatalog({
		sessionId,
		backend: isDshSession ? "dsh" : "pi",
		projectId: record?.projectId,
		enabled: catalogEnabled,
	});
	// 引导页点选按后端读各自的存储（issue #253）：DSH 的模型是 host route 名，
	// 存在 WELCOME_DSH_MODEL_KEY；读错会拿到 pi 的 models.json 模型去高亮 DSH 目录。
	const welcomeModel = isDshSession ? readWelcomeDshModelPreference()?.model : readWelcomeModelPreference()?.model;
	const welcomeModelStorageKey = isDshSession ? WELCOME_DSH_MODEL_KEY : WELCOME_MODEL_KEY;
	// welcome 偏好可能指向已删除的供应商/模型（models.json 已更新而 localStorage 残留）：
	// 目录加载后校验存在性，失效则忽略该偏好，避免选择器/默认高亮落在幽灵模型上。
	// 与 ComposerBottomBar 共用 isWelcomeModelLost 判定；目录未加载（models 为空）时不判定，
	// 避免误清用户仍有效的偏好。
	const welcomeModelLost = isWelcomeModelLost(welcomeModel, models);
	// 展示可以宽容忽略，但删除不可逆：本 hook 在有 record 时按 record.projectId 加载
	// 「项目范围」目录，而偏好是全局 localStorage——项目列表合法地不含该模型时不能
	// 拿它判死全局偏好，否则会把用户在别的项目里仍然有效的点选静默销毁。
	const clearWelcomePreference = shouldClearWelcomePreference({
		welcomeModel,
		models,
		catalogLoaded: report?.ok === true,
		catalogIsGlobal: !record?.projectId,
	});
	useEffect(() => {
		// 失效偏好只清一次：下次引导页不再默认已删除的模型（创建时主进程也会兜底丢弃）。
		if (clearWelcomePreference) {
			try {
				localStorage.removeItem(welcomeModelStorageKey);
			} catch {
				// localStorage 不可用时静默；展示层已忽略该偏好。
			}
		}
	}, [clearWelcomePreference, welcomeModelStorageKey]);
	const effectiveWelcomeModel = welcomeModelLost ? undefined : welcomeModel;
	// 引导页（无 record）模型高亮：与主进程创建解析同序（点选 > 显式默认 > 切换列表 > 上次使用）。
	// 规则收拢到 resolveGuideDisplayModel，不再在本 hook 与 ComposerComponents 各写一份。
	const guideDefaultModel = resolveGuideDisplayModel({
		isDsh: isDshSession,
		welcomeModel: effectiveWelcomeModel,
		defaultModel: options.defaultModel,
	});
	// 模型选择永远取会话记录或引导页偏好；runtime 仅服务执行与能力状态。
	// DSH 例外：host 会话投影（modelSelection.next ?? lastUsed）是会话级持久化选择，
	// 记录缺 model 时用它兜底，避免落到全局部署默认（显示成别的会话的模型）。
	const runtimeLive = isLiveRuntimeStatus(runtime?.status);
	const resolvedLiveModel = resolveComposerLiveModel({
		record: record?.model,
		runtime: isDshSession && runtime?.state ? { provider: runtime.state.provider, modelId: runtime.state.modelId, modelName: runtime.state.modelName } : undefined,
		fallback: {
			// 无 record（引导页）：高亮取 guideDefaultModel（已按「点选 > 显式默认 > 切换列表 > 上次使用」
			// 折叠）；modelName 必须同源取 guideDefaultModel，否则点选生效时会拿默认模型的展示名配点选的 id。
			provider: guideDefaultModel?.provider,
			modelId: guideDefaultModel?.modelId,
			modelName: guideDefaultModel?.modelName,
		},
	});

	const runtimeThinkingEntryRef = useRef(piRuntimeThinkingEntry);
	runtimeThinkingEntryRef.current = piRuntimeThinkingEntry;

	useEffect(() => {
		return () => {
			// The controller is scoped to one mounted session pane; releasing here keeps the
			// per-session atom map bounded without coupling global session atoms to it.
			clearPiRuntimeThinkingLevels(sessionId);
		};
	}, [sessionId, clearPiRuntimeThinkingLevels]);

	/**
	 * Pi 运行态的 RPC 仅在用户打开思考档位（或快捷键武装了档位循环）、capability cache 已
	 * 尝试加载但没有结果、且 Agent 空闲时做后台校验。生成中的 Agent 可能延后处理请求；
	 * 展示始终优先使用 cache / 静态兼容档位，不能被这条非关键校验卡成 loading。
	 */
	useEffect(() => {
		const agentId = runtime?.agentId;
		const runtimeGeneration = runtime?.runtimeGeneration;
		// 只向空闲、且 capability cache 已加载却没有该模型精确档位的 Agent 查
		// thinkingLevelMap。生成中的 Agent 与未打开的菜单都不能触发这条非关键 RPC。
		const provider = resolvedLiveModel.provider;
		const modelId = resolvedLiveModel.modelId;
		const cachedModel = models.find((model) => model.provider === provider && model.id === modelId);
		if (!(options.thinkingPickerOpen || options.cycleArmed) || isDshSession || runtime?.status !== "idle" || report === null || cachedModel?.thinkingLevels !== undefined || !agentId || typeof runtimeGeneration !== "number" || !provider || !modelId) {
			return;
		}
		const target = { agentId, runtimeGeneration, provider, modelId };
		if (matchesPiRuntimeThinkingLevelsTarget(runtimeThinkingEntryRef.current, target)) return;

		beginPiRuntimeThinkingLevels({ sessionId, target });
		void desktopApi.sessions
			.listRuntimeThinkingLevels({
				sessionId,
				agentId,
				runtimeGeneration,
			})
			.then((result) => {
				// The atom accepts the result only while this exact runtime/model still owns the slot.
				resolvePiRuntimeThinkingLevels({
					sessionId,
					target,
					levels: result.ok ? result.value.value : undefined,
				});
			})
			.catch(() => {
				resolvePiRuntimeThinkingLevels({ sessionId, target });
			});
	}, [sessionId, options.thinkingPickerOpen, options.cycleArmed, isDshSession, runtime?.agentId, runtime?.runtimeGeneration, runtime?.status, resolvedLiveModel.provider, resolvedLiveModel.modelId, models, report, beginPiRuntimeThinkingLevels, resolvePiRuntimeThinkingLevels]);

	// 思考档位表：与思考选择器同一份（runtime 精确档位 > capability cache > 兼容全量）。
	const currentModelEntry = models.find((model) => model.provider === resolvedLiveModel.provider && model.id === resolvedLiveModel.modelId);
	const runtimeThinkingTarget =
		!isDshSession && runtimeLive && runtime?.agentId && typeof runtime.runtimeGeneration === "number" && resolvedLiveModel.provider && resolvedLiveModel.modelId
			? {
					agentId: runtime.agentId,
					runtimeGeneration: runtime.runtimeGeneration,
					provider: resolvedLiveModel.provider,
					modelId: resolvedLiveModel.modelId,
				}
			: undefined;
	const runtimeLevels = runtimeThinkingTarget && matchesPiRuntimeThinkingLevelsTarget(piRuntimeThinkingEntry, runtimeThinkingTarget) && piRuntimeThinkingEntry?.status === "resolved" ? piRuntimeThinkingEntry.levels : undefined;
	// 正在运行的 Agent 不能把后台 RPC 当成弹窗/循环的前置条件：统一以 capability cache
	// 为唯一展示源，runtime RPC 仅在 cache 未覆盖该模型时兑底。缓存/元数据尚不可用时
	// 保留全量兼容档位；后端才是最终能力裁决者。
	const thinkingLevels = resolveThinkingPickerLevels({
		backend: isDshSession ? "dsh" : "pi",
		runtimePiLevels: runtimeLevels,
		cachedPiLevels: currentModelEntry?.thinkingLevels,
		dshReasoningEfforts: currentModelEntry?.reasoningEfforts,
	});
	// 无 record 的引导页以用户刚点选的档位为最高优先级；只有尚未点选时，
	// 才依次回退「当前模型的每模型默认」→ settings.defaultThinkingLevel → 模型自身 defaultEffort。
	// 每模型默认必须按当前展示的模型查（用户可在引导页改选模型）：createDraft 也按
	// 最终生效的模型查同一张表，次序一致才能保证「显示的就是创建时套用的」。
	const welcomeThinking = !record ? readWelcomeThinkingPreference()?.thinkingLevel : undefined;
	const perModelThinkingDefault = modelThinkingLevelOfMap(options.modelThinkingLevels, resolvedLiveModel.provider, resolvedLiveModel.modelId);
	const currentThinkingLevel = resolveComposerThinkingLevel({
		// DSH：记录缺档位时用 host 投影的当前档位兜底（与模型同一份 runtime.state）；
		// 不能直接落到 options.defaultThinkingLevel（全局部署默认，会显示成别的会话档位）。
		record: record?.thinkingLevel ?? (isDshSession ? runtime?.state?.thinkingLevel : undefined),
		// 无 record（引导页）：显式点选 > 每模型默认 > 配置默认 > 模型默认（与底栏同规则）。
		fallback: welcomeThinking ?? perModelThinkingDefault ?? options.defaultThinkingLevel ?? currentModelEntry?.defaultEffort,
		allowedLevels: thinkingLevels,
	});

	function setModelPending(pending: ModelPending | undefined) {
		setModelPendingMap((prev) => ({ ...prev, [sessionId]: pending }));
	}

	/** 收藏开关：写 settings.favoriteModels（append 顺序即快捷键循环顺序）。 */
	async function toggleFavorite(provider: string, modelId: string) {
		const key = modelKey(provider, modelId);
		const next = favoriteModels.includes(key) ? favoriteModels.filter((item) => item !== key) : [...favoriteModels, key];
		setFavoriteModels(next);
		try {
			await desktopApi.settings.update({ favoriteModels: next });
		} catch (error) {
			setFavoriteModels(favoriteModels);
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		}
	}

	/**
	 * 模型隐藏开关（与收藏同构的 settings 写入）：隐藏后选择器不再列出，
	 * Ctrl+M 循环候选也一并排除（用户隐藏即不想用它）。
	 */
	async function toggleHideModel(provider: string, modelId: string) {
		const key = modelKey(provider, modelId);
		const next = hiddenModels.includes(key) ? hiddenModels.filter((item) => item !== key) : [...hiddenModels, key];
		setHiddenModels(next);
		try {
			await desktopApi.settings.update({ hiddenModels: next });
		} catch (error) {
			setHiddenModels(hiddenModels);
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		}
	}

	return {
		/** 会话记录 / runtime 快照：写侧判断「有没有 Agent、是否在生成、要不要降级」用 */
		record,
		runtime,
		runtimeLive,
		isDshSession,
		projectId: record?.projectId,
		agentId: runtime?.agentId,
		models,
		report,
		catalogLoading,
		refreshing,
		reloadCatalog: reload,
		currentModel: resolvedLiveModel,
		thinkingLevels,
		currentThinkingLevel,
		favoriteModels,
		favoritesLoaded,
		recentProviders,
		providerOrder,
		dshProviderOrder,
		hiddenProviders,
		hiddenModels,
		modelPending,
		setModelPending,
		upsertSession,
		toggleFavorite,
		toggleHideModel,
	};
}
