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

/**
 * 状态推送订阅：onChange 在服务端确认状态变化时被调（已服务端去抖，客户端不再防抖）。
 *
 * 2027-02 起 onChange 携带服务端已构建好的状态载荷（SSE data 就是 /api/state 同构
 * JSON，见 serializePublicWebPayload）：此前客户端收到事件后丢弃 data 再 GET
 * /api/state 拉一遍——每次真实状态变化服务端构建+序列化两次、网络传输两份
 * ~100KB。直接 parse data 复用载荷，parse 失败（畸形帧）回退无参调用走原刷新。
 */
export function useWebStateEvents(onChange: (payload?: unknown) => void): boolean {
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
			// 服务端仅在快照与上次广播不同才推；data 就是完整状态（/api/state 同构），
			// 优先直接复用，畸形帧回退无参刷新（fetchState 兜底）。
			const data = (event as MessageEvent<string>).data;
			if (!data) {
				onChangeRef.current();
				return;
			}
			try {
				onChangeRef.current(JSON.parse(data));
			} catch {
				onChangeRef.current();
			}
		});
		es.onerror = () => setConnected(false); // 自动重连由浏览器负责
		return () => es.close();
	}, []);

	return connected;
}
