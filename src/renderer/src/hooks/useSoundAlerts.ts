import { useEffect, useRef } from "react";
import { desktopApi } from "../desktopApi";
import { resolveSoundUrl } from "../utils/soundUrls";

/**
 * 全局声音提醒播放器：订阅主进程 `sounds:play` 事件并播放。
 *
 * 设计要点：
 * - 单 Audio 实例复用（每次播放先 stop 再播），多个事件同时到达时后到者覆盖前者，
 *   避免会话并发完成时叠音（主进程侧已有全局冷却，这里做双保险）；
 * - 播放失败（自定义文件被删/格式不支持）静默降级，不打断 UI；
 * - 订阅/卸载配对：组件卸载必须退订，防止向已销毁页面推送导致泄漏。
 */
export function useSoundAlerts(): void {
	const audioRef = useRef<HTMLAudioElement | null>(null);

	useEffect(() => {
		const off = desktopApi.sounds.onPlay((event) => {
			const url = resolveSoundUrl(event.soundId);
			if (!url) return;
			try {
				const audio = audioRef.current ?? new Audio();
				audioRef.current = audio;
				// 先停后播：新事件立即替换当前声音（不用 await 避免事件风暴堆积）
				audio.pause();
				audio.currentTime = 0;
				audio.src = url;
				audio.volume = Math.min(1, Math.max(0, event.volume));
				void audio.play().catch(() => undefined);
			} catch {
				// Audio 构造/赋值失败（极少数平台差异）不影响主流程
			}
		});
		return () => {
			off();
			const audio = audioRef.current;
			if (audio) {
				audio.pause();
				audio.src = "";
				audioRef.current = null;
			}
		};
	}, []);
}
