import { useEffect, useRef, useState } from "react";
import { Check, Clock } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Label } from "../ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { buildCronExpression, CRON_MINUTE_INTERVALS, CRON_VISUAL_KINDS, parseCronVisualState, switchCronKind, type CronVisualKind, type CronVisualState } from "./cronScheduleModel";

const CRON_KIND_VALUES = new Set<string>(CRON_VISUAL_KINDS);

function isCronVisualKind(value: string): value is CronVisualKind {
	return CRON_KIND_VALUES.has(value);
}

const CRON_PRESETS: ReadonlyArray<{ label: TranslationKey; expr: string }> = [
	{ label: "automation.cronPreset.daily9am", expr: "0 9 * * 1-5" },
	{ label: "automation.cronPreset.hourly", expr: "0 * * * *" },
	{ label: "automation.cronPreset.every30m", expr: "*/30 * * * *" },
	{ label: "automation.cronPreset.midnight", expr: "0 0 * * *" },
];

const CRON_KIND_LABELS: Record<CronVisualKind, TranslationKey> = {
	"every-minutes": "automation.cronMode.everyMinutes",
	hourly: "automation.cronMode.hourly",
	daily: "automation.cronMode.daily",
	weekdays: "automation.cronMode.weekdays",
	weekly: "automation.cronMode.weekly",
	monthly: "automation.cronMode.monthly",
	custom: "automation.cronMode.custom",
};

const WEEKDAY_LABELS: TranslationKey[] = ["automation.cronWeekday.0", "automation.cronWeekday.1", "automation.cronWeekday.2", "automation.cronWeekday.3", "automation.cronWeekday.4", "automation.cronWeekday.5", "automation.cronWeekday.6"];

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES = Array.from({ length: 60 }, (_, minute) => minute);
const MONTH_DAYS = Array.from({ length: 31 }, (_, day) => day + 1);

function formatPreviewTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		weekday: "short",
	});
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

interface CronScheduleBuilderProps {
	value: string;
	onChange: (expression: string) => void;
	previews: number[];
	error: string | null;
}

/**
 * 定时任务调度选择器：预设 + 可视化频率，必要时才露出原始 Cron 输入。
 * 业务规则：父组件只存 5 段表达式；本组件用本地状态记住「自定义」以免合法表达式被重新推断回每天/工作日。
 */
