import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sessionDisplayName } = loadTsCommonJs("src/renderer/src/utils/sessionDisplayName.ts");

test("展示名就是标题原文：(fork) 后缀属于真实标题，不再由展示层拼装", () => {
	// fork 会话：标题未带后缀时展示层不补（主进程 fork 时已物理写入后缀）；
	// 用户重命名删掉 (fork) 后能真正保持删除。
	assert.equal(sessionDisplayName("优化下 fork 功能", true), "优化下 fork 功能");
	assert.equal(sessionDisplayName("VSS学习", true), "VSS学习");
});

test("标题已带 (fork) 时按原样展示", () => {
	assert.equal(sessionDisplayName("优化下 fork 功能 (fork)", true), "优化下 fork 功能 (fork)");
});

test("非 fork 会话名字保持原样", () => {
	assert.equal(sessionDisplayName("普通会话", undefined), "普通会话");
	assert.equal(sessionDisplayName("普通会话", false), "普通会话");
});

test("缺标题时保持原样（由调用方回退 Untitled）", () => {
	assert.equal(sessionDisplayName(undefined, true), undefined);
	assert.equal(sessionDisplayName("", true), "");
});
