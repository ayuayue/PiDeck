/**
 * Phase 0 spike 的本地假 pi：实现 get_state、set_model、prompt、abort 四个 JSONL RPC。
 * 默认 prompt 等待 abort；固定验证短句则返回一条模拟成功回答。
 */

import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let activePrompt;
let selectedModel;

function respond(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function finishPrompt(aborted) {
	if (!activePrompt) return;
	clearTimeout(activePrompt.timer);
	const { id } = activePrompt;
	activePrompt = undefined;
	respond({ type: "agent_end", sessionId: "fake-session", messages: [], aborted });
	respond({ type: "response", id, command: "prompt", success: true, data: { aborted } });
}

rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		process.stderr.write(`fake-pi: non-JSON line received (${trimmed.length} bytes)\n`);
		process.exit(1);
		return;
	}
	const { type, id } = message;
	switch (type) {
		case "get_state":
			respond({ type: "response", id, command: "get_state", success: true, data: { status: activePrompt ? "running" : "idle", cwd: process.cwd(), ...(selectedModel ? { model: selectedModel } : {}) } });
			break;
		case "set_model":
			selectedModel = { provider: message.provider, id: message.modelId };
			respond({ type: "response", id, command: "set_model", success: true });
			break;
		case "prompt":
			if (activePrompt) {
				respond({ type: "response", id, command: "prompt", success: false, error: "fake-pi: busy" });
				break;
			}
			if (message.message === "Reply with exactly: PIDECK-PHASE0-OK") {
				respond({ type: "agent_start", sessionId: "fake-session" });
				const assistant = {
					role: "assistant",
					content: [{ type: "text", text: "PIDECK-PHASE0-OK" }],
					stopReason: "stop",
					model: selectedModel,
				};
				respond({ type: "message_start", sessionId: "fake-session", message: { role: "assistant" } });
				respond({ type: "agent_end", sessionId: "fake-session", messages: [assistant], stopReason: "stop" });
				respond({ type: "response", id, command: "prompt", success: true, data: { done: true } });
				break;
			}
			activePrompt = { id, timer: undefined };
			respond({ type: "agent_start", sessionId: "fake-session" });
			respond({ type: "message_start", sessionId: "fake-session", message: { role: "assistant" } });
			activePrompt.timer = setTimeout(() => finishPrompt(false), 30_000);
			break;
		case "abort":
			finishPrompt(true);
			respond({ type: "response", id, command: "abort", success: true });
			break;
		default:
			respond({ type: "response", id, command: String(type), success: false, error: "fake-pi: unknown command" });
	}
});

rl.on("close", () => {
	if (activePrompt) clearTimeout(activePrompt.timer);
	process.exit(0);
});
