/**
 * WebSlashMenu — 输入框上方的 `/` 命令候选列表。
 *
 * 纯展示 + 点击上抛；键盘（↑↓ / Enter / Tab / Esc）由 WebComposer 处理，
 * 因为焦点始终要留在 textarea 上（手机端弹出列表时不能让虚拟键盘收起）。
 */
import { FileText, Sparkles, SquareTerminal, Zap } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { WebSlashItem } from "./webSlashCommands";

function SourceIcon({ source }: { source: WebSlashItem["source"] }) {
	const className = "size-3.5 shrink-0 text-muted-foreground";
	if (source === "skill") return <Sparkles className={className} aria-hidden="true" />;
	if (source === "prompt") return <FileText className={className} aria-hidden="true" />;
	if (source === "builtin") return <Zap className={className} aria-hidden="true" />;
	return <SquareTerminal className={className} aria-hidden="true" />;
}

export function WebSlashMenu(props: { items: WebSlashItem[]; activeIndex: number; onPick: (item: WebSlashItem) => void; onHover: (index: number) => void }) {
	return (
		<div
			// 浮在输入卡上方：不挤占正文高度，也不受滚动容器裁剪（composer-box 是 overflow-visible）。
			className="absolute inset-x-0 bottom-full z-20 mb-1.5 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
			role="listbox"
			aria-label={t("web.slashMenuLabel")}
			data-testid="web-slash-menu"
		>
			{props.items.length === 0 ? <div className="px-3 py-2.5 text-caption text-muted-foreground">{t("web.slashEmpty")}</div> : null}
			{/* scroll-ok: bounded —— 候选条数有硬上限（WEB_SLASH_MAX_ITEMS），不随数据无限增长。 */}
			<div className="max-h-[min(18rem,38dvh)] overflow-y-auto p-1">
				{props.items.map((item, index) => (
					<button
						key={`${item.source ?? "extension"}:${item.name}`}
						type="button"
						role="option"
						aria-selected={index === props.activeIndex}
						className={cn("flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors", index === props.activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}
						// 鼠标移动只更新高亮，不抢 textarea 焦点；点击时组件层 preventDefault 保住焦点。
						onPointerMove={() => props.onHover(index)}
						onPointerDown={(event) => event.preventDefault()}
						onClick={() => props.onPick(item)}
					>
						<SourceIcon source={item.source} />
						<span className="min-w-0 flex-1">
							<span className="block truncate font-mono text-control text-foreground">/{item.name}</span>
							{item.description ? <span className="mt-0.5 block truncate text-micro text-muted-foreground">{item.description}</span> : null}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
