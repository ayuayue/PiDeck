import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
/**
 * 会话删除必须同步清掉微信桥的绑定。
 *
 * 绑定里存着 sessionPath；会话被删后若留着绑定，下一次收信会拿旧路径去「恢复」
 * 一个刚被删掉的文件，聊天就永久卡在「会话创建失败」且没有任何自愈路径。
 * main/index.ts 的装配路线不在沙箱可测范围内，只能用空白容忍的源码契约钉住
 *（AGENTS.md：新增源码扫描测试的正则必须空白容忍）。
 */

const source = mainIpcSource;
test("deleteSessionRecord 在释放运行时之后清掉微信绑定", () => {
	// 窗口宽度只用于切片：块里还会继续长（#539 在删文件与摘记录之间补了平铺子代理清理），
	// 断言本身是与顺序无关的三条必需调用，不是行长契约。
	const block = source.match(/deleteSessionRecord:[\s\S]{0,2400}?removeWithDescendants/);
	assert.ok(block, "deleteSessionRecord 实现应存在");
	assert.match(block[0], /await\s+sessionRuntimeCoordinator\.releaseRuntimeForDelete\(\s*sessionId\s*\)/, "删除会话必须先释放运行时");
	assert.match(block[0], /wechatServiceRef\.current\?\.removeBindingsForSession\(\s*sessionId\s*\)/, "删除会话必须清掉指向它的微信绑定");
});
