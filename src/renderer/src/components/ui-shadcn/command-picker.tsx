import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronsDownUp, ChevronsUpDown, ChevronDown, ChevronRight, X } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "./button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandList,
} from "./command";
import { cn } from "../../lib/utils";

type CommandPickerContextValue = {
	searchActive: boolean;
	allCollapsed: boolean;
	collapsedGroups: Set<string>;
	toggleGroup: (id: string) => void;
};

const CommandPickerContext = createContext<CommandPickerContextValue>({
	searchActive: false,
	allCollapsed: false,
	collapsedGroups: new Set(),
	toggleGroup: () => undefined,
});

/**
 * 可折叠的 Command 分组。折叠状态由共享面板统一持有，保证“全部展开/全部折叠”与单组操作一致。
 * 搜索期间强制展开，避免用户搜到隐藏分组中的项目却看不到结果。
 */
export function CommandPickerGroup(props: {
	id: string;
	label: ReactNode;
	count?: number;
	defaultOpen?: boolean;
	children: ReactNode;
	className?: string;
}) {
	const { searchActive, allCollapsed, collapsedGroups, toggleGroup } = useContext(CommandPickerContext);
	const expanded = searchActive || (!allCollapsed && !collapsedGroups.has(props.id));

	return (
		<div className={cn("border-b border-border/45 last:border-b-0", props.className)}>
			<button
				type="button"
				className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left text-control font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				aria-expanded={expanded}
				onClick={() => toggleGroup(props.id)}
			>
				{expanded ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
				<span className="min-w-0 flex-1 truncate">{props.label}</span>
				{props.count != null && <span className="font-mono text-caption text-muted-foreground/75">{props.count}</span>}
			</button>
			{expanded && <CommandGroup className="p-1">{props.children}</CommandGroup>}
		</div>
	);
}

/**
 * Command 选择器主体：统一标题、搜索、折叠控制、选中项定位、列表空态和底部操作区。
 * Dialog、Popover 只负责浮层容器，因此引导页和会话内选择器使用完全相同的内容结构。
 */
export function CommandPickerPanel(props: {
	title: ReactNode;
	hint?: ReactNode;
	searchPlaceholder: string;
	emptyLabel: ReactNode;
	value?: string;
	onValueChange?: (value: string) => void;
	onClose?: () => void;
	showGroupActions?: boolean;
	children: ReactNode;
	className?: string;
}) {
	const [search, setSearch] = useState("");
	const [allCollapsed, setAllCollapsed] = useState(false);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const listHostRef = useRef<HTMLDivElement | null>(null);

	const toggleGroup = (id: string) => {
		setAllCollapsed(false);
		setCollapsedGroups((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	// cmdk 会选中当前值，但不会保证它在 Portal 内的滚动容器中居中；这里统一补上定位。
	useEffect(() => {
		const value = props.value?.trim().toLowerCase();
		if (!value) return;
		const frame = window.requestAnimationFrame(() => {
			const items = listHostRef.current?.querySelectorAll<HTMLElement>("[data-picker-value]");
			const selected = Array.from(items ?? []).find(
				(item) => item.getAttribute("data-picker-value")?.toLowerCase() === value,
			);
			selected?.scrollIntoView({ block: "center" });
		});
		return () => window.cancelAnimationFrame(frame);
	}, [props.value]);

	return (
		<div className={cn("flex min-h-0 w-full flex-col overflow-hidden bg-popover text-popover-foreground", props.className)}>
			<header className="flex shrink-0 items-start justify-between gap-4 border-b border-border/60 px-4 py-3">
				<div className="min-w-0">
					<h2 className="truncate text-body font-semibold text-foreground">{props.title}</h2>
					{props.hint && <p className="mt-0.5 text-caption text-muted-foreground">{props.hint}</p>}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{props.showGroupActions && (
						<>
							<Button
								variant="ghost"
								size="icon-xs"
								className="text-muted-foreground hover:text-foreground"
								aria-label={t("app.modelExpandAllProviders")}
								title={t("app.modelExpandAllProviders")}
								onClick={() => {
									setAllCollapsed(false);
									setCollapsedGroups(new Set());
								}}
							>
								<ChevronsUpDown size={14} aria-hidden="true" />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								className="text-muted-foreground hover:text-foreground"
								aria-label={t("app.modelCollapseAllProviders")}
								title={t("app.modelCollapseAllProviders")}
								onClick={() => {
									setAllCollapsed(true);
									setCollapsedGroups(new Set());
								}}
							>
								<ChevronsDownUp size={14} aria-hidden="true" />
							</Button>
						</>
					)}
					{props.onClose && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="text-muted-foreground hover:text-foreground"
							aria-label={t("common.close")}
							title={t("common.close")}
							onClick={props.onClose}
						>
							<X size={16} strokeWidth={2} aria-hidden="true" />
						</Button>
					)}
				</div>
			</header>
			<Command defaultValue={props.value} onValueChange={props.onValueChange} className="min-h-0 rounded-none">
				<CommandInput
					onValueChange={setSearch}
					placeholder={props.searchPlaceholder}
					autoFocus
				/>
				<div ref={listHostRef} className="min-h-0">
					<CommandList className="max-h-[min(440px,55vh)] min-h-0">
						{search.trim() ? <CommandEmpty>{props.emptyLabel}</CommandEmpty> : null}
						<CommandPickerContext.Provider value={{ searchActive: search.trim().length > 0, allCollapsed, collapsedGroups, toggleGroup }}>
							{props.children}
						</CommandPickerContext.Provider>
					</CommandList>
				</div>
			</Command>
		</div>
	);
}
