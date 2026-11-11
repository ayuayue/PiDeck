import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 资源目标（W1）UI 侧纯规则：options 只对 wsl 带、写操作本轮只允许本机。
 * 这些判断直接决定资源页读写落在哪个 HOME，因此按行为断言。
 */

const model = loadTsCommonJs("src/renderer/src/config/piResourceTargetModel.ts");

test("IPC options 只对 wsl 目标带 target（local 是兼容缺省）", () => {
	assert.equal(model.resourceTargetOptions({ kind: "local" }), undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(model.resourceTargetOptions({ kind: "wsl" }))), { target: { kind: "wsl" } });
});

test("本轮写操作只允许本机目标：wsl 资源页必须显式只读", () => {
	assert.equal(model.resourceMutationAllowed({ kind: "local" }), true);
	assert.equal(model.resourceMutationAllowed({ kind: "wsl" }), false);
});
test("写动作门禁：本机全放行；WSL 只放行 task-16 已路由的动作", () => {
	const wsl = { kind: "wsl" };
	const local = { kind: "local" };
	const routed = ["skills:create", "skills:delete", "skills:rename", "skills:toggle", "skills:openFolder", "prompts:create", "prompts:delete", "prompts:rename", "prompts:toggle", "prompts:openFolder", "extensions:toggle"];
	const blocked = ["skills:edit", "extensions:install", "extensions:uninstall", "extensions:update", "extensions:updateOne", "extensions:removeBuiltIn", "extensions:restoreBuiltIn"];
	for (const action of [...routed, ...blocked]) {
		assert.equal(model.resourceWriteAllowed(action, local), true, "local " + action);
	}
	for (const action of routed) assert.equal(model.resourceWriteAllowed(action, wsl), true, action);
	for (const action of blocked) assert.equal(model.resourceWriteAllowed(action, wsl), false, action);
	// 旧判据保留：任一写操作对 WSL 仍非全局可用（细粒度以 resourceWriteAllowed 为准）。
	assert.equal(model.resourceMutationAllowed(wsl), false);
});
