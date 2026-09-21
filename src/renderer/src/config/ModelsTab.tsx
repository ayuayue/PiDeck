import { Button } from "../components/ui-shadcn/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Copy, Eye, EyeOff, ExternalLink, GripVertical, SquarePen, Trash2, X } from "lucide-react";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import type { ModelItem, ModelsFile, ProviderConfig } from "./configTypes";
import { openDocsInSystemBrowser } from "./ConfigShared";
import { getHeaderValue, setHeaderValue } from "./providerHeaders";
import { buildModelsFromFetchedSelection } from "./modelsUtils";
// 排序键收敛到 shared：与模型下拉列表 / 主进程写入保持同一顺序。
import { compareModelRows } from "../../../shared/modelOrder";
import { countSelectedModelIndexes, toggleAllModelIndexes, toggleModelIndex } from "./modelBatchSelection";
import { FetchedModelCombobox } from "./FetchedModelCombobox";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Label } from "../components/ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui-shadcn/select";
import { showNotice } from "../utils/notice";
import { applyModelPatches, computeModelSpecPatches, looksDeepSeekBacked } from "../utils/modelSpecAutoFill";
import type { FetchedModel, ConfigProxyMode } from "../../../shared/types/fetchedModel";
import { ProviderMigrationButton } from "./ProviderMigrationButton";
import { ProviderUsageInline } from "../components/app/ProviderUsageInline";
import { UsageQueryEntryButton } from "../components/app/UsageQueryEntryButton";
import { ProviderConnectionForm } from "./ProviderConnectionForm";
import { AddProviderDialog } from "./AddProviderDialog";
import type { ProviderDialogInitial } from "./AddProviderDialog";
import type { AddProviderDraft } from "./addProviderDraft";
import { splitVisibleAndHiddenProviders } from "./providerVisibility";
import { applyProviderOrder } from "../utils/providerOrder";
import { useProviderReorder } from "../hooks/useProviderReorder";
import { ModelsTable } from "./ModelsTable";
import { ModelsExportPanel } from "./ModelsExportPanel";
import { ModelsImportPanel } from "./ModelsImportPanel";
import type { MutableRefObject } from "react";

/** 把现有 provider 配置转成编辑弹窗的预填值（名字/字段/模型列表）。 */
function providerDialogInitial(provider: ProviderConfig | undefined, name: string): ProviderDialogInitial | undefined {
	if (!provider) return undefined;
	return {
		name,
		baseUrl: provider.baseUrl ?? "",
		api: provider.api ?? "",
		apiKey: provider.apiKey ?? "",
		userAgent: getHeaderValue(provider.headers, "User-Agent"),
		compat: provider.compat,
		models: provider.models,
	};
}

const KNOWN_PROVIDER_FIELDS = new Set(["baseUrl", "api", "apiKey", "headers", "authHeader", "models", "modelOverrides", "compat", "oauth"]);

