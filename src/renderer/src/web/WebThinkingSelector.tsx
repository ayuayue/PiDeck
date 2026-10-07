/**
 * WebThinkingSelector — 思考档位选择（Composer 工具行驻留）。
 *
 * 第三批（DeepSeek 式交互）：
 * - pill 触发器常驻 composer 工具行（Brain 图标 + 当前档位短标签），与模型 pill 并排
 * - 点击弹 WebBottomSheet：窄屏底部滑出、宽屏居中卡片；每档一行（h-12 大触控行）
 * - 档位常量/文案映射从 WebHeader 迁出至此（唯一来源），Header 不再渲染思考控件
 */
import { useState } from "react";
import { Brain, Check } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebBottomSheet } from "./WebBottomSheet";

/** pi 支持的思考档位（顺序即展示顺序）；与桌面 thinking 选择一致。 */
export const WEB_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function webThinkingLabel(level: string) {
	switch (level) {
		case "minimal":
			return t("thinking.levelLabel.minimal");
		case "low":
			return t("thinking.levelLabel.low");
		case "medium":
			return t("thinking.levelLabel.medium");
		case "high":
			return t("thinking.levelLabel.high");
		case "xhigh":
			return t("thinking.levelLabel.xhigh");
		case "max":
			return t("thinking.levelLabel.max");
		default:
			return t("thinking.levelLabel.off");
	}
}

export function WebThinkingSelector(props: { level?: string; onChange: (level: string) => void }) {
	const [open, setOpen] = useState(false);
	const current = props.level ?? "off";

	return (
		<>
			<Button type="button" variant="ghost" className="h-8 shrink-0 gap-1 px-1 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label={t("web.thinking")} title={t("web.thinkingSheetTitle")} onClick={() => setOpen(true)}>
				<Brain className="size-4 shrink-0" aria-hidden="true" />
				{/* 窄屏只显 Brain 图标：档位文字（如 max）会挤压发送按钮，宽屏再展开 */}
				<span className="hidden min-w-0 truncate sm:inline">{webThinkingLabel(current)}</span>
			</Button>
			<WebBottomSheet open={open} onOpenChange={setOpen} title={t("web.thinkingSheetTitle")}>
				<ul className="pb-[max(env(safe-area-inset-bottom),0.5rem)]">
					{WEB_THINKING_LEVELS.map((level) => (
						<li key={level}>
							<button
								type="button"
								className={cn("flex h-12 w-full items-center gap-2 px-4 text-left text-sm text-foreground transition-colors hover:bg-muted/60 active:bg-muted", level === current && "text-primary")}
								onClick={() => {
									props.onChange(level);
									setOpen(false);
								}}
							>
								<span className="min-w-0 flex-1 truncate">{webThinkingLabel(level)}</span>
								{level === current ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
							</button>
						</li>
					))}
				</ul>
			</WebBottomSheet>
		</>
	);
}
