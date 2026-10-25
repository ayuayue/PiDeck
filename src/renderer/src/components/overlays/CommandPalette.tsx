import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fuzzyMatch } from "../../utils/commandPaletteFuzzy";
import { PALETTE_GROUP_ORDER, type PaletteCommand } from "../../utils/commandPaletteCommands";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui-shadcn/command";
import { t } from "../../i18n";

export type CommandPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	commands: readonly PaletteCommand[];
	placeholder: string;
	emptyMessage: string;
};

/**
 * 把命中下标渲染成高亮。
 *
 * 按 UTF-16 下标逐字符遍历（不是 Array.from）——fuzzyMatch 回传的就是 UTF-16 下标，
 * 用码点遍历会让带代理对的文本（emoji）高亮错位。
 */
function HighlightedText(props: { text: string; indices: number[] }) {
	const { text, indices } = props;
	if (indices.length === 0) return <>{text}</>;
	const hit = new Set(indices);
	const nodes: ReactNode[] = [];
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		nodes.push(
			hit.has(i) ? (
				<span key={i} className="font-semibold text-[var(--color-accent)]">
					{char}
				</span>
			) : (
				<span key={i}>{char}</span>
			),
		);
	}
	return <>{nodes}</>;
}

/**
 * 全局命令面板（Ctrl/Cmd+P）：模糊搜索「设置项 + 配置页 + 操作」。
 *
 * 交互层**全部交给 cmdk**（`ui-shadcn/command.tsx`）：键盘导航与循环、按分数排序、
 * 分组折叠空组、滚动跟随选中项、焦点陷阱、Esc / 点遮罩关闭、焦点归还，都是它的
 * 现成能力——这些恰恰是自研版本最容易出细节 bug 的地方（越界索引钳制、StrictMode
 * 下的渲染期副作用、关闭后焦点丢失，都实际踩过）。项目里另有 7 处命令面板式选择器
 * 同样基于 cmdk，样式与行为因此天然一致。
 *
 * 自己保留的只有两件事：
 * 1. **打分函数**（自定义 filter）——中文标题需要逐字子序列 + 词首/连续加权，
 *    cmdk 默认的 command-score 是为拉丁文本设计的，对中文的词首加权基本失效；
 * 2. **命中字符高亮**——cmdk 只回传分数、不回传位置，只能在 filter 里顺手记下来。
 *
 * 与侧栏会话搜索（Ctrl+F / MorphingSearch）是两条独立链路：那边是锚定侧栏搜索框的
 * morph 面板、搜项目/会话实体；这边是全局悬浮面板、搜配置与命令。刻意不合并——
 * 合并后两类结果的排序权重与分组语义会互相干扰。
 */
export function CommandPalette(props: CommandPaletteProps) {
	const { open, onOpenChange, commands, placeholder, emptyMessage } = props;
	const [query, setQuery] = useState("");

	/**
	 * 命中下标表（供标题高亮）：value → 下标数组。
	 *
	 * cmdk 会在每次搜索时对每个条目调用一遍 filter，正好是我们需要的时机，就在那里
	 * 顺手记下来。不做清理：条目数有限、下次搜索会覆盖写，且不再渲染的条目不会被读到。
	 */
	const highlightRef = useRef(new Map<string, number[]>());

	// 每次打开都从空查询开始——上次的关键词留着会让「一打开就少了一半结果」显得莫名其妙
	useEffect(() => {
		if (open) setQuery("");
	}, [open]);

	// 空查询时收起 onlyWhenSearching 条目（几十条字段级入口会把顶层入口淹没）
	const visibleCommands = useMemo(() => (query.trim() ? commands : commands.filter((command) => !command.onlyWhenSearching)), [commands, query]);

	/**
	 * 分组：组间顺序由 PALETTE_GROUP_ORDER 定，组内顺序交给 cmdk（按 filter 分数）。
	 * 未登记顺序的分组按「首次出现」追加，避免新增分组时结果凭空消失。
	 */
	const groups = useMemo(() => {
		const order = PALETTE_GROUP_ORDER.map((key) => t(key));
		const buckets = new Map<string, PaletteCommand[]>();
		for (const command of visibleCommands) {
			const bucket = buckets.get(command.group);
			if (bucket) bucket.push(command);
			else buckets.set(command.group, [command]);
		}
		const result: { name: string; commands: PaletteCommand[] }[] = [];
		for (const name of order) {
			const items = buckets.get(name);
			if (items) {
				result.push({ name, commands: items });
				buckets.delete(name);
			}
		}
		for (const [name, items] of buckets) result.push({ name, commands: items });
		return result;
	}, [visibleCommands]);

	/**
	 * 自定义 filter：返回 0~1 的分数（0 = 不显示），由 cmdk 决定排序与可见性。
	 *
	 * 约定：`keywords[0]` 必须是**标题**。条目 id 是唯一的（用它作 cmdk 的 value），
	 * 而标题可能重名，所以把标题放进 keywords 参与匹配、用 id 作 value。
	 * 高亮下标相对标题，超出标题长度的部分（命中落在副标题/别名上）直接丢弃，
	 * 否则高亮会指到标题之外。
	 */
	const filter = useCallback((_value: string, search: string, keywords?: string[]) => {
		const needle = search.trim();
		const [title = "", ...rest] = keywords ?? [];
		if (!needle) {
			highlightRef.current.set(_value, []);
			return 1;
		}
		const hit = fuzzyMatch(needle, [title, ...rest].join(" "));
		if (!hit) return 0;
		highlightRef.current.set(
			_value,
			hit.indices.filter((index) => index < title.length),
		);
		return hit.score;
	}, []);

	return (
		<CommandDialog
			open={open}
			onOpenChange={onOpenChange}
			title={placeholder}
			description={emptyMessage}
			// 贴视口上方（不用 Dialog 默认的垂直居中）+ 定宽：搜索面板靠近视线起点更好读
			className="top-[14vh] w-[min(640px,calc(100vw-2rem))] max-w-none translate-y-0 sm:max-w-none"
			commandProps={{ filter, loop: true }}
		>
			<CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
			<CommandList>
				<CommandEmpty>{emptyMessage}</CommandEmpty>
				{groups.map((group) => (
					<CommandGroup key={group.name} heading={group.name}>
						{group.commands.map((command) => {
							const Icon = command.icon;
							const indices = highlightRef.current.get(command.id) ?? [];
							return (
								<CommandItem
									key={command.id}
									value={command.id}
									// keywords[0] 必须是标题：filter 依赖这个约定取标题做匹配与高亮
									keywords={[command.title, ...(command.subtitle ? [command.subtitle] : []), ...(command.keywords ?? [])]}
									onSelect={() => {
										// 先关面板再执行：命令可能打开设置页/弹窗，面板留着会盖在上面
										onOpenChange(false);
										command.run();
									}}
								>
									{Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm text-foreground">
											<HighlightedText text={command.title} indices={indices} />
										</span>
										{command.subtitle ? <span className="block truncate text-xs text-muted-foreground">{command.subtitle}</span> : null}
									</span>
									{command.kbd ? <kbd className="flex h-6 shrink-0 items-center rounded-md border border-border px-1.5 text-micro text-muted-foreground">{command.kbd}</kbd> : null}
								</CommandItem>
							);
						})}
					</CommandGroup>
				))}
			</CommandList>
		</CommandDialog>
	);
}
