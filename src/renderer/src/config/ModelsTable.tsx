import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Brain, Coins, Eye, EyeOff, Fingerprint, Plus, RotateCcw, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { MODEL_THINKING_LEVELS, enabledModelThinkingLevels, formatModelThinkingLevelsSummary, modelThinkingLevelState, orderModelThinkingLevels } from "../../../shared/modelThinkingLevels";
import type { ModelThinkingLevel } from "../../../shared/modelThinkingLevels";
import type { ModelItem } from "./configTypes";
import { ConfigComboboxInput, ConfigSelect, openDocsInSystemBrowser } from "./ConfigShared";
import { getUserAgentOptions } from "./userAgentPresets";
import { emptyTierDraft, normalizeTiers, toTierDrafts, type CostTierDraft } from "./modelCostTiers";
import { countSelectedModelIndexes, getModelSelectionState } from "./modelBatchSelection";
import { Button } from "../components/ui-shadcn/button";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui-shadcn/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui-shadcn/popover";

/** 模型已知字段（除未知字段外的受管字段），用于计费弹框里提示「高级字段将被保留」。 */
const KNOWN_MODEL_FIELDS = new Set(["id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "headers", "compat"]);

export type ModelsTableProps = {
	models: ModelItem[];
	/** 行编辑回调（index 定位，不再带 providerName）。 */
	onUpdateModel: (index: number, field: string, value: unknown) => void;
	/**
	 * 逐模型 User-Agent 覆盖（可选）：落到 provider.modelOverrides[modelId].headers["User-Agent"]。
	 *
	 * 为什么不走 onUpdateModel 的 field：modelOverrides 是 **provider 级、按模型 id 建键**的
	 * 结构（`{ [modelId]: { headers?: Record<string,string> } }`），不是模型行内的字段，
	 * index 定位写不进去。已按 pi 源码核实：core/provider-composer.js 的 rawModelHeaders
	 * 把 `modelOverrides[id].headers` 展开在 **最后**（优先级高于 provider.headers），
	 * 且 model-config.d.ts 里 headers 是该对象合法的 TypeBox 字段（非自定义字段）。
	 */
	onUpdateModelUserAgent?: (index: number, value: string) => void;
	/** 读取该行当前的逐模型 UA 覆盖（可选；与 onUpdateModelUserAgent 成对出现才渲染操作列的 UA 按钮）。 */
	getModelUserAgentOverride?: (index: number) => string;
	/**
	 * 勾选 / 取消某思考档位（写模型自己的 thinkingLevelMap，见 withModelThinkingLevelEnabled）：
	 * 勾选任意档位同时把模型标成 reasoning；xhigh/max 必须在 map 里显式给值才存在。
	 */
	onUpdateModelThinkingLevel: (index: number, level: ModelThinkingLevel, enabled: boolean) => void;
	/**
	 * 逐模型「默认思考档位」（可选）：写入 pi settings.json 的 modelThinkingLevels（键 `provider/modelId`），
	 * 新建会话与运行中切模型时由 pi 按「显式选择 > 每模型默认 > 全局默认」取值再按能力收敛。
	 * 两个回调成对出现才渲染编辑入口（只给一半等于点了没反应）。
	 */
	onUpdateModelThinkingLevelDefault?: (index: number, value: string) => void;
	/** 读取该行当前的每模型默认档位（可选，与 onUpdateModelThinkingLevelDefault 成对；空串 = 跟随全局）。 */
	getModelThinkingLevelDefault?: (index: number) => string;
	/**
	 * 读取该行模型 Pi 已确认的可用思考档位（可选）：undefined = 未知（展示「未知」，仍允许手动配置），
	 * 空数组 = Pi 的权威空结果。它只作为只读参考展示（草稿勾选态由 thinkingLevelMap 实时推导）。
	 */
	getModelAvailableThinkingLevels?: (index: number) => readonly string[] | undefined;
	/**
	 * 该行还没有可探测的 Pi 数据（新增供应商页的 provider 未落盘）：探测行显示
	 * 「保存后由 Pi 探测」而不是「未知」。默认 false（已保存模型都该有探测结果）。
	 */
	thinkingLevelsProbePending?: boolean;
	onDeleteModel: (index: number) => void;
	/** 重置为自适应（显式刷 endpoint），可选：不传则不渲染重置按钮。 */
	onResetModel?: (index: number) => void;
	/** 正在重置的行 key（与 getRowKey 配合判断按钮禁用态）。 */
	resettingModelKey?: string | null;
	/** 行 key 生成（默认 `${index}`；多表格同屏时传 providerName 前缀防 ref 串扰）。 */
	getRowKey?: (index: number) => string;
	/** 失焦自动补全（按 pi-ai 目录填能力字段），可选：不传则失焦不补全。 */
	onBlurAutoFill?: (index: number, modelId: string) => void;
	/** 批量选择模式（可选：ModelsTab 展开卡片用，编辑页不需要）。 */
	batchMode?: boolean;
	selectedIndexes?: ReadonlySet<number>;
	onToggleSelectIndex?: (index: number) => void;
	onToggleAll?: (total: number) => void;
	/** 聚焦新添加行的 ID 输入框（可选）。 */
	focusModelKey?: string | null;
	/** 聚焦完成后清理（可选；对应 ModelsTab 的 pendingModelFocusKey 清空）。 */
	onFocusHandled?: () => void;
	/** 上移/下移模型（改变该 provider 下模型的实际顺序） */
	onMoveModel?: (index: number, direction: "up" | "down") => void;
	/** 隐藏模型回调（切换 hiddenModels 列表） */
	onHideModel?: (index: number) => void;
	/**
	 * 读取该行是否已隐藏（可选，与 onHideModel 成对）：按钮据此显示成「已隐藏/可恢复」。
	 * 卡片与编辑页的隐藏区在别处，行内只有这个按钮能看出状态——没有回显就成了盲点。
	 */
	getModelHidden?: (index: number) => boolean;
};

/**
 * 模型表格（模型页展开卡片 / 供应商编辑页共用）：
 * id/名称/上下文长度/maxTokens/思考级别/能力（推理、图片）/操作列，
 * 计费弹框（基础费率 + 梯度计费）与逐模型 UA 弹框由组件内部管理，输入即保存。
 * 行操作一律用 index 定位，provider 相关回调由调用方包一层。
 */
export function ModelsTable(props: ModelsTableProps) {
	const { models, batchMode = false, selectedIndexes } = props;
	// UA 预设在渲染期取一次即可（只依赖 i18n，models 变化不会让它失效）。
	const modelUserAgentOptions = getUserAgentOptions();
	// 逐模型 UA 按需渲染：两个回调都给了才有意义（只给一半等于点了没反应）。
	const hasUserAgentOverride = Boolean(props.onUpdateModelUserAgent && props.getModelUserAgentOverride);
	const getRowKey = props.getRowKey ?? ((index: number) => String(index));
	const modelIdInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
	// 计费弹框：打开中的行 index（null = 关闭）
	const [costDialogIndex, setCostDialogIndex] = useState<number | null>(null);

	// 逐模型 UA 弹框：打开中的行 index（null = 关闭）。
	// 收进操作列图标而非独立列：UA 覆盖是少数人才用的高级项，早先每行摊一个空输入框白占整列宽度。
	const [uaDialogIndex, setUaDialogIndex] = useState<number | null>(null);
	// 梯度计费编辑草稿：弹窗打开时从 cost.tiers 初始化；输入即规整落盘（与基础费率行为一致）
	const [tierEditor, setTierEditor] = useState<{ key: string; drafts: CostTierDraft[] } | null>(null);
	const selectionState = getModelSelectionState(selectedIndexes ?? new Set<number>(), models.length);

	useEffect(() => {
		if (costDialogIndex == null) {
			setTierEditor(null);
			return;
		}
		const model = models[costDialogIndex];
		setTierEditor({ key: String(costDialogIndex), drafts: toTierDrafts(model?.cost?.tiers) });
		// 打开弹框即补齐缺失费率为 0：cost 字段缺失会导致 pi 启动会话失败，
		// 「看到 0」与「配置里有 0」保持一致，不依赖用户手动输入（tiers 原样保留）
		if (model) {
			const nextCost = { ...(model.cost ?? {}) };
			let changed = false;
			for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				if (nextCost[field] == null) {
					nextCost[field] = 0;
					changed = true;
				}
			}
			if (changed) props.onUpdateModel(costDialogIndex, "cost", nextCost);
		}
		// 只依赖打开目标：models/onUpdateModel 每次渲染都是新引用，放入会反复重置草稿
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [costDialogIndex]);

	// 手动新增模型后立即聚焦 ID 输入框，避免还要再点一次空输入框
	useLayoutEffect(() => {
		if (!props.focusModelKey) return;
		const frameId = window.requestAnimationFrame(() => {
			const input = modelIdInputRefs.current[props.focusModelKey!];
			if (!input) return;
			input.focus();
			input.select();
			props.onFocusHandled?.();
		});
		return () => window.cancelAnimationFrame(frameId);
	}, [props.focusModelKey]);

	return (
		<div className="config-model-table overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						{batchMode && (
							<TableHead className="w-10 px-2 text-center">
								<Label className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-bg-hover">
									<Checkbox checked={selectionState === "checked" ? true : selectionState === "indeterminate" ? "indeterminate" : false} onCheckedChange={() => props.onToggleAll?.(models.length)} aria-label={t("config.selectAllModels")} />
								</Label>
							</TableHead>
						)}
						{/* ID 与名称同宽：两列都是「长文本 + 输入框」，宽度不一致会显得表格歪（用户反馈） */}
						<TableHead className="w-48 min-w-0">{t("config.modelId")}</TableHead>
						<TableHead className="w-48 min-w-0">{t("config.modelDisplayName")}</TableHead>
						{/* token 数字列加宽一档：原生步进器占住右侧约 17px，96px 会把七位数字裁掉 */}
						<TableHead className="w-28">{t("config.contextWindow")}</TableHead>
						<TableHead className="w-28">{t("config.maxTokens")}</TableHead>
						<TableHead className="w-24">{t("config.thinkingLevels")}</TableHead>
						<TableHead className="w-24">{t("config.capabilities")}</TableHead>
						<TableHead className="w-20 text-right pr-3">{t("config.actions")}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{models.map((m, i) => {
						const rowKey = getRowKey(i);
						const updateCost = (field: "input" | "output" | "cacheRead" | "cacheWrite", rawValue: string) => {
							const nextCost = { ...(m.cost ?? {}) };
							// 清空输入 = 落 0 而非删除字段：cost 字段缺失会导致 pi 启动会话失败，
							// 弹框默认值也统一为 0（不显示占位符 -），保证费率永远齐全
							if (rawValue.trim() === "") nextCost[field] = 0;
							else {
								const value = Number(rawValue);
								if (!Number.isFinite(value) || value < 0) return;
								nextCost[field] = value;
							}
							props.onUpdateModel(i, "cost", Object.keys(nextCost).length > 0 ? nextCost : undefined);
						};
						// 梯度计费：草稿规整后写回 cost.tiers；无有效梯度则删字段（与 updateCost 相同的"输入即保存"语义）
						const applyTiers = (drafts: CostTierDraft[]) => {
							setTierEditor((prev) => (prev ? { ...prev, drafts } : prev));
							const nextCost = { ...(m.cost ?? {}) };
							const tiers = normalizeTiers(drafts);
							if (tiers.length > 0) nextCost.tiers = tiers;
							else delete nextCost.tiers;
							props.onUpdateModel(i, "cost", Object.keys(nextCost).length > 0 ? nextCost : undefined);
						};
						const modelAdvancedFields = Object.keys(m).filter((key) => !KNOWN_MODEL_FIELDS.has(key));
						// thinkingLevelMap 整表由档位勾选列表管理，不再算「高级字段」（计费弹框的保留提示不再列它）
						const modelComplexFields = ["api", "baseUrl", "cost", "headers", "compat"].filter((key) => m[key] !== undefined);

						// 思考档位勾选态只依赖模型自身（reasoning + thinkingLevelMap），与 Popover 里的勾选列表同源，
						// 草稿改动实时预演（不读 Pi 的能力探测结果——那回答的是「已保存配置」，含尚未保存的新行）。
						const thinkingLevelOptions = MODEL_THINKING_LEVELS.map((level) => ({ level, state: modelThinkingLevelState(m, level) }));
						const enabledThinkingLevels = enabledModelThinkingLevels(m);
						// 单元格摘要：范围折叠（CC Switch 风格，如 `off → max`、`off, low → max`），放得下整列宽。
						const thinkingSummary = enabledThinkingLevels.length > 0 ? formatModelThinkingLevelsSummary(enabledThinkingLevels) : t("config.thinkingLevelsNotSet");

						// 每模型默认档位（settings.json 的 modelThinkingLevels）：与 UA 同模式，成对回调才渲染。
						const canEditThinkingDefault = Boolean(props.onUpdateModelThinkingLevelDefault && props.getModelThinkingLevelDefault);
						const thinkingDefaultValue = canEditThinkingDefault ? props.getModelThinkingLevelDefault!(i) : "";
						const availableThinkingLevels = canEditThinkingDefault ? props.getModelAvailableThinkingLevels?.(i) : undefined;
						// 候选只列已勾选档位（默认档位必须落在可用档位里）；当前值不在候选时由 ConfigSelect 的「自定义」项兜底，不丢用户旧值。
						const thinkingDefaultOptions = [{ value: "", label: t("config.thinkingLevelDefaultInherit") }, ...enabledThinkingLevels.map((level) => ({ value: level, label: level }))];
						// 没有勾选任何档位就没有候选默认档位（写了也会被 pi clamp），禁用编辑。
						const thinkingDefaultDisabled = enabledThinkingLevels.length === 0;
						const thinkingAvailabilityText =
							availableThinkingLevels === undefined
								? props.thinkingLevelsProbePending
									? t("config.thinkingLevelsProbedAfterSave")
									: t("config.thinkingLevelsUnknown")
								: availableThinkingLevels.length === 0
									? t("config.thinkingLevelsNone")
									: t("config.thinkingLevelsProbed", { levels: formatModelThinkingLevelsSummary(orderModelThinkingLevels(availableThinkingLevels)) });
						// 单元格只放得下摘要：悬停补充完整档位清单 + 每模型默认档位
						const thinkingSummaryTitle = [`${t("config.thinkingLevels")}: ${enabledThinkingLevels.length > 0 ? enabledThinkingLevels.join(" / ") : t("config.thinkingLevelsNotSet")}`, thinkingDefaultValue ? `${t("config.thinkingLevelDefault")}: ${thinkingDefaultValue}` : ""].filter(Boolean).join(" · ");

						// 逐模型 UA 覆盖值（空串 = 继承供应商级 UA）：操作列按钮据此判断是否已配置，弹框用它做初值
						const userAgentOverride = hasUserAgentOverride ? props.getModelUserAgentOverride!(i) : "";
						return (
							<>
								<TableRow key={rowKey} className="align-middle" data-state={batchMode && selectedIndexes?.has(i) ? "selected" : undefined}>
									{batchMode && (
										<TableCell className="w-10 p-2 text-center">
											<Label className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-bg-hover">
												<Checkbox
													checked={selectedIndexes?.has(i) ?? false}
													onCheckedChange={() => props.onToggleSelectIndex?.(i)}
													aria-label={t("config.selectModel", {
														model: m.name || m.id || String(i + 1),
													})}
												/>
											</Label>
										</TableCell>
									)}
									<TableCell className="min-w-0 p-2 pl-3">
										{/* 模型 ID 是可编辑字段，不能作为 key；否则每次输入都会重建行并导致输入框失焦。 */}
										<Input
											ref={(element) => {
												modelIdInputRefs.current[rowKey] = element;
											}}
											value={m.id}
											onChange={(e) => props.onUpdateModel(i, "id", e.target.value)}
											// 失焦按 pi-ai 目录填充空字段（未命中留空）
											onBlur={(e) => props.onBlurAutoFill?.(i, e.target.value)}
											placeholder="model-id"
											className="h-8 min-w-0"
										/>
									</TableCell>
									<TableCell className="min-w-0 p-2">
										<Input value={m.name ?? ""} onChange={(e) => props.onUpdateModel(i, "name", e.target.value)} onBlur={() => props.onBlurAutoFill?.(i, m.id)} placeholder={t("config.modelDisplayName")} className="h-8 min-w-0" />
									</TableCell>
									<TableCell className="p-2">
										<Input
											type="number"
											value={m.contextWindow ?? ""}
											onChange={(e) => props.onUpdateModel(i, "contextWindow", e.target.value ? Number(e.target.value) : undefined)}
											// 未匹配到目录时保持空（不展示 1000000 这类暗示值，避免用户误以为已匹配，
											// 实际 Pi 只会按自身 128k 回退）。留空 = 交给 Pi 默认，语义与保存结果一致。
											className="h-8 min-w-0"
										/>
									</TableCell>
									<TableCell className="p-2">
										<Input
											type="number"
											value={m.maxTokens ?? ""}
											onChange={(e) => props.onUpdateModel(i, "maxTokens", e.target.value ? Number(e.target.value) : undefined)}
											// 与 contextWindow 一样保持纯数字，未匹配时不展示 128000 暗示值。
											className="h-8 min-w-0"
										/>
									</TableCell>
									{/* 思考级别列：一个按钮弹出 Popover，内含档位勾选（写 thinkingLevelMap）+ 每模型默认档位（写 settings.json），
									    避免行高被多行控件撑高 */}
									<TableCell className="min-w-0 p-2">
										<Popover>
											<PopoverTrigger asChild>
												<Button variant="outline" size="sm" className="h-7 w-full justify-between gap-1 px-2 font-mono text-micro" title={thinkingSummaryTitle}>
													<span className="min-w-0 truncate">{thinkingSummary}</span>
													<Brain className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
												</Button>
											</PopoverTrigger>
											<PopoverContent align="start" className="w-64 p-2">
												{/* 档位勾选：勾上 = 该档位对该模型可用（写 models.json 的 thinkingLevelMap），取消 = 写 null / 删条目 */}
												<div className="text-micro font-semibold text-text-secondary">{t("config.thinkingLevelsPick")}</div>
												<div className="mt-1 flex flex-col">
													{thinkingLevelOptions.map(({ level, state }) => (
														<Label key={level} className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 font-normal hover:bg-bg-hover">
															<Checkbox
																checked={state.enabled}
																onCheckedChange={(checked) => {
																	const enabled = checked === true;
																	props.onUpdateModelThinkingLevel(i, level, enabled);
																	// 取消的档位正好是每模型默认档位时一并清掉：否则默认档位指向不可用档位，pi 只能 clamp，
																	// 用户看到的是「配了但不生效」（与 CC Switch 的档位编辑器一致）。
																	if (!enabled && canEditThinkingDefault && thinkingDefaultValue === level) props.onUpdateModelThinkingLevelDefault!(i, "");
																}}
															/>
															<span className="flex-1 font-mono text-control">{level}</span>
															{/* 非恒等上游值（来自目录补全或手改配置）：展示出来，用户才知道实际发出去的是什么 */}
															{state.wireValue && (
																<span className="shrink-0 font-mono text-micro text-text-tertiary" title={t("config.thinkingLevelsWireValue")}>
																	→ {state.wireValue}
																</span>
															)}
														</Label>
													))}
												</div>
												<div className="mt-1 text-micro leading-relaxed text-text-tertiary">{t("config.thinkingLevelsPickHint")}</div>
												{m.reasoning !== true && <div className="mt-0.5 text-micro leading-relaxed text-text-tertiary">{t("config.thinkingLevelsReasoningHint")}</div>}
												{canEditThinkingDefault && (
													<div className="mt-1.5 border-t border-border-subtle pt-1.5">
														{/* 说明跟在标题右侧（不另起一行）；下面是 Pi 对「已保存配置」的只读探测结果 */}
														<div className="mb-1 flex items-baseline justify-between gap-2">
															<span className="shrink-0 text-micro font-semibold text-text-secondary">{t("config.thinkingLevelDefault")}</span>
															<span className="min-w-0 text-right text-micro leading-relaxed text-text-tertiary">{t("config.thinkingLevelDefaultHint")}</span>
														</div>
														<ConfigSelect value={thinkingDefaultValue} options={thinkingDefaultOptions} onChange={(v) => props.onUpdateModelThinkingLevelDefault!(i, v)} disabled={thinkingDefaultDisabled} />
														<div className="mt-1 text-micro leading-relaxed text-text-tertiary">{thinkingAvailabilityText}</div>
													</div>
												)}
											</PopoverContent>
										</Popover>
									</TableCell>
									{/* 能力列：推理 / 图片两个勾选同列堆叠 */}
									<TableCell className="p-2">
										<div className="flex flex-col gap-1">
											<Label className="config-input-option">
												<Checkbox checked={m.reasoning ?? false} onCheckedChange={(checked) => props.onUpdateModel(i, "reasoning", checked)} />
												<span>{t("config.reasoning")}</span>
											</Label>
											<Label className="config-input-option">
												<Checkbox
													checked={(m.input ?? []).includes("image")}
													onCheckedChange={(checked) => {
														const base = m.input ?? ["text", "image"];
														const next = checked ? [...new Set([...base, "text", "image"])] : ["text"];
														props.onUpdateModel(i, "input", next);
													}}
												/>
												<span>{t("config.inputTypeImage")}</span>
											</Label>
										</div>
									</TableCell>
									{/* 操作列：排序（上移/下移）+ 隐藏 + 重置为自适应 + 逐模型 UA（Dialog）+ 计费（Dialog）+ 删除 */}
									<TableCell className="p-2">
										<div className="flex items-center justify-end gap-0.5">
											{props.onMoveModel && (
												<>
													<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => props.onMoveModel!(i, "up")} disabled={i === 0} title={t("config.moveModelUp")}>
														<ArrowUp className="size-3.5" aria-hidden="true" />
													</Button>
													<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => props.onMoveModel!(i, "down")} disabled={i === models.length - 1} title={t("config.moveModelDown")}>
														<ArrowDown className="size-3.5" aria-hidden="true" />
													</Button>
												</>
											)}
											{props.onHideModel && (
												<Button
													variant="ghost"
													size="icon-sm"
													// 已隐藏的行：图标换成 Eye 并高亮，tooltip 也变成「恢复显示」
													className={props.getModelHidden?.(i) ? "size-7 text-[color:var(--color-accent)]" : "size-7"}
													onClick={() => props.onHideModel!(i)}
													title={props.getModelHidden?.(i) ? t("config.showModel") : t("config.hideModel")}
												>
													{props.getModelHidden?.(i) ? <Eye className="size-3.5" aria-hidden="true" /> : <EyeOff className="size-3.5" aria-hidden="true" />}
												</Button>
											)}
											{props.onResetModel && (
												<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => props.onResetModel!(i)} disabled={props.resettingModelKey === rowKey} title={t("config.modelResetAdaptive")}>
													<RotateCcw className="size-3.5" aria-hidden="true" />
												</Button>
											)}
											{/* 已配置覆盖时图标高亮，并在 tooltip 里直接带出当前 UA（代替独立列的「一眼可见」） */}
											{hasUserAgentOverride && (
												<Button variant="ghost" size="icon-sm" className={userAgentOverride ? "size-7 text-[color:var(--color-accent)]" : "size-7"} onClick={() => setUaDialogIndex(i)} title={userAgentOverride ? `${t("config.modelUserAgent")}: ${userAgentOverride}` : t("config.modelUserAgent")}>
													<Fingerprint className="size-3.5" aria-hidden="true" />
												</Button>
											)}
											<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setCostDialogIndex(i)} title={t("config.modelCost")}>
												<Coins className="size-3.5" aria-hidden="true" />
											</Button>
											<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => props.onDeleteModel(i)} title={t("config.deleteModel")}>
												<Trash2 size={14} />
											</Button>
										</div>
									</TableCell>
								</TableRow>
								{/* 计费弹框：每行一个受控 Dialog，输入即保存（与表格内编辑行为一致） */}
								<Dialog
									open={costDialogIndex === i}
									onOpenChange={(open) => {
										if (!open) setCostDialogIndex(null);
									}}
								>
									<DialogContent className="sm:max-w-3xl">
										<DialogHeader>
											<DialogTitle>{t("config.modelCost")}</DialogTitle>
										</DialogHeader>
										<div className="grid grid-cols-2 gap-2">
											{(
												[
													["input", "config.costInput"],
													["output", "config.costOutput"],
													["cacheRead", "config.costCacheRead"],
													["cacheWrite", "config.costCacheWrite"],
												] as const
											).map(([field, label]) => (
												<label key={field} className="config-model-cost-field">
													<span>{t(label)}</span>
													{/* 默认 0：cost 字段缺失会让 pi 启动会话失败，未配置时也显示 0 而非占位符 - */}
													<Input type="number" min="0" step="any" value={m.cost?.[field] ?? 0} onChange={(e) => updateCost(field, e.target.value)} />
												</label>
											))}
										</div>
										<div className="mt-3 border-t pt-3">
											<div className="mb-1.5 flex items-start justify-between gap-2">
												<div>
													<div className="text-xs font-medium text-text-primary">{t("config.costTiersTitle")}</div>
													<div className="text-micro leading-relaxed text-text-tertiary">{t("config.costTiersHint")}</div>
												</div>
												<Button variant="outline" size="sm" onClick={() => applyTiers([...(tierEditor?.drafts ?? []), emptyTierDraft()])}>
													<Plus className="size-3.5" />
													{t("config.costTiersAdd")}
												</Button>
											</div>
											{(tierEditor?.drafts.length ?? 0) > 0 ? (
												<Table>
													<TableHeader>
														<TableRow>
															<TableHead className="w-28">{t("config.costTierThreshold")}</TableHead>
															<TableHead>{t("config.costInput")}</TableHead>
															<TableHead>{t("config.costOutput")}</TableHead>
															<TableHead>{t("config.costCacheRead")}</TableHead>
															<TableHead>{t("config.costCacheWrite")}</TableHead>
															<TableHead className="w-10" />
														</TableRow>
													</TableHeader>
													<TableBody>
														{tierEditor?.drafts.map((draft, tierIndex) => (
															<TableRow key={tierIndex}>
																<TableCell>
																	<div className="flex items-center gap-1">
																		<span className="text-text-tertiary">&gt;</span>
																		<Input type="number" min="0" step="any" size="sm" placeholder="272000" value={draft.inputTokensAbove} onChange={(e) => applyTiers(tierEditor.drafts.map((d, j) => (j === tierIndex ? { ...d, inputTokensAbove: e.target.value } : d)))} />
																	</div>
																</TableCell>
																{(["input", "output", "cacheRead", "cacheWrite"] as const).map((field) => (
																	<TableCell key={field}>
																		<Input type="number" min="0" step="any" size="sm" placeholder="-" value={draft[field]} onChange={(e) => applyTiers(tierEditor.drafts.map((d, j) => (j === tierIndex ? { ...d, [field]: e.target.value } : d)))} />
																	</TableCell>
																))}
																<TableCell>
																	<Button variant="ghost" size="icon-sm" className="size-7 text-text-tertiary hover:text-destructive" onClick={() => applyTiers(tierEditor.drafts.filter((_, j) => j !== tierIndex))}>
																		<Trash2 className="size-3.5" />
																	</Button>
																</TableCell>
															</TableRow>
														))}
													</TableBody>
												</Table>
											) : (
												<div className="rounded-sm bg-bg-muted px-2 py-1.5 text-micro text-text-secondary">{t("config.costTiersEmpty")}</div>
											)}
										</div>
										{(modelComplexFields.length > 0 || modelAdvancedFields.length > 0) && (
											<div className="mt-1 rounded-sm bg-bg-muted px-2 py-1.5 text-micro leading-relaxed text-text-secondary">
												{t("config.advancedPreservedModel", {
													fields: [...modelComplexFields, ...modelAdvancedFields].join(", "),
												})}
												<a href="https://pi.dev/docs/latest/models" onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/models")} className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline">
													{t("config.docsModels")}
												</a>
											</div>
										)}
										<DialogFooter>
											<Button variant="default" size="sm" onClick={() => setCostDialogIndex(null)}>
												{t("common.done")}
											</Button>
										</DialogFooter>
									</DialogContent>
								</Dialog>

								{/* 逐模型 UA 弹框：与计费同模式（每行一个受控 Dialog，选中即保存）。
									留空 = modelOverrides 不写该键 → 继承供应商级 UA；写了则由 pi 覆盖 provider.headers
									的同名键（core/provider-composer.js 的 rawModelHeaders 把它展开在最后，优先级更高）。 */}
								<Dialog
									open={uaDialogIndex === i}
									onOpenChange={(open) => {
										if (!open) setUaDialogIndex(null);
									}}
								>
									<DialogContent className="sm:max-w-lg">
										<DialogHeader>
											<DialogTitle>{t("config.modelUserAgent")}</DialogTitle>
											<DialogDescription>{t("config.modelUserAgentDialogDesc")}</DialogDescription>
										</DialogHeader>
										<div className="flex items-center gap-2">
											<ConfigComboboxInput value={userAgentOverride} options={modelUserAgentOptions} onChange={(value) => props.onUpdateModelUserAgent!(i, value)} placeholder={t("config.modelUserAgentInherit")} />
											{userAgentOverride && (
												<Button variant="ghost" size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={() => props.onUpdateModelUserAgent!(i, "")}>
													{t("config.modelUserAgentClear")}
												</Button>
											)}
										</div>
										<DialogFooter>
											<Button variant="default" size="sm" onClick={() => setUaDialogIndex(null)}>
												{t("common.done")}
											</Button>
										</DialogFooter>
									</DialogContent>
								</Dialog>
							</>
						);
					})}
					{models.length === 0 && (
						<TableRow className="hover:bg-transparent">
							{/* 空表提示跨全部列：非批量 7 列（ID/名称/上下文/最大Token/思考级别/能力/操作），批量再 +1。
							    加列/删列时必须同步这里，否则空表提示跨不满整行。 */}
							<TableCell colSpan={batchMode ? 8 : 7} className="py-5 text-center text-xs text-text-tertiary">
								{t("config.emptyModels")}
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
		</div>
	);
}
