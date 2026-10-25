/**
 * FormulaCopyLayer 观察者生命周期契约（2027-02 性能治理）。
 *
 * 背景：document.body 上的 subtree MutationObserver 原先「永不 disconnect」，
 * 侧栏/文件树/流式的每次 DOM 增删都会常驻进入回调。修复后按挂载者计数复用、
 * 最后一个卸载时断开，并把同帧增删合并到一次 rAF。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync("src/renderer/src/components/session/FormulaCopyLayer.tsx", "utf8");

test("观察者按挂载计数复用并在归零时断开", () => {
	// 空白容忍：格式化改缩进不能让契约误红
	assert.match(source, /layerMountCount \+= 1/, "挂载必须计数");
	assert.match(source, /function releaseFormulaButtons\(\)/, "必须有释放入口");
	assert.match(source, /return \(\) => releaseFormulaButtons\(\)/, "组件卸载必须释放");
	assert.match(source, /bodyObserver\?\.disconnect\(\)/, "归零时必须 disconnect");
	assert.doesNotMatch(source, /let listenersInitialized/, "旧的永不释放旗标不得复活");
});

test("同帧 DOM 增删合并到一次 rAF 补齐", () => {
	assert.match(source, /pendingRoots/, "必须有帧内待办集合");
	assert.match(source, /requestAnimationFrame\(flushFormulaRoots\)/, "必须 rAF 合并");
	assert.match(source, /cancelAnimationFrame\(pendingFrame\)/, "卸载时必须取消在帧回调");
	assert.match(source, /isConnected/, "已卸载的待办节点要跳过");
});
