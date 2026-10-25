/**
 * 微信侧的文本适配。
 *
 * 微信 iLink 只支持纯文本，而且是聊天窗里的一行行字：没有 Markdown 渲染、
 * 没有可点击链接、没有代码块。直接把 Agent 的 Markdown 输出丢过去，用户会看到
 * 满屏 `**加粗**` 和 `| a | b |` 表格线——比不回答更糟。
 *
 * 这里只做「降级成可读纯文本」，不做语义改写：宁可少一层装饰，也不要把代码里的
 * 内容改坏。所以规则全部是保守的字符级替换，绝不重排代码块内部。
 */

/** 单条微信消息的字符上限。协议未公开，取保守值；超长在行边界切分多条发送。 */
export const WECHAT_TEXT_CHUNK_MAX = 1_500;

/**
 * 去掉 Agent 输出里的宿主动作标记（[SEND_FILE:...]、[CREATE_DOC:...] 等）。
 * 微信通道不支持附件与文档，这些标记若原样发给用户就成了乱码般的噪声。
 */
export function stripActionMarkers(text: string): string {
	return text
		.replace(/^\s*\[(?:SEND_FILE|CREATE_DOC|SEND_IMAGE|SEND_TO_FEISHU):[^\]]*\]\s*$/gm, "")
		.replace(/\[(?:SEND_FILE|CREATE_DOC|SEND_IMAGE|SEND_TO_FEISHU):[^\]]*\]/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * 去掉推理块（thinking），只留可回给用户的正文。
 * pi 把 thinking 内容块并进消息正文（`<thinking>…</thinking>`，见 src/main/pi/messageContent.ts
 * 的 extractMessageText）：桌面端据此渲染可折叠思考区，微信是纯文本通道，原样发出去只能刷屏。
 * 未闭合的 <thinking>（流式截断／模型没按格式收尾）无法区分推理与正文，整段丢弃。
 */
export function stripThinkingBlocks(text: string): string {
	const closed = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
	const unclosed = closed.search(/<thinking>/i);
	if (unclosed >= 0) return closed.slice(0, unclosed);
	return closed.replace(/<\/?thinking>/gi, "");
}

/**
 * Markdown → 纯文本。
 *
 * 刻意不做的：不解析嵌套结构、不重排表格列宽、不处理 HTML。目标是「看得懂」，
 * 不是「渲染还原」——过度处理反而会在代码与路径上产生意外改动。
 */
export function stripMarkdown(text: string): string {
	let out = text;

	// 代码围栏：保留内容，去掉 ``` 行（含语言标识）。微信没有等宽字体，缩进即可读。
	out = out.replace(/^[\t ]*```[^\n]*$/gm, "");

	// 行内代码 → 去掉反引号。保留内容，因为路径/命令才是用户要看的东西。
	out = out.replace(/`([^`\n]+)`/g, "$1");

	// 标题：去掉前导 #，避免出现「### 标题」。
	out = out.replace(/^[\t ]{0,3}#{1,6}[\t ]+/gm, "");

	// 粗体/斜体：去掉标记字符本身。
	out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1");
	out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1");
	out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,，。])/g, "$1$2");
	out = out.replace(/__([^_\n]+)__/g, "$1");

	// 图片语法降级成链接。必须排在普通链接之前：`![alt](url)` 是 `[alt](url)` 的超集，
	// 先跑链接规则会把 `!` 留下（旧实现就是这么漏的）。
	out = out.replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => (label ? `${label} (${url})` : url));
	// 链接：保留文字 + 裸 URL（微信不可点击，但用户能复制）。
	out = out.replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => (label ? `${label} (${url})` : url));

	// 引用：只去掉 > 前缀。
	out = out.replace(/^[\t ]*>[\t ]?/gm, "");

	// 分隔线：整行 ---/***/___ 变成一行短横。
	out = out.replace(/^[\t ]*(?:-{3,}|\*{3,}|_{3,})[\t ]*$/gm, "──────────");

	// 列表：保留 - / * 前缀（纯文本里也看得懂层级），只把 * 统一成 -。
	out = out.replace(/^([\t ]*)[*+][\t ]+/gm, "$1- ");

	// 表格：去掉对齐行，其余去掉首尾竖线、用空格连接单元格。
	out = out.replace(/^[\t ]*\|?[\t :|-]+\|[\t :|-]*$/gm, "");
	out = out.replace(/^[\t ]*\|(.+)\|[\t ]*$/gm, (_m, row: string) =>
		row
			.split("|")
			.map((cell) => cell.trim())
			.filter((cell) => cell.length > 0)
			.join("  "),
	);

	// 折叠多余空行（Agent 输出常有连续空行，在聊天窗里会变成大片留白）。
	out = out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
	return out.trim();
}

/** 完整的出站准备：去标记 → 去思考块 → Markdown 降级 → 收敛空白。 */
export function prepareOutgoingText(text: string): string {
	return stripMarkdown(stripActionMarkers(stripThinkingBlocks(text))).trim();
}

/**
 * 按行边界切分成不超过 limit 的片段。
 *
 * 不按字数硬切的原因：硬切会把一个路径或代码行从中间断开，读起来像乱码。
 * 单行本身超长（例如一整行代码）时才退化为硬切——否则那行永远发不出去。
 */
export function splitForWeChat(text: string, limit = WECHAT_TEXT_CHUNK_MAX): string[] {
	if (!text) return [];
	if (text.length <= limit) return [text];

	const chunks: string[] = [];
	let current = "";
	for (const line of text.split("\n")) {
		// 单行超长：先冲掉手上的缓冲，再把这行硬切。
		if (line.length > limit) {
			if (current) {
				chunks.push(current);
				current = "";
			}
			for (let i = 0; i < line.length; i += limit) {
				chunks.push(line.slice(i, i + limit));
			}
			continue;
		}
		const candidate = current ? `${current}\n${line}` : line;
		if (candidate.length > limit) {
			chunks.push(current);
			current = line;
		} else {
			current = candidate;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

/**
 * 取本轮最近一条失败信息，用于「回合收口了但没有正文」时把后端错误原文回给用户。
 *
 * 两个来源：`role: "error"` 消息（pi 的错误气泡、DSH 的 turn/end 投影）与
 * `stopReason: "error"` 的 assistant 消息（供应商报错被塞进 assistant 骨架的情况）。
 * 只看这两个显式字段，不看 meta：时间线里大量 tool 消息也带 error 状态，按 meta
 * 匹配会把工具失败当成本轮失败发出去。
 */
export function pickLatestFailureText(messages: ReadonlyArray<{ role: string; text?: string; stopReason?: string }>): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message) continue;
		if (message.role !== "error" && message.stopReason !== "error") continue;
		const text = stripThinkingBlocks(message.text ?? "").trim();
		if (text) return text;
	}
	return "";
}

/** 取 Agent 最近一条助手消息的文本，用于回信。 */
export function pickLatestAssistantText(messages: ReadonlyArray<{ role: string; text?: string }>): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "assistant" || !message.text) continue;
		// 只有思考、没有正文的消息不算回复：继续往前找，别把思考内容当答案发出去。
		const text = stripThinkingBlocks(message.text).trim();
		if (text) return text;
	}
	return "";
}
