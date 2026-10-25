import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import test from "node:test";

const scrollerSource = readFileSync("src/renderer/src/components/agents/message-scroller.tsx", "utf8");
const engineSource = readFileSync("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts", "utf8");

// 用户反馈 bug：点击「收起思考」后视口突兀弹到最底端。
// 根因（旧手写实现）：ResizeObserver 对内容「收缩」也触发跟随滚动（scrollToEnd smooth）。
// 换用 use-stick-to-bottom 引擎后，该语义由引擎内置：只有内容「增长」才锁底跟随，
// 收缩（negative resize）只保留当前视口，不主动滚动。
//
// 2026-08 补充守卫：收缩仅在「未逃逸」时维持锁底。流式中中间回复 message_end 时
// live 挂载点（折叠外）先卸载、History 落库后 settled 再进折叠（折叠内），两帧高度
// 往返；已上滚读历史的用户若在近底圈内，会被这个负增长误重锁，随后正增长帧
// instant 拽底（「先上去再下来」抖动）。与 handleScroll 的重锁路径（已带
// !escapedFromLock 守卫）对齐：逃逸用户不被任何 resize 拽回锁底。
test("follow scroll only on content growth, not on shrink", () => {
	// 引擎在 ResizeObserver 回调里区分正/负 resize：增长才 scrollToBottom
	assert.match(engineSource, /const difference = height - \(previousHeight \?\? height\);/);
	assert.match(engineSource, /if \(difference >= 0\) \{/);
	// 收缩只记录几何，不得借负增长把已浏览用户拽回锁底。
	assert.match(engineSource, /内容收缩只记录几何，不改跟随态/);
	assert.doesNotMatch(engineSource, /if \(!state\.escapedFromLock && state\.isNearBottom\) \{\s*setEscapedFromLock\(false\);\s*setIsAtBottom\(true\);/);
	// 增长时追底保留期（350ms）与弹簧物理由引擎管理，避免"收缩弹到底"的旧 bug
	assert.match(engineSource, /RETAIN_ANIMATION_DURATION_MS/);
});

// needsInstant 过渡窗口（busy true→false 后 150ms）：期间追底用 instant，
// 避免流式结束时最终文本长高触发平滑滚动动画造成跳屏。
// 流式进行中不再因 busy 强制 instant——小增高走弹簧，大跳变交给 28px 阈值。
test("needsInstant window forces instant resize after stream ends", () => {
	// MessageScroller 用 state 跟踪 busy 结束窗口（必须 state，resize 需随渲染更新）
	assert.match(scrollerSource, /const \[busyEnding, setBusyEnding\] = useState\(false\)/);
	assert.match(scrollerSource, /resize: busyEnding \|\| reduce \|\| !smooth \? "instant" : "smooth"/);
	// 忙碌期本身不得再一刀切 instant，否则逐行增高没有弹簧。
	assert.doesNotMatch(scrollerSource, /resize: busy \|\| busyEnding \|\| reduce \|\| !smooth \? "instant" : "smooth"/);
	// 150ms 后关闭窗口
	assert.match(scrollerSource, /setTimeout\(\(\) => \{\s*setBusyEnding\(false\);\s*\}, 150\)/);
});

// 内容单次增高超过阈值时强制 instant，避免工具卡等离散跳变走弹簧造成「砰」抖。
test("large positive resize forces instant follow", () => {
	assert.match(engineSource, /instantResizeThreshold/);
	assert.match(engineSource, /difference > threshold/);
	assert.match(scrollerSource, /instantResizeThreshold:\s*28/);
});

// instant 增高必须在 ResizeObserver 回调内同步写 scrollTop，不能再丢进下一帧 rAF。
test("instant positive resize corrects scrollTop synchronously in ResizeObserver", () => {
	assert.match(engineSource, /if \(animation === "instant"\) \{/);
	assert.match(engineSource, /state\.scrollTop = state\.calculatedTargetScrollTop;/);
	// 同步路径会 bump generation 并清掉在途 animation，避免阶梯追赶
	assert.match(engineSource, /state\.scrollGeneration \+= 1;/);
	// 弹簧路径仍走 scrollToBottom；instant 不再经 wait:true 短路
	assert.match(engineSource, /if \(animation === "instant"\) \{[\s\S]*?\} else \{\s*scrollToBottom\(/);
});

// mergeAnimations 缓存 key 必须区分 instant / spring。
test("mergeAnimations cache key includes instant flag", () => {
	const mergeSource = readFileSync("src/renderer/src/lib/stick-to-bottom/mergeAnimations.ts", "utf8");
	assert.match(mergeSource, /const key = `\$\{instant \? "instant" : "spring"\}:\$\{JSON\.stringify\(result\)\}`;/);
});

// 时间线仍把整段 agent 忙碌传给 scroller busy：驱动 aria-busy 和结束后 150ms
// instant 窗口。流式增高是否弹簧不再看这个 flag。
test("timeline marks scroller busy for full agent run", () => {
	const timelineSource = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(timelineSource, /busy=\{isRuntimeBusy \|\| isAwaitingAssistant\}/);
});

// 工具卡入场仅淡入（可有 opacity animation），禁止位移。
test("tool enter animation has no translateY", () => {
	const cssSource = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
	assert.match(cssSource, /@keyframes timeline-step-enter \{[\s\S]*?from \{\s*opacity: 0;\s*\}/);
	// 去掉注释后再断言，避免注释里的 translateY 字样误伤
	const enterBlock = cssSource.match(/@keyframes timeline-step-enter \{[\s\S]*?\n\}/);
	assert.ok(enterBlock, "expected timeline-step-enter keyframes");
	const withoutComments = enterBlock[0].replace(/\/\*[\s\S]*?\*\//g, "");
	assert.doesNotMatch(withoutComments, /transform\s*:/);
	assert.doesNotMatch(withoutComments, /translateY\s*\(/);
	assert.doesNotMatch(cssSource, /\.tool-group-card:has\(\.tool-card--running\)\s*\{/);
});

// 跟随开关（followOutput）与用户逃逸/回底（onFollowChange）桥接到引擎：
// - followOutput=true 时重新锁底（近底 instant / 远处弹簧）
// - followOutput=false 时主动解锁（引擎不读这个 prop，只 return 等于开关无效）
// - 引擎 isAtBottom 变化时上报给 controller，controller 再回写 followOutput
test("followOutput and onFollowChange bridge to the stick engine", () => {
	assert.match(scrollerSource, /const engineScrollToBottom = stick\.scrollToBottom;/);
	// false 分支沿触发（React #185：非沿重复解锁会在 layout cascade 里与引擎/controller 乒乓），
	// 但沿上仍必须主动调 stopScroll（快照 ref + isFollowEscapeEdge）
	assert.match(scrollerSource, /const previousFollowOutput = previousFollowOutputRef\.current;/);
	assert.match(scrollerSource, /if \(!followOutput\) \{\s*if \(isFollowEscapeEdge\(previousFollowOutput, followOutput\)\) engineStopScroll\(\);\s*return;/);
	assert.match(scrollerSource, /engineScrollToBottom\(\{ animation \}\)/);
	assert.match(scrollerSource, /reduce \|\| distance <= followThreshold \? "instant" : "smooth"/);
	assert.match(scrollerSource, /onFollowChange\?\.\(isFollowing\)/);
	assert.match(scrollerSource, /const isFollowing = engineIsAtBottom;/);
	// 引擎自带 wheel 逃逸：向上滚（deltaY<0）时脱离锁底
	assert.match(engineSource, /deltaY < 0/);
	assert.match(engineSource, /setEscapedFromLock\(true\)/);
});

// 会话切换恢复历史位置：引擎必须提供「原子恢复」——定位 + 解锁锁底 + 取消在途动画
// 一次完成。若只做原生 scrollTop 赋值，busy 会话的 ResizeObserver（instant 贴底）
// 会抢先于异步 scroll 解锁事件，把恢复的位置立刻拽回底部（双真相源竞态）。
test("engine exposes atomic restoreAt: position + unlock + cancel in-flight animation", () => {
	// 引擎 API：restoreAt 在返回的实例上（controller 通过 scrollApiRef 调用）
	assert.match(engineSource, /export type RestoreAt = \(scrollTop: number\) => void;/);
	// useCallback 的参数可能被格式化换行：\s* 容忍，仍锁「scrollTop 入参的回调」语义。
	assert.match(engineSource, /const restoreAt = useCallback\(\s*\(scrollTop: number\) => \{/);
	// 原子三件事：取消在途动画（generation++ / animation 清空）→ 解锁（escapedFromLock/isAtBottom）
	assert.match(engineSource, /state\.scrollGeneration \+= 1;/);
	assert.match(engineSource, /state\.animation = undefined;/);
	assert.match(engineSource, /setEscapedFromLock\(true\);/);
	assert.match(engineSource, /setIsAtBottom\(false\);/);
	// 定位走 state.scrollTop setter（写 DOM 并设置 ignoreScrollToTop，后续 scroll 事件被忽略）
	assert.match(engineSource, /state\.scrollTop = Math\.max\(0, scrollTop\);/);
	assert.match(engineSource, /restoreAt,/);
});

test("MessageScroller forwards restoreAt to timeline controller scroll api", () => {
	// MessageScrollerScrollApi 类型与 api 挂载都要包含 restoreAt
	assert.match(scrollerSource, /restoreAt: \(scrollTop: number\) => void;/);
	assert.match(scrollerSource, /const engineRestoreAt = stick\.restoreAt;/);
	assert.match(scrollerSource, /restoreAt: engineRestoreAt,/);
});

test("timeline controller restores via engine restoreAt and keeps negative offset", () => {
	const source = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	// 保存锚点保留负偏移（视口顶部常被上一行底部占据，截断会导致恢复位置偏下）
	// origin 真值：视口顶 = getBoundingClientRect().top + clientTop（IntersectionObserver 的
	// root 相交矩形以 padding box 为界）。改回裸 viewportRect.top 或漏掉 clientTop 必须红。
	assert.match(source, /function timelineViewportTop\(timeline: HTMLElement\): number \{/);
	assert.match(source, /return timeline\.getBoundingClientRect\(\)\.top \+ clientTop;/);
	assert.match(source, /offsetTop:\s*rect\.top\s*-\s*viewportTop\s*,/);
	// 快路径（可见行集合）与回落路径（全量扫描）必须同基准，否则同一会话两次锚点算到不同的行。
	assert.match(source, /expectedViewportTop:\s*rect\.top\s*-\s*viewportTop\s*,/);
	assert.doesNotMatch(source, /offsetTop:\s*Math\.max\(\s*0\s*,\s*rect\.top\s*-\s*viewportTop\s*\)/);
	// 恢复走引擎原子 API（引擎未挂上时回退原生定位）
	assert.match(source, /api\?\.restoreAt/);
	assert.match(source, /api\.restoreAt\(targetTop\)/);
	// 会话复用时在 render 阶段重置为锚点对应的 follow/window 状态，确保 child
	// layout effect 之前就不会跟底；不能只依赖 useState 初始化器。
	assert.match(source, /resolveSessionTimelineRestoreState\(sessionAnchorSnapshot\)/);
	assert.match(source, /if \(viewStateOwnerKey !== ownerKey\) \{/);
});

test("turn-window expansion pins the visible row instead of native scrollTop", () => {
	const timelineSource = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	const controllerSource = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	// 扩窗补偿走 pinBrowseRow（钉正在看的那一轮），不再用整页高度差写原生 scrollTop。
	assert.match(timelineSource, /pinBrowseRow\(\)/);
	assert.doesNotMatch(timelineSource, /restoreTimelineAnchor\(timeline\.scrollTop, nextHeight - prev\.height\)/);
	assert.doesNotMatch(timelineSource, /timeline\.scrollTop = nextTop/);
	assert.match(timelineSource, /\[displayRuns, followingForTurnWindow, pinBrowseRow, turnWindowActive, turnWindowTurns\]/);
	assert.match(controllerSource, /api\.restoreAt\(nextTop\)/);
	assert.match(controllerSource, /scrollerScrollApiRef\.current\?\.stopScroll\(\)/);
	assert.match(controllerSource, /browsePinScrollTop/);
});

test("timeline keeps the same turn window through anchor restoration", () => {
	const timelineSource = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	const controllerSource = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	// 保存、恢复和正常历史浏览必须都按同一个 tail-window 裁剪。恢复期若改成全量，
	// restoreAt 后再收回小窗口会让浏览器把 scrollTop 截断到新的最大值。
	assert.match(timelineSource, /selectTimelineTurnWindow\(reconciledRuns, turnWindowTurns\)/);
	assert.doesNotMatch(timelineSource, /isRestoringScrollAnchor/);
	assert.doesNotMatch(timelineSource, /jumpNavigationActive/);
	assert.doesNotMatch(timelineSource, /Number\.MAX_SAFE_INTEGER/);
	// 跟随态可能在回底 effect 复位 scrolledWindowTurns 前收到一次滚动；保存锚点时
	// 仍必须记录实际的 3 轮 DOM 窗口，而不是那份过期的大窗口状态。
	assert.match(controllerSource, /const effectiveWindowTurns = autoScroll\s*\? TIMELINE_MOUNTED_TURN_LIMIT\s*:\s*scrolledWindowTurns;/);
	assert.match(controllerSource, /renderedWindowTurnsRef\.current = effectiveWindowTurns;/);
	assert.match(controllerSource, /ownerWindowTurnsRef\.current\.set\(ownerKey, effectiveWindowTurns\)/);
});

// 中间回复「消失→回来」循环的根因修复：live 挂载点必须要求「活动正文流」。
// 中间回复 message_end 后槽删（streaming=false）→ 不再挂 live → 落回容器内 settled，
// 消除双失明窗口（live 读空 + 容器内被跳过）；下一条 assistant 出现前不会空白。
test("TurnRow liveInterimId requires an active text stream", () => {
	const turnSource = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
	// 订阅「活动流」派生 atom（稳定 boolean：流式期间 content 变化不触发重渲染）
	assert.match(turnSource, /liveTextActiveBySessionAtom\(props\.sessionId\)/);
	// 判定逻辑收敛到 liveMount.ts（纯函数可单测），TurnRow 只做接线
	assert.match(turnSource, /resolveLiveInterimId\(\{/);
	const liveMountSource = readFileSync("src/renderer/src/components/session/timeline/liveMount.ts", "utf8");
	assert.match(liveMountSource, /if \(!input\.liveTextActive\) return undefined;/);
	// 派生 atom 输出 streaming 或 held 位（session 级单槽）
	const atomsSource = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
	assert.match(atomsSource, /liveTextStreamingBySessionAtom = atomFamily/);
	assert.match(atomsSource, /liveTextActiveBySessionAtom = atomFamily/);
	assert.match(atomsSource, /map\[sessionId\]\?\.streaming === true \|\| map\[sessionId\]\?\.held === true/);
	// 会话移除时成对清理 family（防 atomFamily Map 泄漏）
	assert.match(atomsSource, /liveTextStreamingBySessionAtom\.remove\(sessionId\)/);
	assert.match(atomsSource, /liveTextActiveBySessionAtom\.remove\(sessionId\)/);
});

// stopReason 协议信号：主进程两处提取（live upsert + 历史回放），渲染层按
// stop/toolUse 精确区分中间回复与最终回复（message_end 即确定，永不反复）。
test("stopReason flows from RPC message_end into ChatMessage", () => {
	const agentSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	// live 路径：message_end 更新真实 stopReason，骨架阶段不覆盖旧值；
	// pending 是骨架占位值，必须被排除（否则 message_end 缺字段时消息永远停 in pending，
	// 渲染层回退启发式失效——reviewer 指出删掉该守卫测试照样绿的漏洞，故显式断言）。
	assert.match(agentSource, /extractedStopReason/);
	// 入参收窄后不再有 as any：stopReason 经 nonEmptyString(asRecord(partialMessage)) 提取
	assert.match(agentSource, /nonEmptyString\(asRecord\(partialMessage\)\?\.stopReason\)/);
	assert.match(agentSource, /existing\.stopReason = finalStopReason/);
	assert.match(agentSource, /extractedStopReason && extractedStopReason !== "pending"/);
	// 历史回放路径：JSONL 持久化的 stopReason 透传
	const projectorSource = readFileSync("src/main/pi/AgentMessageProjector.ts", "utf8");
	assert.match(projectorSource, /typeof typed\.stopReason === "string"/);
	assert.match(projectorSource, /stopReason \? \{ stopReason \} : \{\}\)/);
	// 渲染层判定行为（stop=final / toolUse 永不提升 / 无字段与 pending 回退）由
	// tests/turnSegments.test.mjs 行为测试覆盖（20 用例），此处不再重复源码断言。
});

// ── 冷会话 entryId 导航（#401 复审 P0）──
// 判据真值在 timelineRevealChannel（无依赖纯模块），宿主插件与时间线两端共用同一份：
// 消息还没上屏时 targetIndex < 0 不能当成「目标不存在」，否则插件导航静默丢失。
const revealChannel = loadTsCommonJs("src/renderer/src/hooks/timeline/timelineRevealChannel.ts");

test("冷会话：目标不在已加载数据时必须挂起等待而不是放弃", () => {
	const defer = (targetIndex, messageCount, surfaceLoading) => revealChannel.shouldDeferJumpUntilLoaded({ targetIndex, messageCount, surfaceLoading });
	// 会话还没有任何消息投影（插件刚 selectSession）：等首批到达
	assert.equal(defer(-1, 0, false), true);
	// 首屏 / 补页在途：等加载完成
	assert.equal(defer(-1, 12, true), true);
	// 数据已就绪且目标确实不在其中：交回补页 / 放弃逻辑，不能无限挂起
	assert.equal(defer(-1, 12, false), false);
	// 命中已加载数据：不需要等
	assert.equal(defer(7, 12, true), false);
});

test("reveal 事件在监听方晚挂载时会重派，超时仍优先", () => {
	const plan = (input) => ({ ...revealChannel.planRevealAttempt(input) });
	// 首次派发后仍没命中、未到重派间隔：先等
	assert.deepEqual(plan({ found: false, eventDispatched: true, elapsedMs: 400, sinceDispatchMs: 300 }), { action: "wait", keepPolling: true });
	// 超过重派间隔：再发一次（监听方此时可能才挂上）
	assert.deepEqual(plan({ found: false, eventDispatched: true, elapsedMs: 1200, sinceDispatchMs: 1100 }), { action: "dispatch", keepPolling: true });
	// 超时优先于重派
	assert.deepEqual(plan({ found: false, eventDispatched: true, elapsedMs: 4000, sinceDispatchMs: 900 }), { action: "give-up", keepPolling: false });
});
