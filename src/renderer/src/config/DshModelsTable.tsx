/**
 * DshModelsTable — DSH 配置页模型列表（行式，对齐 dsh-web 的模型目录形态）。
 *
 * 每行一个模型：行上显示模型 ID 与显示名称（可编辑），右侧两个无文字操作
 * （展开容量 / 删除）；上下文窗口与最大输出 token 收在该行自己的折叠区里。
 * 顶部「添加模型」按钮；空列表显示「使用适配器默认模型」提示（继承态）。
 *
 * 行 key 用 index（id 是行内可编辑字段，用它做 key 会导致每次输入重建行、失焦）。
 */
import { useState } from "react";
import { Button } from "../components/ui-shadcn/button";
import { Collapsible, CollapsibleContent } from "../components/ui-shadcn/collapsible";
import { Input } from "../components/ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui-shadcn/select";
import { ChevronDown, ChevronRight, Image as ImageIcon, Plus, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { formatDshModelCapacity, dshModalitySelection, dshModalityValue, parseDshModelCapacity, type DshModalitySelection, type DshModelInputField } from "./dshModels";

export type DshModelRow = {
	id?: unknown;
	name?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	input?: unknown;
	reasoningEfforts?: unknown;
	/** Direct adapter models can carry advanced fields that this curated editor must preserve. */
	[key: string]: unknown;
};

export function ModelsTable(props: {
	/** 当前模型数组（现值，行内编辑由父级 draft 覆盖）。 */
	models: DshModelRow[];
	/** Adapter catalog shown while no user-layer model override exists. */
	catalog?: DshModelRow[];
	/** Whether `models` is an explicit user-layer override. Needed by direct DeepSeek,
	 * where an empty array means "advertise no models", not "inherit defaults". */
	modelsOverridden?: boolean;
	/** Drop the user-layer models override and return to the adapter catalog. */
	onReset?: () => void;
	/** DSH Web lets direct-adapter default rows materialize an override on edit. */
	editableInherited?: boolean;
	/** Adapter-level fallback capacities shown as placeholders — only when actually configured,
	 *  no hardcoded numeric hint: an unmatched row must read as empty, not as a fake 1M/128k
	 *  that the user mistakes for a matched capacity (Pi falls back to 128k anyway). */
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
	/** Direct DeepSeek accepts the same 256K / 1M shorthand as DSH Web. */
	allowCapacitySuffixes?: boolean;
	/**
	 * 输入模态在 settings.yaml 的字段名（llm-pi-ai=`input` / llm-deepseek=`inputModalities`）。
	 * 声明为纯文本的模型会被 DSH 的 prompt 准入直接拒绝带图消息，所以这一项必须可配。
	 */
	inputField?: DshModelInputField;
	writable: boolean;
	/** 行内字段更新（field 为模型条目键名，如 id/name/contextWindow/maxTokens）。 */
	onUpdate: (index: number, field: string, value: unknown) => void;
	onAdd: () => void;
	onRemove: (index: number) => void;
	/** 模型 id 失焦：由编辑器按 pi-ai 目录补空容量，表格本身不打 IPC */
	onIdBlur?: (index: number, modelId: string) => void;
}) {
	const { models, writable, onUpdate, onAdd, onRemove } = props;
	/** Current text while a direct-adapter capacity is being edited. */
	const [capacityDrafts, setCapacityDrafts] = useState<Record<string, string>>({});
	/** 当前展开容量编辑的行（同时只展开一行）。 */
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

	const capacityDraftKey = (index: number, field: "contextWindow" | "maxTokens") => `${index}:${field}`;
	const capacityText = (index: number, field: "contextWindow" | "maxTokens", value: unknown) => {
		const typed = capacityDrafts[capacityDraftKey(index, field)];
		if (typed !== undefined) return typed;
		const numeric = typeof value === "number" ? value : undefined;
		return props.allowCapacitySuffixes ? formatDshModelCapacity(numeric) : numeric === undefined ? "" : String(numeric);
	};
	const updateCapacity = (index: number, field: "contextWindow" | "maxTokens", raw: string) => {
		if (!props.allowCapacitySuffixes) {
			const next = raw ? Number(raw) : undefined;
			onUpdate(index, field, Number.isFinite(next) ? next : undefined);
			return;
		}
		setCapacityDrafts((current) => ({ ...current, [capacityDraftKey(index, field)]: raw }));
		onUpdate(index, field, parseDshModelCapacity(raw));
	};
	const settleCapacity = (index: number, field: "contextWindow" | "maxTokens") => {
		if (!props.allowCapacitySuffixes) return;
		const key = capacityDraftKey(index, field);
		const raw = capacityDrafts[key];
		if (raw === undefined || Number.isNaN(parseDshModelCapacity(raw))) return;
		setCapacityDrafts((current) => {
			const next = { ...current };
			delete next[key];
			return next;
		});
	};

	const overridden = props.modelsOverridden ?? models.length > 0;
	const inherited = !overridden && (props.catalog?.length ?? 0) > 0;
	const canEditRows = !inherited || props.editableInherited === true;
	const shownModels = inherited ? (props.catalog ?? []) : models;
	// 闭包里保持常量收窄：inputField 存在时才渲染模态选择器。
	const inputField = props.inputField;

	return (
		<div className="grid gap-1.5">
			<div className="flex items-center gap-2">
				<span className="text-caption font-semibold text-muted-foreground">{t("config.dsh.models")}</span>
				<span className="text-micro text-muted-foreground/70">{inherited ? t("config.dsh.modelsInherited") : t("config.dsh.modelsCustomized", { count: models.length })}</span>
				{overridden && props.onReset && (
					<Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-micro text-muted-foreground" disabled={!writable} onClick={props.onReset}>
						{t("config.dsh.resetModels")}
					</Button>
				)}
				<Button type="button" variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-1.5 text-micro text-muted-foreground" disabled={!writable} onClick={onAdd}>
					<Plus className="size-3" aria-hidden="true" />
					{t("config.dsh.addModel")}
				</Button>
			</div>
			{shownModels.length === 0 ? (
				<div className="rounded-sm border border-dashed border-border-subtle px-3 py-2.5 text-micro text-muted-foreground">{inherited ? t("config.dsh.modelsEmptyHint") : t("config.dsh.modelsEmpty")}</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
					{shownModels.map((model, index) => {
						const isOpen = canEditRows && expandedIndex === index;
						const id = typeof model.id === "string" ? model.id : "";
						const name = typeof model.name === "string" ? model.name : "";
						return (
							<div key={`${inherited ? "cat" : "row"}-${index}`} className="border-b border-border/40 last:border-b-0">
								{/* 折叠体走共享折叠原语；display:contents 不生成盒子，折叠态零空档。 */}
								<Collapsible open={isOpen} className="contents">
									<div className="flex items-center gap-2 px-2.5 py-1.5">
										{canEditRows ? (
											<Button type="button" variant="ghost" size="icon-sm" className="size-6 shrink-0 text-muted-foreground" title={t("config.dsh.modelCapacity")} aria-label={t("config.dsh.modelCapacity")} disabled={!writable} onClick={() => setExpandedIndex(isOpen ? null : index)}>
												{isOpen ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
											</Button>
										) : (
											<span className="size-6 shrink-0" aria-hidden="true" />
										)}
										{canEditRows ? (
											<Input
												size="sm"
												className="min-w-0 flex-1 font-mono"
												placeholder={t("config.dsh.modelIdPlaceholder")}
												value={id}
												disabled={!writable}
												onChange={(event) => onUpdate(index, "id", event.target.value)}
												onBlur={(event) => {
													const trimmed = event.target.value.trim();
													if (trimmed !== event.target.value) onUpdate(index, "id", trimmed);
													props.onIdBlur?.(index, trimmed);
												}}
											/>
										) : (
											<span className="min-w-0 flex-1 truncate font-mono text-control text-foreground">{id}</span>
										)}
										{canEditRows ? (
											<Input size="sm" className="min-w-0 flex-1" placeholder={t("config.dsh.modelNamePlaceholder")} value={name} disabled={!writable} onChange={(event) => onUpdate(index, "name", event.target.value)} />
										) : name ? (
											<span className="min-w-0 flex-1 truncate text-control text-muted-foreground">{name}</span>
										) : (
											<span className="min-w-0 flex-1" aria-hidden="true" />
										)}
										{/* 图片能力要在行上直接可见：用户反馈「配置里看不出模型支不支持图片」。 */}
										{inputField && dshModalitySelection(model[inputField]) === "textImage" ? <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" role="img" aria-label={t("config.dsh.inputModalityTextImage")} /> : null}
										{canEditRows && (
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												className="size-7 shrink-0 text-muted-foreground hover:text-danger"
												title={t("config.dsh.removeModel")}
												aria-label={t("config.dsh.removeModel")}
												disabled={!writable}
												onClick={() => {
													// 删除展开行时收拢展开态
													if (expandedIndex === index) setExpandedIndex(null);
													onRemove(index);
												}}
											>
												<Trash2 className="size-3.5" aria-hidden="true" />
											</Button>
										)}
									</div>
									{/* 不再挂 animate-in/fade-in：twMerge 会把 animate-* 判同组，保留会盖掉高度动画。 */}
									<CollapsibleContent className="grid gap-2.5 border-t border-border/40 px-3 py-2.5 sm:grid-cols-2">
										<label className="grid gap-1">
											<span className="text-micro text-muted-foreground">{t("config.contextWindow")}</span>
											<Input
												type={props.allowCapacitySuffixes ? "text" : "number"}
												inputMode="numeric"
												size="sm"
												placeholder={formatDshModelCapacity(props.defaultContextWindow)}
												value={capacityText(index, "contextWindow", model.contextWindow)}
												disabled={!writable}
												onChange={(event) => updateCapacity(index, "contextWindow", event.target.value)}
												onBlur={() => settleCapacity(index, "contextWindow")}
											/>
										</label>
										<label className="grid gap-1">
											<span className="text-micro text-muted-foreground">{t("config.dsh.modelMaxTokens")}</span>
											<Input
												type={props.allowCapacitySuffixes ? "text" : "number"}
												inputMode="numeric"
												size="sm"
												placeholder={formatDshModelCapacity(props.defaultMaxTokens)}
												value={capacityText(index, "maxTokens", model.maxTokens)}
												disabled={!writable}
												onChange={(event) => updateCapacity(index, "maxTokens", event.target.value)}
												onBlur={() => settleCapacity(index, "maxTokens")}
											/>
										</label>
										{inputField ? (
											<div className="grid gap-1 sm:col-span-2">
												<span className="text-micro text-muted-foreground">{t("config.dsh.modelInputModalities")}</span>
												<Select
													value={dshModalitySelection(model[inputField])}
													disabled={!writable}
													onValueChange={(value) => {
														const selection: DshModalitySelection = value === "text" || value === "textImage" ? value : "inherit";
														onUpdate(index, inputField, dshModalityValue(selection));
													}}
												>
													<SelectTrigger size="sm" className="w-full">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="inherit">{t("config.dsh.inputModalityInherit")}</SelectItem>
														<SelectItem value="text">{t("config.dsh.inputModalityText")}</SelectItem>
														<SelectItem value="textImage">{t("config.dsh.inputModalityTextImage")}</SelectItem>
													</SelectContent>
												</Select>
											</div>
										) : null}
									</CollapsibleContent>
								</Collapsible>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
