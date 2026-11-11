/**
 * 工具语义化短语生成器。
 *
 * 将工具名 + 参数合成为一句连贯、可读的中文短语，用于工具卡收起态展示，
 * 替代直接显示完整命令行——折叠态更轻、更易扫读。
 *
 * 2026-10 过程行排版：短语拆成「动词 + 作用对象」两段——
 * 动词做 trigger 行主标签（界面字体），对象进等宽 chip 单行截断预览。
 *
 * 纯函数、无运行时依赖（node 单测直接加载）。
 */
import { parseToolArgs } from "../../app/AppUtils";

/** 从路径中提取文件名（兼容 POSIX `/` 与 Windows `\` 分隔符） */
function filename(path: string): string {
	return path.split(/[/\\]/).pop() || path;
}

/** 截断文本 */
function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + "…" : text;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value;
		if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
			return value[0];
		}
	}
	return undefined;
}

function pickPath(input: Record<string, unknown>): string | undefined {
	return firstString(input.file_path, input.filePath, input.path, input.file, input.target, input.destination, input.dest_path);
}

export interface ToolPhrase {
	/** 完成态/收起态短语（`动词 + 空格 + 对象` 拼接），供组头摘要等整句消费者 */
	label: string;
	/** Loading 态短语，如「正在读取 foo.ts...」 */
	loadingLabel: string;
	/** 人类动词（「读取」「执行」…）：工具行主标签，界面字体 */
	verb: string;
	/** 作用对象（文件名/命令/URL…）：进等宽 chip 预览，视觉单行截断；无对象时缺省 */
	object?: string;
}

/** 直接挂在 MCP server 下的工具名前缀（与 `toolKind.ts` 口径一致；本文件零依赖，不复用常量）。 */
const MCP_DIRECT_PREFIX = "mcp__";

/**
 * 语义猜测所用的名字：`mcp__<server>__<tool>` 只取 `<tool>` 段。
 *
 * server 名由第三方/用户自定（本机宿主 server 叫 `pideck_agent_memory`），拿整条名字做子串
 * 匹配会让 server 名里的词污染动词词典：`mcp__pideck_agent_memory__memory_get` 被 server 名里
 * 的 `agent` 截走，一次读记忆被显示成「派出子代理」（2026-11 用户反馈）。工具段本身照常命中，
 * `mcp__pideck-cua__cua_type` 仍是「输入」。名字里没有 server 段时原样返回。
 */
function semanticMatchName(key: string): string {
	if (!key.startsWith(MCP_DIRECT_PREFIX)) return key;
	const separator = key.lastIndexOf("__");
	return separator > MCP_DIRECT_PREFIX.length ? key.slice(separator + 2) : key;
}

/** 组装 ToolPhrase：label 固定为「动词 对象」拼接，保持整句消费者的产出不变 */
function phraseFor(verb: string, object: string | undefined, loadingVerb: string): ToolPhrase {
	return {
		verb,
		object,
		label: object ? `${verb} ${object}` : verb,
		loadingLabel: object ? `${loadingVerb} ${object}...` : `${loadingVerb}...`,
	};
}

/**
 * 常见工具动作关键词 → 中文动宾（按序子串匹配，命中即止）。
 *
 * 覆盖内置短语表之外的宿主 MCP 工具（pideck-cua 的 cua_*、browser_*）与常见第三方
 * MCP/扩展工具名（`mcp__server__tool` 形态只拿 `<tool>` 段匹配，server 名不参与猜词）。
 * 词序敏感：更具体的键必须排在会被它截胡的短键前面（subagent_result 先于 agent）。
 * 新增宿主工具时在这里补一行即可让过程行本土化，避免回退到英文工具名。
 */
const KEYWORD_PHRASES: ReadonlyArray<readonly [keyword: string, verb: string, loadingVerb: string]> = [
	["click", "点击", "正在点击"],
	["press_key", "按键", "正在按键"],
	["type", "输入", "正在输入"],
	["navigate", "打开页面", "正在打开页面"],
	["goto", "跳转", "正在跳转"],
	// 「屏幕捕捉」只认带 screen/screenshot 的写法。裸 `capture` 不能进词典：
	// 抓包/代理类 MCP 工具（reqable、mitmproxy）的工具名同样含 capture，
	// 命中后会把一次「读取抓包记录」说成「截屏」（2026-10 用户反馈）。
	["screenshot", "截图", "正在截图"],
	["screen_capture", "截图", "正在截图"],
	["capture_screen", "截图", "正在截图"],
	["cua_capture", "截图", "正在截图"],
	["snapshot", "获取快照", "正在获取快照"],
	["scroll", "滚动", "正在滚动"],
	["wait", "等待", "正在等待"],
	["list_windows", "列出窗口", "正在列出窗口"],
	["state", "读取状态", "正在读取状态"],
	["subagent_result", "领取子代理结果", "正在领取子代理结果"],
	["agent", "派出子代理", "正在派出子代理"],
	["git", "Git 操作", "正在执行 Git"],
];

/**
 * ACP 工具类别（`meta.kind`）→ 复用的内置短语分支。
 *
 * ACP 的 `meta.toolName` 不是工具名，而是 agent 给的**人类标题**（opencode 给
 * `` `ls -la` ``，claude 系给 `Read <路径>`）。标题本身已包含参数，当工具名走通用回退
 * 分支时动词是整条标题、对象又是同一个参数 → 同一行把命令重复两遍（2026-10 反馈）。
 * 类别是协议里的稳定字段（ACP `ToolKind`），用它选动词；标题只留在行 tooltip 与展开详情。
 */
