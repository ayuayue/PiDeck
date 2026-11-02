import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { t } from "../../i18n";
import { planOutlineQuery } from "./timeline/outlineQueryPolicy";
import type { OutlineRailItem } from "./timeline/outlineRailTicks";

/**
 * 会话目录面板（右缘刻度条的展开态）。
 *
 * 折叠态是那列刻度：条数 = 可用高度 / 12，147 条提问被压成约 90 根，一根刻度背后
 * 可能差几条 —— 用户想找「第 87 条」只能点完再往下翻。展开态把完整目录摆出来。
 *
 * 四条硬约束（都来自真机/复审缺陷，改这里之前先看）：
 * 1. **必须是浮层，不得挤占消息区**。容器 .outline-hover 是 absolute，不占宽度。
 * 2. **必须标出当前轮**。刻度条有高亮，面板若只剩一个列表，用户展开后反而失去
 *    「我在哪」的定位感。展开时自动滚到当前轮。
 * 3. **序号是渲染顺序的属性，不是数据的属性**：直接用下标 + 1。merged 的顺序就是
 *    全量目录顺序（mergeOutlineRailItems 按 directory 逐条 push），与底部状态栏
 *    countUserTurns/outlineDirectory.length 同源。
 * 4. **[耦合点] 根节点的 class 名 "session-outline-panel" 被 SurfaceComponents 的
 *    wheel 转发逻辑用 closest() 判归属**（那里也写了指向本条的反向注释）。
 *    改类名会让面板内的滚轮重新被转给时间线 —— 表现是「面板滚不动、背景在动」。
 *    滚轮不能靠 stopPropagation 修：原生监听挂在比 React root 更内层的 container 上，
 *    冒泡阶段先执行，React 合成事件那时已经晚了。
 */
export const SESSION_OUTLINE_PANEL_WIDTH_PX = 288;
/** 行高固定 68px。
 *
 *  按主题的最坏情况算，不是按默认主题猜：
 *    内容 = 标题两行 + 时间行 + mt-0.5(2) + 上下 padding(py-1.5 = 12)
 *    text-xs 行高 16px（Tailwind 标准 12/16），两行 32
 *    text-micro 的行高有**三个值**（foundation.css 的 --line-height-micro）：
 *      默认 16 / 紧凑 15 / 宽松 18 —— 取最大 18
 *    最坏 = 32 + 2 + 18 + 12 = 64
 *  取 68 而不是 64：64 正好等于宽松主题的极限，字体渲染的亚像素偏差会吃掉 0 余量。
 *
 *  曾经写 44，再改成 60（按「17px 行高 + 12px 时间」估算），两种都溢出：
 *  行是绝对定位、height = virtualRow.size 且没有 overflow-hidden，多出来的内容会
 *  探到底部压到下一行上，真机上是「文字贴边 / 时间被切」。
 *
 *  不用 measureElement 动态测量：那要每次滚动重算全部行起点，正是这轮在拆的开销。
 *  固定高度 + line-clamp-2 截断更稳。 */
const ROW_HEIGHT_PX = 68;
/** 首帧 scrollRef 还是 null，tanstack 的 getTotalSize() 为 0，列表区高度塌成 0
 *  （面板只剩头部和底部两行，第二帧才撑开）。给三行兜底。 */
const MIN_LIST_HEIGHT_PX = ROW_HEIGHT_PX * 3;

