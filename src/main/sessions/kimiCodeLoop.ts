import type { KimiAssistantEvent } from "./kimiAssistantSegments";
import type { NormalizedKimiMessage } from "./kimiSessionConvert";
import { readNumber, readRecord, readString, type KimiRecord } from "./kimiSessionSource";

export type KimiLoopStep = {
	id: string;
	events: KimiAssistantEvent[];
	callPositions: Map<string, number>;
	time: number;
	end?: KimiRecord;
};

/** step.end 才给出消息 ID 和 usage。只缓存当前步，保留各条记录的时间与先后关系。 */
export class KimiCodeLoop {
	private step: KimiLoopStep | undefined;

	feed(record: KimiRecord): KimiLoopStep | undefined {
		if (record.type !== "context.append_loop_event") return;
		const event = readRecord(record.event);
		const time = readNumber(record.time);
		switch (event.type) {
			case "step.begin": {
				const previous = this.flush();
				this.open(time, readString(event.uuid));
				return previous;
			}
			case "content.part":
				if (event.part != null) this.open(time, readString(event.stepUuid)).events.push({ type: "part", part: event.part, time });
				break;
			case "tool.call": {
				const id = readString(event.toolCallId);
				if (!id) break;
				const step = this.open(time, readString(event.stepUuid));
				const index = step.callPositions.get(id) ?? step.events.length;
				step.callPositions.set(id, index);
				step.events[index] = { type: "call", call: { id, name: event.name, arguments: event.args }, time };
				break;
			}
			case "tool.result": {
				const toolCallId = readString(event.toolCallId);
				if (!toolCallId || !event.result || typeof event.result !== "object") break;
				const result = readRecord(event.result);
				const late = !this.step;
				this.open(time, "").events.push({ type: "result", result: { toolCallId, output: result.output, isError: result.isError === true, time } });
				if (late) return this.flush();
				break;
			}
			case "step.end": {
				const id = readString(event.uuid);
				if (id && this.step?.id && id !== this.step.id) return;
				return this.flush(event);
			}
		}
	}

	/** 快照可能穿插在 loop 内，要等前面的事件一起按序写出。 */
	bufferSnapshot(message: NormalizedKimiMessage): boolean {
		if (!this.step) return false;
		this.step.events.push({ type: "snapshot", message });
		return true;
	}

	flush(end?: KimiRecord): KimiLoopStep | undefined {
		const step = this.step;
		this.step = undefined;
		if (step?.events.length) return { ...step, end };
	}

	private open(time: number, id: string): KimiLoopStep {
		return (this.step ??= { id, events: [], callPositions: new Map(), time });
	}
}
