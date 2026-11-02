import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { selectAtom } from "jotai/utils";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const source = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
const visibleRowsSource = readFileSync("src/renderer/src/hooks/timeline/useVisibleTimelineRows.ts", "utf8");

/**
 * 时间线控制器模块图。
 *
 * 用 createTsSandbox（相对 import 以**被加载文件目录**为基准解析）而不是手写
 * require 桥：旧写法未列进 stub 表的本地依赖会以 tests/ 为基准解析，生产代码
 * 一新增 import 就整片 MODULE_NOT_FOUND（本文件曾因此踩坑两次）。现在只有需要
 * 替身/故意打桩的依赖才列在 stubs 里，其余相对依赖（jumpWindowPolicy /
 * browsePin / turnRenderWindow 等策略模块）按真实路径加载——跳转策略必须真实
 * 求值才能测行为，桩掉等于测了个假的。
 */
function loadTimelineHelpers() {
	return createTsSandbox({
		stubs: {
			react: {},
			jotai: { atom: (value) => ({ _mockInit: value }) },
			"jotai/utils": {},
			"../atoms": {},
			"../lib/pinTurnScroll": { animateScrollTop: () => () => undefined, pinScrollDurationMs: () => 320 },
			"../desktopApi": {},
			// i18n 只用到 t()：测试不校验文案，桩成直返 key（避免加载真实词典）。
			"../i18n": { t: (key) => key },
			"./timeline/autoExpandThreshold": { TURN_WINDOW_AUTO_EXPAND_THRESHOLD: 120, resolveAutoExpandThreshold: (h) => Math.max(120, Math.round(h * 0.4)) },
			"./timeline/scrollHistoryPolicy": {},
			"../components/session/timeline/turnRenderWindow": {
				TIMELINE_MOUNTED_TURN_LIMIT: 3,
				TIMELINE_SCROLLED_TURN_LIMIT: 3,
				TIMELINE_WINDOW_EXPAND_STEP: 3,
			},
		},
		globals: { Date },
	})("src/renderer/src/hooks/useSessionTimelineController.ts");
}

/**
 * session-atoms 模块图：依赖都是真实相对路径，直接交给 createTsSandbox 按源文件
 * 目录解析（旧写法逐个 stub 真实文件，只是为了绕开手写 loader 的解析基准）。
 */
function loadSessionAtoms() {
	return createTsSandbox()("src/renderer/src/atoms/session-atoms.ts");
}

test("timeline pagination restores the load-more anchor instead of jumping the viewport", () => {
	const { restoreTimelineAnchor } = loadTimelineHelpers();
	assert.equal(restoreTimelineAnchor(240, 600), 840);
	assert.equal(restoreTimelineAnchor(0, 0), 0);
});

test("session switch restores anchored history view state including its turn window", () => {
	const { resolveSessionTimelineRestoreState } = loadTimelineHelpers();

	const bottom = resolveSessionTimelineRestoreState(undefined);
	assert.equal(bottom.autoScroll, true);
	assert.equal(bottom.showScrollToBottom, false);
	assert.equal(bottom.scrolledWindowTurns, 3);

	const history = resolveSessionTimelineRestoreState({
		messageId: "run-4",
		offsetTop: -24,
		windowTurns: 9,
		savedAt: 100,
	});
	assert.equal(history.autoScroll, false);
	assert.equal(history.showScrollToBottom, true);
	assert.equal(history.scrolledWindowTurns, 9);

	// Hot-reload may leave a pre-window anchor in memory; it must safely fall
	// back to the small base window rather than treating the anchor as invalid.
	const legacy = resolveSessionTimelineRestoreState({
		messageId: "run-4",
		offsetTop: -24,
		savedAt: 100,
	});
	assert.equal(legacy.scrolledWindowTurns, 3);
});

test("timeline auto-scroll only sticks while the reader remains near the bottom", () => {
	const { isTimelineAtBottom } = loadTimelineHelpers();
	assert.equal(isTimelineAtBottom(980, 1100, 120), true);
	assert.equal(isTimelineAtBottom(700, 1100, 120), false);
});

