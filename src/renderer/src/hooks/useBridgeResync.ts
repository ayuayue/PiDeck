/**
 * GUI 扩展桥 —— 渲染层请求「全量重推一次」（§9.4）。
 *
 * ## 为什么需要
 * 桥的落点是**一次性推送** —— 推过了就不再推。渲染层一旦丢过桥状态
 * （换 agent 绑定 / 切换聚焦会话 / 重开设置弹窗 / 重启应用），
 * 贡献就永远回不来，表现为「扩展明明装了，卡片却是空的」。
 *
 * 主进程不新开路由：这个请求只在桥**下一次轮询的响应体**里带一个
 * `resync: true`，桥收到就绕过去重全量重推。
 *
 * ## 去重纪律（本文件的核心）
 * 落点组件（`BridgeGuiSlot` / `BridgeSlot`）数量多、挂载频繁 ——
 * 每个都直接发请求会把主进程的 `resyncRequested` 标志一直点亮，
 * 桥就变成每轮都全量重推。因此这里**按「会话 + 绑定代次」记一次**：
 * 同一个 `sessionId:agentId:runtimeGeneration` 只真正发一次。
 *
 * - 发送**失败**（旧 runtime / 桥还没注册）→ 不记，允许之后重试
 * - `force: true` → 绕过记忆（用户主动重开设置弹窗这类场景用）
 *
 * 身份字段与 `useBridgeEventSink` 完全一致：`sessionId + agentId + runtimeGeneration`，
 * 主进程据此拒绝旧 runtime 的迟到请求（AGENTS.md 硬性要求）。
 */

import { useCallback, useEffect, useMemo } from "react";
import { useAtomValue } from "jotai";
import { sessionRuntimeByIdAtom } from "../atoms/session-atoms";
import { desktopApi } from "../desktopApi";
import type { BridgeResyncInput } from "../../../shared/types/bridge";

/**
 * 已经为哪个「绑定代次」发过请求。
 *
 * 放模块级（不是 useRef）是**故意的**：去重的粒度是「这次绑定」，
 * 而绑定可能被多个落点组件同时观察 —— 用 ref 就变成每个组件各去重一次，
 * 等于没去重。键 = `${sessionId}:${agentId}:${runtimeGeneration}`。
 */
const requestedBindings = new Set<string>();

/** 仅供测试：清空去重记忆。 */
export function __resetBridgeResyncMemoForTests(): void {
	requestedBindings.clear();
}

/**
 * 返回一个「请求桥全量重推」的回调，并在**挂载 / 绑定变化**时自动发一次。
 *
 * 绑定未就绪（detached / 无 agentId）时是 no-op —— 桥此时也不会推内容。
 * 返回的回调可用于用户主动重试（`requestResync({ force: true })`）。
 */
export function useBridgeResync(sessionId: string | undefined): {
	requestResync: (options?: { force?: boolean }) => void;
} {
	const runtime = useAtomValue(sessionRuntimeByIdAtom);
	const binding = sessionId ? runtime[sessionId] : undefined;
	const agentId = binding?.agentId;
	const runtimeGeneration = binding?.runtimeGeneration;

	const bindingKey = useMemo(() => (sessionId && agentId && typeof runtimeGeneration === "number" ? `${sessionId}:${agentId}:${runtimeGeneration}` : undefined), [agentId, runtimeGeneration, sessionId]);

	const requestResync = useCallback(
		(options?: { force?: boolean }) => {
			if (!sessionId || !agentId || typeof runtimeGeneration !== "number" || !bindingKey) return;
			if (!options?.force && requestedBindings.has(bindingKey)) return;
			requestedBindings.add(bindingKey);
			const input: BridgeResyncInput = { sessionId, agentId, runtimeGeneration };
			// fire-and-forget：请求失败（旧 runtime / 桥未连）不影响 UI。
			// 失败时**撤销记忆** —— 否则桥稍后注册好，这次会话就再也不会补推了。
			// 走 desktopApi 规范入口（PR 评审 §3）：浏览器/预览态由 stub 应答，
			// 不直接摸 window.piDesktop（绕开入口会让 stub 失效）。
			try {
				void Promise.resolve(desktopApi.sessions.requestBridgeResync(input))
					.then((accepted) => {
						if (accepted === false) requestedBindings.delete(bindingKey);
					})
					.catch(() => {
						requestedBindings.delete(bindingKey);
					});
			} catch {
				// preload 缺失的配置错误态：desktopApi 是抛错 Proxy，这里静默即可
				requestedBindings.delete(bindingKey);
			}
		},
		[agentId, bindingKey, runtimeGeneration, sessionId],
	);

	// 挂载时 + 绑定变化时自动补一次（去重后实际只发一次）
	useEffect(() => {
		if (!bindingKey) return;
		requestResync();
	}, [bindingKey, requestResync]);

	return { requestResync };
}
