import { memo, useState } from "react";
import { useAtomValue } from "jotai";
import { ArrowUpRight, CornerDownRight, Network, Send } from "lucide-react";
import type { ChatMessage } from "../../../../shared/types";
import type { LinkedSessionProposal, LinkedSessionProposalAnswer, LinkedSessionProposalStatus } from "../../../../shared/types/linkedSessions";
import { linkedSessionLinkByChildIdAtom, linkedSessionProposalIndexAtom } from "../../atoms/linked-session-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { useSessionPaneServices } from "./SessionPaneServices";
import { getToolDetailText, getToolName, getToolStatus } from "./TimelineFormat";

/**
 * 关联会话三件工具（start_session / send_to_session / list_linked_sessions）的时间线卡片。
 * start_session 的 offer / own_initiative 在这里出「新会话 / 在此做 / 不要」按钮；按钮只经
 * linked-sessions:answer IPC 作答，建不建会话由主进程按提议状态机裁决（重复点击无副作用）。
 */

export const LINKED_SESSION_TOOL_NAMES = new Set(["start_session", "send_to_session", "list_linked_sessions"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readArgs(message: ChatMessage): Record<string, unknown> {
	const args = message.meta?.args;
	if (isRecord(args)) return args;
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args) as unknown;
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}

/** pi 工具结果是 `{content:[{type:"text",text}]}`；历史投影可能只剩字符串。 */
function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (isRecord(result) && Array.isArray(result.content)) {
		return result.content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
	}
	return "";
}

