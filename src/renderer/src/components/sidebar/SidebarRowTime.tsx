import { formatRelativeTime } from "../../utils/relativeTime";

/**
 * 会话行尾的相对时间（历史会话行 / 关联子会话行 / 会话分组行共用同一份 markup）。
 *
 * hover / 行内聚焦时让位给右侧「⋯」按钮：用「宽度收拢」而不是 display:none——时间瞬时消失
 * 会让左侧胶囊一步跳到行尾（那一刻正好压在「⋯」上，150ms 后才被 padding 带回左边），
 * 改成与 padding 同步（同为 150ms 默认时长）收拢后胶囊是缓慢滑过去，任何一帧都不会越过「⋯」左缘。
 * w-max 保证非 hover 态宽度与 auto 完全一致（不写魔法宽度，「3天」这类文案不会被截）；
 * interpolate-size 让 max-content→0 可插值（Electron 43 / Chromium 142 支持）。
 * 不支持该属性的旧浏览器退化为瞬时收拢，胶囊在该帧会短暂压到「⋯」左缘——仅降级路径，
 * 比时间直接 display:none 时「整颗胶囊跳到行尾」轻得多，故不额外加延迟。
 *
 * 时间基准由调用方给（见 hooks/sidebar/useSessionActivityClock）：live 计时点优先，
 * 否则回落会话更新时间；`title` 给完整相对时间，窄侧栏被截断时仍可查。
 */
export function SidebarRowTime(props: { at: number }) {
	const label = formatRelativeTime(props.at);
	return (
		<span className="w-max shrink-0 overflow-hidden whitespace-nowrap text-micro tabular-nums text-muted-foreground transition-[width,opacity] [interpolate-size:allow-keywords] group-hover/row:w-0 group-hover/row:opacity-0 group-focus-within/row:w-0 group-focus-within/row:opacity-0" title={label}>
			{label}
		</span>
	);
}
