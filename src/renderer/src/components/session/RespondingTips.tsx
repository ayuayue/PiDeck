import { Lightbulb } from "lucide-react";
import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { formatAccelerator, resolveShortcutBindings } from "../../../../shared/shortcuts";
import { useShortcutBindings } from "../../hooks/useShortcutBindings";
import { t } from "../../i18n";
import { respondingTipsHiddenAtom } from "../../atoms";
import { SESSION_FEATURE_TIPS } from "./sessionFeatureTips";

/** 每条提示的停留时长：状态条自身 1.8s 轮一句，提示必须明显更慢，否则两处文字同时跳会很吵。 */
const TIP_INTERVAL_MS = 7000;

/**
 * 流式响应状态条右侧的功能提示轮播（内容见 sessionFeatureTips.ts）。
 *
 * 视觉：一个灯泡图标 + 一行次要色小字，与状态文案之间用左侧细分割线区分层级，
 * 不做卡片、不加背景——它必须在消息流里保持"顺手看一眼"的存在感，不能抢状态本身。
 * 限宽 + 截断：提示是单行 nowrap 的旁注，窄窗口下宁可截断也不能把消息流撑宽。
 *
 * 可在设置 → 外观 → 功能模块里关掉（默认显示）：该开关只停提示本身，不影响提示里
 * 提到的任何功能，与其他「隐藏模块」一致。
 */
export function RespondingTips() {
	const hidden = useAtomValue(respondingTipsHiddenAtom);
	const { bindings, platform } = useShortcutBindings();
	// 随机起点：短回复往往撑不过一轮轮播，固定从第一条开始等于只有第一条有曝光
	const [index, setIndex] = useState(() => Math.floor(Math.random() * SESSION_FEATURE_TIPS.length));

	useEffect(() => {
		const timer = window.setInterval(() => setIndex((current) => (current + 1) % SESSION_FEATURE_TIPS.length), TIP_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, []);

	// 提前返回必须放在全部 hook 之后：开关在响应过程中被改时，hook 数量变化会直接抛
	// 「Rendered fewer hooks than expected」
	if (hidden) return null;

	const tip = SESSION_FEATURE_TIPS[index % SESSION_FEATURE_TIPS.length];
	// 设置未到手时用平台默认键位兜底：带 {shortcut} 的文案不能空着，否则会露出占位符
	const shortcutTable = bindings ?? resolveShortcutBindings(undefined, platform);
	const shortcut = tip.shortcutId ? formatAccelerator(shortcutTable[tip.shortcutId], platform) : undefined;

	return (
		<span className="ml-1 flex min-w-0 items-center gap-1.5 border-l border-border-subtle pl-2.5 text-micro text-muted-foreground">
			<Lightbulb className="size-3 shrink-0 opacity-70" aria-hidden="true" />
			{/* key=index 让新提示重新挂载，触发一次淡入；motion-safe 保证「减少动态效果」下不闪 */}
			<span key={index} className="max-w-[min(30rem,100%)] truncate motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500">
				{t(tip.textKey, shortcut ? { shortcut } : undefined)}
			</span>
		</span>
	);
}
