import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveComposerPiSkillSource } = loadTsCommonJs("src/renderer/src/components/session/composerSkillSource.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("SSH 项目的技能选择器路由到远端主机资源", () => {
	const source = resolveComposerPiSkillSource("remote-project", {
		id: "remote-project",
		name: "Remote",
		lastOpenedAt: 1,
		locator: { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111", remotePath: "/workspace/demo" },
	});
	assert.deepEqual(plain(source), { kind: "remote", hostId: "11111111-1111-4111-8111-111111111111" });
});

test("项目清单尚未加载时不猜测本机目录", () => {
	assert.deepEqual(plain(resolveComposerPiSkillSource("project", undefined)), { kind: "pending" });
});

test("本地项目仍查询项目资源，聊天项目只查询全局资源", () => {
	assert.deepEqual(plain(resolveComposerPiSkillSource("local-project", { id: "local-project", name: "Local", lastOpenedAt: 1, path: "C:/workspace" })), { kind: "local", projectId: "local-project" });
	assert.deepEqual(plain(resolveComposerPiSkillSource("chat", { id: "chat", name: "Chat", lastOpenedAt: 1, kind: "chat", path: "C:/chat" })), { kind: "global" });
});
