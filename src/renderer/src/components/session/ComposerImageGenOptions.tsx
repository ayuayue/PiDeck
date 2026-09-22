import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { DEFAULT_IMAGE_GEN_OUTPUT_FORMAT, DEFAULT_IMAGE_GEN_SIZE, IMAGE_GEN_OUTPUT_FORMATS, IMAGE_GEN_SIZE_PRESETS, IMAGE_GEN_SIZE_UNSET, parseImageGenOutputFormat, parseImageGenSize, type ImageGenOutputFormat, type ImageGenSizePreset } from "../../../../shared/imageGenParams";
import { DEFAULT_IMAGE_GEN_EXTRA_PARAMS, decodeImageGenSelection, encodeImageGenSelection, type ImageGenConfigFile, type ImageGenProviderExtraParams } from "../../../../shared/imageGenConfig";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui-shadcn/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { Switch } from "../ui-shadcn/switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui-shadcn/select";

/**
 * 生图模式底栏：供应商+模型合并成一个下拉（供应商作分组），再跟该供应商勾选过的官方字段。
 */
export function ComposerImageGenOptions(props: {
	config: ImageGenConfigFile;
	providerId: string;
	modelId: string;
	size: string;
	outputFormat: string;
	watermark: boolean;
	disabled?: boolean;
	onSelectionChange: (providerId: string, modelId: string) => void;
	onSizeChange: (size: string) => void;
	onOutputFormatChange: (format: string) => void;
	onWatermarkChange: (watermark: boolean) => void;
}) {
	const providers = props.config.providers;
	const provider = providers.find((item) => item.id === props.providerId);
	const extra: ImageGenProviderExtraParams = provider?.extraParams ?? DEFAULT_IMAGE_GEN_EXTRA_PARAMS;
	const models = provider?.models.filter(Boolean) ?? [];
	const outputFormat = parseImageGenOutputFormat(props.outputFormat) ?? DEFAULT_IMAGE_GEN_OUTPUT_FORMAT;
	const modelValue = provider && models.includes(props.modelId) ? props.modelId : "";
	const selectionValue = provider && modelValue ? encodeImageGenSelection(provider.id, modelValue) : "";
	const providerLabel = provider?.name.trim() || provider?.id || "";
	const triggerLabel = provider && modelValue ? `${providerLabel} / ${modelValue}` : "";

	if (providers.length === 0) {
		return <span className="truncate px-1.5 text-micro text-muted-foreground">{t("imagegen.notConfiguredHint")}</span>;
	}

	return (
		<div className="inline-flex h-7 min-w-0 shrink-0 items-center gap-0.5">
			<Select
				value={selectionValue || undefined}
				disabled={props.disabled}
				onValueChange={(value) => {
					const next = decodeImageGenSelection(value);
					if (!next) return;
					props.onSelectionChange(next.providerId, next.modelId);
				}}
			>
				<SelectTrigger size="sm" className="composer-bar-btn h-7 max-w-[16rem] gap-1 rounded-md border-transparent px-1.5 text-control font-medium text-foreground hover:bg-muted/60" title={t("imagegen.providerModel")} aria-label={t("imagegen.providerModel")}>
					<SelectValue placeholder={t("imagegen.providerModel")}>
						<span className="min-w-0 truncate">{triggerLabel || t("imagegen.providerModel")}</span>
					</SelectValue>
				</SelectTrigger>
				<SelectContent align="start" className="min-w-[16rem]">
					{providers.map((item) => {
						const itemModels = item.models.filter(Boolean);
						if (itemModels.length === 0) return null;
						const groupLabel = item.name.trim() || item.id;
						return (
							<SelectGroup key={item.id}>
								<SelectLabel>{groupLabel}</SelectLabel>
								{itemModels.map((modelId) => (
									<SelectItem key={encodeImageGenSelection(item.id, modelId)} value={encodeImageGenSelection(item.id, modelId)}>
										{modelId}
									</SelectItem>
								))}
							</SelectGroup>
						);
					})}
				</SelectContent>
			</Select>
			{extra.size ? <ImageGenSizeCombobox value={props.size} disabled={props.disabled} onChange={props.onSizeChange} /> : null}
			{extra.output_format ? (
				<Select value={outputFormat} disabled={props.disabled} onValueChange={props.onOutputFormatChange}>
					<SelectTrigger size="sm" className="composer-bar-btn h-7 max-w-[5.5rem] gap-1 rounded-md border-transparent px-1.5 text-control font-medium uppercase text-foreground hover:bg-muted/60" title={t("imagegen.outputFormatHint")} aria-label={t("imagegen.outputFormat")}>
						<SelectValue placeholder={t("imagegen.outputFormat")} />
					</SelectTrigger>
					<SelectContent align="start">
						{IMAGE_GEN_OUTPUT_FORMATS.map((format: ImageGenOutputFormat) => (
							<SelectItem key={format} value={format} className="uppercase">
								{format}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : null}
			{extra.watermark ? (
				<label className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-control text-foreground hover:bg-muted/60 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50" title={t("imagegen.watermarkHint")}>
					<Switch size="sm" checked={props.watermark} disabled={props.disabled} onCheckedChange={props.onWatermarkChange} aria-label={t("imagegen.watermark")} />
					<span className="whitespace-nowrap">{t("imagegen.watermark")}</span>
				</label>
			) : null}
		</div>
	);
}

function sizeTriggerLabel(size: string): string {
	const parsed = parseImageGenSize(size) ?? DEFAULT_IMAGE_GEN_SIZE;
	return parsed === IMAGE_GEN_SIZE_UNSET ? t("imagegen.sizeAuto") : parsed;
}

/**
 * 分辨率与预设共用同一块区域：可点选、可搜索，也可直接输入宽×高（如 1280x720）。
 * 确认非法输入不提交，避免把坏 size 写进请求。
 */
function ImageGenSizeCombobox(props: { value: string; disabled?: boolean; onChange: (size: string) => void }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const selected = parseImageGenSize(props.value) ?? DEFAULT_IMAGE_GEN_SIZE;
	const typed = parseImageGenSize(query);
	const isCustomValue = (size: string) => size !== IMAGE_GEN_SIZE_UNSET && !(IMAGE_GEN_SIZE_PRESETS as readonly string[]).includes(size);
	const customSize = typed && isCustomValue(typed) ? typed : null;
	const selectedCustom = isCustomValue(selected) ? selected : null;

	const commit = (size: string) => {
		props.onChange(size);
		setQuery("");
		setOpen(false);
	};

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setQuery("");
			}}
		>
			<PopoverTrigger asChild>
				<Button type="button" variant="ghost" size="sm" disabled={props.disabled} className="composer-bar-btn h-7 max-w-[9.5rem] gap-1 rounded-md px-1.5 text-control font-medium text-foreground hover:bg-muted/60" title={t("imagegen.sizeHint")} aria-label={t("imagegen.size")}>
					<span className="min-w-0 truncate">{sizeTriggerLabel(props.value)}</span>
					<ChevronDown size={12} aria-hidden="true" className={`flex-none text-muted-foreground transition-transform duration-150${open ? " rotate-180" : ""}`} />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" side="top" className="w-52 p-0">
				<Command shouldFilter={false}>
					<CommandInput
						value={query}
						onValueChange={setQuery}
						placeholder={t("imagegen.sizeCustomPlaceholder")}
						autoFocus
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							const next = customSize ?? typed;
							if (!next) return;
							event.preventDefault();
							commit(next);
						}}
					/>
					<CommandList className="max-h-56">
						<CommandEmpty>{t("imagegen.sizeCustomInvalid")}</CommandEmpty>
						<CommandGroup>
							{!query.trim() || typed === IMAGE_GEN_SIZE_UNSET || t("imagegen.sizeAuto").toLowerCase().includes(query.trim().toLowerCase()) ? (
								<CommandItem value={IMAGE_GEN_SIZE_UNSET} data-checked={selected === IMAGE_GEN_SIZE_UNSET ? "true" : undefined} onSelect={() => commit(IMAGE_GEN_SIZE_UNSET)}>
									{t("imagegen.sizeAuto")}
								</CommandItem>
							) : null}
							{customSize ? (
								<CommandItem value={customSize} onSelect={() => commit(customSize)}>
									{t("imagegen.sizeCustomUse", { size: customSize })}
								</CommandItem>
							) : selectedCustom ? (
								<CommandItem value={selectedCustom} data-checked="true" onSelect={() => commit(selectedCustom)}>
									{selectedCustom}
								</CommandItem>
							) : null}
							{IMAGE_GEN_SIZE_PRESETS.filter((preset) => {
								if (!query.trim()) return true;
								return preset.toLowerCase().includes(query.trim().toLowerCase());
							}).map((preset: ImageGenSizePreset) => (
								<CommandItem key={preset} value={preset} data-checked={selected === preset ? "true" : undefined} onSelect={() => commit(preset)}>
									{preset}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
