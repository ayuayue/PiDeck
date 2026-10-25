import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const controllerSource = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");

test("the Session composer delegates newline and IME intent to the shared behavior helper", () => {
	assert.match(controllerSource, /getComposerEnterIntent\(event, sendShortcut\)/);
	// 建议列表的回车分支也必须走共享 IME 判定：TipTap 桥接的原生事件没有
	// nativeEvent，手写 `event.nativeEvent?.isComposing` 会漏判合成态。
	assert.match(controllerSource, /isComposingKeyboardEvent\(event\)/);
	// 控制器不得手写 IME 判定（keyCode/which 229 是旧写法），
	// 也不得手搓已废弃的 execCommand 插入/复制路径——那属于编辑器适配层的职责。
	assert.doesNotMatch(controllerSource, /keyCode === 229/);
	assert.doesNotMatch(controllerSource, /document\.execCommand\(/);
});
