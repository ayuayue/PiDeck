import type { AgentBackend } from "../../../../../shared/types";
import { useAtomValue } from "jotai";
import { t } from "../../../i18n";
import { acpToolsAtom } from "../../../atoms";
import { Avatar, AvatarFallback } from "../../ui-shadcn/avatar";
import { AcpToolLogo, DshLogo, PiLogo } from "../SessionSourceBadge";
import { formatTime } from "../TimelineFormat";

/**
 * AI 回复行头：圆形品牌头像 + 时间。
 *
 * 业务规则：
 * - 时间线必须同时展示 Pi 与 DSH logo。Pi 虽是默认后端，但回复气泡需要明确“是谁在说话”，
 *   不能沿用侧栏 `SessionBackendMark`「Pi 不署名」的降噪策略。
 * - 可见层只留 logo，不再跟文字（头像已能区分后端）；名称走 aria-label / title，
 *   给读屏和悬停辨认，避免纯装饰图标无法区分。
 * - ACP 会话按记录绑定的工具显示各家品牌 logo（OpenCode / Codex / Claude …），
 *   而不是统一的终端图标——否则同一会话里分不清是哪个 CLI 在回答；工具已删除时
 *   回退通用终端图标 + 通用名「ACP」。
 * - 头像走品牌内联 SVG（Fallback），不拉远程图，保证离线会话也能辨认。
 * - 行头只留时间戳；本轮模型名与耗时一起放 turn 尾部（见 TurnRow 底部耗时行），
 *   同一会话频繁换模型时用户视线本来就在回复底部。
 */
export function TurnAuthorHeader(props: { backend?: AgentBackend; acpToolId?: string; endedAt: number }) {
	const backend: AgentBackend = props.backend ?? "pi";
	const isDsh = backend === "dsh";
	const isAcp = backend === "acp";
	const acpTool = useAtomValue(acpToolsAtom).find((tool) => tool.id === props.acpToolId);
	const name = isDsh ? t("sessionBackend.dsh") : isAcp ? (acpTool?.name ?? t("sessionBackend.acp")) : t("sessionBackend.pi");

	return (
		<div className="mb-1 flex items-center gap-2" data-turn-author={backend} aria-label={name}>
			<Avatar title={name} className="bg-muted text-foreground">
				{/* 无 AvatarImage：品牌 logo 是矢量资源，失败态就是正常态。 */}
				<AvatarFallback delayMs={0} className="bg-transparent text-current">
					{isDsh ? <DshLogo className="size-4" /> : isAcp ? <AcpToolLogo tool={acpTool} className="size-4" /> : <PiLogo className="size-4" />}
				</AvatarFallback>
			</Avatar>
			{/* 时间/耗时数字统一走界面字体（与输入框下方统计条一致），不跟代码/路径一起用等宽字体；
			    数字本身等宽，流式跳动也不会左右抖（Segoe UI 等基数字体实测通过）。 */}
			<time className="shrink-0 text-body leading-none text-muted-foreground tabular-nums">{formatTime(props.endedAt)}</time>
		</div>
	);
}
