/**
 * 公告快照全局同步 hook：初始拉取一次 list（主进程返回缓存态，不触发网络）+
 * 订阅 announcement:changed 推送。全局唯一挂载点在 AppBootstrap（与 useSoundAlerts
 * 同层），组件卸载/应用关闭时退订，防止向已销毁页面推送导致泄漏。
 */
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import { announcementStateAtom } from "../atoms/announcement-atoms";

export function useAnnouncementsSync(): void {
	const setSnapshot = useSetAtom(announcementStateAtom);
	useEffect(() => {
		let alive = true;
		// 初始拉取：启动后主进程缓存立即可见（定时拉取有 2min+ 抖动延迟，不阻塞首帧）
		desktopApi.announcements
			.list()
			.then((state) => {
				if (alive) setSnapshot(state);
			})
			.catch(() => undefined);
		const off = desktopApi.announcements.onChanged((state) => setSnapshot(state));
		return () => {
			alive = false;
			off();
		};
	}, [setSnapshot]);
}
