import { atom } from "jotai";

/**
 * 会话内查找的「打开请求」计数，按会话 id 累加。
 *
 * 为什么走 atom 而不是 props：入口按钮在 SessionHeader（单栏时外置在 Tab 栏、分屏时
 * 每栏各一份），浮层在 ChatSessionPane —— 两者隔着 App 的装配层，props 透传会把
 * 「找谁打开搜索框」这条会话级交互塞进通用 header props。按 sessionId 计数后，
 * 快捷键、头部放大镜、浮层重挂都读同一份信号（浮层只认「变化」，见 SessionFindOverlay）。
 */
export const sessionFindOpenRequestsAtom = atom<Readonly<Record<string, number>>>({});

/** 请求打开某个会话的内查找浮层（快捷键与头部放大镜共用）。 */
export const requestSessionFindAtom = atom(null, (_get, set, sessionId: string) => {
	set(sessionFindOpenRequestsAtom, (current) => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }));
});
