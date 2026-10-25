import { useEffect } from "react";
import { useStore } from "jotai";
import { desktopApi } from "../desktopApi";
import { cacheSessionMessagesAtom, sessionMessagesCacheAtom } from "../atoms/session-atoms";
import { setVideoGenJobAtom } from "../atoms/videogen-atoms";
import type { ChatMessage } from "../../../shared/types";
import type { VideoGenJobSnapshot, VideoGenMeta } from "../../../shared/types/videogen";
import { t } from "../i18n";

/**
 * 生视频任务事件的全局对账（App 级单点挂载）：
 * - 任务快照写 videoGenJobsBySessionAtom（按钮态/恢复）；
 * - 按 snapshot.messageId 原地更新会话消息缓存里的占位消息（时间线即时反馈）。
 *
 * 消息不在缓存时只记任务不造消息——占位的真相源是主进程 VideoSessionStore，
 * 历史加载（切会话回来/重启）自然带出最新状态。
 */
export function useVideoGenEvents() {
	const store = useStore();
	useEffect(() => {
		const unsubscribe = desktopApi.videogen.onEvent((snapshot) => {
			store.set(setVideoGenJobAtom, snapshot);
			applySnapshotToTimeline(store, snapshot);
		});
		return unsubscribe;
	}, [store]);
}

function snapshotToMeta(snapshot: VideoGenJobSnapshot): VideoGenMeta {
	const status: VideoGenMeta["status"] = snapshot.status === "succeeded" ? "complete" : snapshot.status === "queued" ? "queued" : snapshot.status === "running" ? "generating" : "error";
	const errorDetail = snapshot.status === "cancelled" ? t("videogen.error.cancelled") : snapshot.status === "timeout" ? t("videogen.error.timeout") : snapshot.errorDetail;
	return {
		status,
		prompt: snapshot.prompt,
		jobId: snapshot.jobId,
		resolution: snapshot.resolution,
		duration: snapshot.duration,
		ratio: snapshot.ratio,
		videoRef: snapshot.status === "succeeded" ? snapshot.videoRef : undefined,
		errorDetail: status === "error" ? errorDetail : undefined,
	};
}

/** 占位消息原地更新：找不到（事件早于本地上屏/历史未加载）就跳过，等历史对账。 */
function applySnapshotToTimeline(store: ReturnType<typeof useStore>, snapshot: VideoGenJobSnapshot) {
	if (!snapshot.sessionId) return;
	const current = store.get(sessionMessagesCacheAtom)?.[snapshot.sessionId];
	if (!current) return;
	const target = current.messages.find((message) => message.id === snapshot.messageId);
	if (!target) return;
	const meta = snapshotToMeta(snapshot);
	const patch = (message: ChatMessage): ChatMessage => ({
		...message,
		meta: { ...message.meta, videoGen: meta },
		videos: meta.videoRef ? [{ type: "video", ref: meta.videoRef, mimeType: "video/mp4" }] : undefined,
		timestamp: snapshot.finishedAt ?? message.timestamp,
	});
	store.set(cacheSessionMessagesAtom, {
		sessionId: snapshot.sessionId,
		messages: current.messages.map((message) => (message.id === snapshot.messageId ? patch(message) : message)),
		source: "runtime",
	});
}
