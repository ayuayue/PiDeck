import { useCallback } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import { askPanelCreatingAtom, askPanelOpenAtom, askPanelOriginSessionIdAtom, askPanelSessionIdAtom } from "../atoms/ask-panel-atoms";
import { effectiveAgentBackendAtom } from "../atoms/app-ui-atoms";
import { sessionRecordsAtom } from "../atoms/session-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { buildAskContextForSession } from "../utils/askPanelContextSource";
import { showNotice } from "../utils/notice";

/**
 * 并行问询：
 * - sendToAsk(projectId, text, options)：创建/复用匿名会话 → 等 runtime 就绪 → 投递消息 → 显示悬浮胶囊。
 *   匿名会话是独立子进程（noSession 不落盘），与当前会话并行，不打断其输出。
 *   options.context：主会话上下文块（见 utils/askPanelContext.ts）。pi RPC 无跨进程上下文注入通道，
 *   改为经 SendPromptInput.agentMessage 传给模型（agentMessage 模型可见、UI 时间线不可见），
 *   因此首条 user 消息仍是用户原文，胶囊时间线不被上下文污染。调用方未显式传 context 时，
 *   本 hook 会按 originSessionId 从消息缓存现取一份，避免「输入框并行发送」这类入口漏传。
 *   options.originSessionId：发起并行问询的主会话 id，「带回主线（插入主会话 composer）」的落点。
 * - sendFollowUp(text)：向已就绪的匿名会话继续追问（复用 sessionId，不重建 runtime）。
 * - close()：停止匿名 runtime（主进程随后回收 transient 内存）并收起胶囊，同时清空 origin 记录。
 */
export function useAskPanel() {
	const [isOpen, setOpen] = useAtom(askPanelOpenAtom);
	const [sessionId, setSessionId] = useAtom(askPanelSessionIdAtom);
	const [originSessionId, setOriginSessionId] = useAtom(askPanelOriginSessionIdAtom);
	const [creating, setCreating] = useAtom(askPanelCreatingAtom);
	// 读「有效」后端（经 DSH runtime 安装态钳制）：runtime 不可用时新建不会落在 dsh 上。
	const defaultAgentBackend = useAtomValue(effectiveAgentBackendAtom);
	const store = useStore();

	// 创建或复用匿名会话；失败返回 null 并 toast
	const ensureSession = useCallback(
		async (projectId: string): Promise<string | null> => {
			if (sessionId) return sessionId;
			setCreating(true);
			try {
				const { session } = await desktopApi.sessions.createAnonymous({
					projectId,
					title: t("askPanel.sessionTitle"),
					// 默认后端跟随设置项（defaultAgentBackend，默认 pi），避免后端分裂（F2）
					backend: defaultAgentBackend,
				});
				// 只登记会话记录供 timeline 渲染，不加入 sessionIdsByProjectAtom：
				// 匿名会话不落盘、不该出现在左侧项目会话列表（关闭弹框后由 detach 事件清理）
				store.set(sessionRecordsAtom, {
					...store.get(sessionRecordsAtom),
					[session.id]: session,
				});
				setSessionId(session.id);
				return session.id;
			} catch (error) {
				setOpen(false);
				// 会话创建失败属异常，常驻提示直到用户手动关闭
				showNotice(error instanceof Error ? error.message : String(error), Number.POSITIVE_INFINITY, "error");
				return null;
			} finally {
				setCreating(false);
			}
		},
		[sessionId, setCreating, setOpen, setSessionId, store, defaultAgentBackend],
	);

	// 轮询等待匿名 runtime 就绪：匿名会话是后台激活（createAnonymous 后主进程
	// 异步 bind+activate），立即 sendPrompt 会因 runtime 未就绪而丢失/失败。
	// 注意 agent 就绪状态是 "idle"（"running" 表示正在处理消息），两者都算可发送。
	const waitRuntimeReady = useCallback(
		async (sessionId: string, timeoutMs = 15000): Promise<boolean> => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
				if (runtime?.status === "running" || runtime?.status === "idle") return true;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			return false;
		},
		[store],
	);

	// 向匿名会话投递一条 prompt（共用首条/追问发送路径）
	const dispatchPrompt = useCallback(
		async (id: string, text: string, context?: string): Promise<boolean> => {
			if (!(await waitRuntimeReady(id))) {
				// 启动超时提示含「请重试」指引，常驻直到用户手动关闭
				showNotice(t("askPanel.runtimeTimeout"), Number.POSITIVE_INFINITY, "error");
				return false;
			}
			try {
				// 上下文经 agentMessage 注入：模型看到「上下文块 + 用户问题」，
				// UI 乐观消息与权威回读都只显示 message（用户原文），不让上下文污染胶囊时间线
				await desktopApi.sessions.sendPrompt({
					sessionId: id,
					requestId: crypto.randomUUID(),
					message: text,
					...(context ? { agentMessage: `${context}\n\n${text}` } : {}),
				});
				return true;
			} catch (error) {
				// 发送失败属会话异常，常驻提示直到用户手动关闭
				showNotice(error instanceof Error ? error.message : String(error), Number.POSITIVE_INFINITY, "error");
				return false;
			}
		},
		[waitRuntimeReady],
	);

	const sendToAsk = useCallback(
		async (projectId: string, text: string, options?: { context?: string; originSessionId?: string }): Promise<boolean> => {
			// 上下文在创建/等待 runtime 前取快照：等 runtime 就绪期间主会话可能继续流式输出，
			// 用户点「并行发送」时看到的那一屏才是应该继承的上下文。
			const context = options?.context ?? buildAskContextForSession(store, options?.originSessionId) ?? undefined;
			const id = await ensureSession(projectId);
			if (!id) return false;
			// 胶囊先显示：会话创建/启动需要数秒，先给用户即时反馈（创建中/等待响应状态）
			setOpen(true);
			setCreating(true);
			// 记录来源主会话，供「带回主线：插入主会话 composer」定位落点
			if (options?.originSessionId) setOriginSessionId(options.originSessionId);
			try {
				const ok = await dispatchPrompt(id, text, context);
				return ok;
			} finally {
				setCreating(false);
			}
		},
		[dispatchPrompt, ensureSession, setCreating, setOpen, setOriginSessionId, store],
	);

	// 追问：复用已创建的匿名会话继续对话（不再走 ensureSession/setCreating，避免胶囊闪烁）
	const sendFollowUp = useCallback(
		async (text: string): Promise<boolean> => {
			if (!sessionId) return false;
			const trimmed = text.trim();
			if (!trimmed) return false;
			return dispatchPrompt(sessionId, trimmed);
		},
		[dispatchPrompt, sessionId],
	);

	const close = useCallback(async () => {
		setOpen(false);
		if (!sessionId) return;
		// 停止匿名 runtime：主进程收到 stop 后回收 transient 会话内存并广播 detach
		const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
		if (runtime?.agentId) {
			try {
				await desktopApi.sessions.stopRuntime({
					sessionId,
					agentId: runtime.agentId,
					runtimeGeneration: runtime.runtimeGeneration,
				});
			} catch {
				// 停止失败不阻塞关闭（进程可能已退出）
			}
		}
		setSessionId(null);
		setOriginSessionId(null);
	}, [sessionId, setOpen, setSessionId, setOriginSessionId, store]);

	return { isOpen, sessionId, originSessionId, creating, sendToAsk, sendFollowUp, close };
}
