/**
 * 输入预测与提示词增强的模型配置必须彼此独立。
 *
 * 这条链路横跨 settings → atom → composer controller，前两段有各自的行为测试，
 * 装配点在 useSessionComposerController 里只有三行、载入成本极高——用源码契约守住
 * 「预测误用增强模型」这个回归（正是本功能修复的缺陷）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const controllerSource = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const atomSource = readFileSync("src/renderer/src/atoms/composer-atoms.ts", "utf8");

test("预测目标模型来自独立的 promptSuggestionModel 设置，不复用增强模型", () => {
	// 两套配置各自读取自己的 atom。
	assert.match(controllerSource, /promptSuggestionModelConfig\s*=\s*useAtomValue\(\s*promptSuggestionModelAtom\s*\)/);
	assert.match(controllerSource, /enhanceModelConfig\s*=\s*useAtomValue\(\s*enhanceModelAtom\s*\)/);
	// 预测用 promptSuggestionModel 解析，增强用 enhanceModel 解析，共用同一条优先级链。
	assert.match(controllerSource, /suggestionTarget\s*=\s*resolveEnhanceTargetModel\(\s*\{\s*\.\.\.targetModelChain\s*,\s*configured:\s*promptSuggestionModelConfig\s*\}\s*\)/);
	assert.match(controllerSource, /enhanceTarget\s*=\s*resolveEnhanceTargetModel\(\s*\{\s*\.\.\.targetModelChain\s*,\s*configured:\s*enhanceModelConfig\s*\}\s*\)/);
	// hook 必须收到预测自己的目标模型。
	assert.match(controllerSource, /usePromptSuggestion\(\{[\s\S]{0,240}?target:\s*suggestionTarget/);
});

test("两个模型 atom 是各自独立的 state，不能共用一个 atom", () => {
	assert.match(atomSource, /export const enhanceModelAtom\s*=\s*atom<[^>]*>\(null\)/);
	assert.match(atomSource, /export const promptSuggestionModelAtom\s*=\s*atom<[^>]*>\(null\)/);
});
