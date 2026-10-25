import { memo } from "react";
import type { ChatMessage } from "../../../../../shared/types";
import { stripAnsi } from "../TimelineFormat";
import { StackTrace } from "../../ui-shadcn/stack-trace";

/**
 * 过程行（重试/错误诊断）的展开错误详情。
 *
 * 用户反馈：429 等错误合并进工具调用后，要能「点开看具体错误」——重试行同理。
 * 详情取 meta.debugDetails（主进程 addDetailedErrorMessage / retry 收敛时写入的原文，
 * 如 "429 Too Many Requests …"）；旧数据缺 debugDetails 时回退 meta.errorMessage。
 * 无详情返回 null（不渲染 chevron，保持单行），成功态重试一般不携带详情。
 */
export function resolveStepDetail(message: ChatMessage): string {
	const debugDetails = typeof message.meta?.debugDetails === "string" ? message.meta.debugDetails.trim() : "";
	if (debugDetails) return stripAnsi(debugDetails).trim();
	const errorMessage = typeof message.meta?.errorMessage === "string" ? message.meta.errorMessage.trim() : "";
	if (stripAnsi(errorMessage).trim()) return stripAnsi(errorMessage).trim();
	// 回退一：主进程带原文的错误行（"请求失败：<原因>"，DSH turn/end 错误只有裸 text）从未写
	// debugDetails，原因只存在于正文；无 i18nKey 说明 text 就是错误原文本身，直接作详情展示。
	if (!message.meta?.i18nKey && (message.role === "error" || message.role === "system")) return stripAnsi(message.text ?? "").trim();
	// 回退二：带 i18nKey 的行文案是翻译后的状态描述（"自动重试成功" 等），展开只会原样重复，不算详情。
	return "";
}

export const StepTraceDetails = memo(function StepTraceDetails(props: { message: ChatMessage }) {
	const detail = resolveStepDetail(props.message);
	if (!detail) return null;
	// 默认折叠，只留 StackTrace header 首行（"429 Too Many Requests …"）做留痕，
	// 点开看完整错误/栈帧；copy 按钮保留（StackTrace 自带）。
	return <StackTrace trace={detail} defaultOpen={false} className="mt-1" />;
});
