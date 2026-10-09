import type { ReactNode } from "react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { THINKING_LEVELS, type ThinkingPickerLevel } from "./sessionPickerOptions";

/** 紧凑的模型/思考组合：模型直接打开完整选择器，思考保留独立的就地入口。 */
export function ModelThinkingChip(props: { modelLabel: string; modelPendingTo?: string; modelPendingTitle?: string; disabled?: boolean; onPickModel: () => void; thinkingControl: ReactNode }) {
	const modelValue = props.modelPendingTo ? `${props.modelLabel} → ${props.modelPendingTo}` : props.modelLabel;
	return (
		<div className="composer-bar-btn model-thinking inline-flex h-7 min-w-0 max-w-[52ch] items-center rounded-md text-caption font-medium">
			<Button variant="ghost" size="sm" className="h-7 min-w-0 rounded-md px-2 text-caption font-medium text-foreground hover:bg-muted/60" disabled={props.disabled} onClick={props.onPickModel} title={props.modelPendingTitle ?? t("app.modelPickerTitle")} aria-label={t("app.modelPickerTitle")}>
				<span className="min-w-0 truncate">{modelValue}</span>
			</Button>
			<span className="shrink-0 text-muted-foreground/70" aria-hidden="true">
				·
			</span>
			{props.thinkingControl}
		</div>
	);
}

/** 少量离散档位用普通单选下拉；沿用宿主解析的档位和保存命令，不增加确认步骤。 */
export function ThinkingLevelDropdown(props: { current?: string; levels?: ThinkingPickerLevel[]; open: boolean; onOpenChange: (open: boolean) => void; disabled?: boolean; onPick: (level: string) => void }) {
	// undefined 表示能力尚未知，沿用旧版全量回退；[] 则是后端明确表示不支持。
	const levels = props.levels ?? THINKING_LEVELS;
	const currentLevel = levels.find((level) => level.value === props.current) ?? THINKING_LEVELS.find((level) => level.value === props.current);
	const thinkingText = currentLevel?.labelKey ? t(currentLevel.labelKey) : (currentLevel?.label ?? props.current ?? t("app.think"));
	return (
		<DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm" className="h-7 min-w-0 shrink-0 rounded-md px-2 text-caption font-medium text-muted-foreground hover:bg-muted/60" disabled={props.disabled} title={t("app.thinkingPickerTitle")} aria-label={t("app.thinkingPickerTitle")}>
					<span className="max-w-[16ch] truncate">{thinkingText}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" side="top" className="min-w-36 max-w-[min(280px,calc(100vw-24px))]" aria-label={t("app.thinkingPickerTitle")}>
				{levels.length === 0 ? (
					<div className="px-3 py-2 text-caption text-muted-foreground">{t("app.thinkingPickerUnsupported")}</div>
				) : (
					<DropdownMenuRadioGroup value={props.current}>
						{levels.map((level) => (
							<DropdownMenuRadioItem key={level.value} value={level.value} disabled={props.disabled} title={level.descriptionKey ? t(level.descriptionKey) : level.description} onSelect={() => props.onPick(level.value)} className="min-h-8 text-control">
								<span className="min-w-0 truncate">{level.labelKey ? t(level.labelKey) : (level.label ?? level.value)}</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
