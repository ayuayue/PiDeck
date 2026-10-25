import type { PiAuthFlowEvent } from "../../../shared/types/piAuth";

/**
 * 登录流程事件流的派生逻辑（纯函数，无 React）。
 *
 * 为什么单独抽出来：弹框要回答三个与渲染无关的问题——「现在有没有可点的授权入口」、
 * 「哪些事件该当正文、哪些只配当日志」、「要不要替用户打开浏览器」。
 * 放在这里可以直接单测，组件只负责把结果画出来，不再自己 some()/filter() 事件数组。
 */

/** 授权入口：设备码流程给「验证码 + 验证页」，OAuth 流程只给授权页 URL。 */
export type ProviderAuthEntry = { kind: "device-code"; userCode: string; verificationUri: string } | { kind: "auth-url"; url: string; instructions?: string };

/** 日志类事件的保留条数；授权入口不受此限制（见 `appendFlowEvent`）。 */
export const MAX_FLOW_LOG_EVENTS = 20;

/** 授权入口事件：会主动把用户送去供应商页面的那两类事件。 */
function isAuthEntryEvent(event: PiAuthFlowEvent): boolean {
	return event.type === "auth_url" || event.type === "device_code";
}

/**
 * 挑出「当前有效」的授权入口：从后往前找第一条 auth_url / device_code。
 *
 * 为什么取最新的而不是第一条：供应商重新签发验证码（用户重试、上一条过期）时 pi 会再推一条事件，
 * 旧码此刻已经失效——展示第一条会把用户送进必然失败的授权页。
 */
export function pickProviderAuthEntry(events: readonly PiAuthFlowEvent[]): ProviderAuthEntry | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "device_code") return { kind: "device-code", userCode: event.userCode, verificationUri: event.verificationUri };
		if (event.type === "auth_url") return { kind: "auth-url", url: event.url, instructions: event.instructions };
	}
	return undefined;
}

/** 授权入口在系统浏览器里对应的地址（设备码流程用验证页，不是 API 地址）。 */
export function authorizationEntryUrl(entry: ProviderAuthEntry | undefined): string | undefined {
	if (!entry) return undefined;
	return entry.kind === "device-code" ? entry.verificationUri : entry.url;
}

/**
 * 往事件流里追加一条事件并裁剪：日志类只留最近 `limit` 条，授权入口永远保留最新一条。
 *
 * 为什么不能直接 `slice(-limit)`：设备码流程会按 interval 持续推轮询进度，几分钟的等待
 * 就足以把一次性验证码挤出窗口，用户看到的是「验证码突然消失、界面回到等待中」，
 * 而 pi 那边其实还在用这个码等授权。
 */
export function appendFlowEvent(events: readonly PiAuthFlowEvent[], event: PiAuthFlowEvent, limit: number): PiAuthFlowEvent[] {
	const log: PiAuthFlowEvent[] = [];
	let latestEntry: PiAuthFlowEvent | undefined;
	for (const item of [...events, event]) {
		if (isAuthEntryEvent(item)) {
			latestEntry = item;
			continue;
		}
		log.push(item);
	}
	// 入口统一放在最前面：日志区本来就会把它过滤掉（见 `pickFlowLogEvents`），顺序对 UI 无影响。
	return latestEntry ? [latestEntry, ...log.slice(-limit)] : log.slice(-limit);
}

/**
 * 日志区该显示的事件：授权入口已单独成卡，留在日志里会变成「同一串地址出现两次」，
 * 用户反而容易点到下面那行没有按钮的旧链接。
 */
export function pickFlowLogEvents(events: readonly PiAuthFlowEvent[]): PiAuthFlowEvent[] {
	return events.filter((event) => !isAuthEntryEvent(event));
}

/**
 * 还该不该替用户打开系统浏览器：同一地址只打开一次。
 * 记进 `opened` 是为了防「pi 重复推同一条事件」把浏览器反复抢到前台。
 */
export function pickPendingExternalOpen(entry: ProviderAuthEntry | undefined, opened: ReadonlySet<string>): string | undefined {
	const url = authorizationEntryUrl(entry);
	if (!url || opened.has(url)) return undefined;
	return url;
}