export function SessionOutlinePanel(props: { items: readonly OutlineRailItem[]; activeId: string | undefined; onJump: (id: string) => void; onClose: () => void }) {
	const { items, activeId, onJump, onClose } = props;
	const [query, setQuery] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// 三态：none（不动）/ jump（找第 N 条）/ invalid（数字超范围）/ filter（按标题）
	const plan = useMemo(() => planOutlineQuery(query, items.length), [query, items.length]);

	/** 过滤结果带着原下标，序号显示必须用原下标（跳转目标的编号不能随搜索变）。 */
	const rows = useMemo(() => {
		const indexed = items.map((item, index) => ({ item, index }));
		if (plan.kind !== "filter") return indexed;
		return indexed.filter(({ item }) => item.title.toLowerCase().includes(plan.text));
	}, [items, plan]);

	// 滚动定位 effect 要读最新 rows，但不该因 rows 变化重跑（否则打字时列表被打回原位）。
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const jumpIndex = plan.kind === "jump" ? plan.index : undefined;

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT_PX,
		overscan: 8,
	});

	// ① mount 一次：落到当前轮。依赖刻意为空 —— 用户滚到第 30 行再打字时，
	//    rows 变化绝不能把列表拽回当前轮（那时他想看的是命中结果）。
	const activeIdRef = useRef(activeId);
	activeIdRef.current = activeId;
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const mountedRef = useRef(false);
	useEffect(() => {
		if (mountedRef.current) return;
		mountedRef.current = true;
		const id = activeIdRef.current;
		if (!id) return;
		const sourceIndex = itemsRef.current.findIndex((item) => item.id === id);
		if (sourceIndex < 0) return;
		const rowIndex = rowsRef.current.findIndex((row) => row.index === sourceIndex);
		if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "center" });
	}, [virtualizer]);

	// ② 数字跳转：滚到目标行并高亮（不过滤、不收起，用户还要看上下文）
	useEffect(() => {
		if (jumpIndex === undefined) return;
		const rowIndex = rowsRef.current.findIndex((row) => row.index === jumpIndex);
		if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "center" });
	}, [jumpIndex, virtualizer]);

	// ③ 文字过滤：滚到第一个命中，没有命中就不动
	useEffect(() => {
		if (plan.kind === "filter" && rows.length > 0) virtualizer.scrollToIndex(0);
		// 依赖必须是 plan 与 rows 本体，不能只取 plan.kind 与 rows.length：
		// 打字时 kind 一直叫 "filter"（字符串不变），条数也常常不变（「修改」与「修改代码」
		// 都命中 5 条）—— 那样 effect 不重跑，新的命中不从顶部开始展示。
		// scrollToIndex(0) 幂等，已在顶部时重复跑无害。
	}, [plan, rows, virtualizer]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const commitJump = useCallback(() => {
		if (jumpIndex === undefined) return;
		const target = rowsRef.current.find((row) => row.index === jumpIndex);
		if (target) onJump(target.item.id);
	}, [jumpIndex, onJump]);

	const hint = plan.kind === "invalid" ? t("outline.onlyRange", { count: items.length }) : plan.kind === "filter" ? t("outline.hits", { count: rows.length }) : "";
	const activeSourceIndex = plan.kind === "jump" ? plan.index : activeId ? items.findIndex((item) => item.id === activeId) : -1;

	return (
		<div
			className="session-outline-panel pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-lg"
			style={{ width: SESSION_OUTLINE_PANEL_WIDTH_PX }}
			role="dialog"
			aria-label={t("outline.panel")}
			onKeyDown={(event) => {
				// 焦点会移到列表项按钮上，Esc 必须挂在根节点，否则只有输入框有焦点时才管用
				if (event.key === "Escape") {
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
				<input
					ref={inputRef}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") commitJump();
					}}
					placeholder={t("outline.searchPlaceholder")}
					aria-label={t("outline.searchAria")}
					className="min-w-0 flex-1 rounded-md bg-muted/60 px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-accent"
				/>
				<button type="button" onClick={onClose} aria-label={t("outline.collapse")} className="shrink-0 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground">
					×
				</button>
			</div>
			{/* scroll-ok: nested —— 本层是右缘目录面板的浮层列表：行模型由本组件持有（rows + @tanstack/react-virtual 的 useVirtualizer，getVirtualItems 只挂载视口行），不接 <VirtualStack> 是因为那一层绑定的是一次性滚动视口与会话时间线；这里接上去会把它变成第二个时间线。虚拟化本身已经在做（虚拟行 + getTotalSize 撑高），所以它不是「没虚拟化的长列表」。 */}
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" style={{ minHeight: MIN_LIST_HEIGHT_PX }}>
				<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
					{virtualizer.getVirtualItems().map((virtualRow) => {
						const row = rows[virtualRow.index];
						if (!row) return null;
						const isActive = row.item.id === activeId;
						const isTarget = activeSourceIndex === row.index;
						return (
							<button
								key={row.item.id}
								type="button"
								onClick={() => onJump(row.item.id)}
								style={{ position: "absolute", top: 0, left: 0, width: "100%", height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
								className={`flex w-full items-start gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/60 ${isActive || isTarget ? "bg-accent-soft text-foreground" : "text-muted-foreground"}`}
							>
								<span className="w-7 shrink-0 text-right tabular-nums opacity-60">{row.index + 1}</span>
								<span className="min-w-0 flex-1">
									<span className={`line-clamp-2 break-words ${row.item.pending === true ? "opacity-60" : ""}`}>{row.item.title}</span>
									{row.item.time ? <span className="mt-0.5 block text-micro opacity-60">{row.item.time}</span> : null}
								</span>
							</button>
						);
					})}
				</div>
			</div>
			{/* 这里的条数是 merged 后的长度，可能与底部状态栏的「N 轮」差 1–2 条：
			    mergeOutlineRailItems 会在尾部追加「没有 entryId 的 live 消息」，刚发一条提问、
			    目录索引还没更新时面板会多一条；状态栏用 max(countUserTurns, directory.length)，
			    两者不是同一口径的边界。不改逻辑（那边 max 有它自己的理由），只说明差异来源，
			    否则以后有人对着两个数找不到原因。 */}
			<div className="border-t border-border px-2 py-1.5 text-micro text-muted-foreground">
				{t("outline.total", { count: items.length })}
				{hint ? ` · ${hint}` : ""}
			</div>
		</div>
	);
}