const ACP_KIND_BUILTIN_TOOL: Readonly<Record<string, string>> = {
	read: "read",
	edit: "edit",
	search: "grep",
	execute: "bash",
	fetch: "fetch",
};

/** ACP 类别里没有内置分支的两个文件操作：直接给动词，对象取路径文件名。 */
const ACP_KIND_VERBS: Readonly<Record<string, readonly [verb: string, loadingVerb: string]>> = {
	delete: ["删除", "正在删除"],
	move: ["移动", "正在移动"],
};

/**
 * 根据工具名和输入参数生成语义化短语。
 * 内置工具走中文动宾短语；常见 MCP/扩展工具名走关键词词典；其余回退为 `工具名 参数摘要`。
 * `kind` 是 ACP 工具类别：给了类别时先按类别选动词，不拿标题式工具名拼短语。
 */
export function getToolPhrase(toolName: string, input: Record<string, unknown> = {}, kind?: string): ToolPhrase {
	const acpKind = typeof kind === "string" ? kind.trim().toLowerCase() : "";
	const builtinTool = ACP_KIND_BUILTIN_TOOL[acpKind];
	if (builtinTool) return getToolPhrase(builtinTool, input);
	const kindVerbs = ACP_KIND_VERBS[acpKind];
	if (kindVerbs) {
		const target = pickPath(input);
		return phraseFor(kindVerbs[0], target ? filename(target) : undefined, kindVerbs[1]);
	}

	const key = toolName.toLowerCase();
	// 下面所有「名字里含某个词就猜语义」的分支都只看 matchKey：MCP 的 server 名不参与猜词。
	const matchKey = semanticMatchName(key);
	const path = pickPath(input);
	const file = path ? filename(path) : undefined;

	// 文件读取/编辑/写入类。无对象时动词回退为完整动宾（「读取文件」），
	// 行内不能只剩光杆动词——那会比旧短语更少信息量。
	if (key === "read") {
		if (!file) return phraseFor("读取文件", undefined, "正在读取文件");
		const range = firstString(input.offset, input.start_line) !== undefined ? `（${firstString(input.offset, input.start_line)} 行起）` : "";
		return phraseFor("读取", `${file}${range}`, "正在读取");
	}
	if (key === "edit" || key === "multi_edit") {
		return file ? phraseFor("编辑", file, "正在编辑") : phraseFor("编辑文件", undefined, "正在编辑文件");
	}
	if (key === "write" || key === "create") {
		return file ? phraseFor("写入", file, "正在写入") : phraseFor("写入文件", undefined, "正在写入文件");
	}

	// bash / shell 命令
	if (key === "bash" || key === "shell" || key === "run") {
		const command = firstString(input.command, input.cmd);
		return phraseFor("执行", command, "正在执行");
	}

	// 搜索类
	if (key === "grep" || key === "search") {
		const pattern = firstString(input.pattern, input.query, input.q);
		return phraseFor("搜索", pattern, "正在搜索");
	}
	if (key === "glob" || key === "find") {
		const pattern = firstString(input.pattern, input.glob, input.query);
		return phraseFor("查找", pattern, "正在查找");
	}

	// 网络获取类
	if (key === "fetch" || key === "fetch_content" || key === "web_search" || key === "url" || key === "http" || matchKey.includes("fetch")) {
		const url = firstString(input.url, input.urls, input.query);
		return phraseFor("获取", url, "正在获取");
	}

	// 待办/清单类
	if (key === "todo" || key === "todolist" || key === "task") {
		const action = firstString(input.action, input.text);
		return phraseFor("待办", action, "正在更新待办");
	}

	// 图片/附件
	if (key === "image" || key === "vision" || matchKey.includes("image")) {
		return phraseFor("查看图片", file, "正在查看图片");
	}

	// 关键词词典：常见 MCP/扩展工具动词本土化（cua_*、browser_*、子代理、Git 等）。
	// 对象优先取可读字符串参数（输入文本/URL/查询词/选择器），其余进等宽 chip。
	for (const [keyword, verb, loadingVerb] of KEYWORD_PHRASES) {
		if (matchKey.includes(keyword)) {
			const param = firstString(input.text, input.url, input.query, input.prompt, input.selector, input.target, input.path, input.file_path, input.filePath, input.command, input.pattern);
			return phraseFor(verb, param ? truncate(String(param), 60) : undefined, loadingVerb);
		}
	}

	// 通用/扩展/MCP 工具：回退到「工具名 参数摘要」。
	// 标题式工具名（ACP 未给类别的 `other`、部分第三方扩展）本身已含参数摘要，
	// 再拼一遍对象就是同一行重复两遍，因此标题里已有这串参数时不再拼。
	const paramSummary = firstString(input.command, input.cmd, input.pattern, input.query, input.url, input.file_path, input.filePath, input.path);
	const displayName = toolName || "工具";
	const summary = paramSummary !== undefined ? String(paramSummary) : undefined;
	const alreadyInTitle = summary !== undefined && displayName.includes(summary);
	return phraseFor(displayName, summary !== undefined && !alreadyInTitle ? truncate(summary, 60) : undefined, `正在${displayName}`);
}

/** 兼容旧签名：接收 ChatMessage 的 meta.args / meta.kind，内部解析（给 ToolCard 直接用）。 */
export function getToolPhraseFromArgs(toolName: string, args: unknown, kind?: unknown): ToolPhrase {
	const parsed = parseToolArgs(args);
	return getToolPhrase(toolName, parsed ?? {}, typeof kind === "string" ? kind : undefined);
}
