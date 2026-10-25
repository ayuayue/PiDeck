import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归（2026-10 内存审计）：飞书文件上传的 30MB 上限曾放在 readFileSync 之后——
// 大文件先整读进内存才被拒，单次拖错 500MB 文件就是一次白读峰值。必须先 stat 拦截再读。
const bridge = readFileSync("src/main/feishu/FeishuBridge.ts", "utf8");

test("feishu file upload checks the 30MB limit via stat before reading the file", () => {
	const block = bridge.match(/private async sendFeishuFile\([\s\S]*?\n\t\}/);
	assert.ok(block, "sendFeishuFile should be discoverable");
	const statIdx = block[0].indexOf("statSync(filePath).size");
	const readIdx = block[0].indexOf("readFileSync(filePath)");
	assert.ok(statIdx > 0, "stat-based size guard should exist in sendFeishuFile");
	assert.ok(readIdx > statIdx, "readFileSync must come after the stat guard (先判后读)");
	assert.match(block[0], /statSync\(filePath\)\.size > 30 \* 1024 \* 1024/);
});
