import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveModelPickerBody } = loadTsCommonJs(
  "src/renderer/src/components/session/sessionPickerOptions.ts",
);

/**
 * 模型选择器主体状态回归测试。
 *
 * 背景：首屏加载期间 models=[] 且 report=null，旧渲染逻辑两个分支都不命中，
 * 面板渲染空白——用户看到「模型选择器是空的」却不知道还在加载（应用启动水合、
 * 改完 models.json/auth.json 后 watcher 作废快照，都会出现这个窗口）。
 * 本函数把「还没拿到任何报告 + 正在加载」明确判成 loading。
 */

const okReport = { models: [], ok: true, reason: null, version: null, detail: "", source: "cli", at: 0 };
const failedReport = { models: [], ok: false, reason: "cli-failed", version: null, detail: "boom", source: "none", at: 0 };

test("有模型时始终渲染列表（加载中也不闪空）", () => {
  assert.equal(resolveModelPickerBody({ modelCount: 3, report: null, loading: true }), "list");
  assert.equal(resolveModelPickerBody({ modelCount: 3, report: okReport, loading: false }), "list");
});

test("无模型 + 首次加载在途 → loading", () => {
  assert.equal(resolveModelPickerBody({ modelCount: 0, report: null, loading: true }), "loading");
});

test("无模型 + 已有报告 → guide（成功空态与失败原因都走引导块）", () => {
  assert.equal(resolveModelPickerBody({ modelCount: 0, report: okReport, loading: false }), "guide");
  assert.equal(resolveModelPickerBody({ modelCount: 0, report: failedReport, loading: false }), "guide");
});

test("未接入报告通道的调用方保持旧行为（list，不能伪装成永久加载中）", () => {
  assert.equal(resolveModelPickerBody({ modelCount: 0, report: undefined, loading: false }), "list");
  assert.equal(resolveModelPickerBody({ modelCount: 0, report: undefined, loading: true }), "list");
});

test("无模型、无报告、也不在加载 → list（不新增状态，交给上层兜底）", () => {
  assert.equal(resolveModelPickerBody({ modelCount: 0, report: null, loading: false }), "list");
});
