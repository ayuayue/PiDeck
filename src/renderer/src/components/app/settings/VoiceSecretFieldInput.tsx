import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { VoiceTranscriptionSecretField, VoiceTranscriptionSecretHint } from "../../../../../shared/types/voiceTranscription";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";

/**
 * 密钥输入框。两件事一起解决「看不见就无从核对」：
 * - 未编辑时占位符直接显示主进程算好的摘要（末几位 + 总长），至少看得出存的是哪一格、有没有被截断；
 * - 点「显示」才按需向主进程取回明文填进框里逐字核对，收起时把没改动的明文退回空草稿。
 * 豆包有两格（App ID / Access Token），填反或多一个空格都只表现为服务端鉴权失败，所以这条自查入口必须有。
 */
export function SecretFieldInput(props: { value: string; disabled: boolean; field: VoiceTranscriptionSecretField; configured: boolean; hint: VoiceTranscriptionSecretHint | null; onChange: (value: string) => void; onBlur: () => void }) {
	const [revealed, setRevealed] = useState(false);
	/** 本次展开取回的明文，用来在收起时判断「用户没改过」从而可以安全地清空。 */
	const [revealedValue, setRevealedValue] = useState<string | null>(null);
	const placeholder = props.configured ? (props.hint ? t("voice.settings.apiKeyConfiguredWithHint", { tail: props.hint.tail, length: props.hint.length }) : t("voice.settings.apiKeyConfigured")) : t("voice.settings.apiKeyMissing");

	const toggle = async () => {
		if (revealed) {
			if (revealedValue !== null && props.value === revealedValue) props.onChange("");
			setRevealedValue(null);
			setRevealed(false);
			return;
		}
		setRevealed(true);
		// 框里已有草稿就直接看草稿；没配置则没有可取的东西。
		if (props.value.trim() || !props.configured) return;
		const plain = await desktopApi.voiceTranscription.revealSecret(props.field).catch(() => null);
		if (!plain) return;
		setRevealedValue(plain);
		props.onChange(plain);
	};

	return (
		<div className="flex w-full items-center gap-1.5">
			<Input
				type={revealed ? "text" : "password"}
				value={props.value}
				disabled={props.disabled}
				placeholder={placeholder}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => props.onChange(event.target.value)}
				onBlur={() => {
					// 只是「看了一眼」而没改动：不要触发等值落盘——落盘会把草稿清空，看起来像内容凭空消失了。
					if (revealedValue !== null && props.value === revealedValue) return;
					props.onBlur();
				}}
			/>
			{/* 切换可见性不能让输入框失焦，否则「先看一眼再改」会顺手触发一次落盘。 */}
			<Button type="button" variant="ghost" size="icon-sm" className="shrink-0" disabled={props.disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => void toggle()} title={t(revealed ? "common.hide" : "common.show")} aria-label={t(revealed ? "common.hide" : "common.show")}>
				{revealed ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
			</Button>
		</div>
	);
}
