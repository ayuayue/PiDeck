import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { listProjectPrompts } = loadTsCommonJs("src/main/projects/projectPromptsListing.ts");

/**
 * 真机（2026-11-26）：主进程日志里同一份堆栈无限重复 ——
 *
 * ```
 * Error occurred in handler for 'prompts:list-by-project': Error: Chat 项目不支持项目级资源。
 *     at ProjectResourceManager.requireProject
 * ```
 *
 * chat 项目没有项目级提示词，这是**读取**：语义是空集，不是错误。
 * `getProjectRoot()` 是写路径守卫，读路径不该走它。
 */
const CHAT_MESSAGE = "Chat 项目不支持项目级资源。";

const deps = (overrides = {}) => ({
	projectResourceManager: { getProjectRoot: () => "/tmp/project" },
	promptManager: { listByProject: async () => ({ templates: [{ name: "a" }], globalDir: "/tmp/global" }) },
	chatUnsupportedMessage: CHAT_MESSAGE,
	...overrides,
});

test("普通项目：照常返回模板列表", async () => {
	const result = await listProjectPrompts(deps(), "p1");
	assert.equal(result.templates.length, 1);
});

test("chat 项目：返回空集，不抛错", async () => {
	const result = await listProjectPrompts(
		deps({
			projectResourceManager: {
				getProjectRoot: () => {
					throw new Error(CHAT_MESSAGE);
				},
			},
		}),
		"builtin-chat",
	);
	assert.equal(result.templates.length, 0);
	assert.equal(result.globalDir, "");
});

test("其它错误必须照原样抛（不能被吞成空集）", async () => {
	const failing = deps({
		projectResourceManager: {
			getProjectRoot: () => {
				throw new Error("EPERM: operation not permitted");
			},
		},
	});
	await assert.rejects(() => listProjectPrompts(failing, "p1"), /EPERM/);
});

test("非法 projectId 直接拒绝", async () => {
	await assert.rejects(() => listProjectPrompts(deps(), ""), /Invalid project id/);
	await assert.rejects(() => listProjectPrompts(deps(), 42), /Invalid project id/);
});
