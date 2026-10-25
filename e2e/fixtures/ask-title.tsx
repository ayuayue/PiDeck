import { createRoot } from "react-dom/client";
import { Provider } from "jotai";
import { SessionRuntimeUiOverlay } from "../../src/renderer/src/components/overlays/SessionRuntimeUiOverlay";
import { TooltipProvider } from "../../src/renderer/src/components/ui-shadcn/tooltip";
import type { AgentUiRequest } from "../../src/shared/types";
import "../../src/renderer/src/styles.css";

/** 挂真实统一 Ask 与真实层叠样式，仅替换 runtime 数据；不启动 Electron/pi 或访问账号。 */
const params = new URLSearchParams(location.search);
const question = params.get("question") ?? "短问题";
const single = params.get("mode") === "single";
// 同一挂载点验证批量题干与单题摘要，避免只测新协议而遗漏复用外壳的旧请求。
const request: AgentUiRequest = {
	agentId: "ask-title-agent",
	requestId: "ask-title-request",
	method: single ? "select" : "batch_ask",
	title: single ? question : (params.get("heading") ?? ""),
	options: single ? ["保留", "修改"] : undefined,
	batchQuestions: single
		? undefined
		: [
				{ id: "long-question", type: "select", question, options: ["保留", "修改"] },
				{ id: "short-question", type: "input", question: "下一题" },
			],
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
	<Provider>
		<TooltipProvider>
			<main className="mx-auto mt-8 w-full max-w-[420px] p-3">
				<SessionRuntimeUiOverlay
					sessionId="ask-title-session"
					runtime={{ agentId: request.agentId, runtimeGeneration: 1, status: "running", updatedAt: 0 }}
					ui={{ agentId: request.agentId, runtimeGeneration: 1, requests: { [request.requestId]: { request, status: "pending" } }, widgets: {} }}
					responder={{ respond: async () => true }}
				/>
			</main>
		</TooltipProvider>
	</Provider>,
);
