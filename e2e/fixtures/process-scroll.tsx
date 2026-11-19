import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "jotai";
import { MessageScroller, type MessageScrollerScrollApi } from "../../src/renderer/src/components/agents/message-scroller";
import { ProcessFold } from "../../src/renderer/src/components/session/turn/ProcessFold";
import { ProcessSummaryToggle } from "../../src/renderer/src/components/session/turn/ProcessSummaryToggle";
import { EMPTY_PROCESS_GROUP_STATE, advanceAutoGroup, toggleGroupByUser } from "../../src/renderer/src/components/session/turn/useProcessGroupState";
import type { TurnProcessNode } from "../../src/renderer/src/components/session/timeline/groupTurnProcess";
import { TooltipProvider } from "../../src/renderer/src/components/ui-shadcn/tooltip";
import { Collapsible, CollapsibleContent } from "../../src/renderer/src/components/ui-shadcn/collapsible";
import type { ChatMessage } from "../../src/shared/types";
import "../../src/renderer/src/styles.css";

const params = new URLSearchParams(location.search);
const count = Number(params.get("count") ?? 8);
const height = Number(params.get("height") ?? 480);
const live = params.has("live");
const initialOpen = !params.has("closed");
const diff = params.has("diff");
const noop = () => {};

/** 挂真实会话滚动区、过程组和工具输出，数据使用内存 fixture，不启动后端进程。 */
function Fixture() {
	const [extra, setExtra] = useState(0);
	const [open, setOpen] = useState(initialOpen);
	const [following, setFollowing] = useState(true);
	const [groupState, setGroupState] = useState(() => (initialOpen ? advanceAutoGroup(EMPTY_PROCESS_GROUP_STATE, "group-main") : EMPTY_PROCESS_GROUP_STATE));
	const scrollApi = useRef<MessageScrollerScrollApi | null>(null);
	const nodes = useMemo<TurnProcessNode[]>(() => {
		const messages: ChatMessage[] = Array.from({ length: count + extra }, (_, index) => {
			const output = `output-${index}\n${Array.from({ length: 80 }, (_, line) => `result line ${index}-${line} with readable tool output`).join("\n")}`;
			return {
				id: `tool-${index}`,
				agentId: "process-scroll",
				role: "tool",
				text: output,
				timestamp: 1000 + index,
				meta: { toolName: diff ? "write" : "bash", status: "success", args: diff ? { path: `result-${index}.ts`, content: Array.from({ length: 65 }, (_, line) => `const line${line} = "${"wide diff content ".repeat(10)}";`).join("\n") } : { command: `echo step-${index}` }, detailText: output },
			};
		});
		return [
			{ kind: "interim", id: "intro", message: { id: "intro", agentId: "process-scroll", role: "assistant", text: "阶段性回复\n\n检查工具执行过程。", timestamp: 1 } },
			{ kind: "group", id: "group-main", members: messages.map((message) => ({ kind: "tool-entry", id: message.id, group: { kind: "tool-group", id: message.id, messages: [message] } })), counts: [{ kind: "commands", count: messages.length }], toolCount: messages.length, hasThinking: false, extensionCount: 0 },
		];
	}, [extra]);
	const pause = () => {
		scrollApi.current?.stopScroll();
		setFollowing(false);
	};
	const toggleFold = () => {
		pause();
		setOpen((value) => !value);
	};
	return (
		<main className="mx-auto flex w-full max-w-[760px] flex-col gap-2 p-4">
			<div className="flex gap-2">
				<button data-testid="grow" onClick={() => setExtra((value) => value + 1)}>
					追加工具
				</button>
				<button
					data-testid="bottom"
					onClick={() => {
						setFollowing(true);
						scrollApi.current?.scrollToBottom({ animation: "instant" });
					}}
				>
					回到底部
				</button>
				<output data-testid="following">{String(following)}</output>
			</div>
			<div style={{ height }}>
				<MessageScroller
					className="h-full"
					viewportClassName="message-timeline"
					contentClassName="message-list"
					smooth={false}
					busy={live}
					scrollApiRef={scrollApi}
					followOutput={following}
					onFollowChange={setFollowing}
					onUserScrollIntent={(intent) => {
						if (intent === "up") setFollowing(false);
					}}
				>
					<div className="px-3 py-4">
						<p>{"会话历史正文。".repeat(100)}</p>
						<Collapsible open={open} className="execution-summary" onOpenChange={toggleFold}>
							<ProcessSummaryToggle summary={{ toolCount: count + extra, interimCount: 1, thinkingCount: 0, retryCount: 0, errorCount: 0 }} expanded={open} onToggle={toggleFold} />
							<CollapsibleContent className="execution-summary-details data-[state=open]:overflow-visible">
								<ProcessFold nodes={nodes} stepsVisible={open} agentRunning={live} groupState={groupState} onToggleGroup={(id, value) => setGroupState((state) => toggleGroupByUser(state, id, value))} onOpenExternal={noop} onCollapse={toggleFold} />
							</CollapsibleContent>
						</Collapsible>
						<p data-testid="final">最终回复，执行过程仍可展开阅读。</p>
					</div>
				</MessageScroller>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
	<Provider>
		<TooltipProvider>
			<Fixture />
		</TooltipProvider>
	</Provider>,
);
