/**
 * 最终回答超长折叠契约（2027-02 性能审计修复）。
 *
 * 背景：30K 折叠（SettledLongAnswer，2026-10 DSH 长回合事故引入）原先只挂在
 * 「中间回复」路径（AnswerOutput settled 分支）；最典型的长产出载体——最终回答
 * （AssistantText）——没有任何长度守卫，几万字 settle 后单次 mount 数万~数十万
 * DOM 节点并常驻。该契约锁住两条路径共用同一折叠策略，防回归。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const answerOutput = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
const longAnswer = readFileSync("src/renderer/src/components/session/SettledLongAnswer.tsx", "utf8");

test("AssistantText（最终回答）超长 settle 后默认折叠", () => {
	// 空白容忍：格式化改缩进不能让契约误红
	assert.match(surface, /!props\.isStreaming\s*&&\s*shouldCollapseSettledText\(cleanText\.length\)/, "折叠判定必须是「已 settle 且超阈值」，流式期间不折叠");
	assert.match(surface, /<SettledLongAnswer\s+text=\{cleanText\}/, "折叠分支必须渲染共享的 SettledLongAnswer");
	assert.match(surface, /import\s*\{\s*shouldCollapseSettledText\s*\}\s*from\s*"\.\/markdownStreamPolicy"/, "阈值判定必须复用 policy 纯函数（单一事实源）");
});

test("SettledLongAnswer 是两条正文路径的共享实现（不再各持一份）", () => {
	// AnswerOutput 原先内置该组件；提出共享模块后两条路径都必须 import
	assert.match(answerOutput, /import\s*\{\s*SettledLongAnswer\s*\}\s*from\s*"\.\/SettledLongAnswer"/, "中间回复路径必须用共享组件");
	assert.match(surface, /import\s*\{\s*SettledLongAnswer\s*\}\s*from\s*"\.\/SettledLongAnswer"/, "最终回答路径必须用共享组件");
	assert.doesNotMatch(answerOutput, /const SettledLongAnswer = memo/, "AnswerOutput 不得保留本地副本（双实现会漂移）");
});

test("折叠实现：预览前缀 + 展开按钮 + 展开仍受全量渲染路径约束", () => {
	assert.match(longAnswer, /settledCollapsePreview\(props\.text\)/, "折叠态必须渲染预览前缀而不是全文");
	assert.match(longAnswer, /session\.longAnswer\.expand/, "展开按钮文案走 i18n");
	assert.match(longAnswer, /session\.longAnswer\.collapse/, "收起按钮文案走 i18n");
	assert.match(longAnswer, /shouldCollapseSettledText\(props\.text\.length\)/, "未超阈值的调用方仍走全量渲染（组件内兜底）");
});