export function ModelsTab(props: {
	data: ModelsFile;
	expandedProvider: string | null;
	/** 深链聚焦的供应商：展开由父级处理，这里负责滚动到卡片并短暂高亮。 */
	focusProvider?: string;
	/** 打开用量探针配置弹窗（卡头用量查询入口按钮 / 展开区明细失败态跳转用）。 */
	onOpenUsageProbeDialog: (providerName: string) => void;
	/** 新增供应商弹窗开关（由父级持有，确认/取消回调走 props）。 */
	addingProvider: boolean;
	/** 新增/编辑供应商页向设置窗口标题栏暴露的保存入口。 */
	providerPageSaveRef: MutableRefObject<(() => void) | undefined>;
	/** 编辑弹窗目标 provider key（修改名称按钮打开；null = 无编辑弹窗）。 */
	editingProvider: string | null;
	/** 用户隐藏的供应商 key 列表（模型页主列表过滤 + 底部已隐藏区展示）。 */
	hiddenProviders: string[];
	/** 切换供应商隐藏状态（父级持久化到 AppSettings.hiddenProviders）。 */
	onToggleHiddenProvider: (name: string) => void;
	/** 供应商卡片自定义顺序（父级持有并持久化到 AppSettings.providerOrder）。 */
	providerOrder?: string[];
	/** 排序作用域：与认证页共享的并集顺序（由父级用 models.json + auth.json 算出）。 */
	providerOrderScope?: string[];
	/** 卡片重排回调：拖拽/上移下移算出新的完整顺序后交给父级持久化。 */
	onReorderProviders?: (nextOrder: string[]) => void;
	/** 清空自定义顺序（列表上方的「恢复默认顺序」）。 */
	onResetProviders?: () => void;
	/** 用户隐藏的模型标识列表（格式："provider/modelId"）。 */
	hiddenModels?: string[];
	/** 切换单个模型的隐藏状态（父级持久化到 AppSettings.hiddenModels）。 */
	onToggleHiddenModel?: (provider: string, modelId: string) => void;
	fetchingProvider: string | null;
	fetchedModels: Record<string, FetchedModel[]>;
	fetchModelsErrorByProvider: Record<string, string | undefined>;
	testingProvider: string | null;
	testResult: {
		providerName: string;
		success: boolean;
		model?: string;
		snippet?: string;
		tokens?: { input?: number; output?: number };
		latencyMs?: number;
		error?: string;
		requestUrl?: string;
		requestBody?: string;
	} | null;
	testModelIdByProvider: Record<string, string>;
	/** 每个 provider 的测试/拉取代理选择：follow=跟随全局，pi/desktop=强制走对应代理，off=强制直连。 */
	testProxyModeByProvider: Record<string, ConfigProxyMode>;
	saving: boolean;
	onToggleProvider: (name: string) => void;
	onStartAddProvider: () => void;
	onCancelAddProvider: () => void;
	/** 弹窗确认：携带完整草稿（名字 + 服务商字段），父级一步写入 modelsData。 */
	onConfirmAddProvider: (draft: AddProviderDraft) => void;
	onStartEditProvider: (name: string) => void;
	onCancelEditProvider: () => void;
	/** 编辑弹窗确认：旧名 + 完整草稿（名字可改，走 rename 语义），父级写回 modelsData。 */
	onConfirmEditProvider: (oldName: string, draft: AddProviderDraft) => void;
	onDeleteProvider: (name: string) => void;
	onDuplicateProvider: (name: string) => void;
	onDeleteProviders: (names: string[]) => void;
	onAddModel: (providerName: string) => void;
	onUpdateModel: (providerName: string, index: number, field: string, value: unknown) => void;
	onUpdateModelThinkingLevel: (providerName: string, index: number, key: "xhigh" | "max", value: "" | "xhigh" | "max") => void;
	/** 逐模型 User-Agent 覆盖（落到 provider.modelOverrides），可选。 */
	onUpdateModelUserAgent?: (providerName: string, index: number, value: string) => void;
	/** 读取某模型当前的 UA 覆盖值（可选；与上一个回调成对出现才渲染该列）。 */
	getModelUserAgentOverride?: (providerName: string, index: number) => string;
	onDeleteModel: (providerName: string, index: number) => void;
	onDeleteModels: (providerName: string, indexes: number[]) => void;
	/** 重置为自适应：显式刷新 endpoint /models 后按模板清空并重填能力字段。 */
	onResetModel: (providerName: string, index: number) => void;
	/** 正在重置的模型行 key（`${providerName}-${index}`），null 表示无。 */
	resettingModelKey: string | null;
	onFetchModels: (providerName: string) => void;
	onTestProvider: (providerName: string) => void;
	onChangeTestModelId: (providerName: string, modelId: string) => void;
	onChangeTestProxyMode: (providerName: string, mode: ConfigProxyMode) => void;
	onClearTestResult: () => void;
	/** 导入面板把合并结果写回未保存草稿（父级 ConfigModal 处理，不直接落盘）。 */
	onApplyModelsTransfer: (next: ModelsFile) => void;
	onSave: () => void;
	onChangeProvider: (name: string, field: string, value: unknown) => void;
}) {
	const { data, expandedProvider, saving } = props;
	const providerNames = Object.keys(data.providers);
	// 隐藏开关：主列表只显示未隐藏项，隐藏项进页面底部「已隐藏」折叠区（设置页隐藏开关）
	// 自定义排序只作用于展示：先按用户拖拽/上移下移结果重排完整列表，再切分可见/隐藏。
	// 用完整列表而非仅可见列表：隐藏区也遵循同一顺序，恢复显示时不会突然跳到列表最前。
	const orderedProviderNames = applyProviderOrder(providerNames, props.providerOrder);
	const { visible: visibleProviderNames, hidden: hiddenProviderNames } = splitVisibleAndHiddenProviders(orderedProviderNames, props.hiddenProviders ?? []);
	// 底部已隐藏折叠区展开状态（默认收起，避免一屏多折叠区）
	const [hiddenSectionOpen, setHiddenSectionOpen] = useState(false);
	// 自动获取后的待保存选择：与 provider 分开存储，避免多个 provider 同时展开时选中状态互相污染。
	const [selectedFetchedModelIds, setSelectedFetchedModelIds] = useState<Record<string, string[]>>({});
	// 计费弹框状态（costDialogKey/tierEditor）已内聚到共享组件 ModelsTable，这里不再持有。

	/**
	 * 模型 ID/名称失焦时按端点元数据、当前 Pi 目录和内置目录补齐空字段。
	 * 未命中就保持空，手填值不覆盖；匹配结果直接填进对应输入框，不再展示来源。
	 */
	const applyModelSpecAutoFill = async (providerName: string, index: number, modelId: string) => {
		const trimmed = modelId.trim();
		if (!trimmed) return;
		const model = data.providers[providerName]?.models[index];
		if (!model) return;
		const spec = await desktopApi.projects.getModelSpec(providerName, trimmed, model.name);
		const updates = computeModelSpecPatches(model, spec);
		for (const [field, value] of updates) {
			props.onUpdateModel(providerName, index, field, value);
		}
		if (updates.length > 0) {
			showNotice(
				t("config.modelSpecAutoFilled", {
					model: spec?.matchedId ?? trimmed,
				}),
				3000,
			);
		}
	};

	const [pendingModelFocusKey, setPendingModelFocusKey] = useState<string | null>(null);
	const [showGuide, setShowGuide] = useState(false);
	const [batchMode, setBatchMode] = useState(false);
	const [selectedProviders, setSelectedProviders] = useState<Set<string>>(() => new Set());
	// 批量模式当前动作；null = 未选择（进入批量管理时不预选，强制用户显式选择）
	const [batchAction, setBatchAction] = useState<"delete" | "export" | null>(null);
	// 批量导出：非空时列表区被面板独占（与 AddProviderDialog 同一模式）。
	const [transferView, setTransferView] = useState<{ kind: "export"; ids: string[] } | { kind: "import" } | null>(null);
	const exitBatchMode = () => {
		setBatchMode(false);
		setSelectedProviders(new Set());
		setBatchAction(null);
	};
	const handleBatchExecute = () => {
		if (!batchAction || selectedProviders.size === 0) return;
		if (batchAction === "delete") {
			// 确认弹窗由 ConfigModal.handleDeleteProviders 承载（common.deleteBatchConfirm），此处只发起
			props.onDeleteProviders([...selectedProviders]);
		} else {
			setTransferView({ kind: "export", ids: [...selectedProviders] });
		}
		exitBatchMode();
	};
	// 模型批量删除只作用于当前展开的 provider，避免不同 provider 的同一行索引互相污染。
	const [modelBatchProvider, setModelBatchProvider] = useState<string | null>(null);
	const [selectedModelIndexes, setSelectedModelIndexes] = useState<Set<number>>(() => new Set());
	const setSelectedFetchedModels = (providerName: string, modelIds: string[]) => {
		setSelectedFetchedModelIds((current) => ({
			...current,
			[providerName]: modelIds,
		}));
	};
	const getModelInputKey = (providerName: string, index: number) => `${providerName}\u0000${index}`;
	const clearModelBatch = () => {
		setModelBatchProvider(null);
		setSelectedModelIndexes(new Set<number>());
	};
	const toggleModelBatch = (providerName: string) => {
		if (modelBatchProvider === providerName) {
			clearModelBatch();
			return;
		}
		setModelBatchProvider(providerName);
		setSelectedModelIndexes(new Set<number>());
	};
	const toggleAllModels = (total: number) => {
		setSelectedModelIndexes((current) => toggleAllModelIndexes(current, total));
	};

	// 切换 provider 时不保留上一个表格的索引选择，避免删除确认中的索引指向另一家 provider。
	useEffect(() => {
		setModelBatchProvider(null);
		setSelectedModelIndexes(new Set());
	}, [expandedProvider]);

	// 深链聚焦：滚动到目标供应商卡片并短暂高亮（展开由父级 ConfigModalContent 处理）。
	const providerCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

	/**
	 * 拖拽/上移下移的统一出口：算出新的完整顺序交给父级持久化。
	 * 顺序无变化时（拖回原位）也照常上报，由主进程 SettingsStore 的「值未变则剔除」拦下写盘，
	 * 避免这里再维护一份比较逻辑。
	 */
	const reorderProviders = useCallback(
		(nextOrder: string[]) => {
			props.onReorderProviders?.(nextOrder);
		},
		[props.onReorderProviders],
	);

	// 拖动与上移/下移的状态机（落点判定、拖动中半透明、插入指示线、边界禁用）内聚在共享 hook，
	// DSH 模型页的供应商卡片复用同一份，避免两页规则漂移。
	// 拖拽的作用域是「模型 + 认证」两页的并集（providerOrderScope）：认证页独有的供应商也要参与
	// 同一份顺序，否则在认证页排一次会在并集里丢掉它们，模型页的顺序跟着回到默认。
	const providerReorder = useProviderReorder({ names: props.providerOrderScope?.length ? props.providerOrderScope : orderedProviderNames, visibleNames: visibleProviderNames, onReorder: reorderProviders });
	const [highlightProvider, setHighlightProvider] = useState<string | null>(null);
	useEffect(() => {
		if (!props.focusProvider) return;
		setHighlightProvider(props.focusProvider);
		const frameId = window.requestAnimationFrame(() => {
			providerCardRefs.current[props.focusProvider!]?.scrollIntoView({ block: "start", behavior: "smooth" });
		});
		const timer = window.setTimeout(() => setHighlightProvider(null), 2400);
		return () => {
			window.cancelAnimationFrame(frameId);
			window.clearTimeout(timer);
		};
	}, [props.focusProvider]);
	const getCompat = (providerName: string) => {
		const provider = data.providers[providerName];
		const saved = provider.compat ?? {};
		const savedReasoningContent = saved.requiresReasoningContentOnAssistantMessages;
		// 未落盘（undefined）= 用户未表态：与编辑页/保存时归一化同一判定预置勾选，
		// 否则卡片上看着没勾、保存后文件里却是 true。已落盘的值（含 false）原样回显。
		return {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			requiresReasoningContentOnAssistantMessages: savedReasoningContent !== undefined ? savedReasoningContent === true : looksDeepSeekBacked(provider, providerName),
			...saved,
		};
	};

	return (
		<div>
			{/* 列表态：顶部按钮 + 指南 + 卡片列表；新增/编辑时整区切换为配置表单页（非弹窗） */}
			{!props.addingProvider && !props.editingProvider && !transferView && (
				<>
					<div className="mb-3 flex items-center justify-between gap-3">
						<span className="font-mono text-xs tabular-nums text-text-tertiary">{t("config.count.providers", { count: visibleProviderNames.length })}</span>
						<div className="flex min-w-0 items-center gap-1.5">
							{!batchMode && (
								<>
									<Button size="sm" variant="outline" onClick={props.onStartAddProvider} disabled={saving}>
										{t("config.addProvider")}
									</Button>
									<Button size="sm" variant="outline" onClick={() => setTransferView({ kind: "import" })} disabled={saving}>
										{t("config.models.transfer.importButton")}
									</Button>
									<Button size="sm" variant="outline" onClick={() => setShowGuide(!showGuide)} disabled={saving}>
										{t("config.providerGuide")}
									</Button>
								</>
							)}
							<Button size="sm" variant="outline" onClick={() => (batchMode ? exitBatchMode() : setBatchMode(true))} disabled={saving || visibleProviderNames.length === 0}>
								{batchMode ? t("common.cancel") : t("common.batchManage")}
							</Button>
							{batchMode && (
								<>
									<Select value={batchAction ?? undefined} onValueChange={(next) => setBatchAction(next === "delete" || next === "export" ? next : null)}>
										<SelectTrigger aria-label={t("config.models.batchActionLabel")} className="h-8 w-32">
											<SelectValue placeholder={t("config.models.batchActionLabel")} />
										</SelectTrigger>
										<SelectContent position="popper">
											<SelectItem value="delete">{t("config.models.batchAction.delete")}</SelectItem>
											<SelectItem value="export">{t("config.models.batchAction.export")}</SelectItem>
										</SelectContent>
									</Select>
									<Button size="sm" variant="outline" disabled={!batchAction || selectedProviders.size === 0} onClick={handleBatchExecute}>
										{t("config.models.batchExecute")}
									</Button>
								</>
							)}
						</div>
					</div>

					{/* 排序说明：顺序是跨页共用的偏好（AppSettings.providerOrder），
					    不写在这里用户只能靠试——拖了之后模型选择器也跟着变会让人困惑。 */}
					{visibleProviderNames.length > 1 && (
						<div className="mb-2.5 flex items-start gap-2 text-[11px] leading-relaxed text-text-tertiary">
							<ArrowUpDown size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
							<span className="min-w-0 flex-1">{t("config.providerOrderHint")}</span>
							{(props.providerOrder?.length ?? 0) > 0 && props.onResetProviders && (
								<Button variant="ghost" size="sm" className="h-5 shrink-0 px-1.5 text-[11px] font-normal text-text-tertiary hover:text-text-primary" onClick={props.onResetProviders} disabled={saving}>
									{t("config.providerOrderReset")}
								</Button>
							)}
						</div>
					)}

					{/* Provider 配置指南 */}
					{showGuide && (
						<div className="mb-4 rounded-md border border-border-subtle bg-bg-subtle p-4">
							<div className="mb-2.5 flex items-center justify-between">
								<strong className="text-sm text-text-primary">{t("config.providerGuideTitle")}</strong>
								<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setShowGuide(false)}>
									<X size={14} />
								</Button>
							</div>
							<div className="text-xs leading-relaxed text-text-secondary">
								<p>{t("config.providerGuideIntro")}</p>

								<strong className="mt-3.5 mb-1.5 block text-sm text-text-primary">{t("config.providerGuideApis")}</strong>
								<div className="grid grid-cols-3 gap-1.5">
									<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
										<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">openai-completions</code>
										<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc1")}</span>
									</div>
									<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
										<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">anthropic-messages</code>
										<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc2")}</span>
									</div>
									<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
										<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">openai-responses</code>
										<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc3")}</span>
									</div>
									<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
										<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">openai-codex-responses</code>
										<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc5")}</span>
									</div>
									<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
										<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">google-generative-ai</code>
										<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc4")}</span>
									</div>
									<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
										<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">mistral-conversations</code>
										<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc6")}</span>
									</div>
								</div>

								<strong className="mt-3.5 mb-1.5 block text-sm text-text-primary">{t("config.providerGuideCompat")}</strong>
								<table className="w-full border-collapse text-xs">
									<tbody>
										<tr>
											<td className="w-[180px] border-b border-border-subtle px-2.5 py-1.5 align-top">
												<code className="rounded-[4px] bg-[color:color-mix(in_srgb,var(--color-accent)_5%,transparent)] px-1.5 py-px font-mono text-[11px] text-[color:var(--color-accent)]">supportsDeveloperRole</code>
											</td>
											<td className="border-b border-border-subtle px-2.5 py-1.5 align-top">{t("config.providerGuideCompatDevRole")}</td>
										</tr>
										<tr>
											<td className="w-[180px] border-b border-border-subtle px-2.5 py-1.5 align-top">
												<code className="rounded-[4px] bg-[color:color-mix(in_srgb,var(--color-accent)_5%,transparent)] px-1.5 py-px font-mono text-[11px] text-[color:var(--color-accent)]">supportsReasoningEffort</code>
											</td>
											<td className="border-b border-border-subtle px-2.5 py-1.5 align-top">{t("config.providerGuideCompatReasoning")}</td>
										</tr>
										<tr>
											<td className="w-[180px] border-b border-border-subtle px-2.5 py-1.5 align-top">
												<code className="break-all rounded-[4px] bg-[color:color-mix(in_srgb,var(--color-accent)_5%,transparent)] px-1.5 py-px font-mono text-[11px] text-[color:var(--color-accent)]">requiresReasoningContentOnAssistantMessages</code>
											</td>
											<td className="border-b border-border-subtle px-2.5 py-1.5 align-top">{t("config.providerGuideCompatReasoningContent")}</td>
										</tr>
									</tbody>
								</table>

								<strong className="mt-3.5 mb-1.5 block text-sm text-text-primary">{t("config.providerGuideTroubleshoot")}</strong>
								<ul className="my-1.5 list-disc pl-5 text-xs text-text-secondary">
									<li className="mb-1.5 leading-relaxed">{t("config.providerGuideTip1")}</li>
									<li className="mb-1.5 leading-relaxed">{t("config.providerGuideTip2")}</li>
									<li className="mb-1.5 leading-relaxed">{t("config.providerGuideTip3")}</li>
									<li className="mb-1.5 leading-relaxed">{t("config.providerGuideTip4")}</li>
								</ul>

								<p className="mt-3 border-t border-border-subtle pt-2.5 text-text-tertiary">
									{t("config.providerGuideNote")}{" "}
									<a href="https://pi.dev/docs/latest/models" onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/models")} className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline">
										{t("config.modelsDocs")} <ExternalLink size={12} />
									</a>
									{" · "}
									<a href="https://pi.dev/docs/latest/providers" onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/providers")} className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline">
										{t("config.providersDocs")} <ExternalLink size={12} />
									</a>
								</p>
							</div>
						</div>
					)}

					<div className="flex flex-col gap-2.5">
						{visibleProviderNames.map((name) => {
							const provider = data.providers[name];
							const isExpanded = expandedProvider === name;
							const isModelBatchMode = modelBatchProvider === name;
							const selectedModelCount = countSelectedModelIndexes(selectedModelIndexes, provider.models.length);
							const userAgentValue = getHeaderValue(provider.headers, "User-Agent");
							const providerAdvancedFields = Object.keys(provider).filter((key) => !KNOWN_PROVIDER_FIELDS.has(key));
							const providerComplexFields = ["headers", "authHeader", "compat", "modelOverrides", "oauth"].filter((key) => provider[key] !== undefined);
							return (
								<div
									key={name}
									ref={(element) => {
										providerCardRefs.current[name] = element;
										providerReorder.registerCard(name, element);
									}}
									className={`config-provider-card relative overflow-hidden rounded-lg border border-border-subtle bg-bg-panel transition-[border-color,box-shadow,background-color,opacity] duration-150${providerReorder.draggingName === name ? " opacity-50" : ""}${isExpanded ? " border-[color-mix(in_srgb,var(--color-accent)_32%,var(--color-border-subtle))] shadow-[var(--shadow-border)] overflow-visible" : ""}${highlightProvider === name ? " ring-2 ring-[color:var(--color-accent)]" : ""}`}
									{...providerReorder.cardProps(name)}
								>
									{/* 拖拽插入指示线：贴卡片内缘（卡片是 overflow-hidden，放到卡片外会被剪掉） */}
									{providerReorder.dropTarget?.name === name && <span className={`absolute ${providerReorder.dropTarget.position === "before" ? "top-0" : "bottom-0"} right-0 left-0 z-10 h-0.5 bg-[color:var(--color-accent)]`} />}
									{/* 整行点击展开/收起；右侧操作区 stopPropagation，避免点复制/删除/用量配置时误折叠。 */}
									<div data-provider-head="" className="group flex cursor-pointer items-center justify-between px-3.5 py-2 transition-colors duration-150 hover:bg-bg-hover" onClick={() => props.onToggleProvider(name)}>
										{batchMode && (
											<Label className="mr-2.5 inline-flex size-4 shrink-0 items-center justify-center" onClick={(e) => e.stopPropagation()}>
												<Checkbox
													checked={selectedProviders.has(name)}
													onClick={(e) => e.stopPropagation()}
													onCheckedChange={() => {
														setSelectedProviders((prev) => {
															const next = new Set(prev);
															if (next.has(name)) next.delete(name);
															else next.add(name);
															return next;
														});
													}}
												/>
											</Label>
										)}
										<div className="flex min-w-0 flex-1 items-center gap-2.5">
											{/* 拖拽手柄：draggable 落在按钮上（Button 直接透传原生属性），只有按住手柄才能拖动，避免整行点击展开被拖拽抢掉 */}
											<Button variant="ghost" size="icon-sm" className="size-6 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" title={t("config.dragProvider")} {...providerReorder.gripProps(name)} onClick={(event) => event.stopPropagation()}>
												<GripVertical size={14} />
											</Button>
											{/* 上移/下移：悬停浮现（键盘聚焦也可见），到顶/到底禁用；disabled 带 pointer-events-none，不会抢整行点击 */}
											<div className="flex shrink-0 items-center">
												<Button
													variant="ghost"
													size="icon-sm"
													className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
													disabled={!providerReorder.canMove(name, -1)}
													title={t("config.moveProviderUp")}
													onClick={(event) => {
														event.stopPropagation();
														providerReorder.moveBy(name, -1);
													}}
												>
													<ArrowUp size={13} />
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
													disabled={!providerReorder.canMove(name, 1)}
													title={t("config.moveProviderDown")}
													onClick={(event) => {
														event.stopPropagation();
														providerReorder.moveBy(name, 1);
													}}
												>
													<ArrowDown size={13} />
												</Button>
											</div>
											<span className="min-w-0 truncate text-control font-semibold text-text-primary">{name}</span>
											{/* 折叠态把「N 模型」和用量收进标题行，避免底部再占一条 h-9 空行。用量拦截点击，避免点刷新时误折叠卡片。 */}
											<span className="shrink-0 rounded-full border border-border-subtle px-1.5 py-px font-mono text-micro tabular-nums text-muted-foreground">{t("config.count.models", { count: provider.models.length })}</span>
											<span onClick={(event) => event.stopPropagation()}>
												<ProviderUsageInline provider={name} variant="card" />
											</span>
										</div>

										<div className="flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
											<Button
												variant="ghost"
												size="icon-sm"
												className="size-7"
												onClick={(e) => {
													e.stopPropagation();
													props.onStartEditProvider(name);
												}}
												title={t("config.editProvider")}
											>
												<SquarePen size={14} />
											</Button>
											{/* 隐藏开关：眼睛按钮切换隐藏，隐藏后卡片移入底部「已隐藏」折叠区（模型选择器同步不显示） */}
											<Button
												variant="ghost"
												size="icon-sm"
												className="size-7"
												onClick={(e) => {
													e.stopPropagation();
													props.onToggleHiddenProvider(name);
												}}
												title={t("config.hideProvider")}
											>
												<Eye size={14} />
											</Button>
											<ProviderMigrationButton direction="pi-to-dsh" provider={name} />
											{/* 用量查询配置（内置支持的供应商零配置自动生效，不渲染；其余可配通用/New API 模板） */}
											<UsageQueryEntryButton provider={name} onOpen={() => props.onOpenUsageProbeDialog(name)} />
											<Button
												variant="ghost"
												size="icon-sm"
												className="size-7"
												onClick={(e) => {
													e.stopPropagation();
													props.onDuplicateProvider(name);
												}}
												title={t("config.duplicateProvider")}
											>
												<Copy size={14} />
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
												onClick={(e) => {
													e.stopPropagation();
													props.onDeleteProvider(name);
												}}
												title={t("config.deleteProvider")}
											>
												<Trash2 size={14} />
											</Button>
											{/* 显式展开按钮：与整行点击共用 onToggleProvider；按钮自身 stopPropagation 避免冒泡双触发 */}
											<Button
												variant="ghost"
												size="icon-sm"
												className="size-7"
												onClick={(e) => {
													e.stopPropagation();
													props.onToggleProvider(name);
												}}
												title={isExpanded ? t("config.providerCollapse") : t("config.providerExpand")}
											>
												{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
											</Button>
										</div>
									</div>

									{isExpanded && (
										<div className="config-provider-body border-t border-border-subtle bg-bg-muted pt-3">
											<div className="config-provider-form mx-4 my-3.5 grid gap-2.5 rounded-lg border border-border-subtle bg-bg-panel p-3.5">
												<ProviderConnectionForm
													baseUrl={provider.baseUrl ?? ""}
													api={provider.api ?? ""}
													apiKey={provider.apiKey ?? ""}
													userAgent={userAgentValue}
													onChangeBaseUrl={(value) => props.onChangeProvider(name, "baseUrl", value)}
													onChangeApi={(value) => props.onChangeProvider(name, "api", value)}
													onChangeApiKey={(value) => props.onChangeProvider(name, "apiKey", value)}
													onChangeUserAgent={(value) => props.onChangeProvider(name, "headers", setHeaderValue(provider.headers, "User-Agent", value))}
													compat={getCompat(name)}
													onChangeCompat={(next) => props.onChangeProvider(name, "compat", next)}
													testModelId={props.testModelIdByProvider[name] ?? ""}
													onChangeTestModelId={(value) => props.onChangeTestModelId(name, value)}
													testing={props.testingProvider === name}
													firstModelId={provider.models[0]?.id}
													onTest={() => props.onTestProvider(name)}
													onClearTestResult={props.onClearTestResult}
													testProxyMode={props.testProxyModeByProvider[name] ?? "follow"}
													onChangeTestProxyMode={(mode) => props.onChangeTestProxyMode(name, mode)}
													testResult={props.testResult && props.testResult.providerName === name ? props.testResult : null}
													testHint={t((props.fetchedModels[name]?.length ?? 0) > 0 ? "config.testFailedButModelsFetched" : "config.testConnectionHint")}
													advancedHint={
														(providerComplexFields.length > 0 || providerAdvancedFields.length > 0) && (
															<div className="mt-1.5 mb-2.5 flex items-start gap-2.5 rounded-md border border-border-subtle bg-bg-muted px-3 py-2 text-text-secondary">
																<strong className="min-w-[100px] shrink-0 whitespace-nowrap text-[11px] font-semibold text-text-primary">{t("config.advancedPreservedTitle")}</strong>
																<span>
																	{t("config.advancedPreservedProvider", {
																		fields: [...providerComplexFields, ...providerAdvancedFields].join(", "),
																	})}{" "}
																	<a href="https://pi.dev/docs/latest/models" onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/models")} className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline">
																		pi {t("config.docsModels")}
																	</a>
																	{" / "}
																	<a href="https://pi.dev/docs/latest/custom-provider" onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/custom-provider")} className="font-medium text-[color:var(--color-accent)] no-underline hover:underline">
																		{t("config.docsCustomProvider")}
																	</a>
																</span>
															</div>
														)
													}
												/>
											</div>

											<div className="config-models-section">
												<div className="config-models-header flex-wrap gap-2">
													<div className="flex min-w-0 flex-wrap items-center gap-2">
														<span>{t("config.modelList")}</span>
														{isModelBatchMode && (
															<span className="rounded-full bg-[color:var(--color-accent-soft)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[color:var(--color-accent)]">
																{t("config.modelBatchSelected", {
																	selected: selectedModelCount,
																	total: provider.models.length,
																})}
															</span>
														)}
													</div>
													<div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
														<Button variant="outline" size="sm" onClick={() => props.onFetchModels(name)} disabled={props.fetchingProvider === name}>
															{props.fetchingProvider === name ? t("config.fetchingModels") : t("config.fetchModels")}
														</Button>
														<Button
															variant="outline"
															size="sm"
															onClick={() => {
																setPendingModelFocusKey(getModelInputKey(name, provider.models.length));
																props.onAddModel(name);
															}}
														>
															{t("config.addModelManual")}
														</Button>
														<Button variant={isModelBatchMode ? "secondary" : "outline"} size="sm" className={!isModelBatchMode ? "text-destructive hover:bg-destructive/10 hover:text-destructive" : undefined} onClick={() => toggleModelBatch(name)} disabled={saving || provider.models.length === 0}>
															{isModelBatchMode ? <X className="size-3.5" aria-hidden="true" /> : <Trash2 className="size-3.5" aria-hidden="true" />}
															{isModelBatchMode ? t("common.cancel") : t("common.deleteBatch")}
														</Button>
														{isModelBatchMode && (
															<Button
																variant="destructive"
																size="sm"
																onClick={() => {
																	if (selectedModelCount === 0) return;
																	props.onDeleteModels(name, [...selectedModelIndexes]);
																	clearModelBatch();
																}}
																disabled={selectedModelCount === 0}
															>
																<Trash2 className="size-3.5" aria-hidden="true" />
																{t("common.deleteSelected")} ({selectedModelCount})
															</Button>
														)}
													</div>
												</div>

												{props.fetchModelsErrorByProvider[name] && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{props.fetchModelsErrorByProvider[name]}</div>}

												{/* 自动获取后直接在同一区块勾选保存，保留手动添加作为兜底入口。 */}
												{props.fetchedModels[name] && props.fetchedModels[name].length > 0 && (
													<div className="mb-2.5 flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-subtle p-2.5">
														<FetchedModelCombobox models={props.fetchedModels[name]} value={selectedFetchedModelIds[name] ?? []} existingModelIds={provider.models.map((model) => model.id)} onChange={(modelIds) => setSelectedFetchedModels(name, modelIds)} />
														<div className="flex justify-end border-t border-border-subtle pt-2">
															<Button
																variant="default"
																size="sm"
																onClick={async () => {
																	const currentProvider = data.providers[name];
																	if (!currentProvider) return;
																	const selectedIds = selectedFetchedModelIds[name] ?? [];
																	// listing 已带容量的字段直接写入；其余空字段再按 pi-ai 目录补，仍缺则空着
																	const baseModels = buildModelsFromFetchedSelection(props.fetchedModels[name], selectedIds, currentProvider.models);
																	if (baseModels.length === 0) return;
																	const results = await Promise.all(baseModels.map((m) => desktopApi.projects.getModelSpec(name, m.id, m.name).catch(() => null)));
																	let filledCount = 0;
																	const newModels = baseModels.map((m, i) => {
																		const updates = computeModelSpecPatches(m, results[i]);
																		if (updates.length === 0) return m;
																		filledCount++;
																		return applyModelPatches(m, updates);
																	});
																	const allModels = [...currentProvider.models, ...newModels];
																	// 按模型名称（无名称时回退 id）字母正序排列，保证保存后模型表顺序稳定。
																	allModels.sort(compareModelRows);
																	props.onChangeProvider(name, "models", allModels);
																	setSelectedFetchedModels(name, []);
																	if (filledCount > 0) {
																		showNotice(t("config.modelsSavedWithSpecs", { count: filledCount }), 3000);
																	}
																}}
																disabled={(selectedFetchedModelIds[name] ?? []).length === 0}
															>
																{t("config.saveSelectedModels")}
															</Button>
														</div>
													</div>
												)}
												<ModelsTable
													models={provider.models}
													onUpdateModel={(i, field, value) => props.onUpdateModel(name, i, field, value)}
													onUpdateModelThinkingLevel={(i, key, value) => props.onUpdateModelThinkingLevel(name, i, key, value)}
													onUpdateModelUserAgent={props.onUpdateModelUserAgent && props.getModelUserAgentOverride ? (i, value) => props.onUpdateModelUserAgent!(name, i, value) : undefined}
													getModelUserAgentOverride={props.onUpdateModelUserAgent && props.getModelUserAgentOverride ? (i) => props.getModelUserAgentOverride!(name, i) : undefined}
													onDeleteModel={(i) => {
														clearModelBatch();
														props.onDeleteModel(name, i);
													}}
													onMoveModel={(i, direction) => {
														const targetIndex = direction === "up" ? i - 1 : i + 1;
														if (targetIndex < 0 || targetIndex >= provider.models.length) return;
														const nextModels = [...provider.models];
														const [removed] = nextModels.splice(i, 1);
														nextModels.splice(targetIndex, 0, removed);
														props.onChangeProvider(name, "models", nextModels);
													}}
													onHideModel={
														props.onToggleHiddenModel
															? (i) => {
																	const model = provider.models[i];
																	if (model) props.onToggleHiddenModel!(name, model.id);
																}
															: undefined
													}
													onResetModel={(i) => props.onResetModel(name, i)}
													resettingModelKey={props.resettingModelKey}
													getRowKey={(i) => getModelInputKey(name, i)}
													onBlurAutoFill={(i, modelId) => void applyModelSpecAutoFill(name, i, modelId)}
													batchMode={isModelBatchMode}
													selectedIndexes={selectedModelIndexes}
													onToggleSelectIndex={(i) => setSelectedModelIndexes((current) => toggleModelIndex(current, i))}
													onToggleAll={(total) => toggleAllModels(total)}
													onDeleteSelected={(indexes) => {
														props.onDeleteModels(name, indexes);
														clearModelBatch();
													}}
													focusModelKey={pendingModelFocusKey}
													onFocusHandled={() => setPendingModelFocusKey(null)}
												/>
												{/* 隐藏模型折叠展示区：在当前 provider 下展示已隐藏的模型，可随时点眼睛恢复 */}
												{(() => {
													const hiddenModelsInProvider = provider.models.filter((m) => (props.hiddenModels ?? []).includes(`${name}/${m.id}`));
													if (hiddenModelsInProvider.length === 0) return null;
													return (
														<div className="mt-2 rounded border border-border-subtle bg-bg-muted/40 p-2 text-xs">
															<div className="mb-1 flex items-center gap-1.5 font-medium text-text-secondary">
																<EyeOff size={13} className="text-muted-foreground" />
																<span>{t("config.hiddenModels", { count: hiddenModelsInProvider.length })}</span>
															</div>
															<div className="flex flex-col gap-1">
																{hiddenModelsInProvider.map((hiddenModel) => (
																	<div key={hiddenModel.id} className="flex items-center justify-between rounded bg-bg-panel px-2 py-1 text-control">
																		<span className="font-mono text-text-primary">{hiddenModel.name ? `${hiddenModel.name} (${hiddenModel.id})` : hiddenModel.id}</span>
																		<Button variant="ghost" size="icon-xs" onClick={() => props.onToggleHiddenModel?.(name, hiddenModel.id)} title={t("config.showModel")}>
																			<Eye size={13} />
																		</Button>
																	</div>
																))}
															</div>
														</div>
													);
												})()}
											</div>
										</div>
									)}
								</div>
							);
						})}
						{/* 已隐藏的供应商折叠区：眼睛按钮隐藏后移到这里，可展开恢复显示 */}
						{hiddenProviderNames.length > 0 && (
							<div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
								<button type="button" className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2 text-left transition-colors duration-150 hover:bg-bg-hover" onClick={() => setHiddenSectionOpen((prev) => !prev)}>
									{hiddenSectionOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
									<EyeOff size={14} className="text-muted-foreground" aria-hidden="true" />
									<span className="text-control font-semibold text-text-primary">{t("config.hiddenProviders", { count: hiddenProviderNames.length })}</span>
								</button>
								{hiddenSectionOpen && (
									<div className="border-t border-border-subtle px-3.5 py-2">
										<p className="mb-2 text-[11px] leading-relaxed text-text-tertiary">{t("config.hiddenProvidersHint")}</p>
										<div className="flex flex-col gap-1">
											{hiddenProviderNames.map((hiddenName) => (
												<div key={hiddenName} className="flex items-center justify-between gap-2 rounded-sm bg-bg-muted px-2.5 py-1.5">
													<span className="min-w-0 truncate font-mono text-control text-text-primary">{hiddenName}</span>
													<Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={() => props.onToggleHiddenProvider(hiddenName)} title={t("config.showProvider")}>
														<Eye size={14} />
													</Button>
												</div>
											))}
										</div>
									</div>
								)}
							</div>
						)}
						{providerNames.length === 0 && <div className="py-12 text-center text-control text-text-tertiary">{t("config.emptyProviders")}</div>}
					</div>
				</>
			)}

			{/* 新增/编辑供应商：以「模型页的下一页」形式呈现（非浮层弹窗）——
			   整个内容区切换成配置表单页，左上角返回按钮回列表，获取模型也在页内。 */}
			{(props.addingProvider || props.editingProvider) && (
				<AddProviderDialog
					mode={props.editingProvider ? "edit" : "add"}
					initial={props.editingProvider ? providerDialogInitial(data.providers[props.editingProvider], props.editingProvider) : undefined}
					existingNames={props.editingProvider ? providerNames.filter((name) => name !== props.editingProvider) : providerNames}
					onBack={props.editingProvider ? props.onCancelEditProvider : props.onCancelAddProvider}
					onConfirm={props.editingProvider ? (draft) => props.onConfirmEditProvider(props.editingProvider!, draft) : props.onConfirmAddProvider}
					onRequestSave={(save) => {
						props.providerPageSaveRef.current = save;
					}}
				/>
			)}

			{transferView?.kind === "export" && <ModelsExportPanel providerIds={transferView.ids} providers={props.data.providers} onBack={() => setTransferView(null)} />}
			{transferView?.kind === "import" && <ModelsImportPanel data={props.data} onApply={props.onApplyModelsTransfer} onBack={() => setTransferView(null)} />}
		</div>
	);
}
