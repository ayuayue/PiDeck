import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifyComposerSlashCommand } from "../src/renderer/src/utils/composerSlashCommand.ts";

/**
 * 输入框斜杠命令分类。
 *
 * 回归背景（用户反馈）：`/login` 在 `/` 菜单里能看到（pi 的命令表包含它），但输入框
 * 只拦了 `/new` 与 `/compact`，于是 `/login` 被当普通文本发给模型。这些用例锁住
 * 「桌面接管的命令一律不进 pi 消息流」的边界。
 */
test("识别 /new：桌面新建会话，不发给 pi", () => {
	assert.deepEqual(classifyComposerSlashCommand("/new"), { kind: "new" });
	assert.deepEqual(classifyComposerSlashCommand("  /new  "), { kind: "new" });
});

test("识别 /compact：提示词按 pi 语义剥离", () => {
	assert.deepEqual(classifyComposerSlashCommand("/compact"), { kind: "compact", prompt: "" });
	assert.deepEqual(classifyComposerSlashCommand("/compact 只保留结论"), { kind: "compact", prompt: "只保留结论" });
});

test("识别 /login 并接受可选供应商参数", () => {
	assert.deepEqual(classifyComposerSlashCommand("/login"), { kind: "login" });
	assert.deepEqual(classifyComposerSlashCommand("/login anthropic"), { kind: "login", providerId: "anthropic" });
	// 多余参数只取第一个词，不把整串当 id。
	assert.deepEqual(classifyComposerSlashCommand("/login anthropic extra"), { kind: "login", providerId: "anthropic" });
});

test("不合法或带路径感的 id 退回手选，不把垃圾值传下去", () => {
	assert.deepEqual(classifyComposerSlashCommand("/login ../etc/passwd"), { kind: "login" });
	assert.deepEqual(classifyComposerSlashCommand("/login -x"), { kind: "login" });
});

test("名字相近的命令与普通文本仍然发给 pi", () => {
	for (const text of ["/loginx", "/logins", "/newx", "/compactx", "/logout", "请帮我 /login 一下", ""]) {
		assert.deepEqual(classifyComposerSlashCommand(text), { kind: "text" }, text);
	}
});

/**
 * 契约守卫：`/login` 必须在 useSessionSend 里被拦截（不写乐观气泡、不发给 pi）。
 * 用源码扫描而不是渲染层集成测试——这里要防的是「分支被删掉」这类回归，
 * 正则按仓库约定保持空白容忍。
 */
test("useSessionSend 拦截 /login 且不再自写正则", () => {
	const source = readFileSync(new URL("../src/renderer/src/hooks/useSessionSend.ts", import.meta.url), "utf8");
	assert.match(source, /classifyComposerSlashCommand\s*\(\s*trimmedMessage\s*\)/, "useSessionSend 应通过分类器判断接管命令");
	assert.match(source, /slashCommand\.kind\s*===\s*"login"/, "useSessionSend 应有 /login 分支");
	assert.doesNotMatch(source, /\/\^\\\/login/, "不要另写一份 /login 正则，避免两处判定漂移");
});

/** 契约守卫：`/login` 的入口接线（App → SessionPaneServices → ComposerArea → 控制器）不能断。 */
test("登录弹框接线在各层都存在", () => {
	const files = ["../src/renderer/src/App.tsx", "../src/renderer/src/components/session/ComposerArea.tsx", "../src/renderer/src/hooks/useSessionComposerController.ts", "../src/renderer/src/components/session/SessionPaneServices.tsx"];
	for (const file of files) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.match(source, /openProviderLogin|onProviderLogin/, `${file} 缺少 /login 接线`);
	}
});
