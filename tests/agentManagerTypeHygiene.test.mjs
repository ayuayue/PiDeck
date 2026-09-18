import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");

test("AgentManager 不再使用 Record<string, any> 收窄（全表 8 处）", () => {
  // 全文件级断言：4865/5472/5971/6291/6295/6449/6822/7180 共 8 处全部收窄
  // 后才转绿——只修计划原列 5 处（4865/5472/6291/6295/7180）仍红，
  // 5971/6449/6822 三处制定时即漏，必须一并收窄（禁止删断言转绿）。
  assert.doesNotMatch(source, /as Record<string, any>/);
  assert.doesNotMatch(source, /: Record<string, any>/);
});

test("统一 isRecord 谓词存在（与 AnnouncementService 同型）", () => {
  assert.match(source, /function isRecord\(value: unknown\): value is Record<string, unknown>/);
});
