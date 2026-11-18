import { createInterface } from "node:readline";

// 真子进程 + stdio NDJSON；只模拟 ACP agent 协议，不替换 PiDeck 的 spawn/IPC/投影。
const sessionId = "release-smoke-acp";
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
	let frame;
	try {
		frame = JSON.parse(line);
	} catch {
		return;
	}
	if (frame.id === undefined) return;
	if (frame.method === "initialize") {
		send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "Release Smoke ACP" } } });
		return;
	}
	if (frame.method === "session/new") {
		if (!Array.isArray(frame.params?.mcpServers)) {
			send({ id: frame.id, error: { code: -32602, message: "mcpServers required" } });
			return;
		}
		send({ id: frame.id, result: { sessionId } });
		return;
	}
	if (frame.method === "session/prompt") {
		const prompt = frame.params?.prompt?.find((part) => part.type === "text")?.text;
		if (frame.params?.sessionId !== sessionId || typeof prompt !== "string" || !prompt) {
			send({ id: frame.id, error: { code: -32602, message: "invalid prompt" } });
			return;
		}
		send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ACP 冒烟回复：${prompt}` } } } });
		send({ id: frame.id, result: { stopReason: "end_turn" } });
		return;
	}
	send({ id: frame.id, error: { code: -32601, message: "Method not found" } });
});
