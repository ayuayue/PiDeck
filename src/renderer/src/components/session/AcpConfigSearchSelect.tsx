import { useEffect, useRef, useState } from "react";
import { Check, Lock } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../ui-shadcn/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { AcpConfigGlyph } from "./AcpConfigGlyph";
import { AcpModelRateBadge } from "./AcpModelRateBadge";
import type { AcpConfigSelectModel } from "./acpConfigSelect";

/**
 * ACP 长枚举（模型列表）的可搜索下拉：Popover + cmdk。
 *
 * 为什么不用 Radix Select：ACP agent（Claude / OpenCode / Codex…）回传的模型枚举
 * 常常几十项平铺，Select 没有输入过滤，只能一路滚着找。短枚举（模式/思考档）仍走
 * Select，保持底栏轻量；这里只在模型或长列表时替换。
 *
 * 搜索匹配显示名 + 原始值（模型 id），用精确子串过滤而不是 cmdk 默认 fuzzy——
 * 后者对任意子序列都返回 >0，1-2 个字符的输入会把整张表都命中。
 */
export function AcpConfigSearchSelect(props: { option: { id: string; name: string; description?: string; category?: string; lockedReason?: string }; select: AcpConfigSelectModel; disabled?: boolean; onPick: (value: string) => void }) {
	const [open, setOpen] = useState(false);
	const listRef = useRef<HTMLDivElement | null>(null);

	// cmdk 用 defaultValue 选中当前项，但列表仍从顶部开始：打开时把选中行滚进视野，
	// 否则几十个模型的列表里根本看不到「现在用的是哪个」。
	useEffect(() => {
		if (!open) return;
		const frame = window.requestAnimationFrame(() => {
			listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "center" });
		});
		return () => window.cancelAnimationFrame(frame);
	}, [open]);

	// 收起态只显示名称：把当前项的 description（模型倍率等）带进悬停提示，不挤占底栏宽度。
	const currentValue = props.select.values.find((value) => value.value === props.select.value);
	const locked = props.option.lockedReason;
	const title = `${props.option.name}: ${props.select.label}${currentValue?.description ? ` — ${currentValue.description}` : ""}${props.option.description ? ` — ${props.option.description}` : ""}${locked === undefined ? "" : ` — ${locked}`}`;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					role="combobox"
					aria-expanded={open}
					aria-label={title}
					title={title}
					disabled={props.disabled}
					className="composer-bar-btn backend inline-flex h-7 max-w-56 min-w-0 items-center gap-1 rounded-md border-transparent bg-transparent px-1.5 text-control font-semibold text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-muted/60"
				>
					<AcpConfigGlyph option={props.option} />
					<span className="truncate text-xs">{props.select.label}</span>
					{locked === undefined ? null : <Lock size={12} strokeWidth={1.8} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" side="top" className="w-[min(360px,calc(100vw-24px))] p-0">
				<Command
					defaultValue={props.select.value || undefined}
					filter={(itemValue, search) => {
						const item = props.select.values.find((candidate) => candidate.value === itemValue);
						if (!item) return 1;
						const needle = search.trim().toLowerCase();
						if (!needle) return 1;
						return `${item.value} ${item.name} ${item.description ?? ""}`.toLowerCase().includes(needle) ? 1 : 0;
					}}
					className="rounded-none"
				>
					<CommandInput placeholder={t("app.modelPickerSearch")} autoFocus />
					<div ref={listRef}>
						<CommandList className="max-h-[min(320px,50vh)]">
							<CommandEmpty>{t("app.modelPickerEmpty")}</CommandEmpty>
							{props.select.values.map((value) => (
								<CommandItem
									key={value.value}
									value={value.value}
									keywords={value.description ? [value.name, value.description] : [value.name]}
									onSelect={() => {
										// 再点当前项等价于「保持不变」：不发 IPC（与 Radix Select 分支同口径）。
										if (value.value !== props.select.value) props.onPick(value.value);
										setOpen(false);
									}}
								>
									<Check className={cn("size-4 shrink-0", value.value === props.select.value ? "opacity-100" : "opacity-0")} aria-hidden="true" />
									<span className="flex min-w-0 flex-1 flex-col" title={value.description ? `${value.name} — ${value.description}` : value.name}>
										<span className="truncate">{value.name}</span>
										{value.description ? <span className="truncate text-micro text-muted-foreground">{value.description}</span> : null}
									</span>
									<AcpModelRateBadge rate={value.rate} />
								</CommandItem>
							))}
						</CommandList>
					</div>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
