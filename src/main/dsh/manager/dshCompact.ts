import type { AgentRuntimeState } from "../../../shared/types";
import type { DshRemoteClient } from "../dshRemoteClient";
import type { DshAgentRuntime } from "./dshAgentRuntime";

/**
 * DSH 会话压缩（issue #557）。
 *
 * `/compact` 走 host 侧命令注册表（dsh-command-compact），wire 上没有显式 compact RPC
 * （计划 D11）：以 queue 提示词触发命令回合。原先 `sessionsPrompt` 的 admission 一回包就
 * 返回，UI 据此提示「压缩完成」——但 DSH 的 `command/done` 可能是 error（busy / 摘要失败 /
 * cancelled），于是压缩失败也报成功、上下文 token 数不变。
 *
 * 现在等命令回合收口：mux 把 `command/done` 的 error 文本记在 runtime.compactRound 上，
 * `turn/end` 时结算（见 dshMuxFrames）。命令报错就把原文透出去，不再假装完成。
 */

export type DshCompactHost = {
	getRuntime(agentId: string): DshAgentRuntime;
	requireClient(): DshRemoteClient;
	waitForIdle(agentId: string): Promise<void>;
	emitRuntimeState(agentId: string): void;
	getRuntimeState(agentId: string): Promise<AgentRuntimeState>;
};

/** 命令回合迟迟不收口时的兜底：宁可退回旧的「不判定」语义，也不把 RPC 挂死。 */
const DSH_COMPACT_SETTLE_TIMEOUT_MS = 120_000;

export async function compactDshSession(host: DshCompactHost, agentId: string, prompt?: string): Promise<AgentRuntimeState> {
	const runtime = host.getRuntime(agentId);
	// 与 pi 一致：压缩中拒绝重复请求，避免第二次 /compact 拼进命令回合。
	if (runtime.isCompacting) {
		throw new Error("already compacting");
	}
	// 占位必须在第一个 await 之前：否则两个并发请求都能通过上面的判据，各发一条 /compact。
	runtime.isCompacting = true;
	try {
		const client = host.requireClient();
		// 与 sendPrompt 同一串行化约束：上一回合（含命令回合）idle 后才发 /compact，
		// 避免压缩指令被 host 拼进运行中回合（D4）。
		await host.waitForIdle(agentId);
		const settled = new Promise<string | undefined>((resolve) => {
			runtime.compactRound = { resolve };
		});
		const commandText = prompt && prompt.trim() ? `/compact ${prompt.trim()}` : "/compact";
		host.emitRuntimeState(agentId);
		const sent = await client.sessionsPrompt({
			sessionId: runtime.sessionId,
			mode: "queue",
			content: [{ type: "text", text: commandText }],
		});
		if (!sent.result.ok) {
			throw new Error(`dsh /compact failed: ${JSON.stringify(sent.result.error)}`);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<string | undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), DSH_COMPACT_SETTLE_TIMEOUT_MS);
		});
		const errorText = await Promise.race([settled, timeout]);
		clearTimeout(timer);
		// 正常路径的进行态由 mux 的 turn/end 复位；超时兜底时在这里收回，避免按钮永远转圈。
		runtime.compactRound = undefined;
		if (runtime.isCompacting) {
			runtime.isCompacting = false;
			host.emitRuntimeState(agentId);
		}
		if (errorText) throw new Error(`dsh /compact failed: ${errorText}`);
		return host.getRuntimeState(agentId);
	} catch (error) {
		runtime.compactRound = undefined;
		if (runtime.isCompacting) {
			runtime.isCompacting = false;
			host.emitRuntimeState(agentId);
		}
		throw error;
	}
}
