import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 输入框功能显示（shared/composerFeatures.ts）回归测试：
 * isComposerFeatureHidden / toggleHiddenComposerFeature / 清单顺序与稳定性。
 * 清洗复用 normalizeHiddenModules（已在 hiddenModules 相关测试覆盖），这里只验透传。
 */

const { HIDEABLE_COMPOSER_FEATURE_IDS, isComposerFeatureHidden, toggleHiddenComposerFeature } = loadTsCommonJs("src/shared/composerFeatures.ts");

test("清单包含全部五个可关入口且顺序稳定（外观设置行的展示顺序）", () => {
	assert.deepEqual([...HIDEABLE_COMPOSER_FEATURE_IDS], ["security", "quickMessages", "gitBranch", "enhance", "voice"]);
});

test("isComposerFeatureHidden：空清单 = 全显示；按 id 判定成员关系", () => {
	assert.equal(isComposerFeatureHidden([], "enhance"), false);
	assert.equal(isComposerFeatureHidden(["enhance"], "enhance"), true);
	assert.equal(isComposerFeatureHidden(["enhance"], "voice"), false);
	// 未知 id（来自更新版本的 settings.json）不影响既有判定
	assert.equal(isComposerFeatureHidden(["composer:future"], "enhance"), false);
});

test("toggleHiddenComposerFeature：隐藏 = 追加；显示 = 移除；不改入参", () => {
	const original = ["security"];
	const hidden = toggleHiddenComposerFeature(original, "enhance", true);
	// vm 加载的生产模块来自另一个 realm，数组必须展开后再 deepEqual（跨 realm 原型不同）
	assert.deepEqual([...hidden], ["security", "enhance"]);
	assert.deepEqual([...original], ["security"], "入参数组被修改了");

	const shown = toggleHiddenComposerFeature(hidden, "enhance", false);
	assert.deepEqual([...shown], ["security"]);

	// 重复隐藏同一项不产生重复条目（移除后追加，顺序为剩余项在前；排序比较不过度拟合实现顺序）
	const deduped = toggleHiddenComposerFeature(toggleHiddenComposerFeature(hidden, "security", true), "security", true);
	assert.deepEqual([...deduped].sort(), ["enhance", "security"]);
});
