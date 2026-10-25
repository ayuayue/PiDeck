import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";

/**
 * 密钥核对摘要：只露末几位与原长度，够认出「填反了 / 被截断 / 多了个空格」，不足以还原凭据。
 * 与主进程 VoiceTranscriptionConfigStore.secretHint 同算法，保证两处的摘要长得一样。
 * 刻意不 trim：尾随空格正是最常见的错法，算进长度才看得见。
 */
export type SecretHint = { tail: string; length: number };

export function secretHint(value: string): SecretHint | null {
	if (!value) return null;
	return { tail: value.slice(-Math.min(4, Math.floor(value.length / 2))), length: value.length };
}

/**
 * 密钥输入框（明文本来就常驻渲染层草稿的场景，如设置 → 生图）。
 *
 * 解决「全是脱敏点，根本看不到填了啥」：
 * - 掩码态在框下方常驻一行摘要，不点眼睛也能核对存的是哪一格、有没有被截断；
 * - 点眼睛才把明文摊开逐字比对；切换按钮不得抢输入框焦点（抢了会顺手触发一次变更）。
 *
 * 与语音设置的 SecretFieldInput 的区别：那边明文不出主进程，收起要把未改动的明文退回空草稿；
 * 这边整份配置本来就在草稿里随顶部「保存」整体落盘，所以只做呈现层切换，收起**不清值**——
 * 清值等于把用户没碰过的密钥一起抹掉。
 */
export function SecretValueInput(props: { value: string; onChange: (value: string) => void; label: string; hintText: string | null }) {
	const [revealed, setRevealed] = useState(false);
	return (
		<div className="grid gap-1">
			<div className="flex w-full items-center gap-1.5">
				<Input type={revealed ? "text" : "password"} value={props.value} aria-label={props.label} autoComplete="off" spellCheck={false} className="min-w-0 flex-1" onChange={(event) => props.onChange(event.target.value)} />
				<Button type="button" variant="ghost" size="icon-sm" className="shrink-0" onMouseDown={(event) => event.preventDefault()} onClick={() => setRevealed((prev) => !prev)} title={t(revealed ? "common.hide" : "common.show")} aria-label={t(revealed ? "common.hide" : "common.show")}>
					{revealed ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
				</Button>
			</div>
			{/* 明文已经摊开时摘要就是噪音，只在掩码态占一行 */}
			{props.hintText && !revealed ? <small className="px-0.5 text-caption text-muted-foreground">{props.hintText}</small> : null}
		</div>
	);
}
