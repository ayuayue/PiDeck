import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import { isValidProviderName } from "../../../shared/providerName";
import { FetchedModelCombobox } from "./FetchedModelCombobox";
import { buildModelsFromFetchedSelection } from "./modelsUtils";
import { showNotice } from "../utils/notice";
import { ArrowLeft, RefreshCw, Trash2, X } from "lucide-react";
import type { FetchedModel, ConfigProxyMode } from "../../../shared/types/fetchedModel";
import type { ModelItem, ProviderCompat } from "./configTypes";
import { ModelsTable } from "./ModelsTable";
import { ProviderConnectionForm, type ProviderTestResult } from "./ProviderConnectionForm";
import { buildProviderConfigFromDraft, providerDialogResetKey, resolveFetchedBaseUrl, resolveInitialReasoningContentReplay, type AddProviderDraft } from "./addProviderDraft";
import { applyModelPatches, applyAdaptiveTemplateReset, computeModelSpecPatches, mergeAdaptiveModelTemplate } from "../utils/modelSpecAutoFill";
import { pickManagedCompatFlags } from "./modelCompatFields";
import { countSelectedModelIndexes, invertModelIndexes, removeSelectedModelIndexes, selectAllModelIndexes, toggleAllModelIndexes, toggleModelIndex } from "./modelBatchSelection";
import { withModelThinkingLevelEnabled } from "../../../shared/modelThinkingLevels";
import { getModelUserAgentOverride, readModelOverrides, setModelUserAgentOverride } from "./providerHeaders";
import { pickProviderHiddenIds } from "./hiddenModels";
import { useConfigEditor } from "./useConfigEditorApi";

/** 共享供应商表单：页内草稿交给宿主统一保存，取消不落盘。 */
/** 页面模式：add=新增空草稿；edit=预填现有 provider（含改名）。 */
export type ProviderDialogMode = "add" | "edit";

/** 编辑模式预填数据（现有 provider 配置）。 */
export type ProviderDialogInitial = {
	name: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	userAgent?: string;
	compat?: ProviderCompat;
	models?: ModelItem[];
	/** 逐模型 UA 覆盖（provider.modelOverrides；页内可编辑，确认时随 provider 一起落盘）。 */
	modelOverrides?: Record<string, Record<string, unknown>>;
};

/** 按当前模型列表读取默认档位；孤儿键不回填，随保存时的替换写入清除。 */
function readProviderThinkingDefaults(initial: ProviderDialogInitial | undefined, read: ((providerName: string, modelId: string) => string) | undefined): Record<string, string> {
	if (!initial?.name || !read) return {};
	const defaults: Record<string, string> = {};
	for (const model of initial.models ?? []) {
		if (!model.id) continue;
		const level = read(initial.name, model.id);
		if (level) defaults[model.id] = level;
	}
	return defaults;
}

