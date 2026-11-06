import { Sparkles } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import { t } from "../i18n";
import { CompatLabelHint, ConfigSelect } from "./ConfigShared";
import type { ProviderCompat } from "./configTypes";
import { MODEL_COMPAT_FIELDS, applyModelCompatSuggestion, diffModelCompatSuggestion, readCompatBooleans, setModelCompatFlag, type ModelCompatSuggestion } from "./modelCompatFields";

/**
 * 逐模型兼容性面板：models.json 里 `models[].compat` 的可视化编辑。
 *
 * 全部 value 驱动（与 ProviderConnectionForm 一致）：调用方决定写到哪里
 * （ModelsTab 写 modelsData，AddProviderDialog 写页内草稿），本组件不持有状态。
 *
 * 三态语义：跟随供应商 = 不写键（供应商级同名键、再到 pi 的判定依次生效），
 * 开/关 = 显式落盘并覆盖供应商级。改完保存后要新开会话才生效（pi 启动时读取 models.json）。
 */
export function ModelCompatPanel(props: {
	value: ProviderCompat | undefined;
	/** 官方目录建议（未命中目录时为 null）；只在面板管理的键上生效。 */
	suggestion?: ModelCompatSuggestion | null;
	onChange: (next: ProviderCompat | undefined) => void;
}) {
	const current = readCompatBooleans(props.value);
	const diff = props.suggestion ? diffModelCompatSuggestion(props.value, props.suggestion.flags) : [];
	const triStateOptions = [
		{ value: "follow", label: t("config.modelCompatFollowProvider") },
		{ value: "on", label: t("config.strictToolSamplingOn") },
		{ value: "off", label: t("config.strictToolSamplingOff") },
	];
	return (
		<div className="flex flex-col gap-3">
			<p className="text-caption leading-relaxed text-text-tertiary">{t("config.modelCompatHint")}</p>
			<div className="flex flex-col rounded-md border border-border-subtle">
				{MODEL_COMPAT_FIELDS.map((field) => {
					const value = current[field.key];
					const suggested = props.suggestion?.flags[field.key];
					return (
						<div key={field.key} className="flex items-start justify-between gap-4 border-b border-border-subtle px-3 py-2 last:border-b-0">
							<div className="flex min-w-0 flex-col gap-0.5">
								<div className="flex items-center gap-1">
									<span className="text-caption text-text-primary">{t(field.labelKey)}</span>
									<CompatLabelHint tipKey={field.hintKey} />
								</div>
								<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
									{/* 原始键名常驻：用户能直接在 models.json 里搜到这一行 */}
									<code className="font-mono text-micro text-text-tertiary">{field.key}</code>
									{suggested !== undefined && suggested !== value ? <span className="text-micro text-text-tertiary">{t("config.modelCompatSuggestionRow", { value: suggested ? t("config.strictToolSamplingOn") : t("config.strictToolSamplingOff") })}</span> : null}
								</div>
							</div>
							<ConfigSelect triggerClassName="w-auto min-w-28 shrink-0" value={value === undefined ? "follow" : value ? "on" : "off"} options={triStateOptions} onChange={(next) => props.onChange(setModelCompatFlag(props.value, field.key, next === "follow" ? undefined : next === "on"))} />
						</div>
					);
				})}
			</div>
			{diff.length > 0 ? (
				<div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-subtle p-3">
					<div className="flex items-center gap-1.5 text-caption font-medium text-text-primary">
						<Sparkles size={12} aria-hidden="true" />
						{t("config.modelCompatSuggestionTitle")}
					</div>
					<p className="text-caption leading-relaxed text-text-tertiary">{t("config.modelCompatSuggestionDesc", { model: props.suggestion?.matchedId ?? "" })}</p>
					{/* 建议值用原始键名 + true/false 展示：与 models.json 一一对应，不需要再铺一轮 i18n */}
					<ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-micro text-text-secondary">
						{diff.map((item) => (
							<li key={item.key}>
								{item.key}={String(item.suggested)}
							</li>
						))}
					</ul>
					<div>
						<Button variant="secondary" size="sm" onClick={() => props.onChange(applyModelCompatSuggestion(props.value, props.suggestion?.flags ?? {}))}>
							{t("config.modelCompatApplySuggestion")}
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}
