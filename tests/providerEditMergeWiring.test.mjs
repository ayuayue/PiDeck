/**
 * 编辑供应商页「保留高级字段」接线测试（数据丢失回归守卫）。
 *
 * 背景：编辑页曾用 buildProviderConfigFromDraft 从头重建 provider，把
 * oauth / authHeader / modelOverrides / 自定义字段以及除 User-Agent 外的自定义
 * headers 静默丢掉；展开卡片的内联编辑是原地改同一个对象，不会丢（两条入口行为不一致）。
 * 现在编辑页改用 mergeProviderDraft(原 provider, 草稿) 合并。
 *
 * 断言：
 *  1. handleEditProvider 以原 provider 为基底合并（不是重建），且 ConfigModal 不再用重建函数；
 *  2. handleAddProvider（新增）走 mergeProviderDraft(undefined, draft)，与编辑同一入口；
 *  3. mergeProviderDraft 的合并契约：未知字段透传、表单字段覆盖、headers 逐键合并。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const configModalSource = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const draftSource = readFileSync("src/renderer/src/config/addProviderDraft.ts", "utf8");

test("编辑页保存以原 provider 为基底合并，不再重建（保留 oauth/自定义 headers 等）", () => {
  assert.match(
    configModalSource,
    /const provider = mergeProviderDraft\(modelsData\.providers\[oldName\], draft\);/,
  );
  assert.doesNotMatch(configModalSource, /buildProviderConfigFromDraft/);
});

test("新增供应商走 mergeProviderDraft(undefined, draft)（与编辑同一入口）", () => {
  assert.match(configModalSource, /const provider = mergeProviderDraft\(undefined, draft\);/);
});

test("mergeProviderDraft 契约：新增回落重建；编辑以原对象为基底并逐键合并 headers", () => {
  assert.match(draftSource, /export function mergeProviderDraft\(/);
  assert.match(draftSource, /if \(!original\) return buildProviderConfigFromDraft\(draft\);/);
  assert.match(draftSource, /const next: ProviderConfig = \{ \.\.\.original \};/);
  assert.match(
    draftSource,
    /setHeaderValue\(original\.headers, "User-Agent", draft\.userAgent\)/,
  );
});