import type { SessionProcessEvent } from "../../shared/types/trajectory";
import { scanJsonlLines } from "./jsonlLineStream";
import { MAX_EVENTS, createSessionProcessCollector, retainProcessEvents } from "./sessionProcessEvents";

/**
 * 事件上限满了之后，为了继续捕获后段提示词变化而额外扫描的正文字节预算。
 * 超过就停：账本宁可只覆盖到某处并标记覆盖不足，也不能为一条轨迹读遍几百 MB。
 */
export const TRAIL_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * 直接从会话文件流式抽过程事件（历史会话的轨迹账本入口）。
 *
 * 为什么不做「读全文再 parseSessionProcessEvents」：会话文件可达数百 MB，
 * 整文件 readFile 会撞 V8 单字符串上限（ERR_STRING_TOO_LONG）或主进程 384MB 堆上限
 * （V8 `FatalProcessOutOfMemory` abort → 应用闪退），而账本只需要前 MAX_EVENTS 条事件
 * ——流式 + 收够即停让读取量与实际需要成正比，几百 MB 的会话只会读前几 KB~几 MB。
 * 见 jsonlLineStream 模块注释。
 */
export async function parseSessionProcessEventsFromFile(filePath: string): Promise<SessionProcessEvent[]> {
	let events: SessionProcessEvent[] = [];
	const collector = createSessionProcessCollector();
	let trailBytes = 0;
	try {
		await scanJsonlLines(filePath, (line, context) => {
			// 已满上限：只为后续提示词变化继续扫一段有界尾巴，普通事件不再往尾部长。
			if (events.length >= MAX_EVENTS) {
				trailBytes += context.byteLength;
				if (trailBytes > TRAIL_SCAN_BYTES) return "stop";
			}
			events.push(...collector.push(line, context.index));
			if (events.length > MAX_EVENTS) events = retainProcessEvents(events, MAX_EVENTS);
		});
	} catch (error) {
		// 读盘中途失败但已收到部分事件：返回部分结果；一条都没读到才按失败处理
		// （与旧「整文件读失败」的对外表现一致，由 IPC 层转错误态）。
		if (events.length === 0) throw error;
	}
	return retainProcessEvents([...events, ...collector.finish()], MAX_EVENTS);
}