function readResult(message: ChatMessage): { data?: Record<string, unknown>; error?: string } {
	const text = resultText(message.meta?.result) || getToolDetailText(message) || "";
	const trimmed = text.trim();
	if (!trimmed) return {};
	if (trimmed.startsWith("失败：")) return { error: trimmed.slice(3) };
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return isRecord(parsed) ? { data: parsed } : {};
	} catch {
		return {};
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function proposalStatusLabel(status: LinkedSessionProposalStatus): string {
	switch (status) {
		case "pending":
			return t("linkedSessions.status.pending");
		case "started":
			return t("linkedSessions.status.started");
		case "here":
			return t("linkedSessions.status.here");
		case "dismissed":
			return t("linkedSessions.status.dismissed");
		case "expired":
			return t("linkedSessions.status.expired");
	}
}

/** 结果里的 status（工具返回）映射到提议状态，供提议已不在快照里（历史会话）时展示。 */
function statusFromResult(value: unknown): LinkedSessionProposalStatus | undefined {
	switch (value) {
		case "started":
			return "started";
		case "do_here":
			return "here";
		case "declined":
			return "dismissed";
		case "no_answer":
			return "expired";
		case "proposed":
			return "pending";
		default:
			return undefined;
	}
}

export const LinkedSessionToolCard = memo(function LinkedSessionToolCard(props: { message: ChatMessage; stopped?: boolean }) {
	const toolName = getToolName(props.message);
	const toolStatus = getToolStatus(props.message);
	const args = readArgs(props.message);
	const result = readResult(props.message);
	const proposalIndex = useAtomValue(linkedSessionProposalIndexAtom);
	const linkByChildId = useAtomValue(linkedSessionLinkByChildIdAtom);
	const services = useSessionPaneServices();
	const [busy, setBusy] = useState<LinkedSessionProposalAnswer | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const toolCallId = str(props.message.meta?.toolCallId);
	const resultProposalId = str(result.data?.proposalId) ?? str(args.proposal_id);
	const proposal: LinkedSessionProposal | undefined = (toolCallId ? proposalIndex.byToolCallId.get(toolCallId) : undefined) ?? (resultProposalId ? proposalIndex.byId.get(resultProposalId) : undefined);
	const childSessionId = proposal?.childSessionId ?? str(result.data?.sessionId) ?? (toolName === "send_to_session" ? str(args.session_id) : undefined);
	const childLink = childSessionId ? linkByChildId.get(childSessionId) : undefined;

	const openChild = () => {
		if (!childSessionId) return;
		const projectId = childLink?.projectId ?? services.activeProjectId;
		if (projectId) void services.openSidebarSessionById?.(projectId, childSessionId);
	};

	const answer = async (choice: LinkedSessionProposalAnswer) => {
		if (!proposal || busy) return;
		setBusy(choice);
		setActionError(null);
		try {
			const outcome = await desktopApi.linkedSessions.answer({ proposalId: proposal.id, answer: choice });
			if (!outcome.ok) setActionError(outcome.error);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(null);
		}
	};

	if (toolName === "list_linked_sessions") {
		const children = Array.isArray(result.data?.children) ? result.data.children.length : undefined;
		return (
			<div className="linked-session-card my-1 flex items-center gap-2 px-1 text-chat-detail text-text-tertiary" data-tool-name={toolName}>
				<Network size={12} aria-hidden="true" />
				<span>{t("linkedSessions.cardList")}</span>
				{children !== undefined && <span className="tabular-nums">{t("linkedSessions.childCount", { count: children })}</span>}
			</div>
		);
	}

	const initiation = str(args.initiation) ?? proposal?.initiation ?? (args.proposal_id ? "own_initiative" : "offer");
	const heading = toolName === "send_to_session" ? t("linkedSessions.cardSend") : initiation === "user_asked" ? t("linkedSessions.cardUserAsked") : initiation === "own_initiative" ? t("linkedSessions.cardOwnInitiative") : t("linkedSessions.cardOffer");
	const title = proposal?.title ?? str(args.title) ?? childLink?.title ?? str(result.data?.title) ?? "";
	const brief = proposal?.prompt ?? str(args.prompt) ?? (toolName === "send_to_session" ? str(args.message) : undefined);
	const effectiveStatus: LinkedSessionProposalStatus | undefined = proposal?.status ?? statusFromResult(result.data?.status);
	const pending = proposal?.status === "pending" && !(props.stopped && proposal.initiation === "offer");
	const errorText = actionError ?? result.error;

	return (
		<div className={cn("linked-session-card my-1.5 rounded-lg border border-border-subtle px-3 py-2", pending && "border-warning/40")} data-tool-name={toolName} data-proposal-status={effectiveStatus ?? ""}>
			<div className="flex min-w-0 items-center gap-2">
				{toolName === "send_to_session" ? <Send size={13} className="shrink-0 text-text-tertiary" aria-hidden="true" /> : <CornerDownRight size={13} className="shrink-0 text-text-tertiary" aria-hidden="true" />}
				<span className="shrink-0 text-chat-detail text-text-tertiary">{heading}</span>
				<span className="min-w-0 flex-1 truncate font-medium" title={title}>
					{title}
				</span>
				{toolName === "start_session" && effectiveStatus && (
					<Badge variant="outline" className={cn("shrink-0 px-1 py-0 text-chat-detail", pending ? "border-warning/40 text-warning" : "border-border-subtle text-text-tertiary")}>
						{proposalStatusLabel(effectiveStatus)}
					</Badge>
				)}
				{toolName === "start_session" && !effectiveStatus && toolStatus === "running" && (
					<Badge variant="outline" className="shrink-0 border-warning/40 px-1 py-0 text-chat-detail text-warning">
						{t("tool.statusRunning")}
					</Badge>
				)}
			</div>
			{brief && (
				<details className="mt-1 text-chat-detail text-text-secondary">
					<summary className="cursor-pointer select-none text-text-tertiary">{t("linkedSessions.showBrief")}</summary>
					{/* scroll-ok: text —— 单段简报正文，没有行列表可切。 */}
					<div className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{brief}</div>
				</details>
			)}
			{errorText && <div className="mt-1 text-chat-detail text-danger">{t("linkedSessions.actionFailed", { error: errorText })}</div>}
			{(pending || (childSessionId && toolName === "start_session")) && (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{pending && (
						<>
							<Button type="button" size="sm" disabled={busy !== null} onClick={() => void answer("new")}>
								{t("linkedSessions.newSession")}
							</Button>
							<Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void answer("here")}>
								{t("linkedSessions.doHere")}
							</Button>
							<Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void answer("dismiss")}>
								{t("linkedSessions.dismiss")}
							</Button>
						</>
					)}
					{!pending && childSessionId && (
						<Button type="button" size="sm" variant="outline" onClick={openChild}>
							<ArrowUpRight size={13} aria-hidden="true" />
							{t("linkedSessions.open")}
						</Button>
					)}
				</div>
			)}
		</div>
	);
});