export function CronScheduleBuilder({ value, onChange, previews, error }: CronScheduleBuilderProps) {
	const [state, setState] = useState<CronVisualState>(() => parseCronVisualState(value));
	const lastEmittedRef = useRef(value);

	useEffect(() => {
		// 仅在外部写入（切任务 / 点预设落到同一表达式之外）时重解析，避免选「自定义」被 roundtrip 抢回。
		if (value === lastEmittedRef.current) return;
		lastEmittedRef.current = value;
		setState(parseCronVisualState(value));
	}, [value]);

	const commit = (next: CronVisualState) => {
		const expression = buildCronExpression(next);
		lastEmittedRef.current = expression;
		setState(next);
		onChange(expression);
	};

	const expression = buildCronExpression(state);
	const intervalOptions = uniqueIntervals(state.kind === "every-minutes" ? state.interval : 30);

	return (
		<div className="flex flex-col gap-2.5 rounded-lg border border-border/50 bg-bg-panel/40 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Label className="flex items-center gap-1.5 text-xs font-medium">
					<Clock className="size-3.5 text-sky-500" />
					{t("automation.cronExpression")} <span className="text-destructive">*</span>
				</Label>
				<div className="flex flex-wrap items-center gap-1">
					{CRON_PRESETS.map((preset) => (
						<Button key={preset.expr} type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-micro text-muted-foreground hover:text-foreground" onClick={() => commit(parseCronVisualState(preset.expr))}>
							{t(preset.label)}
						</Button>
					))}
				</div>
			</div>

			<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
				<div className="flex flex-col gap-1">
					<span className="text-micro text-muted-foreground">{t("automation.cronMode")}</span>
					<Select
						value={state.kind}
						onValueChange={(kind) => {
							if (!isCronVisualKind(kind)) return;
							commit(switchCronKind(state, kind));
						}}
					>
						<SelectTrigger size="sm" className="text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{CRON_VISUAL_KINDS.map((kind) => (
								<SelectItem key={kind} value={kind} className="text-xs">
									{t(CRON_KIND_LABELS[kind])}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				{renderKindFields(state, intervalOptions, commit)}
			</div>

			{state.kind === "weekly" && (
				<div className="flex flex-col gap-1">
					<span className="text-micro text-muted-foreground">{t("automation.cronDaysOfWeek")}</span>
					<div className="flex flex-wrap gap-1">
						{WEEKDAY_LABELS.map((label, day) => {
							const selected = state.days.includes(day);
							return (
								<button
									key={label}
									type="button"
									aria-pressed={selected}
									className={cn("size-7 rounded-md text-micro font-medium transition-colors", selected ? "bg-primary text-primary-foreground" : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground")}
									onClick={() =>
										commit({
											...state,
											days: toggleDay(state.days, day),
										})
									}
								>
									{t(label)}
								</button>
							);
						})}
					</div>
				</div>
			)}

			{state.kind === "custom" && <Input id="cron-expr" value={state.expression} onChange={(event) => commit({ kind: "custom", expression: event.target.value })} placeholder="0 9 * * 1-5" className="h-8 font-mono text-xs" />}

			<div className="flex flex-wrap items-center justify-between gap-2 text-micro text-muted-foreground">
				<span className="font-mono text-foreground/80">
					{t("automation.cronGenerated")}: {expression || "—"}
				</span>
				{error ? (
					<span className="text-destructive">{error}</span>
				) : (
					previews.length > 0 && (
						<span className="flex items-center gap-1 text-emerald-500">
							<Check className="size-3" />
							{t("automation.cronPreview")}: {previews.map(formatPreviewTime).join(" ➔ ")}
						</span>
					)
				)}
			</div>
			<p className="text-micro text-muted-foreground">{t("automation.cronHelp")}</p>
		</div>
	);
}

function renderKindFields(state: CronVisualState, intervalOptions: number[], commit: (next: CronVisualState) => void) {
	if (state.kind === "every-minutes") {
		return <NumberSelect label={t("automation.cronEveryNMinutes")} value={state.interval} options={intervalOptions} onChange={(interval) => commit({ kind: "every-minutes", interval })} />;
	}
	if (state.kind === "hourly") {
		return <NumberSelect label={t("automation.cronAtMinute")} value={state.minute} options={MINUTES} format={pad2} onChange={(minute) => commit({ kind: "hourly", minute })} />;
	}
	if (state.kind === "custom") {
		return <div className="flex flex-col justify-end text-micro text-muted-foreground">{t("automation.cronHelp")}</div>;
	}

	return (
		<div className="flex flex-col gap-1">
			<span className="text-micro text-muted-foreground">{t("automation.cronAtTime")}</span>
			<div className="flex items-center gap-1.5">
				<NumberSelect value={state.hour} options={HOURS} format={pad2} onChange={(hour) => commit({ ...state, hour })} />
				<span className="text-xs text-muted-foreground">:</span>
				<NumberSelect value={state.minute} options={MINUTES} format={pad2} onChange={(minute) => commit({ ...state, minute })} />
				{state.kind === "monthly" && <NumberSelect label={t("automation.cronDayOfMonth")} value={state.day} options={MONTH_DAYS} onChange={(day) => commit({ ...state, day })} />}
			</div>
		</div>
	);
}

function NumberSelect(props: { label?: string; value: number; options: number[]; format?: (value: number) => string; onChange: (value: number) => void }) {
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-1">
			{props.label && <span className="text-micro text-muted-foreground">{props.label}</span>}
			<Select value={String(props.value)} onValueChange={(next) => props.onChange(Number(next))}>
				<SelectTrigger size="sm" className="text-xs">
					<SelectValue />
				</SelectTrigger>
				<SelectContent className="max-h-64">
					{props.options.map((option) => (
						<SelectItem key={option} value={String(option)} className="text-xs">
							{props.format ? props.format(option) : String(option)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function toggleDay(days: number[], day: number): number[] {
	const selected = new Set(days);
	if (selected.has(day)) {
		if (selected.size === 1) return days;
		selected.delete(day);
	} else {
		selected.add(day);
	}
	return [...selected].sort((left, right) => left - right);
}

function uniqueIntervals(current: number): number[] {
	const values = new Set<number>(CRON_MINUTE_INTERVALS);
	if (Number.isFinite(current) && current >= 1 && current <= 59) values.add(current);
	return [...values].sort((left, right) => left - right);
}
