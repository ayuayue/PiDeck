import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import type { SettingsSectionId, SettingsTabId } from "../../../atoms";
import { t } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { ensurePinyinTable } from "../../../utils/pinyinSearch";
import { Input } from "../../ui-shadcn/input";
import { buildSettingsSearchEntries } from "./settingsSearchEntries";
import { searchSettingsEntries, splitHighlightedTitle } from "./settingsSearch";

type SettingsSearchEntryItem = ReturnType<typeof buildSettingsSearchEntries>[number];

/**
 * 设置页搜索：工具条挂在**内容列顶部**（侧栏只有 196px，提示文案与结果行在窄列里
 * 必然换行截断——首版放侧栏顶部的方案因此废弃），输入即搜全部 tab 与设置项
 * （中文 / 英文 / 拼音首字母），结果直接替换内容区，选中后由调用方跳 tab 并滚到锚点。
 *
 * 为什么是「替换内容区」而不是下拉浮层：浮层要和弹窗滚动容器、层级与焦点圈打架；
 * 替换内容区给结果全宽的舒适行（标题 + tab 面包屑同一行），侧栏 tab 导航保持可见，
 * 用户随时能直接点 tab 离开搜索。设置草稿在 SettingsModal 层持有，内容被结果
 * 暂时替换不丢数据（tab 内容本来就按 activeTab 条件挂载）。
 *
 * 查询态由调用方持有（受控）：弹窗壳要在 Esc 时先清搜索再关弹窗，见 DialogContent
 * 的 onEscapeKeyDown。
 */
export function SettingsSearchBox(props: { entries: readonly SettingsSearchEntryItem[]; tabOrder: readonly SettingsTabId[]; query: string; onQueryChange: (query: string) => void; onPick: (entry: SettingsSearchEntryItem) => void; children: ReactNode }) {
	const [activeIndex, setActiveIndex] = useState(0);
	const listRef = useRef<HTMLUListElement | null>(null);
	const query = props.query;
	const searching = query.trim().length > 0;
	// 拼音字典按需装载：设置弹窗挂载时才拉（字典不进启动 chunk）。就绪前 pinyin 通道
	// 打 0 分，就绪后置位触发 hits 重算——用户从打开弹窗到输入第一个字之间的空档
	// 足够本地 chunk 毫秒级到位。失败静默（只损失拼音通道）。
	const [pinyinTableReady, setPinyinTableReady] = useState(false);
	useEffect(() => {
		let cancelled = false;
		ensurePinyinTable()
			.then(() => {
				if (!cancelled) setPinyinTableReady(true);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	const hits = useMemo(() => searchSettingsEntries(props.entries, query, props.tabOrder), [props.entries, props.tabOrder, query, pinyinTableReady]);

	// 查询变化后选中项回到第一条：否则「搜 A 时停在第 5 条，改成 B 还停在第 5 条」会误跳。
	useEffect(() => {
		setActiveIndex(0);
	}, [query]);

	// 键盘上下移动时把选中项滚进视野（结果 > 一屏时才看得出来在动）。
	useEffect(() => {
		if (!searching) return;
		const list = listRef.current;
		const active = list?.querySelector<HTMLElement>('[data-index="' + activeIndex + '"]');
		active?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, searching]);

	const pick = (entry: SettingsSearchEntryItem) => {
		props.onPick(entry);
		props.onQueryChange("");
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		// Esc 不在这里处理：Radix 在 document 捕获阶段先收到（组件内 stopPropagation 挡不住），
		// 由弹窗壳的 onEscapeKeyDown 统一拦截——搜索中清搜索，否则关弹窗。
		if (!searching || hits.length === 0) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex((index) => (index + 1) % hits.length);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex((index) => (index - 1 + hits.length) % hits.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const hit = hits[activeIndex] ?? hits[0];
			if (hit) pick(hit.entry);
		}
	};

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{/* 搜索工具条：内容列顶部，宽度足够让提示文案单行放下（truncate 兜底更窄的窗口）；
			    完整说明与键盘操作复用 settings.searchHint（也是输入框的 title 悬停提示）。 */}
			<div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-4 py-2 max-[820px]:px-3">
				<div className="relative w-full max-w-[420px]">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<Input
						type="search"
						value={query}
						onChange={(event) => props.onQueryChange(event.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={t("settings.searchPlaceholder")}
						aria-label={t("settings.searchPlaceholder")}
						title={t("settings.searchHint")}
						role="combobox"
						aria-expanded={searching}
						aria-controls={searching ? "settings-search-results" : undefined}
						aria-autocomplete="list"
						aria-activedescendant={searching && hits.length > 0 ? "settings-search-option-" + activeIndex : undefined}
						className="pl-9 pr-8 text-control [&::-webkit-search-cancel-button]:hidden"
					/>
					{query ? (
						<button type="button" onClick={() => props.onQueryChange("")} aria-label={t("common.clear")} title={t("common.clear")} className="absolute right-2 top-1/2 grid size-4 -translate-y-1/2 cursor-pointer place-items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground">
							<X className="size-3.5" aria-hidden="true" />
						</button>
					) : null}
				</div>
				{/* 提示文案常驻一行：中文/英文/拼音 + 键盘操作；窗口不够宽时收起（说明仍在输入框 title 里） */}
				<p className="min-w-0 flex-1 truncate text-caption text-muted-foreground max-[820px]:hidden">{t("settings.searchHint")}</p>
			</div>
			{searching ? (
				<ul ref={listRef} id="settings-search-results" role="listbox" aria-label={t("settings.searchPlaceholder")} className="min-h-0 flex-1 overflow-y-auto p-2">
					{hits.length === 0 ? <li className="px-3 py-6 text-center text-caption text-muted-foreground">{t("settings.searchNoResult")}</li> : null}
					{hits.map((hit, index) => (
						<li
							key={hit.entry.id}
							id={"settings-search-option-" + index}
							data-index={index}
							role="option"
							aria-selected={index === activeIndex}
							onMouseEnter={() => setActiveIndex(index)}
							onClick={() => pick(hit.entry)}
							className={cn("flex cursor-pointer items-baseline gap-3 rounded-md px-3 py-2", index === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground")}
						>
							<span className="min-w-0 flex-1 text-control">
								{splitHighlightedTitle(hit.entry.title, hit.titleIndices).map((segment, segmentIndex) =>
									segment.hit ? (
										<mark key={segmentIndex} className="bg-transparent font-semibold text-primary">
											{segment.text}
										</mark>
									) : (
										<span key={segmentIndex}>{segment.text}</span>
									),
								)}
							</span>
							{/* tab 面包屑：结果可能来自任何 tab，右侧标注归属；active 行的字色遵守
							    「--color-accent 是面不是字」，用 accent-foreground 的降透明度。 */}
							<span className={cn("shrink-0 text-caption", index === activeIndex ? "text-accent-foreground/75" : "text-muted-foreground")}>{hit.entry.title === hit.entry.tabLabel ? null : hit.entry.tabLabel}</span>
						</li>
					))}
				</ul>
			) : (
				<div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
			)}
		</div>
	);
}
