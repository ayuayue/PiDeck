/**
 * Git 面板 push/pull 角标（ahead/behind）持久化契约测试。
 *
 * 背景：角标来自 `git fetch` 远程 + 对比，是慢操作。切会话 tab / 关抽屉再开会让
 * GitPanel 卸载重挂，若角标只存在组件本地 state，重挂后要从 0 重新等一轮 fetch，
 * 期间角标消失（静默失败则更久）。修复：按 项目+仓库 把角标缓存到 localStorage，
 * 重挂先秒显缓存值，再由 refresh 成功路径后台 fetch 校正。
 *
 * 此测试防止未来有人把角标缓存删掉或改回每次重挂都置 null。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");

test("ahead/behind 缓存 key 按项目+仓库隔离并带版本号", () => {
  const keyBlock = source.slice(
    source.indexOf("function aheadBehindStorageKey"),
    source.indexOf("function readAheadBehindCache"),
  );
  // key 必须包含 projectId 与 encodeURIComponent 后的 repoScopeKey（多仓共存不串）
  assert.match(keyBlock, /pideck:git-panel:\$\{projectId\}:\$\{encodeURIComponent\(repoScopeKey\)\}:ahead-behind:v1/);
});

test("读取缓存时校验 ahead/behind 为有限数字，非法按无缓存处理", () => {
  const readBlock = source.slice(
    source.indexOf("function readAheadBehindCache"),
    source.indexOf("function writeAheadBehindCache"),
  );
  assert.match(readBlock, /typeof value\.ahead === "number"/);
  assert.match(readBlock, /Number\.isFinite\(value\.ahead\)/);
  assert.match(readBlock, /typeof value\.behind === "number"/);
  assert.match(readBlock, /Number\.isFinite\(value\.behind\)/);
  // 字段不完整时不得把残缺对象当角标展示
  assert.match(readBlock, /return null/);
});

test("写缓存时 null（无上游）清除缓存，避免脏值残留", () => {
  const writeBlock = source.slice(
    source.indexOf("function writeAheadBehindCache"),
    source.indexOf("/**\n * 刷新 push/pull 角标"),
  );
  assert.match(writeBlock, /if \(value === null\)/);
  assert.match(writeBlock, /localStorage\.removeItem\(aheadBehindStorageKey/);
  assert.match(writeBlock, /localStorage\.setItem/);
});

test("切项目/仓库重置时恢复缓存角标，不直接置 null", () => {
  // 重置 effect 中 setAheadBehind 的实参必须是缓存读取结果
  const resetBlock = source.slice(
    source.indexOf("setDiscardTarget(null)"),
    source.indexOf("// 提交框草稿"),
  );
  assert.match(resetBlock, /setAheadBehind\(readAheadBehindCache\(props\.projectId, repoScopeKey\)\)/);
  assert.doesNotMatch(resetBlock, /setAheadBehind\(null\)/);
});

test("refreshAheadBehind 成功后把结果写入缓存", () => {
  const refreshBlock = source.slice(
    source.indexOf("const result = await aheadBehind(projectId)"),
    source.indexOf("    } catch {", source.indexOf("const result = await aheadBehind(projectId)")),
  );
  assert.match(refreshBlock, /setAheadBehind\(result\)/);
  assert.match(refreshBlock, /writeAheadBehindCache\(projectId, currentRepoScopeKey, result\)/);
});
