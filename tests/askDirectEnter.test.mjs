import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

/** 加载 src/renderer/src/utils/askUi.ts（仅类型导入，vm 沙箱无 document 自动跳过模块级守卫） */
function loadAskUi() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/renderer/src/utils/askUi.ts"), sandbox, {
		filename: "askUi.ts",
	});
	return sandbox.exports;
}

test("isComposingKeyboardEvent: IME composing Enter (keyCode 229) is not a submit", () => {
	const mod = loadAskUi();
	assert.equal(mod.isComposingKeyboardEvent({ keyCode: 229 }), true);
	assert.equal(mod.isComposingKeyboardEvent({ keyCode: 13 }), false);
	assert.equal(mod.isComposingKeyboardEvent({}), false);
});

test("single select: Enter submits the chosen option (option button or blank area)", () => {
	const mod = loadAskUi();
	const base = { method: "select", selectedOption: "b", text: "", fromField: false, fromButton: false, fromOptionButton: false };
	// 焦点在选项按钮上、已选中 → 直接提交该项（「选了再回车」主路径）
	// 跨 vm realm 的对象不能 deepStrictEqual（原型不同），逐字段断言 kind/option
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, fromOptionButton: true }).kind, "submit-option");
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, fromOptionButton: true }).option, "b");
	// 卡片空白处回车、已选中 → 提交
	assert.equal(mod.resolveSingleAskDirectEnter(base).kind, "submit-option");
	// 未选中：选项按钮回车交原生 click 完成选中，不提交
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, selectedOption: "", fromOptionButton: true }).kind, "none");
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, selectedOption: "" }).kind, "none");
	// 自定义输入的「提交」按钮：交原生 click，避免把自定义文本提交误判为提交旧选项
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, fromButton: true }).kind, "none");
	// 焦点在输入框内：不拦截（由输入框自己的 onKeyDown 处理）
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, fromField: true }).kind, "none");
});

test("single confirm: blank-area Enter confirms, buttons keep native click", () => {
	const mod = loadAskUi();
	const base = { method: "confirm", selectedOption: "", text: "", fromField: false, fromButton: false, fromOptionButton: false };
	assert.equal(mod.resolveSingleAskDirectEnter(base).kind, "submit-confirm");
	// 是/否按钮交原生 click（取消按钮回车 = 拒绝，不能变成确认）
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, fromButton: true }).kind, "none");
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, fromField: true }).kind, "none");
});

test("single input: Enter submits typed text away from the field, button keeps native click", () => {
	const mod = loadAskUi();
	const base = { method: "input", selectedOption: "", text: "hello", fromField: false, fromButton: false, fromOptionButton: false };
	assert.equal(mod.resolveSingleAskDirectEnter(base).kind, "submit-text");
	assert.equal(mod.resolveSingleAskDirectEnter(base).text, "hello");
	// 提交按钮本身回车 = 原生 click（同一结果，但由按钮处理器兜底）
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, fromButton: true }).kind, "none");
	// 空内容不提交；焦点在输入框内不拦截（输入框内回车即提交）
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, text: "  " }).kind, "none");
	assert.equal(mod.resolveSingleAskDirectEnter({ ...base, fromField: true }).kind, "none");
});

test("batch: Enter advances only when the current question is answered", () => {
	const mod = loadAskUi();
	const base = { type: "select", fromField: false, fromButton: false, fromOptionButton: false, answered: true, nextDisabled: false };
	// 卡片空白处回车：已作答 → 下一题；未作答 → 不动作（防误触丢题）
	assert.equal(mod.resolveBatchAskDirectEnter(base).kind, "advance");
	assert.equal(mod.resolveBatchAskDirectEnter({ ...base, answered: false }).kind, "none");
	// 选项按钮：未作答回车 = 原生 click 选中/切换；已作答回车 = 提交并推进
	assert.equal(mod.resolveBatchAskDirectEnter({ ...base, fromOptionButton: true }).kind, "advance");
	assert.equal(mod.resolveBatchAskDirectEnter({ ...base, fromOptionButton: true, answered: false }).kind, "none");
	// 末题未全部作答时「下一题」禁用：不推进
	assert.equal(mod.resolveBatchAskDirectEnter({ ...base, nextDisabled: true }).kind, "none");
	// 其他按钮（上一步/提交自定义等）与输入框：交原生/字段自身处理器
	assert.equal(mod.resolveBatchAskDirectEnter({ ...base, fromButton: true }).kind, "none");
	assert.equal(mod.resolveBatchAskDirectEnter({ ...base, fromField: true }).kind, "none");
});

test("batch multi_select: Enter never advances on a single pick", () => {
	const mod = loadAskUi();
	// 回归：勾一个选项后 isBatchAnswered 即为 true，回车曾据此把整张卡推进/提交
	// （末题无审阅时直接 submitAnswers），与点击路径排除 multi_select 的口径不一致。
	const answeredMulti = { type: "multi_select", fromField: false, fromButton: false, fromOptionButton: false, answered: true, nextDisabled: false };
	assert.equal(mod.resolveBatchAskDirectEnter(answeredMulti).kind, "none");
	// 焦点在选项按钮上：回车交原生 click 切换勾选，不提交
	assert.equal(mod.resolveBatchAskDirectEnter({ ...answeredMulti, fromOptionButton: true }).kind, "none");
	// 与点击路径同口径：两条路径对 multi_select 的态度必须一致
	assert.equal(mod.shouldAutoAdvanceBatchAnswer({ type: "multi_select", total: 2 }), false);
	// 单值类型不受影响（仍可回车推进），且「已作答」仍是必要条件
	for (const type of ["select", "confirm", "input"]) {
		assert.equal(mod.resolveBatchAskDirectEnter({ ...answeredMulti, type }).kind, "advance");
		assert.equal(mod.resolveBatchAskDirectEnter({ ...answeredMulti, type, answered: false }).kind, "none");
	}
});

test("overlay wires the direct-enter strategy and IME guard into ask card keydown", () => {
	const overlay = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
	// 单卡与批量卡都走共享纯函数，不散落闭包策略。
	// 正则必须容忍任意换行与成员顺序：该 import 会被格式化折成多行且含 type 成员，
	// 不能假设 buildAskResponse 紧跟 `import {`（曾因此红灯）。
	assert.match(overlay, /import \{[\s\S]*?buildAskResponse,[\s\S]*?resolveSingleAskDirectEnter,[\s\S]*?\} from "\.\.\/\.\.\/utils\/askUi"/);
	assert.match(overlay, /resolveSingleAskDirectEnter\(/);
	assert.match(overlay, /resolveBatchAskDirectEnter\(/);
	// 所有 Enter 分支都排除 IME 合成键（keyCode 229），防止输入法选字回车误提交
	assert.match(overlay, /isComposingKeyboardEvent\(event\)/);
	// 多行编辑器保留换行：仅 Ctrl/Cmd+Enter 提交并进入下一题
	assert.match(overlay, /\(event\.ctrlKey \|\| event\.metaKey\)/);
});