test("timeline owns paging, delegated scroll follow, and outline jump lifecycle", () => {
	assert.match(source, /selectAtom\([\s\S]*sessionMessagesCacheAtom/);
	assert.match(source, /readRecordMessagePage\(sessionId/);
	assert.match(source, /prependHistoryPage/);
	// 激活分页（2026-08）：runtime 窗口会话的显示总数 = disk 前缀 + 窗口段的组合长度
	assert.match(source, /totalMessageCount: diskPage \? diskPage\.total : combinedMessages\.length/);
	// 流式跟随由 beUI MessageScroller 负责；controller 只接收跟随状态，避免重复写 scrollTop。
	assert.match(source, /setAutoScrollFromScroller/);
	// 2026-11：100 条分页器已删除，jump 不再扩渲染窗口（数据全量在 atom）
	assert.doesNotMatch(source, /pagination\.loadUntilIncluded\(index\)/);
	assert.match(source, /restoreTimelineAnchor\(/);
});

test("anchor restoration preserves its effective tail window and expands only when needed", () => {
	assert.match(source, /windowTurns: renderedWindowTurnsRef\.current/);
	// 跟随态的 DOM 固定为 3 轮，即使回底 effect 尚未来得及重置 scrolledWindowTurns；
	// 保存必须使用实际窗口，避免切回时恢复到不同高度的文档。
	assert.match(source, /const effectiveWindowTurns = autoScroll\s*\? TIMELINE_MOUNTED_TURN_LIMIT\s*:\s*scrolledWindowTurns;/);
	assert.match(source, /renderedWindowTurnsRef\.current = effectiveWindowTurns;/);
	assert.match(source, /if \(windowExpandableRef\.current\) \{\s*setScrolledWindowTurns\(\(turns\) => turns \+ TIMELINE_WINDOW_EXPAND_STEP\);/);
	// Even an irrecoverable anchor must unlock stick-to-bottom before showing the
	// fallback viewport, otherwise ResizeObserver can immediately re-pin it.
	assert.match(source, /api\.restoreAt\(0\)/);
});

test("scroll events synchronously retain an anchor before a same-task session switch", () => {
	// rAF remains the coalesced persistence path, but the last DOM snapshot must
	// exist before React can commit a tab change and cancel the pending frame.
	assert.match(source, /currentAnchorRef\.current = computeCurrentAnchor\(visibleRows\);[\s\S]*?if \(scrollAnchorFrameRef\.current != null\) return;\s*scrollAnchorFrameRef\.current = requestAnimationFrame/);
	// 同一 scroll 事件只读一次可见行：锚点与浏览钉共用快照，rAF 重算复用最近一份。
	assert.match(source, /scrollVisibleRowsRef\.current = visibleRows;/);
	assert.match(source, /currentAnchorRef\.current = computeCurrentAnchor\(scrollVisibleRowsRef\.current\);/);
});

test("scroll anchors stay restorable across pi reprojection (entryId normalization)", () => {
	// pi 预热重投影把投影 id 前缀 `_viewer-history-X` 改写为 `<agentId>-history-X`（entryId
	// 不变）：锚点保存必须附带 entryId，恢复 miss 时按它反查当前 id，而不是扩窗后降级跳顶。
	assert.match(source, /entryId: anchorEntryIdMapsRef\.current\.byId\.get\(anchorRow\.id\)/);
	assert.match(source, /entryId: anchorEntryIdMapsRef\.current\.byId\.get\(messageId\)/);
	assert.match(source, /const remapped = anchorEntryIdMapsRef\.current\.byEntryId\.get\(anchor\.entryId\);/);
	assert.match(source, /currentAnchorRef\.current = anchorRowId === anchor\.messageId \? anchor : \{ \.\.\.anchor, messageId: anchorRowId \};/);
});

test("scroll anchors prefer stable turn roots over collapsible execution children", () => {
	// 工具卡/思考步骤会随执行过程自动收起卸载；优先 user / run 根节点才能在
	// 切回时仍找到同一 messageId，而非退化到顶部。
	// 选择器真值收敛在 useVisibleTimelineRows 的 ROOT_ROW_SELECTOR；控制器全量扫描直接引用它，
	// 不再各抄一份字面量（快路径与回落路径漂移会让同一会话内两次锚点计算选中不同的行）。
	assert.match(visibleRowsSource, /export const ROOT_ROW_SELECTOR = "article\.user-turn\[data-message-id\], \.turn-row\[data-message-id\]";/);
	assert.match(source, /querySelectorAll<HTMLElement>\(\s*ROOT_ROW_SELECTOR\s*\)/);
	assert.match(source, /if \(stableAnchor\) return stableAnchor;/);
	assert.match(source, /return findAnchor\(timeline\.querySelectorAll<HTMLElement>\("\[data-message-id\]"\)\);/);
});

test("background Session cache changes retain the selected timeline slice", () => {
	const { sessionMessagesCacheAtom } = loadSessionAtoms();
	const store = createStore();
	const currentMessages = [{ id: "current" }];
	const selectedMessages = selectAtom(sessionMessagesCacheAtom, (cache) => cache.current?.messages, Object.is);
	store.set(sessionMessagesCacheAtom, {
		current: { messages: currentMessages },
		background: { messages: [{ id: "old" }] },
	});
	const before = store.get(selectedMessages);
	store.set(sessionMessagesCacheAtom, {
		current: { messages: currentMessages },
		background: { messages: [{ id: "new" }] },
	});
	assert.equal(store.get(selectedMessages), before);
});

test("bottom-settle history clear invalidates in-flight runtime history pages", () => {
	// 清理成功后必须推进 load 序号并复位加载标志：迟到页响应被 latestLoadBySession 丢弃，
	// isLoadingMessagePage 也不会卡死后续加载（修复前只有 clearHistory 调用）。
	assert.match(source, /clearHistory\(sessionId\)/);
	assert.match(source, /const sequence = \+\+nextLoadSequence;/);
	assert.match(source, /setIsLoadingMessagePage\(false\)/);
	assert.match(source, /trackLatestLoad\(sessionId, sequence\)/);
	// 逻辑跟底不等于物理到底：平滑回底途中不会立刻清历史。
	assert.match(source, /isTimelineAtBottom\(timeline\.scrollTop/);
});

test("prepend scroll compensation is skipped while following bottom and pins the visible row", () => {
	// 跟底中/浏览代数过期（autoScrollRef=true 或 generation 不匹配）不恢复旧锚点：
	// 贴底引擎负责生长补偿，迟到分页也不得把刚回底的视口重新插页；
	// 滚动翻页钉正在看的那一轮（pinBrowseRow），禁止按整页 scrollHeight 差写原生 scrollTop。
	// 早退分支必须同时做两件事：释放锚点 + 释放 prependSolid。0a3bab5 在两者之间补了
	// endPrependSolid()（否则 beginPrependSolid 只能靠 1.5s 超时解除，期间强制整表渲染），
	// 原断言要求 return 紧跟 loadMoreAnchorRef 赋值，补了这一行就红——是测试跟不上代码。
	assert.match(source, /if \(autoScrollRef\.current \|\| anchor\.value\.generation !== historyBrowseGenerationRef\.current\) \{\n\s*loadMoreAnchorRef\.current = undefined;[\s\S]{0,240}?endPrependSolid\(\);\n\s*return;\n\s*\}/);
	assert.match(source, /if \(anchor\.value\.preserveAtTop\) \{\n\s*pinBrowseRow\(\);/);
	assert.doesNotMatch(source, /timeline\.scrollTop = nextScrollTop/);
	// 顶部不补偿路径仍需抑制本帧 scroll；守卫由代数化 rAF 清理，不能再用会
	// 被定时窗口永久锁住的独立 boolean。
	// 窗口放宽到 600：该分支现在带「为什么不补偿」与「为什么必须 endPrependSolid」两段注释，
	// 180 字符会被注释本身撑破（注释是正当改动，不该逼代码删注释）。
	assert.match(source, /if \(nextScrollTop === null\) \{[\s\S]{0,600}?markProgrammaticScroll\(\);/);
	assert.match(source, /finishProgrammaticScrollFrame\(guard, generation\)/);
	assert.doesNotMatch(source, /programmaticScrollRef/);
});

test("escaping follow mode and expanding the window unlock the stick-to-bottom engine", () => {
	// 只改 React autoScroll、不 stopScroll 时，扩窗增高会被 RO 在 isAtBottom 下钉回底部。
	assert.match(source, /const escapeAutoScroll = useCallback\(\(\) => \{[\s\S]*?scrollerScrollApiRef\.current\?\.stopScroll\(\);/);
	assert.match(source, /const expandWindow = useCallback\([\s\S]*?escapeAutoScroll\(\);[\s\S]*?setScrolledWindowTurns/);
});

test("prepend pin uses restoreAt so ResizeObserver cannot re-lock to the bottom", () => {
	assert.match(source, /const pinViewportAfterPrepend = useCallback\(\s*\(nextTop: number\) => \{/);
	assert.match(source, /api\?\.restoreAt/);
	assert.match(source, /api\.restoreAt\(nextTop\)/);
});

test("history expand pins the visible turn row instead of container height delta", () => {
	// 上滑跳到更早 1~2 轮的根因：整页 scrollHeight 差把后排版也算进去，且只补一次。
	assert.match(source, /browsePinScrollTop\(timeline\.scrollTop, currentTop, pin\.expectedViewportTop\)/);
	assert.match(source, /const pinBrowseRow = useCallback\(\(\) => \{/);
	assert.match(source, /new ResizeObserver\(\(\) => \{/);
	assert.match(source, /browsePinFrozenRef/);
	assert.doesNotMatch(source, /restoreTimelineAnchor\(timeline\.scrollTop, heightDelta\)/);
});

test("load-more compensation is skipped at the very top so prepended content stays visible", () => {
	// 2026-02 回归：视口在顶部（≤8px 阈值）时 prepend/展开不补偿 scrollTop——
	// 容器 overflow-anchor:none，插入内容不会自动调整滚动位置，补偿会把新内容推出视口上方，
	// 表现为「点击加载更多/显示更早无反馈」。中部才按高度差补偿保持视口内容不动。
	const { resolveTimelineTopCompensation } = loadTimelineHelpers();
	assert.equal(resolveTimelineTopCompensation(0, 600), null);
	assert.equal(resolveTimelineTopCompensation(8, 600), null);
	assert.equal(resolveTimelineTopCompensation(240, 600), 840);
	assert.equal(resolveTimelineTopCompensation(9, -100), -91);
	assert.equal(resolveTimelineTopCompensation(240, 0), 240);
});

test("auto history load consumes engine intent without a competing scroll listener", () => {
	// stick 引擎逐次上报真实用户输入；controller 下一帧读取最终位置后直接决策。
	// 普通 scroll 仅保存锚点，resize/clamp/动画不能凭 scrollTop 变化取得扩窗权限。
	assert.match(source, /const setUserScrollIntent = useCallback/);
	assert.match(source, /if \(intent !== "up"\) return;/);
	assert.match(source, /userScrollIntentFrameRef\.current = window\.requestAnimationFrame/);
	assert.match(source, /if \(isProgrammaticScrollActive\(programmaticScrollGuardRef\.current, performance\.now\(\)\)\) return;/);
	assert.match(source, /HISTORY_AUTO_LOAD_THRESHOLD/);
	assert.doesNotMatch(source, /timeline\.addEventListener\("scroll", onScroll/);
});

test("prepend rejection surfaces a retryable message instead of failing silently", () => {
	// D-R1（2026-11）：prependSessionMessagePageAtom 四个前置（!current / source !== "disk" /
	// revision !== expectedRevision / page.nextBefore !== before）任一不满足即 return false，
	// 而两个调用点原先只写 if、没有 else，.catch 只接 IPC 抛错、接不到 false —— 数据没进缓存、
	// 界面没变化、也没有提示，与「点加载更多没反应」同族。
	// revision 被抬高（翻页在途期间有新内容落盘）是可立刻重试的（游标 before 未变），
	// 报成「加载失败」会把可重试说成坏了，因此两处 else 都必须按 revisionMoved 分文案。
	const elseBlocks = source.match(/\} else \{\s*\/\/ prepend 被拒[\s\S]*?setLoadMoreError\(/g) ?? [];
	assert.equal(elseBlocks.length, 2, "disk 与 runtime 两处 prepend 调用点都必须有 else，否则失败仍然静默");
	assert.match(source, /const revisionMoved = \(cachedEntry\?\.revision \?\? 0\) !== expectedRevision;/);
	assert.match(source, /revisionMoved \? t\("timeline\.loadMoreRetryable"\) : t\("timeline\.loadMoreFailed"\)/);
	// 三语必须同时具备：en-US 声明是 Record<TranslationKey, string>，缺一个 key 就 typecheck 红。
	for (const lang of ["zh-CN", "en-US", "zh-TW"]) {
		const copy = readFileSync(`src/renderer/src/i18n/rendererCopy.${lang}.ts`, "utf8");
		assert.match(copy, /"timeline\.loadMoreRetryable":/, `${lang} 缺 loadMoreRetryable`);
	}
});

test("prepend solid frame close is invalidated by token so a later begin survives", () => {
	// endPrependSolid 的「推迟一帧关掉整表渲染」原本不可取消：上一页的关闭会在下一帧无条件
	// setPrependSolid(false)。若同一帧内又 begin 过（连点按钮、或多条路径同时补页），整表渲染
	// 被提前撤掉 → 插进来的行随即被虚拟化卸载 → pinBrowseRow 找不到钉住的行、位移补不上，
	// 表现为「内容变多了，但视口轻轻跳一下」。
	// 这类守卫删掉后所有行为测试都不会红（只在竞态下失效），只能用源码断言钉住。
	assert.match(source, /const token = \+\+prependSolidTokenRef\.current;/, "end 排帧前必须取代数");
	assert.match(source, /if \(prependSolidTokenRef\.current !== token\) return;/, "rAF 回调必须比对代数，过期即放弃关闭");
	assert.match(source, /const beginPrependSolid = useCallback\(\(\) => \{\n\s*prependSolidTokenRef\.current \+= 1;/, "begin 必须递增代数以作废旧帧");
});

test("prepend solid close is owned by batch consumption, not by the window layout effect", () => {
	// 关闭整表渲染只能挂在「整批消费完」上：若挂回 SessionMessageTimeline 的 useLayoutEffect
	// （每帧 turns 变化就关），连点时每帧关一次 → 上一帧的关闭把新 start 的状态撤掉 →
	// 状态机卡在 true 直到 1.5s 兜底，中间每次插入都是一次重排，视口照跳。
	// 这类职责搬家，行为测试全绿也发现不了，只能用源码断言钉住边界。
	const timelineSource = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	const layoutEffect = timelineSource.match(/useLayoutEffect\(\(\) => \{[\s\S]*?prev\.turns !== turnWindowTurns[\s\S]*?\}, \[[^\]]*\]\);/);
	assert.ok(layoutEffect, "找不到扩窗布局效应的源码块");
	assert.doesNotMatch(layoutEffect[0], /endPrependSolid/, "关闭整表渲染不得挂回每帧布局效应");
	assert.match(layoutEffect[0], /pinBrowseRow\(\)/, "补位移仍必须留在这一拍");
	assert.doesNotMatch(source, /\} else \{[\s\S]{0,420}?endPrependSolid\(\);/, "批次归零分支不得关闭整表渲染：扩窗不再打开它，这里关一次就会撤掉 scroll 路径正在等的整表渲染");
});

test("top-anchored prepend skips compensation but must still end prepend solid", () => {
	// 视口贴顶（top <= HISTORY_AUTO_LOAD_THRESHOLD = 8px）时 resolveTimelineTopCompensation 返回 null，
	// 脚本有意不补偿：插入内容留在上方，用户点「加载更多」要看到的就是这批更早的消息。
	// 但「不补偿」不等于「不结束整表渲染」——漏掉 endPrependSolid 会让整表渲染拖到 1.5s 兜底超时，
	// 超时那刻虚拟化接管、未挂载行从实测高度回退估算、总高度突变 → 重排 → 视口轻跳。
	// 这类「分支里少一行」行为测试抓不到，只能钉源码。
	const nullBranch = source.match(/if \(nextScrollTop === null\) \{[\s\S]*?\n\t\t\}/);
	assert.ok(nullBranch, "找不到 nextScrollTop === null 分支");
	assert.match(nullBranch[0], /endPrependSolid\(\)/, "贴顶分支消费完锚点后必须结束整表渲染");
	assert.doesNotMatch(nullBranch[0], /pinViewportAfterPrepend/, "贴顶分支不得补偿，否则画面停在原地像点了没反应");
});

test("a page load that never commits must end prepend solid in finally", () => {
	// 失败/空页/被拒/prepend 未落地：useLayoutEffect 依赖 visibleMessages.length，
	// 没插入就不跑、也就没人 end —— 整表渲染只能等 1.5s 兜底，超时那刻虚拟化接管、
	// 行高从实测回退估算、总高度突变 -> 重排 -> 视口抖。点几次就种几次跳。
	const opens = source.match(/beginPrependSolid\(\);/g) ?? [];
	assert.equal(opens.length, 2, "只剩两处 begin：分页两条 promise 链各一处；扩窗那处已移除（改由 pinnedRunKeys 强制挂载钉行）");
	const finallyBlocks = source.match(/\.finally\(\(\) => \{[\s\S]*?if \(needsSolid && !insertionCommitted\) endPrependSolid\(\);/g) ?? [];
	assert.equal(finallyBlocks.length, 2, "两条 promise 链各一个 finally");
	for (const block of finallyBlocks) {
		assert.match(block, /if \(needsSolid && !insertionCommitted\) endPrependSolid\(\);/, "没落地的请求必须在 finally 自己关整表渲染（且只在这次真的开过时才关）");
	}
	assert.equal((source.match(/insertionCommitted = true;/g) ?? []).length, 2, "只有真的 prepend 成功才算落地");
});

test("button 翻页不关闭虚拟化：只有 scroll 路径才开整表渲染", () => {
	// 用户点「加载更多」时把 100+ 轮全部真实挂载，是「点了就卡」的主因。
	// 只有 scroll 路径需要：它按 messageId 查 DOM 行做 pin（pinBrowseRow）。
	// button / backfill 走 scrollHeight 差值补偿，不查 DOM。
	assert.match(source, /const needsSolid = source === "scroll";/, "开关必须只由 source 决定");
	const unguarded = source.match(/^\t+beginPrependSolid\(\);$/gm) ?? [];
	assert.equal(unguarded.length, 0, "不允许任何无条件 begin：begin 的唯一来源是 needsSolid 分支，否则摘不掉扩窗期的整表渲染");
	assert.equal((source.match(/if \(needsSolid && !insertionCommitted\) endPrependSolid\(\);/g) ?? []).length, 2, "finally 的 end 也必须带条件");
	assert.doesNotMatch(source, /if \(!insertionCommitted\) endPrependSolid\(\);/, "不带条件的 end 会关掉别处开的整表渲染");
});

test("没打开整表渲染的翻页不得调用 endPrependSolid", () => {
	// end 会 ++token 并排一帧 setPrependSolid(false)。button 路径不开整表渲染，
	// 若消费点仍无条件 end，就会把扩窗路径刚打开、还在消费中的整表渲染关掉。
	const bare = source.match(/^\t+endPrependSolid\(\);$/gm) ?? [];
	assert.equal(bare.length, 0, "不允许任何无条件 end：扩窗已不 begin，再 end 就是替别人关灯（与 651701300 同一形状）");
	assert.equal((source.match(/if \(anchor\.value\.solidOpened\) endPrependSolid\(\);/g) ?? []).length, 4, "四处消费点都必须带 solidOpened 条件");
	assert.match(source, /solidOpened: source === "scroll",/, "锚点必须记录这次是否开过整表渲染");
});
