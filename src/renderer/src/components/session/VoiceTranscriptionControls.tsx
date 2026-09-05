import { LoaderCircle, Mic, Square, X } from "lucide-react";
import type { VoiceTranscriptionState } from "../../hooks/useVoiceTranscription";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";

export function VoiceTranscriptionControls(props: {
	state: VoiceTranscriptionState;
	disabled?: boolean;
	onStart: () => void;
	onStop: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="flex h-7 w-[60px] shrink-0 items-center justify-end gap-1" aria-live="polite">
			{props.state === "idle" ? (
				<VoiceButton
					label={t("voice.start")}
					disabled={props.disabled}
					onClick={props.onStart}
				>
					<Mic className="size-3.5" aria-hidden="true" />
				</VoiceButton>
			) : props.state === "recording" ? (
				<>
					<VoiceButton label={t("voice.stopAndTranscribe")} onClick={props.onStop} tone="recording">
						<Square className="size-3" fill="currentColor" aria-hidden="true" />
					</VoiceButton>
					<VoiceButton label={t("voice.cancel")} onClick={props.onCancel}>
						<X className="size-3.5" aria-hidden="true" />
					</VoiceButton>
				</>
			) : (
				<VoiceButton
					label={t(props.state === "requesting" ? "voice.requesting" : "voice.transcribing")}
					disabled
				>
					<LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" />
				</VoiceButton>
			)}
			<span className="sr-only">
				{props.state === "recording"
					? t("voice.recording")
					: props.state === "requesting"
						? t("voice.requesting")
						: props.state === "transcribing"
							? t("voice.transcribing")
							: ""}
			</span>
		</div>
	);
}

function VoiceButton(props: {
	label: string;
	disabled?: boolean;
	tone?: "recording";
	onClick?: () => void;
	children: React.ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className={props.tone === "recording"
						? "size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
						: "size-7 text-muted-foreground hover:text-foreground"}
					disabled={props.disabled}
					aria-label={props.label}
					onClick={props.onClick}
				>
					{props.children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{props.label}</TooltipContent>
		</Tooltip>
	);
}
