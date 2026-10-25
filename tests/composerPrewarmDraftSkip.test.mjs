import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 2026-10-06 悬浮窗进程堆积事故回归：输入触发的预热（activateRuntime）会把 standby
// 池进程认领给「从未发送的空白草稿」（status=draft），并立刻补一个替补进程；
// 用户反复「新建→输入→放弃」每轮泄漏一个空闲进程（IdleAgentReleaser 60min 才回收，
// keepCount=5）。守卫：空白草稿跳过激活预热——首条消息发送时 coordinator.activate
// 的懒认领路径（!entry.filePath → claimStandbyAgent）同样从池里拿热进程，不损失无感启动。
// 例外：ACP 没有 standby 池，configOptions（模型/模式枚举）只有 runtime 握手
// （session/new/load 响应）才有——选中会话即后台激活（含应用启动时恢复焦点的
// 历史会话），首条消息发送前就能改模型/模式；load 失败回退 session/new 的
// 抹屏风险由主进程快照播种兑住（AcpAgentManager handshake 回退分支）。
// 纯源码契约测试，不依赖 vm loader；正则空白容忍（格式化契约见 AGENTS.md）。
const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");

function prewarmEffectBlock() {
	const start = composerArea.indexOf("prewarmStartedForSessionRef = useRef");
	const depsAt = composerArea.indexOf("}, [composer", start);
	assert.ok(start >= 0 && depsAt > start, "prewarm effect block not found in ComposerArea.tsx");
	return composerArea.slice(start, depsAt);
}

test("input prewarm skips never-sent draft sessions (pi path, after ACP branch)", () => {
	// 跳过判定必须在 pi 路径的 activateRuntime 调用之前，且先于输入非空判断
	// （草稿根本不该走到意图判断）；位于 ACP 草稿分支之后。
	const block = prewarmEffectBlock();
	assert.match(block, /if\s*\(\s*sessionRecords\[props\.sessionId\]\?\.status\s*===\s*"draft"\s*\)\s*return;/);
});

test("ACP session prewarms on selection regardless of draft/active status", () => {
	// ACP 会话（backend=acp，草稿或历史会话）选中即激活：configOptions
	// （模型/模式枚举）只有握手后才有，这是首条消息前可选模型的唯一途径；
	// 历史会话的预热让应用启动恢复焦点时也直接拉起 runtime（无 standby 池可依赖）。
	const block = prewarmEffectBlock();
	// 不再限定 status==="draft"：历史会话同样预热（启动恢复焦点路径）
	assert.doesNotMatch(block, /composer\.backend\s*===\s*"acp"\s*&&\s*sessionRecords\[props\.sessionId\]\?\.status\s*===\s*"draft"/);
	assert.match(block, /if\s*\(\s*composer\.backend\s*===\s*"acp"\s*\)\s*\{/);
	// 工具未选不预热（无工具无法 spawn）
	assert.match(block, /if\s*\(\s*!acpPrewarmToolId\s*\)\s*return;/);
	// 预热键含工具 id：换工具（changeBackend 链停旧 runtime）与切走再切回都能重新预热
	assert.match(block, /acp:\$\{props\.sessionId\}:\$\{acpPrewarmToolId\}/);
	// 该分支内必须真的调用 activateRuntime
	const acpBranch = block.slice(block.indexOf('composer.backend === "acp"'));
	assert.match(acpBranch, /desktopApi\.sessions\.activateRuntime/);
});

test("leaving acp backend clears the ACP prewarm key", () => {
	// changeBackend 切离 acp 时已把 runtime 停掉：不清键的话切回来（即使同工具）
	// 永远命中旧键不再预热，configControls 到首发前都是空的。ACP 分支全部早退后
	// 后端必非 acp，startsWith("acp:") 判定即充分（不再比较 backend，避免 TS narrowing 冗余）。
	const block = prewarmEffectBlock();
	assert.match(block, /if\s*\(\s*prewarmStartedForSessionRef\.current\?\.startsWith\(\s*"acp:"\s*\)\s*\)\s*\{/);
});

test("prewarm effect depends on sessionRecords and ACP inputs so backend and tool switches re-evaluate", () => {
	// 依赖数组必须包含 composer.backend 与 composer.acpTool?.toolId（后端/工具切换
	// 重新评估预热键）；不再依赖 sessionRecords 的 draft 状态（预热已不限草稿）。
	const depsMatch = composerArea.match(/},\s*\[\s*composer[^\]]*\]\);\n/s);
	assert.ok(depsMatch, "prewarm effect deps array not found");
	assert.match(depsMatch[0], /sessionRecords/);
	assert.match(depsMatch[0], /composer\.backend/);
	assert.match(depsMatch[0], /composer\.acpTool\?\.toolId/);
});
