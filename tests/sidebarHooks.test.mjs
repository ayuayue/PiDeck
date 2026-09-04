import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归：SidebarContent 的更新徽标原来写成
 *   const hasPendingUpdate = useAtomValue(pendingAppUpdateAtom) || useAtomValue(pendingPiUpdateAtom);
 * `||` 短路会在应用更新从 false→true 时跳过第二个 Hook，同一组件两次渲染的 Hook
 * 数量不一致，React 抛 #311 / Should have a queue（侧栏崩溃，2026-09-04 用户反馈）。
 * 修复：两个 atom 必须无条件读取，结果在 Hook 之后用普通 `||` 合并。
 */

const sidebar = readFileSync(
  "src/renderer/src/components/sidebar/SidebarContent.tsx",
  "utf8",
);

test("update atoms are read unconditionally (no short-circuit between hooks)", () => {
  // 两个 useAtomValue 必须各自独立成行（无条件执行），禁止 `useAtomValue(...) || useAtomValue(...)` 直接表达式
  assert.doesNotMatch(
    sidebar,
    /useAtomValue\s*\(\s*pendingAppUpdateAtom\s*\)\s*\|\|\s*useAtomValue\s*\(\s*pendingPiUpdateAtom\s*\)/,
    "不得把两个 Hook 写入短路表达式",
  );
  assert.match(sidebar, /const hasPendingAppUpdate = useAtomValue\(pendingAppUpdateAtom\);/);
  assert.match(sidebar, /const hasPendingPiUpdate = useAtomValue\(pendingPiUpdateAtom\);/);
  // 合并发生在两个 Hook 之后（普通布尔表达式，不涉 Hook）
  assert.match(sidebar, /const hasPendingUpdate = hasPendingAppUpdate \|\| hasPendingPiUpdate;/);
  // Hook 读取先于合并出现，保证顺序
  const appHook = sidebar.indexOf("useAtomValue(pendingAppUpdateAtom)");
  const piHook = sidebar.indexOf("useAtomValue(pendingPiUpdateAtom)");
  const merged = sidebar.indexOf("hasPendingAppUpdate || hasPendingPiUpdate");
  assert.ok(appHook >= 0 && piHook >= 0 && merged > Math.max(appHook, piHook));
});
