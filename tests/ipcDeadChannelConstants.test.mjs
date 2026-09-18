import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/shared/ipc.ts", "utf8");

test("已删除无任何 handler/preload 引用的死通道常量", () => {
  assert.doesNotMatch(source, /skillStoreGet: "skill-store:get"/);
  assert.doesNotMatch(source, /feishuQrCode: "feishu:qr-code"/);
  assert.doesNotMatch(source, /feishuAutoGroup: "feishu:auto-group"/);
});
