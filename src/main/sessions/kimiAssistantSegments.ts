import { createHash } from "node:crypto";
import { importedUnknownBlockAsText, normalizeImportedStopReason } from "./importNormalize";
import { normalizeImportedToolArguments } from "./importToolArguments";
import type { NormalizedKimiMessage } from "./kimiSessionConvert";
import { readRecord, readString } from "./kimiSessionSource";

export type PiContent = Record<string, unknown>;
export type KimiLoopResult = { toolCallId: string; output: unknown; isError: boolean; time: number };
export type KimiAssistantEvent = { type: "part"; part: unknown; time: number } | { type: "call"; call: unknown; time: number } | { type: "result"; result: KimiLoopResult } | { type: "snapshot"; message: NormalizedKimiMessage };

export function makeId(sessionId: string, sequence: number): string {
	return createHash("sha1").update(`${sessionId}:${sequence}`).digest("hex").slice(0, 8);
}

function convertPart(block: unknown): PiContent | undefined {
	if (typeof block === "string") return block ? { type: "text", text: block } : undefined;
	const record = readRecord(block);
	const type = readString(record.type);
	if (type === "think" || type === "thinking" || type === "reasoning") {
		const thinking = readString(record.think) || readString(record.thinking) || readString(record.text);
		if (thinking) return { type: "thinking", thinking, thinkingSignature: "kimi_thinking" };
	} else if (type === "text") {
		const text = readString(record.text);
		if (text) return { type: "text", text };
	} else {
		return importedUnknownBlockAsText(record);
	}
}

function convertCall(call: unknown, index: number) {
	const record = readRecord(call);
	const fn = readRecord(record.function);
	const name = readString(record.name) || readString(fn.name) || "tool";
	const id = readString(record.id) || `kimi_${makeId(name, index)}`;
	return { type: "toolCall", id, name, arguments: normalizeImportedToolArguments(record.arguments ?? fn.arguments) };
}

/** Kimi Work 共用块转换，保留其原有的整条消息视图。 */
export function convertKimiAssistantContent(message: NormalizedKimiMessage) {
	const content: PiContent[] = [];
	for (const part of message.content) {
		const block = convertPart(part);
		if (block) content.push(block);
	}
	const calls = message.toolCalls.map(convertCall);
	return { content: content.concat(calls), toolNames: calls.map(({ id, name }) => ({ id, name })) };
}

export function* kimiSnapshotEvents(message: NormalizedKimiMessage): Generator<KimiAssistantEvent> {
	for (const part of message.content) yield { type: "part", part, time: message.time };
	for (const call of message.toolCalls) yield { type: "call", call, time: message.time };
}

/** 相邻文本/思考共用一个回复。调用与结果都是分界，只有纯思考可以随下一次调用写出。 */
export function* kimiAssistantSegments(events: Iterable<KimiAssistantEvent>, finishReason: string) {
	let pending: PiContent[] = [];
	let partTime = 0;
	let hasText = false;
	let callIndex = 0;
	const reason = normalizeImportedStopReason({ raw: finishReason, hasToolCall: false });
	const flush = (stopReason = reason === "toolUse" ? "stop" : reason) => {
		const content = pending;
		pending = [];
		hasText = false;
		return { type: "assistant" as const, content, time: partTime, stopReason };
	};
	for (const event of events) {
		if (event.type === "part") {
			const block = convertPart(event.part);
			if (!block) continue;
			if (!pending.length) partTime = event.time;
			pending.push(block);
			if (block.type === "text") hasText = true;
		} else if (event.type === "call") {
			if (hasText) yield flush("stop");
			const call = convertCall(event.call, callIndex++);
			yield { type: "call" as const, content: [...pending, call], call, time: event.time, stopReason: "toolUse" };
			pending = [];
		} else {
			if (pending.length) yield flush("stop");
			yield event;
		}
	}
	if (pending.length) yield flush();
}
