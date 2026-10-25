import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归：SidebarContent 的更新徽标原来写成
 *   const hasPendingUpdate = useAtomValue(pendingAppUpdateAtom) || useAtomValue(pendingPiUpdateAtom);
 * `||` 短路会在应用更新从 false→true 时跳过第二个 Hook，同一组件两次渲染的 Hook
 * 数量不一致，React 抛 #311 / Should have a queue（侧栏崩溃，2026-09-04 用户反馈）。
 * 修复：所有更新源 atom 必须无条件读取；合并移到派生 atom（hasPendingUpdateAtom，
 * get() 调用不是 Hook，天然无短路风险）。
 */

const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");

const atoms = readFileSync("src/renderer/src/atoms/update-atoms.ts", "utf8");

test("update atoms are read unconditionally (no short-circuit between hooks)", () => {
	// 每个 useAtomValue 必须各自独立成行（无条件执行），禁止 `useAtomValue(...) || useAtomValue(...)` 直接表达式
	assert.doesNotMatch(sidebar, /useAtomValue\s*\(\s*pendingAppUpdateAtom\s*\)\s*\|\|\s*useAtomValue\s*\(\s*pendingPiUpdateAtom\s*\)/, "不得把两个 Hook 写入短路表达式");
	// 三个更新源 atom 都无条件读取（独立 Hook 调用，不能短路跳过）。
	for (const atomName of ["pendingAppUpdateAtom", "pendingPiUpdateAtom", "pendingCatalogUpdateAtom"]) {
		assert.match(sidebar, new RegExp(`const hasPending[A-Za-z]+ = useAtomValue\\(${atomName}\\);`));
	}
	// 合并发生在派生 atom 里（get() 非 Hook，短路不会破坏 Hook 顺序）。
	assert.match(atoms, /hasPendingUpdateAtom = atom<boolean>\(\s*\(get\) =>/s);
	assert.match(atoms, /get\(pendingAppUpdateAtom\)/);
	assert.match(atoms, /get\(pendingPiUpdateAtom\)/);
	assert.match(atoms, /get\(pendingCatalogUpdateAtom\)/);
	// 侧栏直接用派生 atom，不再在组件里做合并。
	assert.match(sidebar, /const hasPendingUpdate = useAtomValue\(hasPendingUpdateAtom\);/);
	// Hook 读取先于 hasPendingUpdateAtom 出现，保证顺序。
	const appHook = sidebar.indexOf("useAtomValue(pendingAppUpdateAtom)");
	const piHook = sidebar.indexOf("useAtomValue(pendingPiUpdateAtom)");
	const catalogHook = sidebar.indexOf("useAtomValue(pendingCatalogUpdateAtom)");
	const merged = sidebar.indexOf("useAtomValue(hasPendingUpdateAtom)");
	assert.ok(appHook >= 0 && piHook >= 0 && catalogHook >= 0 && merged > Math.max(appHook, piHook, catalogHook));
});
