/**
 * webStateEvents — /api/events SSE 订阅：项目/会话/运行态变更的服务端推送。
 *
 * 替代 Web 端原来的 1s/3s fetchState 轮询作为主数据通道：服务端在 pi 事件 / 目录
 * 变化时去抖比对快照并推送（见 WebServiceManager.handleStateEvents），轮询降级为
 * 低频兑底（连接断开时自动回退高频，由 WebChatApp 的轮询 effect 控制）。
 *
 * 本 hook 只负责连接与转发，不做任何状态加工：收到 state 事件 → 调用方回调
 * （WebChatApp 复用轮询同一条 refresh 路径，保证去重/边沿检测只有一份实现）。
 * EventSource 自带断线重连，onerror 只用于回退信号（轮询加速）。
 */
import { useEffect, useRef, useState } from "react";
import { getWebToken } from "./webApi";

/** 状态推送订阅：onChange 在服务端确认状态变化时被调（已服务端去抖，客户端不再防抖）。 */
export function useWebStateEvents(onChange: () => void): boolean {
	const [connected, setConnected] = useState(false);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	useEffect(() => {
		const token = getWebToken();
		const url = token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events";
		const es = new EventSource(url);
		es.onopen = () => setConnected(true);
		es.addEventListener("state", (event) => {
			setConnected(true);
			// 服务端仅在快照与上次广播不同才推；无需客户端比对，直接触发一次刷新。
			if ((event as MessageEvent<string>).data) onChangeRef.current();
		});
		es.onerror = () => setConnected(false); // 自动重连由浏览器负责
		return () => es.close();
	}, []);

	return connected;
}
