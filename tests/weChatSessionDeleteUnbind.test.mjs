import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 会话删除必须同步清掉微信桥的绑定。
 *
 * 绑定里存着 sessionPath；会话被删后若留着绑定，下一次收信会拿旧路径去「恢复」
 * 一个刚被删掉的文件，聊天就永久卡在「会话创建失败」且没有任何自愈路径。
 * main/index.ts 的装配路线不在沙箱可测范围内，只能用空白容忍的源码契约钉住
 *（AGENTS.md：新增源码扫描测试的正则必须空白容忍）。
 */
const source = readFileSync("src/main/index.ts", "utf8");

test("deleteSessionRecord 在释放运行时之后清掉微信绑定", () => {
	const block = source.match(/deleteSessionRecord:[\s\S]{0,1200}?removeWithDescendants/);
	assert.ok(block, "deleteSessionRecord 实现应存在");
	assert.match(block[0], /await\s+sessionRuntimeCoordinator\.releaseRuntimeForDelete\(\s*sessionId\s*\)/, "删除会话必须先释放运行时");
	assert.match(block[0], /wechatServiceRef\.current\?\.removeBindingsForSession\(\s*sessionId\s*\)/, "删除会话必须清掉指向它的微信绑定");
});
