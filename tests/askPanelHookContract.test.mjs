import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 并行问询 hook 源码契约测试（src/renderer/src/hooks/useAskPanel.ts）。
 *
 * 为什么用源码断言而不是直接执行 hook：useAskPanel 是 React hook，依赖 jotai store
 * 与 preload desktopApi，完整执行需要大量 stub；本测试聚焦「能力契约」——
 * 上下文继承如何注入、追问是否复用匿名会话、关闭是否清空 origin，
 * 通过编译后模块的代码形状断言防回归（与 sessionComposer.test.mjs 同款方式）。
 */
function compile(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
			jsx: ts.JsxEmit.ReactJSX,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => stubsFor(specifier);
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			crypto: { randomUUID: () => "request-id" },
			console,
			Set,
		},
		{ filename: filePath },
	);
	return module.exports;
}

/** 按模块名提供最小 stub：hook 只 import 不直接调用外部实现，源码形状断言不依赖其行为 */
function stubsFor(specifier) {
	const stub = { useAtom: (v) => [v, () => undefined], useAtomValue: (v) => v, useCallback: (fn) => fn, useStore: () => ({ get: () => undefined, set: () => undefined }) };
	if (specifier.includes("react")) return { useCallback: stub.useCallback };
	if (specifier.includes("jotai")) return stub;
	if (specifier.includes("desktopApi")) return { sessions: { createAnonymous: async () => ({ session: { id: "s" } }), sendPrompt: async () => ({ accepted: true }), stopRuntime: async () => undefined } };
	return {};
}

const askPanelSource = () => readFileSync("src/renderer/src/hooks/useAskPanel.ts", "utf8");
const composerSource = () => readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const overlaySource = () => readFileSync("src/renderer/src/components/overlays/AskPanelOverlay.tsx", "utf8");
const contextSource = () => readFileSync("src/renderer/src/utils/askPanelContext.ts", "utf8");
const atomsSource = () => readFileSync("src/renderer/src/atoms/ask-panel-atoms.ts", "utf8");

test("context is injected via agentMessage so UI timeline only shows user text", () => {
	const source = askPanelSource();
	assert.match(source, /agentMessage: `\$\{context\}\\n\\n\$\{text\}`/);
	// message 仍是用户原文（胶囊时间线不被上下文污染）
	assert.match(source, /message: text,/);
});

test("sendAsk passes context and originSessionId to the panel", () => {
	const source = askPanelSource();
	// 公共 API：sendToAsk(projectId, text, { context?, originSessionId? })
	assert.match(source, /context\?: string; originSessionId\?: string/);
	assert.match(source, /if \(options\?\.originSessionId\) setOriginSessionId/);
});

test("调用方未显式传 context 时，按 originSessionId 自动生成主会话上下文", () => {
	const source = askPanelSource();
	// 输入框「并行发送」只传 originSessionId；自动兜底放在 hook 内，避免各入口各写一份
	assert.match(source, /options\?\.context\s*\?\?\s*buildAskContextForSession\(store, options\?\.originSessionId\)/);
});

test("输入框并行发送只传 originSessionId，不另建一份 context", () => {
	const source = composerSource();
	assert.match(source, /sendToAsk\(effectiveProjectId, text, \{\s*originSessionId: sessionId,?\s*\}\)/);
});

test("follow-up reuses the existing anonymous session without creating a new one", () => {
	const source = askPanelSource();
	// sendFollowUp 直接 dispatchPrompt(sessionId)，不再走 ensureSession/setCreating
	assert.match(source, /const sendFollowUp = useCallback/);
	assert.match(source, /if \(!sessionId\) return false;/);
	assert.match(source, /return dispatchPrompt\(sessionId, trimmed\);/);
});

test("close clears origin session id along with the anonymous session", () => {
	const source = askPanelSource();
	assert.match(source, /setSessionId\(null\);\n\s*setOriginSessionId\(null\);/);
});

test("overlay exposes copy-answer and insert-to-composer actions", () => {
	const source = overlaySource();
	// 复制答案：汇聚全部 assistant 正文
	assert.match(source, /const fullAnswer = messages/);
	// 链式调用可能被格式化拆到多行（navigator.clipboard 与 .writeText 分行）：容忍换行。
	assert.match(source, /navigator\.clipboard\s*\n?\s*\.writeText\(fullAnswer\)/);
	// 插入主会话 composer：setSessionDraftAtom 追加，不自动发送
	assert.match(source, /setInsertComposer\(\{/);
	assert.match(source, /sessionId: origin,/);
	assert.match(source, /value: \(current\) => \(current \? `\$\{current\}\\n\\n\$\{fullAnswer\}` : fullAnswer\)/);
});

test("overlay keeps a follow-up composer that reuses the panel session", () => {
	const source = overlaySource();
	assert.match(source, /const submitFollowUp = /);
	assert.match(source, /panel\.sendFollowUp\(text\)\.then/);
	assert.match(source, /if \(ok\) setFollowUpText\(""\)/);
});

test("atoms track the origin session for bring-back-to-main", () => {
	const source = atomsSource();
	assert.match(source, /askPanelOriginSessionIdAtom/);
	// origin 与匿名会话同生命周期：注释明确「关闭弹框即清空」
	assert.match(source, /关闭弹框即清空|cleared when the panel closes/);
});

test("context block module is pure and exported", () => {
	const source = contextSource();
	assert.match(source, /export function buildAskContextBlock/);
});

test("compile smoke: useAskPanel module loads without throwing", () => {
	const loaded = compile("src/renderer/src/hooks/useAskPanel.ts");
	assert.ok(loaded, "module should compile and load");
});
