import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { appendSessionForkSuffix } = loadTsCommonJs("src/main/sessions/sessionForkTitle.ts");

test("fork 产物把 (fork) 追加为真实标题的一部分", () => {
	assert.equal(appendSessionForkSuffix("VSS学习", "(fork)"), "VSS学习 (fork)");
	assert.equal(appendSessionForkSuffix("新课题调研", "(fork)"), "新课题调研 (fork)");
});

test("已带后缀不再重复追加", () => {
	assert.equal(appendSessionForkSuffix("VSS学习 (fork)", "(fork)"), "VSS学习 (fork)");
	// 无空格形式（用户手动命名）同样不重复追加
	assert.equal(appendSessionForkSuffix("VSS学习(fork)", "(fork)"), "VSS学习(fork)");
});

test("空标题或空后缀原样返回", () => {
	assert.equal(appendSessionForkSuffix("", "(fork)"), "");
	assert.equal(appendSessionForkSuffix("VSS学习", ""), "VSS学习");
});
