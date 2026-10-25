import { Brain, FileText, MessageCircle, Wrench } from "lucide-react";
import type { AgentRunItem, RenderMessage } from "../app/AppUtils";
import { summarizeMessage } from "../app/AppUtils";
import { formatTime, stripAnsi } from "./TimelineFormat";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Label } from "../ui-shadcn/label";
import { getRunSelectionState, getToolSummaries } from "../../utils/messageSelection";

/**
 * 多选消息树（共享 presentational 组件）。
 * MessageShareModal 与 SessionReferenceModal 共用，保证两处勾选行为与视觉完全一致。
 *
 * 结构：用户消息为独立行；agent-run 为卡片（头部三态 checkbox 整组切换，
 * 子区 = assistant 消息行 + 工具只读摘要行）。工具/思考不参与勾选，只读展示。
 */
export function MessageSelectionTree(props: { items: RenderMessage[]; selectedIds: ReadonlySet<string>; onToggleMessage: (id: string) => void; onToggleRun: (run: AgentRunItem) => void }) {
	return (
		<div className="flex flex-col gap-1.5">
			{props.items.map((item) => {
				if (item.kind === "message") {
					const msg = item.message;
					if (msg.role !== "user" && msg.role !== "assistant") return null;
					const isChecked = props.selectedIds.has(msg.id);
					return <MessageRow key={msg.id} checked={isChecked} onToggle={() => props.onToggleMessage(msg.id)} text={summarizeMessage(stripAnsi(msg.text))} icon={<MessageCircle size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />} />;
				}

				if (item.kind === "agent-run") {
					const assistantSubs = item.items.filter((i): i is Extract<typeof i, { kind: "message" }> => i.kind === "message" && i.message.role === "assistant");
					if (assistantSubs.length === 0) return null;
					const runState = getRunSelectionState(props.selectedIds, item);
					const toolSummaries = getToolSummaries(item);
					return (
						<div key={item.id} className="overflow-hidden rounded-lg border border-border-subtle bg-bg-muted/50">
							{/* run 头部：整组切换；checkbox 三态表达部分勾选 */}
							<div
								role="button"
								tabIndex={0}
								className="flex cursor-pointer select-none items-center gap-2.5 border-b border-border-subtle px-2.5 py-2 text-control transition-[background] duration-fast hover:bg-bg-hover focus-visible:bg-bg-hover focus-visible:outline-none"
								onClick={() => props.onToggleRun(item)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										props.onToggleRun(item);
									}
								}}
							>
								<Checkbox checked={runState === "checked" ? true : runState === "indeterminate" ? "indeterminate" : false} aria-label={item.id} className="shrink-0" onClick={(event) => event.stopPropagation()} onCheckedChange={() => props.onToggleRun(item)} />
								<Brain size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
								<span className="font-mono text-caption font-semibold tracking-[0.4px] text-text-secondary">Pi</span>
								<span className="shrink-0 text-caption whitespace-nowrap text-text-tertiary">{formatTime(item.endedAt)}</span>
								<span className="ml-auto shrink-0 rounded-full bg-bg-muted px-2 py-0.5 font-mono text-micro text-text-tertiary">{assistantSubs.length}</span>
							</div>
							<div className="flex flex-col gap-0.5 bg-bg-panel p-1.5 pl-4">
								{assistantSubs.map((sub) => {
									const id = sub.message.id;
									return <MessageRow key={id} checked={props.selectedIds.has(id)} onToggle={() => props.onToggleMessage(id)} text={summarizeMessage(stripAnsi(sub.message.text))} icon={<FileText size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />} />;
								})}
								{/* 工具只读摘要行：不参与勾选，提示该轮包含哪些工具调用 */}
								{toolSummaries.map((summary) => (
									<div key={summary.name} className="flex cursor-default items-center gap-2.5 px-2.5 py-1 text-caption text-text-tertiary">
										<Wrench size={12} className="shrink-0" aria-hidden="true" />
										<span className="min-w-0 truncate font-mono">{summary.name}</span>
										{summary.count > 1 ? <span className="shrink-0 rounded-full bg-bg-muted px-1.5 py-px font-mono text-micro">×{summary.count}</span> : null}
									</div>
								))}
							</div>
						</div>
					);
				}

				return null;
			})}
		</div>
	);
}

/** 单条可勾选消息行（用户消息 / run 内 assistant 消息共用）。 */
function MessageRow(props: { checked: boolean; onToggle: () => void; text: string; icon: React.ReactNode }) {
	return (
		<Label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-transparent px-2.5 py-2 leading-relaxed font-normal text-control transition-[background,border-color] duration-fast hover:border-border-subtle hover:bg-bg-hover">
			<Checkbox checked={props.checked} className="m-0 shrink-0" onCheckedChange={() => props.onToggle()} />
			{props.icon}
			<span className="min-w-0 flex-1 truncate text-text-primary">{props.text}</span>
		</Label>
	);
}
