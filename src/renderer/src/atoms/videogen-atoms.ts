import { atom } from "jotai";
import { EMPTY_VIDEO_GEN_CONFIG, type VideoGenConfigFile } from "../../../shared/videoGenConfig";
import type { VideoGenJobSnapshot } from "../../../shared/types/videogen";

/**
 * 独立生视频配置快照。App 启动与配置页保存后写入；
 * composer 生视频模式只读这份，不订阅会话 LLM 模型（与 imageGenConfigAtom 同构）。
 */
export const videoGenConfigAtom = atom<VideoGenConfigFile>(EMPTY_VIDEO_GEN_CONFIG);

/**
 * 各会话的生视频任务快照（videogen:event 事件流对账的渲染层镜像）。
 * submit 受理后本地写入，事件到达原地覆盖；重启恢复由 useVideoGenJobs 播种。
 * 只存未终态 + 最近终态任务，渲染层用它驱动占位/按钮态，不是持久真相源。
 */
export const videoGenJobsBySessionAtom = atom<Record<string, VideoGenJobSnapshot[]>>({});

/** 写入/覆盖某会话的一条任务快照（按 jobId 去重，新在前）。 */
export const setVideoGenJobAtom = atom(null, (get, set, snapshot: VideoGenJobSnapshot) => {
	if (!snapshot.sessionId) return;
	const previous = get(videoGenJobsBySessionAtom)[snapshot.sessionId] ?? [];
	const next = [snapshot, ...previous.filter((job) => job.jobId !== snapshot.jobId)].slice(0, 50);
	set(videoGenJobsBySessionAtom, { ...get(videoGenJobsBySessionAtom), [snapshot.sessionId]: next });
});
