import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 回归：`ComposerBottomBar` 把 hook 写进三元表达式的条件分支，点开后端选择器选中
 * ACP 工具（opencode）时整个输入框区域崩溃：
 *
 *     const lockedAcpTool = props.backend === "acp" ? useAtomValue(acpToolsAtom).find(...) : undefined;
 *
 * 切到 acp 这一次渲染比上一次多调一个 hook，React 直接抛 #310
 * （Minified React error #310 = Rendered more hooks than during the previous render），
 * 抛错点是 `updateWorkInProgressHook` 里的 useReducer（jotai useAtomValue）。
 *
 * hook 调用必须与条件无关（hook 无条件调用、结果再按条件取用）。本文件做渲染层全量
 * 守卫：任何 `? / ?? / && / ||` 之后紧跟的 hook 调用都判违规——这类写法在
 * 「条件首次成立那一次渲染」必然炸，且报错栈只指向库内部，靠单测很难复现。
 */

const RENDERER_SRC = "src/renderer/src";

/** hook 名约定：use + 大写开头的驼峰（useAtomValue / useMemo / useSessionPaneServices）。 */
const CONDITIONAL_HOOK_CALL = /(?:\?\?|\?|&&|\|\|)\s*(?:[\w$]+\.)*use[A-Z]\w*\s*\(/gu;

/** 递归收集渲染层源码文件（i18n 词典是文案产物，不含 hook 调用）。 */
function rendererSources(dir = RENDERER_SRC) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (full.includes("i18n")) continue;
			files.push(...rendererSources(full));
		} else if (/\.tsx?$/.test(full)) {
			files.push({ name: full.split(path.sep).join("/"), source: readFileSync(full, "utf8") });
		}
	}
	return files;
}

/** 去掉注释后再判定：说明性注释里会写出违规写法（例如本 bug 的注释），不能算命中。 */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => line.replace(/(^|[^:])\/\/.*$/u, "$1"))
		.join("\n");
}

/** 返回 [{ line, text }]：命中位置的行号（1-based）与该行原文。 */
function findConditionalHookCalls(source) {
	const stripped = stripComments(source);
	const lines = stripped.split("\n");
	const hits = [];
	CONDITIONAL_HOOK_CALL.lastIndex = 0;
	let match = CONDITIONAL_HOOK_CALL.exec(stripped);
	while (match) {
		const line = stripped.slice(0, match.index).split("\n").length;
		hits.push({ line, text: (lines[line - 1] ?? "").trim() });
		match = CONDITIONAL_HOOK_CALL.exec(stripped);
	}
	return hits;
}

test("检测器能识别导致 React #310 的历史写法", () => {
	// 修复前的原始代码（ComposerComponents.tsx 的 lockedAcpTool 行）。
	const historical = `const lockedAcpTool = props.backend === "acp" ? useAtomValue(acpToolsAtom).find((tool) => tool.id === props.acpTool?.toolId) : undefined;`;
	assert.deepEqual(
		findConditionalHookCalls(historical).map((hit) => hit.line),
		[1],
		"三元条件分支里的 hook 调用必须判违规",
	);
	// 跨行三元同样要抓到（? 与 hook 分处两行）。
	assert.equal(findConditionalHookCalls("const x = cond\n\t? useAtomValue(atom)\n\t: undefined;").length, 1, "跨行三元条件分支里的 hook 调用必须判违规");
});

test("合法写法不误报", () => {
	// 对象字面量的属性值里调 hook 是无条件的（ComposerArea 的 useSessionComposerController 入参就是这个形状）。
	assert.deepEqual(findConditionalHookCalls("\t\tonPromoteSession: useSessionPaneServices().promoteSessionToPermanent,"), []);
	// 可选链方法名与 hook 命名撞车（?.useXxx）。
	assert.deepEqual(findConditionalHookCalls("const label = node?.useLabels();"), []);
	// 注释里描述违规写法不算命中。
	assert.deepEqual(findConditionalHookCalls("\t// 反面写法：cond ? useAtomValue(atom) : undefined"), []);
	// 条件只决定 hook 的入参、hook 本身仍无条件调用。
	assert.deepEqual(findConditionalHookCalls("const v = useMemo(() => (cond ? a : b), [cond]);"), []);
});

test("渲染层不存在条件调用的 hook（React #310 类崩溃）", () => {
	const offenders = [];
	for (const file of rendererSources()) {
		for (const hit of findConditionalHookCalls(file.source)) {
			offenders.push(`${file.name}:${hit.line} ${hit.text}`);
		}
	}
	assert.deepEqual(offenders, [], `hook 必须无条件调用，条件判断放到调用之后；违规位置：\n${offenders.join("\n")}`);
});
