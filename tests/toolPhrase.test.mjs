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
	const js = ts.transpileModule(moduleSource, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const module = { exports: {} };
	const sandbox = { module, exports: module.exports, console };
	vm.runInNewContext(js, sandbox);
	return sandbox.module.exports.getToolPhrase(toolName, input);
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
