/**
 * Git 面板 push/pull 角标（ahead/behind）持久化契约测试。
 *
 * 背景：角标来自 `git fetch` 远程 + 对比，是慢操作。切会话 tab / 关抽屉再开会让
 * GitPanel 卸载重挂，若角标只存在组件本地 state，重挂后要从 0 重新等一轮 fetch，
 * 期间角标消失（静默失败则更久）。修复：按 项目+仓库 把角标缓存到 localStorage，
 * 重挂先秒显缓存值，再由 refresh 成功路径后台 fetch 校正。
 *
 * 此测试防止未来有人把角标缓存删掉或改回每次重挂都置 null。另含「无变化不重写缓存 /
 * 不重渲染」的防连射契约：角标改为每 5 秒重读后，写入频次放大了 60 倍。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const source = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");

test("ahead/behind 缓存 key 按项目+仓库隔离并带版本号", () => {
	const keyBlock = source.slice(source.indexOf("function aheadBehindStorageKey"), source.indexOf("function readAheadBehindCache"));
	// key 必须包含 projectId 与 encodeURIComponent 后的 repoScopeKey（多仓共存不串）
	assert.match(keyBlock, /pideck:git-panel:\$\{projectId\}:\$\{encodeURIComponent\(repoScopeKey\)\}:ahead-behind:v1/);
});

test("读取缓存时校验 ahead/behind 为有限数字，非法按无缓存处理", () => {
	const readBlock = source.slice(source.indexOf("function readAheadBehindCache"), source.indexOf("function writeAheadBehindCache"));
	assert.match(readBlock, /typeof value\.ahead === "number"/);
	assert.match(readBlock, /Number\.isFinite\(value\.ahead\)/);
	assert.match(readBlock, /typeof value\.behind === "number"/);
	assert.match(readBlock, /Number\.isFinite\(value\.behind\)/);
	// 字段不完整时不得把残缺对象当角标展示
	assert.match(readBlock, /return null/);
});

test("写缓存时 null（无上游）清除缓存，避免脏值残留", () => {
	const writeBlock = source.slice(source.indexOf("function writeAheadBehindCache"), source.indexOf("/**\n * 刷新 push/pull 角标"));
	assert.match(writeBlock, /if \(value === null\)/);
	assert.match(writeBlock, /localStorage\.removeItem\(aheadBehindStorageKey/);
	assert.match(writeBlock, /localStorage\.setItem/);
});

test("切项目/仓库重置时恢复缓存角标，不直接置 null", () => {
	// 重置 effect 中 setAheadBehind 的实参必须是缓存读取结果
	const resetBlock = source.slice(source.indexOf("setDiscardTarget(null)"), source.indexOf("// 提交框草稿"));
	assert.match(resetBlock, /setAheadBehind\(readAheadBehindCache\(props\.projectId, repoScopeKey\)\)/);
	assert.doesNotMatch(resetBlock, /setAheadBehind\(null\)/);
});

test("角标读取成功后写入缓存，但数值未变时跳过写入与重渲染", () => {
	const start = source.indexOf("const result = await aheadBehind(projectId)");
	// 终止锚点用 `} catch {`（缩进无关）：修复前这里是 4 空格字面量，换 tab 缩进后已搜不到
	const readBlock = source.slice(start, source.indexOf("} catch {", start));
	// 数值没变保留原对象：GitAheadBehind 每次都是新引用，直接 set 等于每 5 秒白重渲染整个面板
	assert.match(readBlock, /setAheadBehind\(\(current\) => \(deepEqual\(current, result\) \? current : result\)\)/);
	// 未变化时不重写 localStorage（同步存储，5 秒一次纯浪费）
	assert.match(readBlock, /if \(persisted\?\.key === scopeKey && deepEqual\(persisted\.value, result\)\) return;/);
	assert.match(readBlock, /writeAheadBehindCache\(projectId, currentRepoScopeKey, result\)/);
});

test("角标去重判等语义：同值不同引用判等，null 与对象可区分", () => {
	// 上面的 setAheadBehind / 缓存写入去重全靠这个语义，判错会导致角标停留在旧值或永不更新
	const { deepEqual } = loadTsCommonJs("src/renderer/src/utils/deepEqual.ts");
	assert.equal(deepEqual({ ahead: 2, behind: 0 }, { ahead: 2, behind: 0 }), true);
	assert.equal(deepEqual({ ahead: 2, behind: 0 }, { ahead: 2, behind: 1 }), false);
	assert.equal(deepEqual(null, null), true);
	// null 表示「无上游，不显示角标」，不能与 {0,0} 判等
	assert.equal(deepEqual(null, { ahead: 0, behind: 0 }), false);
	assert.equal(deepEqual({ ahead: 0, behind: 0 }, null), false);
});
