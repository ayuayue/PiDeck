import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 纯函数模块（无 electron 依赖），直接编译执行，测行为不测实现
function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const { extractFocusTargetFromArgv } = compile("src/main/utils/focusTarget.ts");

const SESSION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const AGENT_ID = "9c858b90-9e1e-4e8b-9f4e-8f9e9e9e9e9e";

// vm 上下文的对象原型与测试 realm 不同，deepStrictEqual 会误报，统一逐字段断言
function expectTarget(argv, expected) {
	const target = extractFocusTargetFromArgv(argv);
	assert.equal(target?.sessionId, expected.sessionId);
	assert.equal(target?.agentId, expected.agentId);
	assert.equal(target?.projectPath, expected.projectPath);
}

test("解析 pideck://session/ 协议 URL（通知点击主路径）", () => {
	const argv = ["C:\\Program Files\\PiDeck\\PiDeck.exe", `pideck://session/${SESSION_ID}`];
	expectTarget(argv, { sessionId: SESSION_ID, agentId: undefined });
});

test("解析 pideck://agent/ 兼容格式（旧 toast 兜底）", () => {
	const argv = ["PiDeck.exe", `pideck://agent/${AGENT_ID}`];
	expectTarget(argv, { sessionId: undefined, agentId: AGENT_ID });
});

test("解析 pideck-dev:// 协议 URL（dev 通道安装包的同源 scheme）", () => {
	const argv = ["PiDeckDev.exe", `pideck-dev://session/${SESSION_ID}`];
	expectTarget(argv, { sessionId: SESSION_ID, agentId: undefined });
	const agentArgv = ["PiDeckDev.exe", `pideck-dev://agent/${AGENT_ID}`];
	expectTarget(agentArgv, { sessionId: undefined, agentId: AGENT_ID });
});

test("协议 URL 大小写不敏感", () => {
	const upper = SESSION_ID.toUpperCase();
	const argv = ["PiDeck.exe", `PIDECK://SESSION/${upper}`];
	expectTarget(argv, { sessionId: upper, agentId: undefined });
});

test("无通知唤起参数时返回 undefined（仅聚焦窗口）", () => {
	assert.equal(extractFocusTargetFromArgv(["PiDeck.exe"]), undefined);
	assert.equal(extractFocusTargetFromArgv([]), undefined);
	assert.equal(extractFocusTargetFromArgv(undefined), undefined);
});

test("非 agent/session 协议（如 pideck:// 根地址）不产生跳转目标", () => {
	assert.equal(extractFocusTargetFromArgv(["PiDeck.exe", "pideck://"]), undefined);
});

test("解析 --open-project 独立参数（文件夹右键菜单唤起主路径）", () => {
	const argv = ["PiDeck.exe", "--open-project", "D:\\work\\my-project"];
	expectTarget(argv, { sessionId: undefined, agentId: undefined, projectPath: "D:\\work\\my-project" });
});

test("解析 --open-project=<path> 等号形式（含空格路径）", () => {
	expectTarget(["PiDeck.exe", "--open-project=C:\\a b\\repo"], {
		sessionId: undefined,
		agentId: undefined,
		projectPath: "C:\\a b\\repo",
	});
});

test("--open-project 后跟 -- 开头参数视为缺路径（避免吞掉其他开关）", () => {
	const argv = ["PiDeck.exe", "--open-project", "--remote-debugging-port=9222"];
	assert.equal(extractFocusTargetFromArgv(argv), undefined);
});

test("--open-project 缺参数时不产生跳转目标", () => {
	assert.equal(extractFocusTargetFromArgv(["PiDeck.exe", "--open-project"]), undefined);
	// 参数在末尾且完全没有值
	assert.equal(extractFocusTargetFromArgv(["PiDeck.exe", "--open-project"]), undefined);
});

test("协议 URL 与 --open-project 并存时按 argv 顺序取先命中者", () => {
	const argv = ["PiDeck.exe", "--open-project", "D:\\proj", `pideck://session/${SESSION_ID}`];
	const target = extractFocusTargetFromArgv(argv);
	assert.equal(target?.projectPath, "D:\\proj");
	assert.equal(target?.sessionId, undefined);
});

test("--open-project 路径前后空白被裁剪", () => {
	expectTarget(["PiDeck.exe", "--open-project", "  C:\\proj  "], {
		sessionId: undefined,
		agentId: undefined,
		projectPath: "C:\\proj",
	});
});
