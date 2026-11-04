import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 工具语义短语（学 Proma tool-phrase.ts）：折叠态显示可读中文短语，
// 替代完整命令行，让工具行更轻、更易扫读。
// 纯函数用 ts 编译 + vm 加载，避免模块路径解析负担。
const rawSource = readFileSync("src/renderer/src/components/session/timeline/toolPhrase.ts", "utf8");
// 去掉 import 行（本测试直接传解析后的 input，不需要真实 parseToolArgs）；
// 保留 export，CommonJS 编译后挂到 module.exports。
const moduleSource = rawSource.replace(/^import .*$/gm, "").replace("export interface ToolPhrase", "interface ToolPhrase");

function loadPhrase(toolName, input) {
	return loadPhraseWithKind(toolName, input);
}

// ACP 专用：meta.toolName 是 agent 给的人类标题、不是工具名，短语要靠 meta.kind 选动词。
function loadPhraseWithKind(toolName, input, kind) {
	const js = ts.transpileModule(moduleSource, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const module = { exports: {} };
	const sandbox = { module, exports: module.exports, console };
	vm.runInNewContext(js, sandbox);
	return sandbox.module.exports.getToolPhrase(toolName, input, kind);
}

test("read tool produces a readable file phrase", () => {
	const phrase = loadPhrase("Read", { file_path: "src/main.ts" });
	assert.match(phrase.label, /读取 main\.ts/);
	assert.match(phrase.loadingLabel, /正在读取 main\.ts/);
});

test("bash tool shows the command", () => {
	const phrase = loadPhrase("Bash", { command: "npm run build" });
	assert.match(phrase.label, /执行 npm run build/);
	assert.match(phrase.loadingLabel, /正在执行 npm run build/);
});

test("grep tool shows the pattern", () => {
	const phrase = loadPhrase("Grep", { pattern: "TODO" });
	assert.match(phrase.label, /搜索 TODO/);
});

test("write tool produces file phrase", () => {
	const phrase = loadPhrase("Write", { file_path: "a/b/new.ts" });
	assert.match(phrase.label, /写入 new\.ts/);
});

test("unknown/extension tool falls back to name + arg summary", () => {
	const phrase = loadPhrase("get_search_content", { query: "shadcn" });
	assert.match(phrase.label, /get_search_content shadcn/);
});

// 2026-10 对齐 ZCode 过程行排版：短语拆成「动词 + 对象」两段——动词做工具行主标签
// （界面字体），对象进等宽 chip 单行截断；label/loadingLabel 拼接格式保持不变。
test("phrase splits into verb and object for the silent tool row", () => {
	const read = loadPhrase("Read", { file_path: "src/main.ts" });
	assert.equal(read.verb, "读取");
	assert.equal(read.object, "main.ts");
	assert.equal(read.label, "读取 main.ts");

	const bash = loadPhrase("Bash", { command: "npm run build" });
	assert.equal(bash.verb, "执行");
	assert.equal(bash.object, "npm run build");
	assert.equal(bash.label, "执行 npm run build");
	assert.equal(bash.loadingLabel, "正在执行 npm run build...");
});

test("phrase without an object keeps label equal to the verb alone", () => {
	const read = loadPhrase("Read", {});
	assert.equal(read.object, undefined);
	assert.equal(read.label, "读取文件");
	assert.equal(read.loadingLabel, "正在读取文件...");
});

test("unknown tool verb falls back to the raw tool name", () => {
	const phrase = loadPhrase("get_search_content", { query: "shadcn" });
	assert.equal(phrase.verb, "get_search_content");
	assert.equal(phrase.object, "shadcn");
});

// 2026-10 全量本土化：内置短语表之外的常见 MCP/扩展工具名走关键词词典，
// 过程行不再露出英文工具名（cua_*、browser_*、子代理、Git 等）。
test("keyword dictionary localizes host MCP tool names (cua/browser)", () => {
	const click = loadPhrase("cua_click", { x: 100, y: 200 });
	assert.equal(click.verb, "点击");
	assert.equal(click.object, undefined);
	assert.equal(click.loadingLabel, "正在点击...");

	const typed = loadPhrase("mcp__pideck-cua__cua_type", { text: "你好，世界" });
	assert.equal(typed.verb, "输入");
	assert.equal(typed.object, "你好，世界");

	const nav = loadPhrase("browser_navigate", { url: "https://example.com/docs" });
	assert.equal(nav.verb, "打开页面");
	assert.equal(nav.object, "https://example.com/docs");

	const shot = loadPhrase("browser_screenshot", {});
	assert.equal(shot.verb, "截图");
});

// 2026-10 用户反馈「行里写着截屏，实际是抓包工具的 MCP 调用」：`capture` 是歧义词
// （截屏 / 抓包），裸关键词会把 mcp__reqable__capture_live_get_by_id 说成截屏。
// 口径：屏幕捕捉只认 screenshot / screen_capture / capture_screen / cua_capture，
// 其余带 capture 的工具落回通用回退（原样显示工具名），不猜语义。
test("bare capture keyword no longer claims screen capture for packet-capture tools", () => {
	const proxy = loadPhrase("mcp__reqable__capture_live_get_by_id", { id: 24587 });
	assert.notEqual(proxy.verb, "截屏");
	assert.equal(proxy.verb, "mcp__reqable__capture_live_get_by_id");
	assert.equal(proxy.object, undefined);

	const cua = loadPhrase("cua_capture", {});
	assert.equal(cua.verb, "截图");
});

// 2026-11 用户反馈「读记忆的 MCP 调用被显示成派出子代理」：`mcp__<server>__<tool>` 里的 server
// 名同样由第三方/用户自定（宿主记忆 server 叫 `pideck_agent_memory`），拿整条工具名做子串匹配
// 时 server 名里的 `agent` 会截走 `memory_get` 这类无关工具。口径：名词猜语义的分支只拿
// `<tool>` 段匹配，server 名不参与；工具段本身仍照常命中（`cua_type` → 「输入」）。
test("MCP server namespace does not drive the verb dictionary", () => {
	const get = loadPhrase("mcp__pideck_agent_memory__memory_get", { target: "user" });
	assert.notEqual(get.verb, "派出子代理");
	assert.equal(get.verb, "mcp__pideck_agent_memory__memory_get");
	// target=user 不是通用可读参数（是记忆范围），不再变成动词旁的 chip
	assert.equal(get.object, undefined);

	const search = loadPhrase("mcp__pideck_agent_memory__memory_search", { query: "路由" });
	assert.notEqual(search.verb, "派出子代理");

	// server 名里的词不再截胡；工具段里的关键词照常命中
	const typed = loadPhrase("mcp__pideck-cua__cua_type", { text: "你好" });
	assert.equal(typed.verb, "输入");
	const dispatch = loadPhrase("mcp__agent_hub__agent_dispatch", { prompt: "查一下路由" });
	assert.equal(dispatch.verb, "派出子代理");
});

test("keyword dictionary covers subagent and git tool families with order guard", () => {
	const dispatch = loadPhrase("Agent", { prompt: "查一下路由" });
	assert.equal(dispatch.verb, "派出子代理");
	assert.equal(dispatch.object, "查一下路由");

	const result = loadPhrase("get_subagent_result", { agent_id: "explore-1" });
	assert.equal(result.verb, "领取子代理结果");

	const git = loadPhrase("git_status", {});
	assert.equal(git.verb, "Git 操作");
	assert.equal(git.loadingLabel, "正在执行 Git...");
});

test("keyword dictionary keeps exact builtin branches winning over substring matches", () => {
	// web_search 是内置精确分支（获取），不能被词典的 search 类键截胡
	const web = loadPhrase("web_search", { query: "react 19" });
	assert.equal(web.verb, "获取");
});

// 2026-10 用户反馈「acp 的工具调用有时候一行重复俩」：ACP 的 meta.toolName 是 agent
// 给的人类标题（opencode 给 `` `ls -la` ``、claude 系给 `Read C:\a.ts`），标题本身已含
// 参数。此前按工具名走通用回退 → 动词是整条标题、对象又是同一个参数，同一行把命令印两遍。
// 修复口径：有 meta.kind 时按协议类别选动词（复用内置分支），标题不再进短语。
test("ACP tool kinds reuse builtin verbs instead of the title-as-tool-name fallback", () => {
	const command = 'grep -ril "durable" "/srv/pi-deck/chat-workspace" 2>/dev/null';
	const execute = loadPhraseWithKind(`\`${command}\``, { command }, "execute");
	assert.equal(execute.verb, "执行");
	assert.equal(execute.object, command);
	assert.equal(execute.loadingLabel, `正在执行 ${command}...`);
	assert.ok(!execute.loadingLabel.includes("`"), "标题不再参与拼接：行内只剩一遍命令");

	const read = loadPhraseWithKind("Read src/work/models.json", { file_path: "src/work/models.json" }, "read");
	assert.equal(read.verb, "读取");
	assert.equal(read.object, "models.json");
	assert.equal(read.loadingLabel, "正在读取 models.json...");

	const search = loadPhraseWithKind("Searching for durable", { query: "durable" }, "search");
	assert.equal(search.verb, "搜索");
	assert.equal(search.object, "durable");

	const fetch = loadPhraseWithKind("fetch https://example.com", { url: "https://example.com" }, "fetch");
	assert.equal(fetch.verb, "获取");
	assert.equal(fetch.object, "https://example.com");
});

test("ACP delete/move kinds get their own verbs and the file name as object", () => {
	const removed = loadPhraseWithKind("Delete src/work/tmp.log", { file_path: "src/work/tmp.log" }, "delete");
	assert.equal(removed.verb, "删除");
	assert.equal(removed.object, "tmp.log");
	assert.equal(removed.loadingLabel, "正在删除 tmp.log...");

	const moved = loadPhraseWithKind("Move a.ts", { file_path: "src/a.ts" }, "move");
	assert.equal(moved.verb, "移动");
	assert.equal(moved.object, "a.ts");
});

test("title-like tool names drop the argument already contained in the title", () => {
	// 无 kind（ACP `other`）或第三方扩展把标题当工具名：标题已含参数时不再拼一遍。
	for (const kind of [undefined, "other", "think"]) {
		const phrase = loadPhraseWithKind("`ls -la`", { command: "ls -la" }, kind);
		assert.equal(phrase.verb, "`ls -la`");
		assert.equal(phrase.object, undefined);
		assert.equal(phrase.label, "`ls -la`");
		assert.equal(phrase.loadingLabel, "正在`ls -la`...");
	}
	// 标题不含参数时仍保留对象预览（不误删可读信息）。
	const mcp = loadPhraseWithKind("get_search_content", { query: "shadcn" }, "other");
	assert.equal(mcp.object, "shadcn");
});
