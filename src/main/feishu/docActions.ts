export const FEISHU_DOC_ACTION_HINT = [
	"\n\n[PiDeck 飞书能力]",
	"当前会话已连接飞书，PiDeck 主进程已配置可用凭证。需要创建飞书文档时，直接产出正文和动作标记。",
	"请先给出要写入文档的完整正文，最后单独输出一行 [CREATE_DOC:文档标题]。",
	"不要自己调用飞书 API，不要要求用户提供飞书凭证。",
].join("\n");

export function withFeishuDocActionHint(message: string): string {
	return `${message}${FEISHU_DOC_ACTION_HINT}`;
}

export function stripFeishuDocActionHint(text: string): string {
	return text.replace(/\n{0,2}\[PiDeck 飞书能力\][\s\S]*$/, "").trim();
}

export function stripFeishuActionMarkers(text: string): string {
	return text.replace(/\[(SEND_FILE|CREATE_DOC):[^\]]*\]/g, "").trim();
}

/**
 * 清洗同步到飞书的 assistant 正文：
 * - 去掉 <thinking> 标签块
 * - 去掉残留的 SEND_FILE/CREATE_DOC 动作标记
 * - 去掉 PiDeck 内部能力提示与宿主注入说明
 * 只保留用户可见的最终回复。
 */
export function sanitizeFeishuUserVisibleText(text: string): string {
	if (!text) return "";
	let next = text.replace(/\r\n/g, "\n");
	// 思考过程不应出现在飞书最终消息里
	next = next.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
	// 兼容模型直接输出未闭合标签的情况
	next = next.replace(/<\/?thinking>/gi, "");
	next = stripFeishuDocActionHint(next);
	next = stripFeishuActionMarkers(next);
	// 去掉宿主注入的飞书动作说明（若模型回显）
	next = next
		.replace(/^当前会话已连接飞书聊天[\s\S]*?(?:\n{2,}|$)/, "")
		.replace(/\n{0,2}\[这是飞书群聊消息[\s\S]*?\]\s*$/g, "")
		.replace(/\n{0,2}\[飞书群聊消息[\s\S]*?\]\s*$/g, "");
	return next.replace(/\n{3,}/g, "\n\n").trim();
}

export function splitDocTextBlocks(text: string, maxChars = 1800): string[] {
	const normalized = stripFeishuActionMarkers(text).replace(/\r\n/g, "\n").trim();
	if (!normalized) return [];

	const blocks: string[] = [];
	let current = "";
	for (const paragraph of normalized.split(/\n{2,}/)) {
		const next = current ? `${current}\n\n${paragraph}` : paragraph;
		if (next.length <= maxChars) {
			current = next;
			continue;
		}
		if (current) blocks.push(current);
		if (paragraph.length <= maxChars) {
			current = paragraph;
			continue;
		}
		for (let index = 0; index < paragraph.length; index += maxChars) {
			blocks.push(paragraph.slice(index, index + maxChars));
		}
		current = "";
	}
	if (current) blocks.push(current);
	return blocks;
}

export function buildFeishuTextChildren(text: string) {
	return splitDocTextBlocks(text).map((content) => ({
		block_type: 2,
		text: {
			elements: [{
				text_run: {
					content,
					text_element_style: {},
				},
			}],
			style: {},
		},
	}));
}

/** 从用户消息中判断是否要创建飞书文档，返回推断的文档标题。 */
export function wantsFeishuDoc(text: string): string | undefined {
	const t = text.toLowerCase();
	const hasDocIntent =
		/飞书文档/.test(text) ||
		/feishu.?doc/.test(t) ||
		/创建(?:一个|个|)?文档/.test(text) && /飞书|feishu/.test(t) ||
		/(?:做|生成|写)(?:一个|个|)?(?:飞书|feishu)(?:的)?(?:文档|doc)\b/.test(t) ||
		/(?:帮我)?(?:整理|总结|写).*(?:并|且|同时).*(?:飞书|feishu).*(?:文档|doc)/.test(text);
	if (!hasDocIntent) return undefined;

	const titleMatch = text.match(/(?:标题[是为叫]?|名称)[：:\s]*["""]?([^"""，,\s。.!！?？\n]{1,40})/);
	return titleMatch?.[1] || "Pi Agent 文档";
}
