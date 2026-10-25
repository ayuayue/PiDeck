export const FEISHU_DOC_ACTION_HINT = ["\n\n[PiDeck 飞书能力]", "当前会话已连接飞书，PiDeck 主进程已配置可用凭证。需要创建飞书文档时，直接产出正文和动作标记。", "请先给出要写入文档的完整正文，最后单独输出一行 [CREATE_DOC:文档标题]。", "不要自己调用飞书 API，不要要求用户提供飞书凭证。"].join("\n");

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
/** 宿主注入给模型的内部指令边界（不应对用户展示）。 */
export const HOST_INSTRUCTION_START = "[PIDECK_HOST_INSTRUCTION]";
export const HOST_INSTRUCTION_END = "[/PIDECK_HOST_INSTRUCTION]";

/**
 * 把宿主指令与用户原文打包成发给模型的 message。
 * 指令包在标记内，展示层会剥离，只保留用户原文。
 */
export function wrapHostInstruction(instruction: string, userMessage: string): string {
	const instr = instruction.trim();
	const user = userMessage ?? "";
	if (!instr) return user;
	return `${HOST_INSTRUCTION_START}\n${instr}\n${HOST_INSTRUCTION_END}\n\n${user}`;
}

/**
 * 剥离宿主注入的内部指令，只保留用户可见输入。
 * 兼容历史会话：未加标记时，按已知通道指令前缀/特征行剥离（飞书、微信）。
 */
export function stripHostInstruction(text: string): string {
	if (!text) return "";
	let next = text.replace(/\r\n/g, "\n");

	// 新格式：明确边界标记
	next = next.replace(/\[PIDECK_HOST_INSTRUCTION\][\s\S]*?\[\/PIDECK_HOST_INSTRUCTION\]\s*/g, "");

	// 历史格式：指令直接拼在用户消息前。
	// 旧实现用 join("\n") 拼多行指令，再 "\n\n" + 用户原文；
	// 也兼容 content 数组拼接后只有单换行的情况。
	if (next.startsWith("当前会话已连接飞书聊天")) {
		// 优先按双换行切开（指令块 / 用户原文）
		const parts = next.split(/\n\n+/);
		if (parts.length >= 2 && parts[0].includes("SEND_FILE")) {
			next = parts.slice(1).join("\n\n");
		} else {
			// 单换行兜底：去掉所有“宿主指令特征行”，保留其余
			next = next
				.split("\n")
				.filter((line) => {
					const t = line.trim();
					if (!t) return true;
					if (t.startsWith("当前会话已连接飞书聊天")) return false;
					if (t.startsWith("当前绑定的飞书 chat_id:")) return false;
					if (t.includes("严禁调用 lark-cli")) return false;
					if (t.includes("这是只读上下文，用于确认当前会话绑定")) return false;
					if (t.includes("创建飞书文档时，先输出完整正文")) return false;
					if (t === "这是飞书群聊消息。请直接回复用户。") return false;
					return true;
				})
				.join("\n");
		}
	}

	// 历史格式（微信）：WeChatBridge.buildAgentMessage 把通道指令拼在用户原文前。
	// 必须匹配带通道签名的完整首行：用户真的问「当前会话已连接微信吗」时不能被当成指令剥空。
	if (/^当前会话已连接微信[（(]iLink/.test(next)) {
		const parts = next.split(/\n\n+/);
		if (parts.length >= 2 && parts[0].includes("iLink")) {
			next = parts.slice(1).join("\n\n");
		} else {
			// 单换行兜底（用户原文为空时只剩指令块）：去掉已知指令特征行
			next = next
				.split("\n")
				.filter((line) => {
					const t = line.trim();
					if (!t) return true;
					if (/^当前会话已连接微信[（(]iLink/.test(t)) return false;
					if (t.includes("微信只支持纯文本")) return false;
					if (t.includes("不要调用任何微信/IM 发送接口")) return false;
					if (t.includes("该通道不支持发送文件、图片与引用消息")) return false;
					if (t.includes("微信通道不能主动推送消息")) return false;
					if (/^请用.{1,20}回答。$/.test(t)) return false;
					return true;
				})
				.join("\n");
		}
	}

	// 飞书来源尾部宿主说明
	next = next.replace(/\n{0,2}\[这是飞书群聊消息。请直接回复用户。\]\s*$/g, "").replace(/\n{0,2}\[飞书群聊消息。请直接回复用户。\]\s*$/g, "");

	return next.replace(/\n{3,}/g, "\n\n").trim();
}

export function sanitizeFeishuUserVisibleText(text: string): string {
	if (!text) return "";
	let next = text.replace(/\r\n/g, "\n");
	// 思考过程不应出现在飞书最终消息里
	next = next.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
	// 兼容模型直接输出未闭合标签的情况
	next = next.replace(/<\/?thinking>/gi, "");
	next = stripHostInstruction(next);
	next = stripFeishuDocActionHint(next);
	next = stripFeishuActionMarkers(next);
	// 去掉宿主注入的飞书动作说明（若模型回显）
	next = next.replace(/^当前会话已连接飞书聊天[\s\S]*?(?:\n{2,}|$)/, "");
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
			elements: [
				{
					text_run: {
						content,
						text_element_style: {},
					},
				},
			],
			style: {},
		},
	}));
}

/** 从用户消息中判断是否要创建飞书文档，返回推断的文档标题。 */
export function wantsFeishuDoc(text: string): string | undefined {
	const t = text.toLowerCase();
	const hasDocIntent = /飞书文档/.test(text) || /feishu.?doc/.test(t) || (/创建(?:一个|个|)?文档/.test(text) && /飞书|feishu/.test(t)) || /(?:做|生成|写)(?:一个|个|)?(?:飞书|feishu)(?:的)?(?:文档|doc)\b/.test(t) || /(?:帮我)?(?:整理|总结|写).*(?:并|且|同时).*(?:飞书|feishu).*(?:文档|doc)/.test(text);
	if (!hasDocIntent) return undefined;

	const titleMatch = text.match(/(?:标题[是为叫]?|名称)[：:\s]*["""]?([^"""，,\s。.!！?？\n]{1,40})/);
	return titleMatch?.[1] || "Pi Agent 文档";
}
