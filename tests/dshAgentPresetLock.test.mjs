import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isDshAgentPresetLocked } = loadTsCommonJs("src/shared/dshAgentPresetLock.ts");

test("未激活草稿（无 runtime、无 host 会话）仍可切换模式", () => {
	assert.equal(isDshAgentPresetLocked({ backend: "dsh", status: "draft", hasRuntime: false }), false);
});

test("有 runtime 绑定时锁定（含草稿期预热/发送后未回收）", () => {
	assert.equal(isDshAgentPresetLocked({ backend: "dsh", status: "draft", hasRuntime: true }), true);
	assert.equal(isDshAgentPresetLocked({ backend: "dsh", status: "active", hasRuntime: true }), true);
});

test("host 会话已建（dshSessionId）即锁定，即使 catalog 还停在 draft", () => {
	// 激活失败/停止后残留在 draft 的会话：host header 已持有 preset，再改只会写进
	// catalog、host 不会重组合，必须和主进程一样拒绝。
	assert.equal(isDshAgentPresetLocked({ backend: "dsh", status: "draft", dshSessionId: "dsh-1", hasRuntime: false }), true);
});

test("已 active 的 dsh 会话锁定（含历史导入、暂未 attach 的会话）", () => {
	assert.equal(isDshAgentPresetLocked({ backend: "dsh", status: "active", hasRuntime: false }), true);
});

test("非 dsh 后端不参与预设锁定", () => {
	assert.equal(isDshAgentPresetLocked({ backend: "pi", status: "active", hasRuntime: true }), false);
	assert.equal(isDshAgentPresetLocked({ backend: "acp", status: "active", hasRuntime: true }), false);
	assert.equal(isDshAgentPresetLocked({ status: "draft", hasRuntime: false }), false);
});

test("主进程边界与渲染层胶囊共用同一判据（禁止各自内联锁定条件）", () => {
	const ipc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	assert.match(ipc, /isDshAgentPresetLocked\(\{/, "sessions:catalog-update 必须走 shared 判据");
	const control = readFileSync("src/renderer/src/components/session/DshAgentPresetControl.tsx", "utf8");
	assert.match(control, /isDshAgentPresetLocked\(\{/, "会话头胶囊必须走同一判据决定只读/可选");
});
