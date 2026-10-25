import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { zhCN } from "date-fns/locale/zh-CN";
import { zhTW } from "date-fns/locale/zh-TW";
import { enUS } from "date-fns/locale/en-US";
import { Calendar } from "../../ui-shadcn/calendar";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui-shadcn/popover";
import { getI18nLocale, t } from "../../../i18n";

/**
 * 日志"时间范围"筛选组件：一个触发器按钮 + 弹层内 起止日期（日历区间选择）+ 起止时刻。
 * 替代旧的两个独立 LogsDatePicker（用户易混淆、且 to 默认 00:00 导致
 * "选 8/9 却只查到 8/9 零点之前"的语义坑）。
 * - 起止日期：react-day-picker mode="range"，一次点选起、二次点选止；
 * - 起止时刻：两个 time 输入，起始默认 00:00、截止默认 23:59（"到 8/9"= 含 8/9 整天）；
 * - value 格式沿用 "YYYY-MM-DDTHH:mm"，上层 new Date(...).getTime() 无需改动。
 */

/** 解析日期部分为本地时区 Date（不能用 new Date("YYYY-MM-DD")——按 UTC 零点解析会偏移一天）。 */
function parseDatePart(value: string): Date | undefined {
	const [year, month, day] = value.slice(0, 10).split("-").map(Number);
	if (!year || !month || !day) return undefined;
	return new Date(year, month - 1, day);
}

/** 从 "YYYY-MM-DDTHH:mm" 中取时刻部分；无日期时返回空串。 */
function extractTime(value: string): string {
	return value.includes("T") ? value.slice(11, 16) : "";
}

/** 按本地时区拼回 "YYYY-MM-DDTHH:mm"；时间未选时 fallback 到默认时刻。 */
function formatValue(date: Date, time: string, fallback: string): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}T${time || fallback}`;
}

/** 按钮上显示的紧凑标签："2026/8/9 00:00 ~ 2026/8/12 23:59"，未选端省略。 */
function rangeLabel(from: string, to: string, localeName: string): string {
	const fmt = (value: string) => {
		const date = parseDatePart(value);
		if (!date) return "";
		const time = extractTime(value) || "00:00";
		return `${date.toLocaleDateString(localeName)} ${time}`;
	};
	const fromLabel = fmt(from);
	const toLabel = fmt(to);
	if (fromLabel && toLabel) return `${fromLabel} ~ ${toLabel}`;
	if (fromLabel) return `${fromLabel} ~`;
	if (toLabel) return `~ ${toLabel}`;
	return "";
}

export function LogsDateRangePicker(props: { from: string; to: string; onChange: (from: string, to: string) => void }) {
	const [open, setOpen] = useState(false);
	// pseudo locale 走 en-US，与 formatI18nDateTime 的处理一致；zh-TW 用繁中文日历（日期串也交给 zh-TW）
	const localeMode = getI18nLocale();
	const isEnglishCalendar = localeMode === "en-US" || localeMode === "pseudo";
	const locale = isEnglishCalendar ? enUS : localeMode === "zh-TW" ? zhTW : zhCN;
	const localeName = isEnglishCalendar ? "en-US" : localeMode;
	const fromDate = parseDatePart(props.from);
	const toDate = parseDatePart(props.to);
	const fromTime = extractTime(props.from);
	const toTime = extractTime(props.to);
	const label = rangeLabel(props.from, props.to, localeName) || t("logs.rangeFilter");

	// 日历选日期：保留已填时刻（未填用默认 00:00 / 23:59）；
	// 只点选起点时（range.to 为空）清空原截止，视为重新开始选区间。
	const onSelectRange = (range: { from?: Date; to?: Date } | undefined) => {
		if (!range) return;
		const nextFrom = range.from ? formatValue(range.from, fromTime, "00:00") : "";
		const nextTo = range.to ? formatValue(range.to, toTime, "23:59") : "";
		props.onChange(nextFrom, nextTo);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="justify-start font-normal" title={t("logs.rangeFilter")} aria-label={t("logs.rangeFilter")}>
					<CalendarIcon className="size-3.5 shrink-0" aria-hidden="true" />
					<span className="max-w-56 truncate">{label}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[320px] p-0" align="start">
				<Calendar
					mode="range"
					locale={locale}
					selected={fromDate || toDate ? { from: fromDate, to: toDate } : undefined}
					// 固定宽度：默认 w-fit 在窄弹层下表头前后翻月按钮会与内容重叠
					classNames={{ root: "w-full" }}
					onSelect={onSelectRange}
				/>
				{/* 起止时刻 + 清除：日历选完日期后微调时刻；不选日期时整个面板无意义地空着，故日期未选时不渲染 */}
				{(fromDate || toDate) && (
					<div className="flex items-center gap-1.5 border-t border-border-subtle px-3 py-2">
						<Input
							type="time"
							className="w-[104px] shrink-0"
							value={fromTime}
							onChange={(event) => {
								const base = fromDate ?? new Date();
								props.onChange(formatValue(base, event.target.value, "00:00"), props.to);
							}}
							aria-label={t("logs.rangeFrom")}
						/>
						<span className="text-text-tertiary" aria-hidden="true">
							~
						</span>
						<Input
							type="time"
							className="w-[104px] shrink-0"
							value={toTime}
							onChange={(event) => {
								const base = toDate ?? new Date();
								props.onChange(props.from, formatValue(base, event.target.value, "23:59"));
							}}
							aria-label={t("logs.rangeTo")}
						/>
						<Button variant="ghost" size="sm" className="ml-auto shrink-0" onClick={() => props.onChange("", "")} title={t("logs.clearRangeFilter")} aria-label={t("logs.clearRangeFilter")}>
							{t("common.clear")}
						</Button>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
