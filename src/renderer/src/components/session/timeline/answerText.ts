/**
 * 助手正文的展示文本：去掉终端控制码和内嵌思考，保留现有正文清理语义。
 * 渲染、过程计数和分组必须共用此结果，避免原文非空但页面没有正文时仍计入中间回复。
 * 只返回展示副本，不改写历史消息，也不移除 live 正文需要的骨架挂载点。
 */
export function cleanAnswerText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.trim();
}
