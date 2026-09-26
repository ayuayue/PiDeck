import { Mic, Square, X } from "lucide-react";
import type { VoiceTranscriptionState } from "../../hooks/useVoiceTranscription";
import { t } from "../../i18n";
import { Button } from "../motion/button";
import { Loader } from "../motion/loader";
import { VoiceLevelBars } from "./VoiceLevelBars";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";

/**
 * 语音输入控件：动效一律用已 vendored 的 beui 组件（motion/button、motion/loader），
 * 但几何与配色跟随输入框底栏既有语言（28px、rounded-md、text-foreground、hover:bg-muted/60），
 * 避免和左侧的「+ / 模型」chip 不齐，也避免抢走右侧那颗实心发送圆钮的视觉主次。
 *
 * 三个状态必须在**不看文字**时也能区分（用户反馈：以前只能看出在录音，不知道在不在转写）：
 * - idle：mic 图标 + beui Button（按下缩放 + 点击涟漪）；
 * - recording：红色胶囊 + 电平波纹（`VoiceLevelBars`，跟随真实麦克风音量，不说话不动）；
 * - transcribing：中性胶囊 + loader `helix`（波形塌缩成点的「解码中」语义）+ 文案呼吸。
 * 用不同变体而不是只换颜色：色盲/高对比主题下也能分辨。
 */
const BAR_BUTTON_CLASS = "size-7 rounded-md text-foreground hover:bg-muted/60";

/** 转写胶囊：与录音胶囊同为 28px 高，但走中性色 + 波形塌缩动效，避免与录音混淆。 */
const TRANSCRIBING_PILL_CLASS = "flex h-7 items-center gap-1 rounded-md bg-muted/60 pr-0.5 pl-1.5";

export function VoiceTranscriptionControls(props: { state: VoiceTranscriptionState; busy?: boolean; disabled?: boolean; readLevel: () => number; onStart: () => void; onStop: () => void; onCancel: () => void }) {
	const busyLabel = t(props.state === "requesting" ? "voice.requesting" : props.busy === false ? "voice.finalizing" : "voice.transcribing");
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
					<VoiceLevelBars readLevel={props.readLevel} label={t("voice.recording")} className="text-destructive" />
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
				<div className={TRANSCRIBING_PILL_CLASS}>
					{/* helix：波形塌缩成点的「正在解码」语义，和录音的电平波纹在形状上就不同。
					    两者都带 reduce-motion 降级（loader 内部统一处理）。
					    busy 为假时（队列已排空、等最后一段落地）停下动效，避免「空转骗人」。 */}
					{props.busy === false ? <Loader variant="dots" size={13} speed={1.1} label={busyLabel} className="text-muted-foreground" /> : <Loader variant="helix" size={13} speed={1.1} label={busyLabel} className="text-primary" />}
					<span className={`text-caption whitespace-nowrap text-muted-foreground ${props.busy === false ? "" : "animate-pulse"}`} aria-hidden="true">
						{busyLabel}
					</span>{" "}
					{/* 转写中必须可取消：本地 whisper 可能跑数秒，且队列里还有待处理分段。
					    之前这一支只渲染 loading 按钮，用户根本点不到取消。 */}
					<VoiceTip label={t("voice.cancel")}>
						<Button type="button" variant="ghost" size="icon" aria-label={t("voice.cancel")} className={BAR_BUTTON_CLASS} onClick={props.onCancel}>
							<X className="size-3.5" aria-hidden="true" />
						</Button>
					</VoiceTip>
				</div>
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
