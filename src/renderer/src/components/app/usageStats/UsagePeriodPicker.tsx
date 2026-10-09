/**
 * 周期用量档位切换器：日 / 周 / 月 / 年。
 *
 * 受控组件：mode 与 anchor 由父级持有，本组件只负责渲染与派发变更。
 * 周视图用 RDP 的 range_start / range_end / range_middle modifiers 高亮整周；
 * 月视图在 Popover 内提供年份翻页 + 12 月宫格；年视图直接用 shadcn Select。
 */

import { useEffect, useMemo, useState } from "react";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { zhCN } from "date-fns/locale/zh-CN";
import { zhTW } from "date-fns/locale/zh-TW";
import { enUS } from "date-fns/locale/en-US";
import { getI18nLocale, t, type TranslationKey } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Calendar } from "../../ui-shadcn/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui-shadcn/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { dayKeyOf, formatPeriodTitle, parseDayKey, resolvePeriod, type UsagePeriodMode } from "./usagePeriodModel";

const MODES: UsagePeriodMode[] = ["day", "week", "month", "year"];

const MONTH_KEYS: TranslationKey[] = [
	"usageStats.periodPicker.month.1",
	"usageStats.periodPicker.month.2",
	"usageStats.periodPicker.month.3",
	"usageStats.periodPicker.month.4",
	"usageStats.periodPicker.month.5",
	"usageStats.periodPicker.month.6",
	"usageStats.periodPicker.month.7",
	"usageStats.periodPicker.month.8",
	"usageStats.periodPicker.month.9",
	"usageStats.periodPicker.month.10",
	"usageStats.periodPicker.month.11",
	"usageStats.periodPicker.month.12",
];

export function UsagePeriodPicker(props: { mode: UsagePeriodMode; anchor: string; minYear: number; onModeChange: (mode: UsagePeriodMode) => void; onAnchorChange: (anchor: string) => void }): React.JSX.Element {
	const { mode, anchor, minYear, onModeChange, onAnchorChange } = props;
	// zh-TW 同样用繁中文日历（词形由词典负责），只有 en-US / pseudo 走英文
	const localeMode = getI18nLocale();
	const isEnglishCalendar = localeMode === "en-US" || localeMode === "pseudo";
	const localeTag = isEnglishCalendar ? "en-US" : localeMode;
	const locale = isEnglishCalendar ? enUS : localeMode === "zh-TW" ? zhTW : zhCN;
	const period = useMemo(() => resolvePeriod(mode, anchor), [mode, anchor]);
	const anchorDate = useMemo(() => parseDayKey(anchor), [anchor]);
	const currentYear = new Date().getFullYear();

	// 周：周一到周日（闭区间），用本地 Date 构造 RDP DateRange matcher。
	const monday = useMemo(() => parseDayKey(period.start), [period.start]);
	const sunday = useMemo(() => parseDayKey(period.end), [period.end]);
	const selectedRange = useMemo(() => ({ from: monday, to: sunday }), [monday, sunday]);

	// 月：Popover 内的翻页年份，跟随 anchor 变化同步。
	const [displayYear, setDisplayYear] = useState(() => anchorDate.getFullYear());
	useEffect(() => {
		setDisplayYear(anchorDate.getFullYear());
	}, [anchorDate]);

	const yearOptions = useMemo(() => {
		const years: number[] = [];
		for (let y = currentYear; y >= minYear; y--) {
			years.push(y);
		}
		return years;
	}, [currentYear, minYear]);

	const modeButtons = (
		<div className="flex items-center gap-1">
			{MODES.map((m) => (
				<Button key={m} size="sm" variant={mode === m ? "secondary" : "ghost"} onClick={() => onModeChange(m)}>
					{t(`usageStats.dayDetail.range.${m === "day" ? "today" : m}`)}
				</Button>
			))}
		</div>
	);

	const dayTrigger = (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="justify-start font-normal">
					<CalendarIcon className="size-3.5 shrink-0" aria-hidden="true" />
					{anchor}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[320px] p-0" align="start">
				<Calendar
					mode="single"
					locale={locale}
					selected={anchorDate}
					classNames={{ root: "w-full" }}
					onSelect={(date) => {
						if (date) onAnchorChange(dayKeyOf(date));
					}}
				/>
			</PopoverContent>
		</Popover>
	);

	const weekTrigger = (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="justify-start font-normal">
					<CalendarIcon className="size-3.5 shrink-0" aria-hidden="true" />
					{formatPeriodTitle("week", period, localeTag)}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[320px] p-0" align="start">
				<Calendar
					locale={locale}
					selected={{ from: monday, to: sunday }}
					weekStartsOn={1}
					modifiers={{ range_start: monday, range_end: sunday, range_middle: selectedRange }}
					classNames={{ root: "w-full" }}
					onDayClick={(date) => {
						onAnchorChange(dayKeyOf(date));
					}}
				/>
			</PopoverContent>
		</Popover>
	);

	const monthTrigger = (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="justify-start font-normal">
					<CalendarIcon className="size-3.5 shrink-0" aria-hidden="true" />
					{formatPeriodTitle("month", period, localeTag)}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[280px] p-3" align="start">
				<div className="flex items-center justify-between">
					<Button variant="ghost" size="icon" className="size-7" disabled={displayYear <= minYear} onClick={() => setDisplayYear((y) => y - 1)} aria-label={t("pagination.previous")}>
						<ChevronLeftIcon className="size-4" />
					</Button>
					<span className="text-sm font-medium">{displayYear}</span>
					<Button variant="ghost" size="icon" className="size-7" disabled={displayYear >= currentYear} onClick={() => setDisplayYear((y) => y + 1)} aria-label={t("pagination.next")}>
						<ChevronRightIcon className="size-4" />
					</Button>
				</div>
				<div className="mt-2 grid grid-cols-3 gap-1">
					{Array.from({ length: 12 }, (_, i) => {
						const month = i + 1;
						const selectedMonth = anchorDate.getFullYear() === displayYear && anchorDate.getMonth() + 1 === month;
						return (
							<Button key={month} variant={selectedMonth ? "secondary" : "ghost"} size="sm" onClick={() => onAnchorChange(`${displayYear}-${String(month).padStart(2, "0")}-01`)}>
								{t(MONTH_KEYS[i])}
							</Button>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);

	const yearTrigger = (
		<Select value={String(anchorDate.getFullYear())} onValueChange={(year) => onAnchorChange(`${year}-01-01`)}>
			<SelectTrigger className="h-8 w-auto gap-2">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{yearOptions.map((year) => (
					<SelectItem key={year} value={String(year)}>
						{year}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);

	const triggerByMode: Record<UsagePeriodMode, React.ReactNode> = {
		day: dayTrigger,
		week: weekTrigger,
		month: monthTrigger,
		year: yearTrigger,
	};

	return (
		<div className="flex flex-wrap items-center gap-2">
			{modeButtons}
			{triggerByMode[mode]}
		</div>
	);
}
