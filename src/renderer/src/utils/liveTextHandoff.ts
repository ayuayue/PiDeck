/**
 * live 正文与 History 交接（pi / DSH 共用）。
 *
 * done 与 messages 跨通道可能乱序：空 done 不能抹掉已出的字；
 * History 还没本轮助手正文时 live 槽必须暂留，避免空白等待。
 */
export function resolveStreamingTextUpdate(previous: string, incoming: string, done: boolean, reset = false): string {
	// 新一轮 reset 必须丢掉上一轮残留；普通 done+空 text 才保留上一帧。
	if (reset) return incoming;
	if (done && incoming.length === 0 && previous.length > 0) return previous;
	return incoming;
}

export function shouldHoldLiveText(input: { done: boolean; reset?: boolean; liveText: string; historyHasAssistantText: boolean }): boolean {
	if (input.reset) return false;
	if (!input.done) return false;
	if (!input.liveText.trim()) return false;
	return !input.historyHasAssistantText;
}

/** 只看本轮最后一条助手消息，避免上一轮正文把本轮 hold 提前解开。 */
export function historyHasCurrentAssistantText(messages: ReadonlyArray<{ role?: string; text?: string }>): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user") return false;
		if (message.role === "assistant" && Boolean(message.text?.trim())) return true;
	}
	return false;
}

/** 本轮助手正文已落盘，或用户已发出下一问：held live 槽必须卸掉。 */
export function shouldReleaseHeldLiveText(messages: ReadonlyArray<{ role?: string; text?: string }>): boolean {
	if (historyHasCurrentAssistantText(messages)) return true;
	const last = messages[messages.length - 1];
	return last?.role === "user";
}
