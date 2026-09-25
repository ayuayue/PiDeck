import { Mic, Square, X } from "lucide-react";
import type { VoiceTranscriptionState } from "../../hooks/useVoiceTranscription";
import { t } from "../../i18n";
import { Button, StatefulButton } from "../motion/button";
import { Loader } from "../motion/loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";

/**
 * 语音输入控件：动效一律用已 vendored 的 beui 组件（motion/button、motion/loader），
 * 但几何与配色跟随输入框底栏既有语言（28px、rounded-md、text-foreground、hover:bg-muted/60），
 * 避免和左侧的「+ / 模型」chip 不齐，也避免抢走右侧那颗实心发送圆钮的视觉主次。
 *
 * - idle：beui Button（按下缩放 + 点击涟漪）；
 * - recording：beui loader 的 bars 变体做电平感律动，停/取消收进同一颗胶囊；
 * - requesting / transcribing：beui StatefulButton 的 loading 态（宽度形变 + 逐字模糊滚入）。
 */
const BAR_BUTTON_CLASS = "size-7 rounded-md text-foreground hover:bg-muted/60";

export function VoiceTranscriptionControls(props: { state: VoiceTranscriptionState; disabled?: boolean; onStart: () => void; onStop: () => void; onCancel: () => void }) {
	const busyLabel = t(props.state === "requesting" ? "voice.requesting" : "voice.transcribing");
	return (
		<div className="flex h-7 shrink-0 items-center justify-end gap-1">
			{props.state === "idle" ? (
				<VoiceTip label={t("voice.start")}>
					<Button type="button" variant="ghost" size="icon" ripple disabled={props.disabled} aria-label={t("voice.start")} className={BAR_BUTTON_CLASS} onClick={props.onStart}>
						<Mic className="size-3.5" aria-hidden="true" />
					</Button>
				</VoiceTip>
			) : props.state === "recording" ? (
				<div className="flex h-7 items-center gap-0.5 rounded-md bg-destructive/10 pr-0.5 pl-1">
					<Loader variant="bars" size={13} speed={0.85} label={t("voice.recording")} className="text-destructive" />
					<VoiceTip label={t("voice.stopAndTranscribe")}>
						<Button type="button" variant="ghost" size="icon" aria-label={t("voice.stopAndTranscribe")} className="size-7 rounded-md text-destructive hover:bg-destructive/15 hover:text-destructive" onClick={props.onStop}>
							<Square className="size-3" fill="currentColor" aria-hidden="true" />
						</Button>
					</VoiceTip>
					<VoiceTip label={t("voice.cancel")}>
						<Button type="button" variant="ghost" size="icon" aria-label={t("voice.cancel")} className={BAR_BUTTON_CLASS} onClick={props.onCancel}>
							<X className="size-3.5" aria-hidden="true" />
						</Button>
					</VoiceTip>
				</div>
			) : (
				<VoiceTip label={busyLabel}>
					{/* StatefulButton 的 loading 态自带 aria-live 播报，无需再加 sr-only。 */}
					<StatefulButton state="loading" loadingText={busyLabel} variant="ghost" size="sm" className="h-7 rounded-md px-2 text-caption text-foreground">
						{""}
					</StatefulButton>
				</VoiceTip>
			)}
		</div>
	);
}

function VoiceTip(props: { label: string; children: React.ReactElement }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{props.children}</TooltipTrigger>
			<TooltipContent>{props.label}</TooltipContent>
		</Tooltip>
	);
}
