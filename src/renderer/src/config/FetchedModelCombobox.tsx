import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import type { FetchedModel } from "../../../shared/types/fetchedModel";

/**
 * 从 /models 拉回后的多选器（Pi 配置页与 DSH 自定义模型共用）。
 * 已存在的模型灰掉不可再选；全选只作用于当前筛选结果。
 */
export function FetchedModelCombobox(props: { models: FetchedModel[]; value: string[]; existingModelIds: string[]; onChange: (value: string[]) => void }) {
	const [filter, setFilter] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const existingModelIdSet = new Set(props.existingModelIds);
	const selectedModelIdSet = new Set(props.value);
	const normalizedFilter = filter.trim().toLowerCase();
	const visibleModels = normalizedFilter ? props.models.filter((model) => [model.id, model.name].filter(Boolean).some((text) => text!.toLowerCase().includes(normalizedFilter))) : props.models;
	const selectableVisibleModels = visibleModels.filter((model) => !existingModelIdSet.has(model.id));
	const selectedModels = props.models.filter((model) => selectedModelIdSet.has(model.id));
	const allSelectableSelected = selectableVisibleModels.length > 0 && selectableVisibleModels.every((model) => selectedModelIdSet.has(model.id));

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	function toggleModel(modelId: string) {
		if (existingModelIdSet.has(modelId)) return;
		const next = new Set(props.value);
		if (next.has(modelId)) next.delete(modelId);
		else next.add(modelId);
		props.onChange([...next]);
	}

	return (
		<div className="min-w-0">
			<div className="flex items-center gap-2">
				<Input
					ref={inputRef}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder={t("config.modelSearchPlaceholder")}
					size="sm"
					className="min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-popover px-2.5 text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-fast focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						// 全选只作用于当前筛选结果，方便大列表按关键字批量选择，同时不会误选已配置模型。
						const visibleIds = selectableVisibleModels.map((model) => model.id);
						if (allSelectableSelected) {
							props.onChange(props.value.filter((id) => !visibleIds.includes(id)));
						} else {
							props.onChange([...new Set([...props.value, ...visibleIds])]);
						}
					}}
					disabled={selectableVisibleModels.length === 0}
				>
					{allSelectableSelected ? t("common.deselectAll") : t("common.selectAll")}
				</Button>
			</div>
			<div className="text-micro text-text-tertiary">
				<span>
					{t("config.modelFetchSelectionSummary", {
						selected: selectedModels.length,
						total: props.models.length,
					})}
				</span>
			</div>
			<div className="mt-2 flex max-h-[220px] flex-wrap gap-2 overflow-auto p-1">
				{visibleModels.map((model) => {
					const selected = selectedModelIdSet.has(model.id);
					const configured = existingModelIdSet.has(model.id);
					return (
						<button
							key={model.id}
							type="button"
							className={`inline-flex min-h-7 max-w-full cursor-pointer items-center gap-1 rounded-sm border border-border-subtle bg-bg-popover px-2 py-1 text-left text-xs text-text-primary transition-[background-color,border-color,color,box-shadow] duration-fast hover:border-[color-mix(in_srgb,var(--color-accent)_42%,var(--color-border-subtle))] hover:bg-bg-hover focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none${selected ? " border-[color-mix(in_srgb,var(--color-accent)_70%,var(--color-border-subtle))] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg-popover))] text-[color:var(--color-accent)]" : ""}${configured ? " cursor-not-allowed bg-bg-muted opacity-70" : ""}`}
							onClick={() => toggleModel(model.id)}
							disabled={configured}
							aria-pressed={selected}
						>
							<span className="min-w-0 truncate font-medium">{model.name ?? model.id}</span>
							{model.name && model.name !== model.id && <span className="truncate text-micro text-text-tertiary">{model.id}</span>}
							{selected && !configured && <Check size={12} className="shrink-0" />}
							{configured && <span className="shrink-0 rounded-sm bg-bg-muted px-1.5 py-0.5 text-micro leading-tight text-text-tertiary">{t("config.configured")}</span>}
						</button>
					);
				})}
				{visibleModels.length === 0 && <div className="w-full p-3 text-center text-xs text-text-tertiary">{t("app.modelPickerEmpty")}</div>}
			</div>
		</div>
	);
}
