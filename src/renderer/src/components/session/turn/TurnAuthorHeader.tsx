import type { AgentBackend } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Avatar, AvatarFallback } from "../../ui-shadcn/avatar";
import { DshLogo, PiLogo } from "../SessionSourceBadge";
import { formatTime } from "../TimelineFormat";

/**
 * AI 回复行头：圆形品牌头像 + 时间。
 *
 * 业务规则：
 * - 时间线必须同时展示 Pi 与 DSH logo。Pi 虽是默认后端，但回复气泡需要明确“是谁在说话”，
 *   不能沿用侧栏 `SessionBackendMark`「Pi 不署名」的降噪策略。
 * - 可见层只留 logo，不再跟文字（头像已能区分后端）；名称走 aria-label / title，
 *   给读屏和悬停辨认，避免纯装饰图标无法区分。
 * - 头像走品牌内联 SVG（Fallback），不拉远程图，保证离线会话也能辨认。
 */
export function TurnAuthorHeader(props: { backend?: AgentBackend; endedAt: number }) {
	const backend: AgentBackend = props.backend ?? "pi";
	const isDsh = backend === "dsh";
	const name = t(isDsh ? "sessionBackend.dsh" : "sessionBackend.pi");

	return (
		<div className="mb-1 flex items-center gap-2" data-turn-author={backend} aria-label={name}>
			<Avatar title={name} className="bg-muted text-foreground">
				{/* 无 AvatarImage：品牌 logo 是矢量资源，失败态就是正常态。 */}
				<AvatarFallback delayMs={0} className="bg-transparent text-current">
					{isDsh ? <DshLogo className="size-4" /> : <PiLogo className="size-4" />}
				</AvatarFallback>
			</Avatar>
			{/* 时间/耗时数字统一走界面字体（与输入框下方统计条一致），不跟代码/路径一起用等宽字体；
			    数字本身等宽，流式跳动也不会左右抖（Segoe UI 等基数字体实测通过）。 */}
			<time className="shrink-0 text-body leading-none text-muted-foreground tabular-nums">{formatTime(props.endedAt)}</time>
		</div>
	);
}
