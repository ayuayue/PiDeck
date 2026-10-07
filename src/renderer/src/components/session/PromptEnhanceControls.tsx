import { Sparkles, Square } from "lucide-react";
import type { PromptEnhanceView } from "../../hooks/usePromptEnhance";
import { t } from "../../i18n";
import { Button } from "../motion/button";
import { Loader } from "../motion/loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";

/**
 * 提示词增强控件（底栏入口，无浮层）。
 *
 * 动效语言与语音转写控件同源（28px 胶囊、beui motion Button/Loader、形状区分状态）。
 * 曾在输入框上方加过流式预览面板，实测遮挡输入框内容被移除——进度语义收敛到
 * 底部胶囊自身：Loader 形态 + 文案 + 字数跳动已足够表达「正在写、写多少」。
 * 三态不看文字也能区分：
 * - idle：✦ 图标按钮；
 * - starting（模型未吐首字）：中性胶囊 + helix loader；
 * - streaming（增长中）：主色 loader + 字数跳动；任意时刻可点 ■ 停止。
 */
const BAR_BUTTON_CLASS = "size-7 rounded-md text-foreground hover:bg-muted/60";
const RUNNING_PILL_CLASS = "flex h-7 items-center gap-1 rounded-md bg-muted/60 pr-0.5 pl-1.5";

export function PromptEnhanceControls(props: { disabled?: boolean; view: PromptEnhanceView; modelLabel?: string; onStart: () => void; onCancel: () => void }) {
	const running = props.view.phase !== "idle";
	const startTip = props.modelLabel ? `${t("enhance.start")} · ${props.modelLabel}` : t("enhance.start");
	const busyLabel = props.view.phase === "starting" ? t("enhance.starting") : `${t("enhance.streaming")} · ${t("enhance.chars", { count: props.view.chars })}`;

	return running ? (
		<div className={RUNNING_PILL_CLASS} role="status" aria-live="polite">
			<Loader variant="helix" size={13} speed={1.1} label={busyLabel} className={props.view.phase === "starting" ? "text-muted-foreground" : "text-primary"} />
			<span className="text-caption max-w-40 truncate whitespace-nowrap text-muted-foreground" aria-hidden="true">
				{busyLabel}
			</span>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button type="button" variant="ghost" size="icon" aria-label={t("enhance.stop")} className="size-7 shrink-0 rounded-md text-destructive hover:bg-destructive/15 hover:text-destructive" onClick={props.onCancel}>
						<Square className="size-3" fill="currentColor" aria-hidden="true" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("enhance.stop")}</TooltipContent>
			</Tooltip>
		</div>
	) : (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button type="button" variant="ghost" size="icon" ripple disabled={props.disabled} aria-label={t("enhance.start")} className={BAR_BUTTON_CLASS} onClick={props.onStart}>
					<Sparkles className="size-3.5" aria-hidden="true" />
				</Button>
			</TooltipTrigger>
			<TooltipContent>{startTip}</TooltipContent>
		</Tooltip>
	);
}