export function AddProviderDialog(props: {
	mode: ProviderDialogMode;
	/** edit 模式预填值（add 模式忽略）。 */
	initial?: ProviderDialogInitial;
	/** 已存在的供应商名（防重名；edit 模式已排除自身）。 */
	existingNames: string[];
	/** 返回模型列表（页面左上角返回按钮）。 */
	onBack: () => void;
	/** 提交当前页草稿；页面状态由宿主在成功后切换回列表。 */
	onConfirm: (draft: AddProviderDraft) => void;
	/** 设置窗口标题栏保存时触发当前页提交；由父级注入稳定的外部保存入口。 */
	onRequestSave?: (save: (() => boolean) | undefined) => void;
	onDirtyChange: (dirty: boolean) => void;
	/** 模型设置由宿主读取，页内编辑与连接字段一同进入 onConfirm 草稿，保存时按最终供应商名替换。 */
	/** AppSettings.hiddenModels 全量条目：过滤出本供应商的隐藏集合；宿主不给则不渲染眼睛按钮。 */
	hiddenModels?: string[];
	/** 读取某模型当前的默认思考档位（settings.json）；宿主不给则不渲染默认档位入口。 */
	getModelThinkingLevelDefault?: (providerName: string, modelId: string) => string;
	/** Pi 已确认的可用思考档位（只读参考）。 */
	getModelAvailableThinkingLevels?: (providerName: string, modelId: string) => readonly string[] | undefined;
}) {
	const { api: desktopApi, remote, fetchRemoteProviderModels } = useConfigEditor();
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [userAgent, setUserAgent] = useState("");
	const [compat, setCompat] = useState<AddProviderDraft["compat"]>({
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	});
	/** 页内维护的模型草稿：新增=空，编辑=现有模型；获取模型勾选后追加。 */
	const [models, setModels] = useState<ModelItem[]>([]);
	/** UA 覆盖始终持有对象：{} 表达清空；undefined 在 mergeProviderDraft 中表示未编辑，会保留原值。 */
	const [modelOverrides, setModelOverrides] = useState<Record<string, Record<string, unknown>>>({});
	/** 该供应商已隐藏的模型 id（AppSettings.hiddenModels 的页内副本，确认时才落盘）。 */
	const [hiddenModelIds, setHiddenModelIds] = useState<string[]>([]);
	/** 该供应商的每模型默认思考档位（settings.json 的页内副本，绝对快照：删模型即删档位）。 */
	const [thinkingDefaults, setThinkingDefaults] = useState<Record<string, string>>({});
	/** 正在重置为自适应的行 key（String(index)；与 ModelsTable 的默认 getRowKey 对齐）。 */
	const [resettingModelKey, setResettingModelKey] = useState<string | null>(null);
	/** 手动添加模型后待聚焦的新行 key，ModelsTable 聚焦完成后回调清空。 */
	const [pendingModelFocusKey, setPendingModelFocusKey] = useState<string | null>(null);
	const [modelBatchMode, setModelBatchMode] = useState(false);
	const [selectedModelIndexes, setSelectedModelIndexes] = useState<Set<number>>(() => new Set());
	const [testModelId, setTestModelId] = useState("");
	const [testProxyMode, setTestProxyMode] = useState<ConfigProxyMode>("follow");
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
	// ── 获取模型（/models）──
	const [fetching, setFetching] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [fetchedModels, setFetchedModels] = useState<FetchedModel[] | null>(null);
	const [selectedFetchedIds, setSelectedFetchedIds] = useState<string[]>([]);
	const initialValues = useRef("");

	// 只按模式与供应商身份重置；initial 每次渲染都换引用，依赖它会冲掉未保存草稿（#311）。
	const resetKey = providerDialogResetKey(props.mode, props.initial);
	useEffect(() => {
		const initial = props.initial;
		setName(initial?.name ?? "");
		setBaseUrl(initial?.baseUrl ?? "");
		setApi(initial?.api ?? "");
		setApiKey(initial?.apiKey ?? "");
		setUserAgent(initial?.userAgent ?? "");
		const initialCompat = {
			supportsDeveloperRole: initial?.compat?.supportsDeveloperRole ?? false,
			supportsReasoningEffort: initial?.compat?.supportsReasoningEffort ?? false,
			// 三态默认值统一由草稿域判定（见 resolveInitialReasoningContentReplay 注释）
			requiresReasoningContentOnAssistantMessages: resolveInitialReasoningContentReplay(initial),
			// strict 工具采样：文件里有显式表态就回显，未表态保持 undefined（下拉显示
			// 「跟随 pi 默认」）。不做自动推导——真实默认值随协议不同，猜错会让界面与
			// 线上行为不一致（见 configTypes.ProviderCompat.supportsStrictMode）。
			supportsStrictMode: initial?.compat?.supportsStrictMode,
			// 逐模型 compat 名义键的供应商默认值：同样只回显文件里的显式表态，未表态交给 pi 判定
			forceAdaptiveThinking: initial?.compat?.forceAdaptiveThinking,
			supportsTemperature: initial?.compat?.supportsTemperature,
			supportsStore: initial?.compat?.supportsStore,
		};
		setCompat(initialCompat);
		initialValues.current = JSON.stringify({
			name: initial?.name ?? "",
			baseUrl: initial?.baseUrl ?? "",
			api: initial?.api ?? "",
			apiKey: initial?.apiKey ?? "",
			userAgent: initial?.userAgent ?? "",
			compat: initialCompat,
			models: initial?.models ?? [],
			modelOverrides: readModelOverrides(initial?.modelOverrides) ?? {},
			hiddenModelIds: pickProviderHiddenIds(props.hiddenModels, initial?.name ?? ""),
			thinkingDefaults: readProviderThinkingDefaults(initial, props.getModelThinkingLevelDefault),
		});
		setModels(initial?.models ? initial.models.map((model) => ({ ...model })) : []);
		// 三份页内副本按宿主当前状态预填：UA 读 provider，隐藏读 AppSettings，默认档位读 settings.json
		setModelOverrides(readModelOverrides(initial?.modelOverrides) ?? {});
		setHiddenModelIds(pickProviderHiddenIds(props.hiddenModels, initial?.name ?? ""));
		setThinkingDefaults(readProviderThinkingDefaults(initial, props.getModelThinkingLevelDefault));
		setFetchedModels(null);
		setSelectedFetchedIds([]);
		setFetchError(null);
		setModelBatchMode(false);
		setSelectedModelIndexes(new Set());
		setPendingModelFocusKey(null);
		setResettingModelKey(null);
		setTestModelId("");
		setTestResult(null);
	}, [resetKey]);
	useEffect(() => {
		props.onDirtyChange(initialValues.current !== JSON.stringify({ name, baseUrl, api, apiKey, userAgent, compat, models, modelOverrides, hiddenModelIds, thinkingDefaults }));
	}, [name, baseUrl, api, apiKey, userAgent, compat, models, modelOverrides, hiddenModelIds, thinkingDefaults, props.onDirtyChange]);
	useEffect(() => () => props.onDirtyChange(false), [props.onDirtyChange]);

	const trimmedName = name.trim();
	const nameValid = isValidProviderName(trimmedName);
	const duplicate = trimmedName !== "" && props.existingNames.includes(trimmedName);
	const canConfirm = nameValid && !duplicate;

	/** 获取模型用当前草稿的 baseUrl/apiKey/api（不依赖已保存的 provider）。 */
	const handleFetchModels = async () => {
		if (!remote && (!baseUrl.trim() || !apiKey.trim())) {
			setFetchError(t("config.missingBaseUrlApiKey"));
			return;
		}
		setFetching(true);
		setFetchError(null);
		try {
			const result = await (fetchRemoteProviderModels
				? fetchRemoteProviderModels(props.initial?.name ?? name.trim())
				: desktopApi.config.fetchModels(
						baseUrl.trim(),
						apiKey.trim(),
						api || undefined,
						userAgent.trim() ? { "User-Agent": userAgent.trim() } : undefined,
						// 「获取模型」必须带上代理选择：此前这里漏传 proxyMode，导致下拉框选了 pi/desktop
						// 代理也仍然走 follow（跟随全局开关）→ 全局关闭时直连→需要代理的网关直接 TLS 握手失败。
						// 同一个对话框里「测试连接」已正确接线，两个按钮共用同一个 testProxyMode。
						testProxyMode,
					));
			if (result.success && result.models) {
				setFetchedModels(result.models);
				setSelectedFetchedIds([]);
				// 检测走通了 /v1 而草稿还是根路径 → 立即写回草稿，保存时才不落坏 baseUrl（同展开卡片）
				const resolved = resolveFetchedBaseUrl(baseUrl, result.suggestedBaseUrl);
				if (resolved.changed) {
					setBaseUrl(resolved.baseUrl);
					showNotice(t("config.baseUrlAutoNormalized", { url: resolved.baseUrl }));
				}
			} else {
				setFetchError(result.error ?? t("config.fetchModelsFailed"));
			}
		} catch (error) {
			setFetchError(error instanceof Error ? error.message : String(error));
		} finally {
			setFetching(false);
		}
	};

	/**
	 * 把勾选的获取结果追加进模型草稿（跳过已存在的 id）。
	 * 与展开卡片保存勾选流程一致：listing 已带容量的字段直接写入，
	 * 其余空字段再按 pi-ai 目录补全（getModelSpec），仍缺则保持空，不写猜测值。
	 */
	const saveSelectedFetched = async () => {
		if (!fetchedModels || selectedFetchedIds.length === 0) return;
		const baseModels = buildModelsFromFetchedSelection(fetchedModels, selectedFetchedIds, models);
		if (baseModels.length === 0) {
			showNotice(t("config.modelsAlreadyConfigured"));
			return;
		}
		const results = await Promise.all(baseModels.map((m) => desktopApi.projects.getModelSpec(name.trim() || "draft", m.id, m.name).catch(() => null)));
		let filledCount = 0;
		const newModels = baseModels.map((m, i) => {
			const updates = computeModelSpecPatches(m, results[i]);
			if (updates.length === 0) return m;
			filledCount++;
			return applyModelPatches(m, updates);
		});
		setModels((prev) => [...prev, ...newModels]);
		setSelectedFetchedIds([]);
		showNotice(filledCount > 0 ? t("config.modelsSavedWithSpecs", { count: filledCount }) : t("config.modelsSavedFromFetch", { count: newModels.length }), filledCount > 0 ? 3000 : undefined);
	};

	/**
	 * 重置为自适应：显式刷当前草稿 baseUrl/apiKey 的 /models 取实报字段，
	 * 再按 pi-ai 目录模板合并后只覆盖模板有值的字段（语义与 ConfigModal.handleResetModelToAdaptive 一致，
	 * 但作用于页内草稿——未保存的 provider 不落盘）。
	 */
	const handleResetModelToAdaptive = async (index: number) => {
		const model = models[index];
		if (!model) return;
		setResettingModelKey(String(index));
		try {
			let listing: FetchedModel | undefined;
			if (baseUrl.trim() && apiKey.trim()) {
				const result = await desktopApi.config.fetchModels(baseUrl.trim(), apiKey.trim(), api || undefined, userAgent.trim() ? { "User-Agent": userAgent.trim() } : undefined);
				if (result.success && result.models) {
					listing = result.models.find((item) => item.id === model.id);
				}
			}
			const spec = await desktopApi.projects.getModelSpec(name.trim() || "draft", model.id, model.name).catch(() => null);
			const template = mergeAdaptiveModelTemplate(listing, spec, model.id);
			const nextModel = applyAdaptiveTemplateReset(model, template);
			setModels((prev) => prev.map((m, j) => (j === index ? nextModel : m)));
			showNotice(template.matchedId ? t("config.modelResetAdaptiveDone", { model: template.matchedId }) : t("config.modelResetAdaptiveKept"), 3000);
		} finally {
			setResettingModelKey(null);
		}
	};

	/** 模型 ID/名称失焦时按 pi-ai 目录补齐空字段（语义与 ModelsTab.applyModelSpecAutoFill 一致，草稿级）。 */
	const applyModelSpecAutoFill = async (index: number, modelId: string) => {
		const trimmed = modelId.trim();
		if (!trimmed) return;
		const model = models[index];
		if (!model) return;
		const spec = await desktopApi.projects.getModelSpec(name.trim() || "draft", trimmed, model.name);
		const updates = computeModelSpecPatches(model, spec);
		if (updates.length === 0) return;
		setModels((prev) => prev.map((m, j) => (j === index ? applyModelPatches(m, updates) : m)));
		// 命中目录才报「已按目录填充」；未命中时只补了默认思考档位（见 ConfigModal 同名路径）。
		showNotice(spec?.matchedId ? t("config.modelSpecAutoFilled", { model: spec.matchedId }) : t("config.modelSpecUnmatched", { model: trimmed }), 3000);
	};

	/** 手加一行空模型（能力字段留空，由失焦补全/重置为自适应补齐，不写猜测值）。 */
	const handleAddModel = () => {
		setPendingModelFocusKey(String(models.length));
		setModels((prev) => [...prev, { id: "", name: "" }]);
	};

	/** 切换模型批量删除模式；退出或删除后必须清空勾选（行索引随删除漂移）。 */
	const toggleModelBatch = () => {
		if (modelBatchMode) {
			setModelBatchMode(false);
			setSelectedModelIndexes(new Set());
		} else {
			setModelBatchMode(true);
		}
	};
	const clearModelBatch = () => {
		setModelBatchMode(false);
		setSelectedModelIndexes(new Set());
	};

	/**
	 * 测试连接（统一隔离探针）：不落盘正式配置，把当前草稿构建成临时 agent 目录
	 * （models.json + auth.json + PI_CODING_AGENT_DIR）后走真实 pi 探针路径
	 * （见主进程 config:test-provider；与展开卡片同一通道、同一语义）。
	 * 名字未填时用 "draft" 占位：探针只读临时目录，不影响正式配置。
	 */
	const handleTestProvider = async () => {
		if (!baseUrl.trim() || !apiKey.trim()) {
			setTestResult({ success: false, error: t("config.missingBaseUrlApiKey") });
			return;
		}
		const modelId = testModelId.trim() || models[0]?.id || "";
		if (!modelId) {
			setTestResult({ success: false, error: t("config.missingTestModel") });
			return;
		}
		setTesting(true);
		setTestResult(null);
		try {
			const providerName = trimmedName || "draft";
			// 草稿可能尚无模型行：探针按 --model 直测，塞一个最小条目保证 pi 能解析 provider
			const probeProvider = buildProviderConfigFromDraft({
				name: providerName,
				baseUrl,
				api,
				apiKey,
				userAgent,
				compat,
				models: models.length > 0 ? models : [{ id: modelId, name: modelId }],
				// 逐模型 UA 必须带上：配它的场景正是「这个模型要走特殊 UA」，漏了会测出假失败
				modelOverrides,
			});
			const result = await desktopApi.config.testProvider(providerName, modelId, probeProvider, apiKey.trim(), testProxyMode);
			setTestResult(result);
		} catch (error) {
			setTestResult({ success: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			setTesting(false);
		}
	};

	/**
	 * 已保存 provider 的作用域名（edit 模式 = 预填数据里的原名；add 模式 = ""）。
	 * 只用于「读当前状态」（Pi 探测结果）与判断有没有已保存的 provider 上下文；
	 * 页面里改的三份模型设置都先记在页内，确认时由 ConfigModal 按最终名字替换式落盘。
	 */
	const scopedProviderName = props.mode === "edit" ? (props.initial?.name ?? "") : "";
	/** 按行取当前草稿的 modelId（空串 = 还没填 id，依赖它的操作直接不生效）。 */
	const modelIdAt = (index: number) => models[index]?.id ?? "";

	/** 逐模型 UA：页内草稿（与 baseUrl / apiKey 同一层），确认时随 provider 一起落盘。 */
	const updateModelUserAgent = (index: number, value: string) => {
		const modelId = modelIdAt(index);
		if (!modelId) return;
		setModelOverrides((previous) => setModelUserAgentOverride(previous, modelId, value) ?? {});
	};
	const readModelUserAgent = (index: number) => getModelUserAgentOverride(modelOverrides, modelIdAt(index));

	/**
	 * 页内改模型 ID = 重命名同一行：把三份页内副本（UA / 默认档位 / 隐藏）一起搬到新 ID。
	 * 不搬的话确认后这些设置会挂在旧 ID 上，而配置里已经没有那个模型了。
	 */
	const renameRowSettings = (index: number, value: unknown) => {
		const previousId = modelIdAt(index);
		const nextId = typeof value === "string" ? value : "";
		if (!previousId || !nextId || previousId === nextId) return;
		setModelOverrides((previous) => {
			if (!(previousId in previous)) return previous;
			const next = { ...previous };
			next[nextId] = previous[previousId];
			delete next[previousId];
			return next;
		});
		setThinkingDefaults((previous) => {
			if (!(previousId in previous)) return previous;
			const next = { ...previous, [nextId]: previous[previousId] };
			delete next[previousId];
			return next;
		});
		setHiddenModelIds((previous) => previous.map((modelId) => (modelId === previousId ? nextId : modelId)));
	};

	/** 隐藏态回显：读页内副本（确认前不落盘）。 */
	const readModelHidden = (index: number) => {
		const modelId = modelIdAt(index);
		return Boolean(modelId) && hiddenModelIds.includes(modelId);
	};

	/** 隐藏模型：只改页内副本，点保存才写 AppSettings.hiddenModels（与卡片眼睛按钮的差别：卡片是即时）。 */
	const toggleModelHidden = (index: number) => {
		const modelId = modelIdAt(index);
		if (!modelId) return;
		setHiddenModelIds((previous) => (previous.includes(modelId) ? previous.filter((id) => id !== modelId) : [...previous, modelId]));
	};

	/** 每模型默认档位：只改页内副本，点保存才写 settings.json 的 modelThinkingLevels。 */
	const updateModelThinkingDefault = (index: number, level: string) => {
		const modelId = modelIdAt(index);
		if (!modelId) return;
		setThinkingDefaults((previous) => {
			const next = { ...previous };
			const trimmed = level.trim();
			if (trimmed) next[modelId] = trimmed;
			else delete next[modelId];
			return next;
		});
	};
	const readModelThinkingDefault = (index: number) => {
		const modelId = modelIdAt(index);
		return modelId ? (thinkingDefaults[modelId] ?? "") : "";
	};

	/** 统一组装当前页草稿，供页内按钮与宿主标题栏保存共用，避免两条保存路径状态不一致。 */
	const submit = useCallback(() => {
		if (!canConfirm) return false;
		props.onConfirm({
			name: trimmedName,
			baseUrl: baseUrl.trim(),
			api,
			apiKey: apiKey.trim(),
			userAgent: userAgent.trim(),
			compat,
			models,
			modelOverrides,
			// 页内草稿的绝对快照，宿主按最终名字替换式落盘（模型被删掉的设置随之消失）。
			// 宿主没给读取入口（settings 未加载 / 不提供隐藏列表）时不带这两项——不带 = 别动。
			...(props.getModelThinkingLevelDefault ? { modelThinkingLevelDefaults: thinkingDefaults } : {}),
			...(props.hiddenModels ? { hiddenModelIds } : {}),
		});
		return true;
	}, [api, apiKey, baseUrl, canConfirm, compat, hiddenModelIds, modelOverrides, models, props.getModelThinkingLevelDefault, props.hiddenModels, props.onConfirm, thinkingDefaults, trimmedName, userAgent]);

	// 保存按钮在 SettingsModal 标题栏，表单页自身不可直接接收点击；
	// 通过父级注入的入口复用同一份草稿，确保标题栏保存不会绕过页内 state。
	useEffect(() => {
		props.onRequestSave?.(submit);
		return () => props.onRequestSave?.(undefined);
	}, [props.onRequestSave, submit]);

	return (
		<div className="provider-add-page flex h-full min-h-0 min-w-0 flex-col">
			{/* 页面头部：返回按钮 + 标题（对齐设置界面头部形态） */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2.5">
				<Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" onClick={props.onBack} title={t("common.back")} aria-label={t("common.back")}>
					<ArrowLeft size={16} />
				</Button>
				<span className="text-control font-semibold text-foreground">{props.mode === "edit" ? t("config.editProviderDialogTitle") : t("config.addProviderDialogTitle")}</span>
			</div>

			{/* 内容区：配置字段 + 获取模型 + 模型列表（可滚动） */}
			{/* scroll-ok: transient —— 一次性弹窗 / 设置面板：内容随交互生命周期结束，不是随数据增长的列表。 */}
			<div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
				<div className="config-provider-form grid min-w-0 gap-2.5">
					<div className="config-provider-field items-start">
						<Label className="pl-0.5 pt-1.5 text-left text-xs font-medium text-text-secondary">{t("config.addProviderName")}</Label>
						<div className="flex min-w-0 flex-col gap-1">
							<Input
								value={name}
								aria-label={t("config.addProviderName")}
								className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 font-mono text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-fast focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
								placeholder={t("config.providerNamePlaceholder")}
								autoFocus
								onChange={(e) => setName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") submit();
								}}
							/>
							{trimmedName !== "" && !nameValid && <span className="text-micro leading-relaxed text-destructive">{t("config.providerNameRule")}</span>}
							{duplicate && <span className="text-micro leading-relaxed text-destructive">{t("config.providerNameDuplicate")}</span>}
						</div>
					</div>
					{/* 连接字段 + 测试连接 + 兼容性：与模型页展开卡片同一套组件（ProviderConnectionForm） */}
					<ProviderConnectionForm
						baseUrl={baseUrl}
						api={api}
						apiKey={apiKey}
						userAgent={userAgent}
						onChangeBaseUrl={setBaseUrl}
						onChangeApi={setApi}
						onChangeApiKey={setApiKey}
						onChangeUserAgent={setUserAgent}
						compat={compat}
						onChangeCompat={setCompat}
						testModelId={testModelId}
						onChangeTestModelId={setTestModelId}
						testing={testing}
						firstModelId={models[0]?.id}
						onTest={() => void handleTestProvider()}
						onClearTestResult={() => setTestResult(null)}
						testProxyMode={testProxyMode}
						onChangeTestProxyMode={setTestProxyMode}
						testResult={testResult}
						testHint={t((fetchedModels?.length ?? 0) > 0 ? "config.testFailedButModelsFetched" : "config.testConnectionHint")}
					/>
				</div>

				{/* ── 模型配置区：获取 /models + 勾选保存 + 已配置列表（新增/编辑共用） ── */}
				<div className="mt-4 border-t border-border-subtle pt-3">
					<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<span className="text-xs font-semibold text-text-primary">{t("config.modelList")}</span>
							{modelBatchMode && (
								<span className="rounded-full bg-[color:var(--color-accent-soft)] px-2 py-0.5 text-micro font-medium tabular-nums text-[color:var(--color-accent)]">
									{t("config.modelBatchSelected", {
										selected: countSelectedModelIndexes(selectedModelIndexes, models.length),
										total: models.length,
									})}
								</span>
							)}
						</div>
						{/* 与展开卡片同款工具组：手动添加 + 获取模型 + 批量删除/取消 + 删除选中 + 全选/反选/清除 */}
						<div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
							<Button type="button" variant="outline" size="sm" className="h-7" onClick={handleAddModel}>
								{t("config.addModelManual")}
							</Button>
							<Button type="button" variant="outline" size="sm" className="h-7" onClick={() => void handleFetchModels()} disabled={fetching || (!remote && (!baseUrl.trim() || !apiKey.trim()))}>
								<RefreshCw size={13} className={fetching ? "animate-pideck-spin" : ""} aria-hidden="true" />
								{fetching ? t("config.fetchingModels") : t("config.fetchModels")}
							</Button>
							<Button type="button" variant={modelBatchMode ? "secondary" : "outline"} size="sm" className={`h-7${modelBatchMode ? "" : " text-destructive hover:bg-destructive/10 hover:text-destructive"}`} onClick={toggleModelBatch} disabled={models.length === 0}>
								{modelBatchMode ? <X className="size-3.5" aria-hidden="true" /> : <Trash2 className="size-3.5" aria-hidden="true" />}
								{modelBatchMode ? t("common.cancel") : t("common.deleteBatch")}
							</Button>
							{/* 与卡片同款批量工具：全选 / 反选 / 清除选择（只看勾选，不退出批量模式） */}
							{modelBatchMode && (
								<>
									<Button type="button" variant="ghost" size="sm" className="h-7" disabled={models.length === 0} onClick={() => setSelectedModelIndexes(selectAllModelIndexes(models.length))}>
										{t("common.selectAll")}
									</Button>
									<Button type="button" variant="ghost" size="sm" className="h-7" disabled={models.length === 0} onClick={() => setSelectedModelIndexes(invertModelIndexes(selectedModelIndexes, models.length))}>
										{t("common.invertSelection")}
									</Button>
									<Button type="button" variant="ghost" size="sm" className="h-7" disabled={models.length === 0} onClick={() => setSelectedModelIndexes(new Set())}>
										{t("common.clearSelection")}
									</Button>
								</>
							)}
							{modelBatchMode && (
								<Button
									type="button"
									variant="destructive"
									size="sm"
									className="h-7"
									onClick={() => {
										if (countSelectedModelIndexes(selectedModelIndexes, models.length) === 0) return;
										setModels((prev) => removeSelectedModelIndexes(prev, selectedModelIndexes));
										clearModelBatch();
									}}
									disabled={countSelectedModelIndexes(selectedModelIndexes, models.length) === 0}
								>
									<Trash2 className="size-3.5" aria-hidden="true" />
									{t("common.deleteSelected")} ({countSelectedModelIndexes(selectedModelIndexes, models.length)})
								</Button>
							)}
						</div>
					</div>
					{/* 获取结果勾选（拉取成功才显示） */}
					{fetchedModels && fetchedModels.length > 0 && (
						<div className="mb-2 flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-subtle p-2.5">
							<FetchedModelCombobox models={fetchedModels} value={selectedFetchedIds} existingModelIds={models.map((model) => model.id)} onChange={setSelectedFetchedIds} />
							<div className="flex justify-end border-t border-border-subtle pt-2">
								<Button type="button" variant="default" size="sm" disabled={selectedFetchedIds.length === 0} onClick={saveSelectedFetched}>
									{t("config.saveSelectedModels")}
								</Button>
							</div>
						</div>
					)}
					{fetchError && <div className="mb-2 rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-micro leading-relaxed text-danger whitespace-pre-line">{fetchError}</div>}
					{/* 已配置模型列表：与展开卡片同款模型表格（页内草稿管理，确认时随 provider 一起提交） */}
					<ModelsTable
						models={models}
						onUpdateModel={(index, field, value) => {
							// 页内改模型 ID = 重命名同一行：先把三份页内副本搬到新 ID（见 renameRowSettings）
							if (field === "id") renameRowSettings(index, value);
							setModels((prev) => prev.map((m, j) => (j === index ? { ...m, [field]: value } : m)));
						}}
						onUpdateModelThinkingLevel={(index, level, enabled) => {
							// 思考档位勾选写入模型草稿 thinkingLevelMap/reasoning，并同步 compat.supportsReasoningEffort
							// （与 ConfigModal 的 handleUpdateModelThinkingLevel 语义一致）
							setModels((prev) =>
								prev.map((m, j) => {
									if (j !== index) return m;
									const nextMap = withModelThinkingLevelEnabled(m.thinkingLevelMap, level, enabled);
									const next = { ...m, reasoning: enabled ? true : m.reasoning };
									if (nextMap) next.thinkingLevelMap = nextMap;
									else delete next.thinkingLevelMap;
									return next;
								}),
							);
							if (enabled) {
								setCompat((prev) => ({ ...prev, supportsReasoningEffort: true }));
							}
						}}
						onDeleteModel={(index) => {
							clearModelBatch();
							setModels((prev) => prev.filter((_, j) => j !== index));
						}}
						// 与卡片对齐：上移/下移直接改页内草稿顺序（草稿顺序就是保存后的模型顺序）
						onMoveModel={(index, direction) => {
							setModels((prev) => {
								const targetIndex = direction === "up" ? index - 1 : index + 1;
								if (targetIndex < 0 || targetIndex >= prev.length) return prev;
								const next = [...prev];
								const [moved] = next.splice(index, 1);
								next.splice(targetIndex, 0, moved);
								return next;
							});
						}}
						// 逐模型设置一律按 modelId（不是行下标）定位——页内模型草稿可增删/重排，
						// 下标与已保存数组不再对应，按下标会配错模型。
						onHideModel={props.hiddenModels ? toggleModelHidden : undefined}
						getModelHidden={props.hiddenModels ? readModelHidden : undefined}
						onUpdateModelUserAgent={updateModelUserAgent}
						getModelUserAgentOverride={readModelUserAgent}
						onUpdateModelThinkingLevelDefault={props.getModelThinkingLevelDefault ? updateModelThinkingDefault : undefined}
						getModelThinkingLevelDefault={props.getModelThinkingLevelDefault ? readModelThinkingDefault : undefined}
						// Pi 探测只有已保存的 provider 才问得到；新增页显示「保存后由 Pi 探测」
						getModelAvailableThinkingLevels={props.getModelAvailableThinkingLevels && scopedProviderName ? (index) => props.getModelAvailableThinkingLevels!(scopedProviderName, modelIdAt(index)) : undefined}
						thinkingLevelsProbePending={scopedProviderName === ""}
						onResetModel={handleResetModelToAdaptive}
						resettingModelKey={resettingModelKey}
						onBlurAutoFill={applyModelSpecAutoFill}
						// 页内核验目录建议（draft 名未落盘，仍可按模型 id 跨 provider 命中）：
						// 中转 provider 的 Claude 新模型正是靠这里提示 forceAdaptiveThinking/supportsTemperature。
						loadModelCompatSuggestion={async (index) => {
							const model = models[index];
							const modelId = model?.id?.trim();
							if (!modelId) return null;
							const spec = await desktopApi.projects.getModelSpec(name.trim() || "draft", modelId, model.name).catch(() => null);
							const flags = pickManagedCompatFlags(spec?.compat);
							return Object.keys(flags).length > 0 ? { matchedId: spec?.matchedId, flags } : null;
						}}
						batchMode={modelBatchMode}
						selectedIndexes={selectedModelIndexes}
						onToggleSelectIndex={(index) => setSelectedModelIndexes((current) => toggleModelIndex(current, index))}
						onToggleAll={(total) => setSelectedModelIndexes((current) => toggleAllModelIndexes(current, total))}
						focusModelKey={pendingModelFocusKey}
						onFocusHandled={() => setPendingModelFocusKey(null)}
					/>
					<p className="mt-1.5 text-micro leading-relaxed text-text-tertiary">{t("config.providerDialogModelsHint")}</p>
				</div>
			</div>

			{/* 底部操作：返回（取消）+ 添加/保存 */}
			<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
				<Button type="button" variant="outline" size="sm" onClick={props.onBack}>
					{t("common.cancel")}
				</Button>
				<Button type="button" variant="default" size="sm" disabled={!canConfirm} onClick={submit}>
					{props.mode === "edit" ? t("common.save") : t("config.addProviderConfirm")}
				</Button>
			</div>
		</div>
	);
}
