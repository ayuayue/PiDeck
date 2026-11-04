import { useSyncExternalStore } from "react";

/**
 * 文档可见性（窗口最小化 / 被系统遮挡 / 后台标签页时为 false）。
 *
 * 只认 visibilityState，不认 window focus：用户切到别的应用但仍把 PiDeck 摆在
 * 旁边看流式输出时，焦点不在本窗口但内容仍可见，暂停打字机会让文字看起来卡住。
 * 分屏栏的「非焦点」由 ChatSessionPane 的 focused 单独处理。
 */
function subscribe(onChange: () => void): () => void {
	document.addEventListener("visibilitychange", onChange);
	return () => document.removeEventListener("visibilitychange", onChange);
}

function getSnapshot(): boolean {
	return document.visibilityState === "visible";
}

/** SSR / 非浏览器环境按可见处理（本项目渲染层不跑 SSR，仅兜底）。 */
function getServerSnapshot(): boolean {
	return true;
}

export function useDocumentVisible(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
