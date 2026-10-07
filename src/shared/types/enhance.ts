/**
 * 提示词增强（输入框草稿 → 模型改写 → 回填）的跨进程契约。
 *
 * 模型调用走独立 sidecar（resources/pi-enhance-host.mjs，复用用户自己那套 pi 的
 * ModelRuntime），主进程只做生命周期与事件转发；流式 delta 按 runId 推给渲染层。
 */

/** 一次增强请求的状态流转：发起 → 流式增量 → 终态（done / error / aborted）。 */
export type EnhanceEventPayload = { runId: string; phase: "started" } | { runId: string; phase: "delta"; text: string } | { runId: string; phase: "done"; text: string } | { runId: string; phase: "aborted" } | { runId: string; phase: "error"; errorKind: EnhanceErrorKind; message: string };

/** 错误分类：渲染层按此挑 i18n 文案；message 只进详情/日志，不作首屏。 */
export type EnhanceErrorKind = "invalid-request" | "helper-missing" | "wsl" | "no-pi-entry" | "spawn-failed" | "sdk-unavailable" | "model-not-found" | "no-provider" | "busy" | "aborted" | "timeout" | "protocol" | "model-error";

/** enhance:run 的返回：受理后事件经 enhance:event 推送（按 runId 配对）。 */
export type EnhanceRunResult = { ok: true; runId: string } | { ok: false; errorKind: EnhanceErrorKind; message: string };

/** enhance:run 入参（渲染层来的字段一律不可信，IPC 层再校验一次）。 */
export type EnhanceRunInput = {
	provider: string;
	modelId: string;
	/** 待增强的草稿文本（输入框当前内容）。 */
	userText: string;
};

/** sidecar → 主进程的协议记录（主进程转译成 EnhanceEventPayload 后再推渲染层）。 */
export type EnhanceHostRecord = { type: "ready"; protocolVersion: number } | { type: "started"; id: string } | { type: "delta"; id: string; text: string } | { type: "done"; id: string; text: string } | { type: "error"; id: string; errorKind: EnhanceErrorKind; message: string };
