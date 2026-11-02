/**
 * WebBackendMark — Web 端会话后端标记（侧栏会话行与头部共用的 size-4 图标位）。
 *
 * 不复用桌面 SessionBackendBadge 的原因：其 ACP/生图分支是「图标+文字」Badge，
 * 塞进 16px 图标位会把 "Agent CLI" 换行成竖条溢出压住标题（用户截图反馈的丑角标）。
 * 桌面端同等问题已由 AcpBackendMark 解决（按工具出品牌 logo）；Web 没有 jotai
 * acpToolsAtom，/api/state 的安全投影也只外发 {id, name}（command/args 不外发），
 * 所以品牌只能按显示名推断，推断不出回退通用终端图标——与桌面同一观感。
 */
import { ImageIcon } from "lucide-react";
import type { AgentBackend } from "../../../shared/types";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { AcpToolLogo, DshLogo } from "@/components/session/SessionSourceBadge";
import type { WebAcpTool } from "./webTypes";

export function WebBackendMark(props: { backend?: AgentBackend; acpToolId?: string; acpTools?: WebAcpTool[]; className?: string }) {
	const className = cn("shrink-0", props.className ?? "size-4");
	switch (props.backend) {
		case "dsh": {
			const label = t("sessionBackend.dsh");
			return (
				<span role="img" aria-label={label} title={label} className={cn("inline-flex", className)}>
					<DshLogo className="size-3.5" />
				</span>
			);
		}
		case "acp": {
			const tool = props.acpTools?.find((item) => item.id === props.acpToolId);
			const label = tool?.name || t("sessionBackend.acp");
			return (
				<span role="img" aria-label={label} title={label} className={cn("inline-flex", className)}>
					<AcpToolLogo tool={tool ? { command: "", args: [], name: tool.name } : undefined} className="size-3.5" />
				</span>
			);
		}
		case "imagegen": {
			const label = t("sessionBackend.imagegen");
			return (
				<span role="img" aria-label={label} title={label} className={cn("inline-flex", className)}>
					<ImageIcon className="size-3.5" aria-hidden="true" />
				</span>
			);
		}
		default:
			// pi 是默认运行时不署名（与桌面 SessionBackendMark 同一降噪策略）；videogen 不打标。
			return null;
	}
}
