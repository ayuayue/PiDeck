import { decodeVideoGenSelection, encodeVideoGenSelection, VIDEO_GEN_DURATION_PRESETS, VIDEO_GEN_RATIO_PRESETS, VIDEO_GEN_RESOLUTION_PRESETS, type VideoGenConfigFile, type VideoGenProtocolFamily } from "../../../../shared/videoGenConfig";
import { t } from "../../i18n";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui-shadcn/select";

/**
 * 生视频模式底栏：供应商+模型合并下拉（与生图同构）+ 分辨率/时长/画幅三个参数下拉。
 *
 * 参数预设按当前供应商的协议族取（minimax 大写 P / seedance 小写 p 等），并保留
 * 「默认」项（不传参，用供应商 defaults 或上游默认值）；预设之外的自定义值一期不开放——
 * 各家模型支持矩阵差异大，开放自定义容易提交出 4xx，等真实需求再放（报告 §5 待确认项）。
 */
export function ComposerVideoGenOptions(props: {
	config: VideoGenConfigFile;
	providerId: string;
	modelId: string;
	resolution?: string;
	duration?: string;
	ratio?: string;
	disabled?: boolean;
	onSelectionChange: (providerId: string, modelId: string) => void;
	onParamChange: (key: "resolution" | "duration" | "ratio", value: string | undefined) => void;
}) {
	const providers = props.config.providers;
	const provider = providers.find((item) => item.id === props.providerId);
	const models = provider?.models.filter(Boolean) ?? [];
	const modelValue = provider && models.includes(props.modelId) ? props.modelId : "";
	const selectionValue = provider && modelValue ? encodeVideoGenSelection(provider.id, modelValue) : "";
	const providerLabel = provider?.name.trim() || provider?.id || "";
	const triggerLabel = provider && modelValue ? `${providerLabel} / ${modelValue}` : "";
	const protocol: VideoGenProtocolFamily = provider?.protocol ?? "minimax-v2";
	// 显示值：activeParams → 供应商 defaults（与提交侧同一回退链，展示与请求永远一致）
	const resolution = props.resolution ?? provider?.defaults?.resolution;
	const duration = props.duration ?? provider?.defaults?.duration;
	const ratio = props.ratio ?? provider?.defaults?.ratio;

	if (providers.length === 0) {
		return <span className="truncate px-1.5 text-micro text-muted-foreground">{t("videogen.notConfiguredHint")}</span>;
	}

	return (
		<div className="inline-flex h-7 min-w-0 shrink-0 items-center gap-0.5">
			<Select
				value={selectionValue || undefined}
				disabled={props.disabled}
				onValueChange={(value) => {
					const next = decodeVideoGenSelection(value);
					if (!next) return;
					props.onSelectionChange(next.providerId, next.modelId);
				}}
			>
				<SelectTrigger size="sm" className="composer-bar-btn h-7 max-w-[16rem] gap-1 rounded-md border-transparent bg-transparent px-1.5 text-control font-medium text-foreground hover:bg-muted/60 data-[state=open]:bg-muted/60" title={t("videogen.providerModel")} aria-label={t("videogen.providerModel")}>
					<SelectValue placeholder={t("videogen.providerModel")}>
						<span className="min-w-0 truncate">{triggerLabel || t("videogen.providerModel")}</span>
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
									<SelectItem key={encodeVideoGenSelection(item.id, modelId)} value={encodeVideoGenSelection(item.id, modelId)}>
										{modelId}
									</SelectItem>
								))}
							</SelectGroup>
						);
					})}
				</SelectContent>
			</Select>
			{/* 分辨率/时长/画幅：预设来自协议族；选「默认」= 不传该参数 */}
			<ParamSelect label={resolution ?? t("videogen.paramDefault")} title={t("videogen.paramResolution")} disabled={props.disabled} value={resolution} options={VIDEO_GEN_RESOLUTION_PRESETS[protocol]} onChange={(value) => props.onParamChange("resolution", value)} />
			<ParamSelect label={duration ? `${duration}s` : t("videogen.paramDefault")} title={t("videogen.paramDuration")} disabled={props.disabled} value={duration} options={[...VIDEO_GEN_DURATION_PRESETS]} onChange={(value) => props.onParamChange("duration", value)} />
			<ParamSelect label={ratio ?? t("videogen.paramDefault")} title={t("videogen.paramRatio")} disabled={props.disabled} value={ratio} options={VIDEO_GEN_RATIO_PRESETS[protocol]} onChange={(value) => props.onParamChange("ratio", value)} />
		</div>
	);
}

/** 单参数下拉：value 为空时高亮「默认」；选中「默认」回传 undefined（提交侧省略该字段）。 */
function ParamSelect(props: { label: string; title: string; value?: string; options: readonly string[]; disabled?: boolean; onChange: (value: string | undefined) => void }) {
	return (
		<Select value={props.value ?? ""} disabled={props.disabled} onValueChange={(value) => props.onChange(value || undefined)}>
			<SelectTrigger size="sm" className="composer-bar-btn h-7 max-w-[7.5rem] gap-1 rounded-md border-transparent bg-transparent px-1.5 text-control font-medium text-foreground hover:bg-muted/60 data-[state=open]:bg-muted/60" title={props.title} aria-label={props.title}>
				<span className="min-w-0 truncate">{props.label}</span>
			</SelectTrigger>
			<SelectContent align="start">
				<SelectItem value="">{t("videogen.paramDefault")}</SelectItem>
				{props.options.map((option) => (
					<SelectItem key={option} value={option}>
						{option}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
