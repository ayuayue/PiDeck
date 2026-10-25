/**
 * 文件树内容代次 + 着色防抖重拉（useFileTreeContentState / useFileTreeGitStatusRefresh）。
 *
 * 这两条规则都是「什么时候该重拉 Git 着色」，纯展示与源码扫描都覆盖不到行为：
 * - 内容代次只在 setFiles 换了新数组时前进（返回同一引用不算）：无关重渲染、展开已加载
 *   目录不得推进，否则每次展开都要白付一轮 listRepos + 每仓 `git status -uall`
 *   （评审 P1-a 缺陷 1）。边界：判据只认引用，refreshFiles 的「等价重载」也会推进一次
 *   （代价仅一轮多拉，与引入代次前一致，不是回归）；
 * - 代次前进后的防抖窗口内发生任何重渲染都不得把待执行的刷新清掉。旧实现用
 *   props.files + props.expandedDirs 两个 ref 做启发式、cleanup 无条件清定时器，
 *   「内容变化后 400ms 内发生一次展开」会把刷新清掉且永无补偿（缺陷 2）。
 *
 * 计时器全部由测试自己推进（window.setTimeout 换成确定性时钟），不依赖真实时间。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const ROOT = process.cwd();

/** 确定性时钟：只能通过 advance 推进虚拟时间，窗口内的定时器保持待执行。 */
function createClock() {
	let seq = 0;
	let now = 0;
	const timers = new Map();
	return {
		setTimeout(callback, ms) {
			const id = ++seq;
			timers.set(id, { callback, dueAt: now + ms });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		pending: () => timers.size,
		advance(deltaMs) {
			now += deltaMs;
			for (const [id, timer] of [...timers]) {
				if (timer.dueAt > now) continue;
				timers.delete(id);
				timer.callback();
			}
		},
	};
}

function createRefreshHarness() {
	const host = quickMessageHookHost();
	const clock = createClock();
	let refreshes = 0;
	const load = loadTsCommonJs(`${ROOT}/src/renderer/src/hooks/files/useFileTreeGitStatusRefresh.ts`, {
		stubs: { react: host.react },
		globals: { window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } },
	});
	return {
		debounceMs: load.FILE_TREE_GIT_STATUS_REFRESH_DEBOUNCE_MS,
		clock,
		/** 面板每次渲染调用一次：代次 + 当前 refresh 回调（回调引用变化模拟调用方重建） */
		renders: (contentRevision, refresh = () => void (refreshes += 1)) => host.render(() => load.useFileTreeGitStatusRefresh(contentRevision, refresh)),
		refreshCount: () => refreshes,
		unmount: () => host.unmount(),
	};
}

const file = (name, path) => ({ name, path, relativePath: name, type: "file" });
const dir = (name, path, children) => ({ name, path, relativePath: name, type: "directory", children, hasChildren: true });

function createStateHarness() {
	const host = quickMessageHookHost();
	const { useFileTreeContentState } = loadTsCommonJs(`${ROOT}/src/renderer/src/hooks/files/useFileTreeContentState.ts`, { stubs: { react: host.react } });
	return () => host.render(() => useFileTreeContentState());
}

test("内容代次：懒加载新目录的 children 属于内容变化，必须推进", () => {
	const render = createStateHarness();
	const initial = render();
	assert.equal(initial.files.length, 0);
	assert.equal(initial.fileTreeContentRevision, 0, "空树起步");
	initial.setFiles([dir("src", "/p/src", [file("a.ts", "/p/src/a.ts")])]);
	const loaded = render();
	assert.equal(loaded.files[0].children[0].name, "a.ts", "子项写进树");
	assert.equal(loaded.fileTreeContentRevision, 1, "新节点需要着色：代次前进，面板才会去重拉");
});

test("内容代次：更新函数返回同一引用（无变化的变换）不推进", () => {
	const render = createStateHarness();
	const initial = render();
	initial.setFiles([dir("src", "/p/src", [file("a.ts", "/p/src/a.ts")])]);
	const loaded = render();
	// 展开已加载目录时 toggleDirectory 已经在 updater 之外 return（不调 setFiles）；
	// 这里直接构造「同一引用」的 no-op 更新，锁住 hook 自己的契约：返回 current 不推进代次
	loaded.setFiles((current) => current);
	const afterNoop = render();
	assert.equal(afterNoop.files, loaded.files, "同一引用：整树不重渲");
	assert.equal(afterNoop.fileTreeContentRevision, loaded.fileTreeContentRevision, "引用变了但内容没变不算内容变化");
});

test("内容代次：每次真实内容变化单调 +1", () => {
	const render = createStateHarness();
	const initial = render();
	initial.setFiles([file("a.ts", "/p/a.ts")]);
	render().setFiles([file("a.ts", "/p/a.ts"), file("b.ts", "/p/b.ts")]);
	const third = render();
	assert.equal(third.fileTreeContentRevision, 2, "两次内容变化 → 代次 2（单调递增）");
});

test("着色重拉：挂载首帧不拉（useFileTreeGitStatus 自己已经拉过一轮）", () => {
	const h = createRefreshHarness();
	h.renders(0);
	h.clock.advance(h.debounceMs * 2);
	assert.equal(h.refreshCount(), 0);
});

test("着色重拉：内容代次前进后防抖窗口结束时恰好一次", () => {
	const h = createRefreshHarness();
	h.renders(0);
	h.renders(1);
	h.clock.advance(h.debounceMs - 1);
	assert.equal(h.refreshCount(), 0, "防抖窗口内不拉");
	h.clock.advance(1);
	assert.equal(h.refreshCount(), 1, "窗口结束拉一次");
	h.clock.advance(h.debounceMs * 2);
	assert.equal(h.refreshCount(), 1, "不会重复拉");
});

test("着色重拉：窗口内连续多次内容变化只合并成一次", () => {
	const h = createRefreshHarness();
	h.renders(0);
	h.renders(1);
	h.renders(2);
	h.renders(3);
	assert.equal(h.clock.pending(), 1, "新代次重排自己的定时器，不堆多轮");
	h.clock.advance(h.debounceMs);
	assert.equal(h.refreshCount(), 1, "一轮 listRepos + 每仓 status 就够");
});

test("着色重拉：同代次重渲染（引用/展开变化）既不重拉也不打断待执行的刷新", () => {
	const h = createRefreshHarness();
	h.renders(0);
	h.renders(1);
	// 缺陷 2 回归：内容变化后紧跟一次展开（只改视图 → 同代次）且调用方重建了 refresh 回调，
	// 旧实现的 cleanup 会清掉待执行定时器并走「展开」提前返回，刷新永久丢失。
	h.renders(1, () => {});
	h.renders(1);
	h.clock.advance(h.debounceMs);
	assert.equal(h.refreshCount(), 1, "内容变化的那一次刷新必须落地");
	assert.equal(h.clock.pending(), 0);
});

test("着色重拉：只有同代次重渲染时不拉", () => {
	const h = createRefreshHarness();
	h.renders(4);
	h.renders(4);
	h.renders(4);
	h.clock.advance(h.debounceMs * 2);
	assert.equal(h.refreshCount(), 0, "引用变化不触发着色重拉");
});

test("着色重拉：卸载时取消待执行的刷新（生命周期配对）", () => {
	const h = createRefreshHarness();
	h.renders(0);
	h.renders(1);
	h.unmount();
	h.clock.advance(h.debounceMs * 2);
	assert.equal(h.refreshCount(), 0, "卸载后不得留下野定时器");
});
