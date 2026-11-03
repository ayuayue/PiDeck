import { useId, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { AGENT_PROFILE_ICON_MAX_CHARS } from "../../../../../shared/types/agentProfile";
import { t } from "../../../i18n";
import { cn } from "@/lib/utils";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui-shadcn/popover";
import { AGENT_ICON_LUCIDE_IDS, AgentIcon } from "../AgentIcon";
import { agentIconValueOfLucide, parseAgentIcon } from "../agentIconCodec";

/**
 * 常用表情候选：覆盖「助手 / 编码 / 写作 / 分析 / 翻译 / 生活」几类常用形象。
 * 只放单个 emoji 字形，混入普通文字会让卡片图标变成一句话。
 */
const AGENT_ICON_EMOJIS = ["🤖", "🧠", "🪄", "✨", "🧩", "🔮", "🧪", "🧮", "📊", "📈", "🗂️", "📝", "✍️", "📚", "🎓", "🌏", "💬", "🎯", "🚀", "⚡", "🔥", "🌟", "🛠️", "🐛", "💻", "⌨️", "🎨", "🎧", "🔍", "🛡️", "⚖️", "🧭", "🌱", "🍀", "🐳", "🦉"];

interface AgentIconPickerProps {
	value: string;
	onChange: (next: string) => void;
	/** 触发按钮 id：编辑器把字段 Label 指到它。 */
	id?: string;
}

/**
 * 图标选择器：内置组件图标（落盘为 `lucide:<id>`）+ 常用表情 + 自定义 emoji 输入 + 清除。
 * 落盘格式与渲染规则见 `agentIconCodec.ts`：不带前缀的字符串一律按 emoji 文本渲染。
 */
export function AgentIconPicker({ value, onChange, id }: AgentIconPickerProps) {
	const [open, setOpen] = useState(false);
	const customInputId = useId();
	const parsed = parseAgentIcon(value);
	const selectedText = parsed.kind === "text" ? parsed.text : "";

	const pick = (next: string) => {
		onChange(next);
		setOpen(false);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button id={id} type="button" variant="outline" className="relative h-9 w-full justify-center px-2" title={t("agentMarket.iconPickerTitle")} aria-label={t("agentMarket.iconPickerTitle")}>
					<span className="flex items-center justify-center text-base leading-none">
						<AgentIcon icon={value} />
					</span>
					<ChevronDown className="absolute right-1.5 size-3 text-muted-foreground" aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			{/* 宽度按 8 列 × size-7 + gap-1 反推：280 - p-3×2 = 256 ≥ 8*28 + 7*4 = 252，再窄会横向溢出。 */}
			{/* scroll-ok: bounded —— 内容全部来自两个硬编码常量（AGENT_ICON_LUCIDE_IDS 图标目录 + AGENT_ICON_EMOJIS 表情候选），
			    外加一个自定义输入框和清除按钮：条数只跟这两份常量走、不随会话数据增长，高度另有 max-h-[min(60vh,360px)] 兜底。 */}
			<PopoverContent align="end" className="max-h-[min(60vh,360px)] w-[280px] overflow-y-auto p-3">
				<p className="mb-1.5 text-micro font-medium text-muted-foreground">{t("agentMarket.iconPickerBuiltin")}</p>
				<div className="grid grid-cols-8 gap-1">
					{AGENT_ICON_LUCIDE_IDS.map((iconId) => {
						const encoded = agentIconValueOfLucide(iconId);
						return (
							<button
								key={iconId}
								type="button"
								title={iconId}
								aria-label={iconId}
								aria-pressed={value.trim() === encoded}
								onClick={() => pick(encoded)}
								className={cn(
									"flex size-7 items-center justify-center rounded-md text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
									value.trim() === encoded && "bg-accent text-foreground ring-1 ring-ring/40",
								)}
							>
								<AgentIcon icon={encoded} />
							</button>
						);
					})}
				</div>
				<p className="mt-2.5 mb-1.5 text-micro font-medium text-muted-foreground">{t("agentMarket.iconPickerEmoji")}</p>
				<div className="grid grid-cols-8 gap-1">
					{AGENT_ICON_EMOJIS.map((emoji) => (
						<button
							key={emoji}
							type="button"
							aria-label={emoji}
							aria-pressed={selectedText === emoji}
							onClick={() => pick(emoji)}
							className={cn("flex size-7 items-center justify-center rounded-md text-base leading-none transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", selectedText === emoji && "bg-accent ring-1 ring-ring/40")}
						>
							{emoji}
						</button>
					))}
				</div>
				<label className="mt-2.5 mb-1.5 block text-micro font-medium text-muted-foreground" htmlFor={customInputId}>
					{t("agentMarket.iconPickerCustom")}
				</label>
				<Input id={customInputId} className="text-center" size="sm" value={selectedText} onChange={(event) => onChange(event.target.value.trim())} placeholder={t("agentMarket.iconPickerCustomPlaceholder")} maxLength={AGENT_PROFILE_ICON_MAX_CHARS} />
				{value.trim() ? (
					<Button type="button" variant="ghost" size="xs" className="mt-1.5 w-full justify-start text-xs text-muted-foreground" onClick={() => pick("")}>
						<X className="size-3" aria-hidden="true" />
						{t("agentMarket.iconPickerClear")}
					</Button>
				) : null}
			</PopoverContent>
		</Popover>
	);
}
