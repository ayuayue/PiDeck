import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 流式正文划选保持的纯逻辑守卫（用户反馈：「在渲染中的，选中会被清理」）。
 *
 * 分两层：
 * 1. lib/selectionTextOffsets 的纯函数（偏移/上下文锚点、唯一匹配、歧义放弃）——真跑断言；
 * 2. 源码契约（正则空白容忍）：DOM 胶水在浏览器里，node:test 没有 jsdom，只能守
 *    「MutationObserver 三选项都开」「无快照时热路径直接返回」「挂载点在 TurnRow」
 *    「恢复顺序 node→offset→context 且每段都校验文本」这些结构性不变量，防止后续改动
 *    悄悄退化成「每帧遍历 DOM」或「恢复到错误位置」。
 */

const { SELECTION_CONTEXT_CHARS, buildSelectionContext, findTextOccurrences, contextMatchScore, locateSelectionContext } = loadTsCommonJs("src/renderer/src/lib/selectionTextOffsets.ts");

const LIB_SOURCE = readFileSync("src/renderer/src/lib/selectionTextOffsets.ts", "utf8");
const ANSWER_OUTPUT_SOURCE = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
const HOLD_SOURCE = readFileSync("src/renderer/src/hooks/useHoldTextWhileSelecting.ts", "utf8");

/**
 * 断言「定位到某段文本」。
 * 沙箱（loadTsCommonJs 的 vm）返回的对象来自独立 realm，跨 realm 的 deepEqual 会连原型链一起比，
 * 所以这里逐字段用严格相等断言（也顺带断言了「没被定位到 null」）。
 */
function assertLocation(located, start, end) {
	assert.notEqual(located, null, "本应定位到选区，实际放弃（null）");
	assert.equal(located.start, start);
	assert.equal(located.end, end);
}
const HOOK_SOURCE = readFileSync("src/renderer/src/hooks/useStreamSelectionPreserve.ts", "utf8");
const TURN_ROW_SOURCE = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");

test("buildSelectionContext slices the selected text with bounded context", () => {
	const full = "0123456789abcdefghij";
	const context = buildSelectionContext(full, 5, 10, 3);
	assert.equal(context.text, "56789");
	assert.equal(context.prefix, "234");
	assert.equal(context.suffix, "abc");
	// 越界夹紧、顺序颠倒退化为空选区（不抛错）
	const clamped = buildSelectionContext("abc", 1, 99, 8);
	assert.equal(clamped.text, "bc");
	assert.equal(clamped.prefix, "a");
	assert.equal(clamped.suffix, "");
	assert.equal(buildSelectionContext("abc", 2, 1).text, "");
	// 默认上下文长度：前后各 32 字符，够覆盖一个中文段落，又不会把快照撑大
	assert.equal(SELECTION_CONTEXT_CHARS, 32);
	const long = buildSelectionContext("abcdefghijklmnopqrst", 8, 10);
	assert.equal(long.text, "ij");
	assert.equal(long.prefix.length, 8);
	assert.equal(long.suffix.length, 10);
});

test("findTextOccurrences lists every (also overlapping) occurrence", () => {
	assert.equal(findTextOccurrences("必须通过，必须通过。", "必须通过").join(","), "0,5");
	assert.equal(findTextOccurrences("aaaa", "aa").join(","), "0,1,2");
	assert.equal(findTextOccurrences("abc", "z").length, 0);
	assert.equal(findTextOccurrences("abc", "").length, 0);
});

test("contextMatchScore counts contiguous matches outward from the selection only", () => {
	const full = "abcdefghij";
	// index 5 的文本是 "fgh"：前一字符 e 与后三字符 ijk 连续匹配
	assert.equal(contextMatchScore(full, 5, "fgh", "de", "ijk"), 4);
	// 前缀首字符不匹配 → 前缀侧立即停止，不再数更远的字符（前缀只剩 1 分 + 后缀 2 分）
	assert.equal(contextMatchScore(full, 5, "fgh", "xe", "ijk"), 3);
	assert.equal(contextMatchScore(full, 5, "fgh", "", ""), 0);
});

test("locateSelectionContext round-trips the original offsets", () => {
	const full = "以下是渲染元素巡检：修改了 src/main/index.ts 和 docs。行内代码 npm run typecheck 必须通过。";
	const start = full.indexOf("行内代码");
	const end = start + "行内代码".length;
	const located = locateSelectionContext(full, buildSelectionContext(full, start, end));
	assertLocation(located, start, end);
});

test("duplicate text is disambiguated by the surrounding context", () => {
	const full = "第一段 必须通过。第二段 必须通过。第三段";
	const occurrences = findTextOccurrences(full, "必须通过");
	assert.equal(occurrences.length, 2);
	const second = occurrences[1];
	const located = locateSelectionContext(full, buildSelectionContext(full, second, second + 4));
	assertLocation(located, second, second + 4);
	// 上下文一模一样时分不出是哪一处 → 宁可放弃（返回 null，调用方丢快照），也不乱恢复
	assert.equal(locateSelectionContext(full, { text: "必须通过", prefix: "", suffix: "" }), null);
	assert.equal(locateSelectionContext(full, { text: "不存在的片段", prefix: "", suffix: "" }), null);
	assert.equal(locateSelectionContext(full, { text: "", prefix: "", suffix: "" }), null);
});

test("streamed tail growth does not move the anchor", () => {
	const before = "第一段正文。行内代码 必须通过。";
	const start = before.indexOf("行内代码");
	const context = buildSelectionContext(before, start, start + 4);
	// 流式追加只会往后长：绝对偏移不变，前后文匹配直接命中
	const after = before + "后面又流式到达的新段落，长度远大于前文。";
	assertLocation(locateSelectionContext(after, context), start, start + 4);
});

test("settle-time markdown syntax removal keeps the phrase findable", () => {
	// 流式期间 markdown 源码字符（# / **）也在根文本里，settle 渲染后它们消失 → 绝对偏移整体前移；
	// 锚点必须靠文本本身 + 上下文重新定位（这是 restoreSelectionSnapshot 第三段兜底的真实场景）。
	const streaming = "# 标题\n\n这是 **加粗** 的正文。目标片段在这里。";
	const start = streaming.indexOf("目标片段");
	const context = buildSelectionContext(streaming, start, start + 4);
	const settled = "标题这是 加粗 的正文。目标片段在这里。";
	const located = locateSelectionContext(settled, context);
	assertLocation(located, settled.indexOf("目标片段"), settled.indexOf("目标片段") + 4);
});

test("context scoring survives an offset shift when the phrase repeats", () => {
	const settled = "简介 目标 一。附录 目标 二。";
	const second = settled.indexOf("目标", settled.indexOf("附录"));
	const context = buildSelectionContext(settled, second, second + 2);
	// 整篇前面再插入一段（偏移整体后移），仍必须选中「附录」后面那一处
	const shifted = "序言。\n" + settled;
	const expected = shifted.indexOf("目标", shifted.indexOf("附录"));
	assertLocation(locateSelectionContext(shifted, context), expected, expected + 2);
});

test("restore tries node anchors before absolute offsets before context", () => {
	// 顺序是行为契约：节点引用最精确（冻结前缀里节点没被换过），绝对偏移次之（追加式流式），
	// 上下文匹配最后兜底（settle 重排）。顺序反了会把选区恢复到位移后的同文本别处。
	const nodeIndex = LIB_SOURCE.indexOf("// (a) 原始节点引用");
	const offsetIndex = LIB_SOURCE.indexOf("// (b) 绝对偏移");
	const contextIndex = LIB_SOURCE.indexOf("// (c) 前后文唯一匹配");
	assert.ok(nodeIndex > 0, "缺少节点引用兜底分支");
	assert.ok(offsetIndex > nodeIndex, "绝对偏移分支必须在节点引用之后");
	assert.ok(contextIndex > offsetIndex, "上下文匹配分支必须在绝对偏移之后");
	// 三段都必须用 range.toString() 逐字校验：恢复结果文本不一致时宁可放弃
	assert.match(LIB_SOURCE, /if\s*\(\s*range\.toString\(\)\s*===\s*snapshot\.text\s*\)\s*return\s+range\s*;/);
	assert.match(LIB_SOURCE, /if\s*\(\s*offsetRange\s*&&\s*offsetRange\.toString\(\)\s*===\s*snapshot\.text\s*\)\s*return\s+offsetRange\s*;/);
	assert.match(LIB_SOURCE, /if\s*\(\s*contextRange\s*&&\s*contextRange\.toString\(\)\s*===\s*snapshot\.text\s*\)\s*return\s+contextRange\s*;/);
	// 偏移必须从根元素开头起算（与 readRootText 同一套文本节点拼接口径），
	// 不能用 Selection.toString()（跨段落会被塞 \n\n，恢复后校验恒失配）。
	assert.match(LIB_SOURCE, /counter\.selectNodeContents\(\s*root\s*\)/);
	assert.doesNotMatch(LIB_SOURCE, /selection\.toString\(\)/);
});

test("hook observes the row subtree for every DOM mutation kind", () => {
	assert.match(HOOK_SOURCE, /new MutationObserver\(/);
	assert.match(HOOK_SOURCE, /observer\.observe\(\s*root\s*,[\s\S]{0,200}?childList:\s*true[\s\S]{0,120}?subtree:\s*true[\s\S]{0,120}?characterData:\s*true/);
	// 恢复必须同步发生在 observer 回调里（微任务，早于绘制）；不允许 rAF 轮询回路
	assert.doesNotMatch(HOOK_SOURCE, /requestAnimationFrame/);
	// 零重渲染：不引入 React state
	assert.doesNotMatch(HOOK_SOURCE, /useState/);
	// 卸载成对清理（observer + 全部事件监听）
	assert.match(HOOK_SOURCE, /observer\.disconnect\(\)/);
	for (const eventName of ["selectionchange", "pointerdown", "pointerup", "pointercancel", "keydown", "keyup", "blur"]) {
		assert.match(HOOK_SOURCE, new RegExp(`addEventListener\\(\\s*"${eventName}"`), `缺少 ${eventName} 监听`);
		assert.match(HOOK_SOURCE, new RegExp(`removeEventListener\\(\\s*"${eventName}"`), `${eventName} 监听缺少配对清理`);
	}
});

test("no snapshot means the mutation callback is a cheap no-op", () => {
	// 性能契约：每次 React commit 都会触发 observer，无快照时必须第一行返回，
	// 不能在每个 mutation 批次里做文本遍历/偏移计算。
	assert.match(HOOK_SOURCE, /const onMutations = \(\) => \{\s*if \(!snapshot\) return;/);
});

test("selection snapshot lifecycle clears on user intent but not on DOM churn", () => {
	// pointerdown：新交互清快照（右键不清：消息右键菜单打开期间选区要活下来）
	assert.match(HOOK_SOURCE, /if \(event\.button !== 0\) return;\s*dropSnapshot\(\);\s*pointerDown = true;/);
	// 拖选进行中绝不恢复
	assert.match(HOOK_SOURCE, /if \(pointerDown\) return;/);
	// 修饰键 keydown 不清快照（Ctrl+C 复制 / Shift+方向键扩选）
	assert.match(HOOK_SOURCE, /if \(event\.ctrlKey \|\| event\.metaKey \|\| event\.shiftKey\) return;\s*dropSnapshot\(\);/);
	// 折叠/无选区时 selectionchange 不能丢快照（塌陷很可能正是 churn 造成的）
	assert.match(HOOK_SOURCE, /if \(!range\) return; \/\/ 折叠\/无选区/);
	// 关键回归点：Chromium 在选区内文本节点被移除时也会把选区「重锚撑大」成父元素整段文本
	// （某次实测：拖选 4 个字 → 1.5s 后变成几乎整段 live 正文）。所以恢复条件不能只看 collapsed，
	// 必须比对 range 文本与快照文本：不一致同样视为被 churn 搞坏并还原。
	assert.match(HOOK_SOURCE, /if \(range\.toString\(\) === snapshot\.text\) return;/);
	// 还原动作：removeAllRanges + addRange（同步在 observer 回调里执行）
	assert.match(HOOK_SOURCE, /selection\.removeAllRanges\(\);/);
	assert.match(HOOK_SOURCE, /selection\.addRange\(restored\);/);
	// 失配宽限：settle 交接短暂「双无」不能一次失配就把选区判死
	assert.match(HOOK_SOURCE, /MAX_RESTORE_MISSES/);
	assert.match(HOOK_SOURCE, /misses >= MAX_RESTORE_MISSES/);
});

test("snapshots are created only by trusted user actions", () => {
	// 真机诊断 A(b)：DOM churn 触发的 selectionchange 可能是「跨块/撑大」的残影（起点落到行头
	// <time>，Selection.toString() 多出块级换行）。这种残影只能刷新已有快照的节点引用；
	// 没有快照时绝不新建，否则之后每次还原都按错误锚点走。
	assert.match(HOOK_SOURCE, /if \(!snapshot \|\| snapshot\.text !== text\) return;/);
	// 静默期只对键盘生效（C）：鼠标拖选由 pointerDown 拦住，松手后必须立刻允许恢复；
	// 旧的 lastUserInputAt 会把 pointerup 之后的首次还原吞掉 200ms，正好错过 churn 帧。
	assert.doesNotMatch(HOOK_SOURCE, /lastUserInputAt/);
	assert.match(HOOK_SOURCE, /lastKeyboardInputAt/);
	assert.match(HOOK_SOURCE, /now\(\) - lastKeyboardInputAt < KEYBOARD_RESTORE_QUIET_MS/);
});

test("restored range endpoints are biased away from block boundaries", () => {
	// 真机诊断 A(a)：偏移正好落在两个文本节点交界处时，起点若映射到前一个节点末尾、而前一个
	// 节点在别的块里，Selection.toString() 会在文本前补换行（'以下是' → '\n以下是'）。
	// 起点偏后（下一个文本节点）、终点偏前（上一个文本节点），两点都收在各自块内。
	assert.match(LIB_SOURCE, /pointAtTextOffset\(nodes,\s*start,\s*"next"\)/);
	assert.match(LIB_SOURCE, /pointAtTextOffset\(nodes,\s*end,\s*"previous"\)/);
	// next 偏置语义：只有 remaining 严格小于节点长度才落进来（正好等于边界时继续往后找），
	// previous 偏置则是 <=（停在当前节点末尾）。
	assert.match(LIB_SOURCE, /bias === "next" \? remaining < length : remaining <= length/);
	// 空文本节点不参与映射：它们存不住选区，还可能落在别的块里
	assert.match(LIB_SOURCE, /if \(length === 0\) continue;/);
});

test("live answer freezes its rendered text while the pointer is down", () => {
	// 真机诊断 B：拖选期间只要来一个 chunk，live 正文文本节点就会重挂，浏览器在 pointerup 之前
	// 就把选区收掉（快照都拍不到）。所以按下期间必须冻结渲染文本，松手后立刻换回最新文本。
	assert.match(ANSWER_OUTPUT_SOURCE, /useHoldTextWhileSelecting\(text, liveRef\)/);
	assert.match(ANSWER_OUTPUT_SOURCE, /ref=\{liveRef\}/);
	// 冻结文本必须真的喂给 MarkdownStream（只冻 state 不冻渲染等于没冻）
	assert.match(ANSWER_OUTPUT_SOURCE, /<MarkdownStream text=\{displayText\}/);
	// 只认主键且落点必须在 live 正文内（右键菜单/其它区域不冻结正文）
	assert.match(HOLD_SOURCE, /if \(event\.button !== 0\) return;/);
	assert.match(HOLD_SOURCE, /root\.contains\(event\.target\)/);
	// 按下冻结、松开/取消/失焦解冻，监听成对清理
	for (const eventName of ["pointerdown", "pointerup", "pointercancel", "blur"]) {
		assert.match(HOLD_SOURCE, new RegExp(`addEventListener\\(\\s*"${eventName}"`), `缺少 ${eventName} 监听`);
		assert.match(HOLD_SOURCE, new RegExp(`removeEventListener\\(\\s*"${eventName}"`), `${eventName} 监听缺少配对清理`);
	}
	// 冻结期间不更新 heldTextRef（否则冻结文本会跟着 churn 一起变，等于没冻）
	assert.match(HOLD_SOURCE, /if \(!held && !heldRef\.current\) heldTextRef\.current = text;/);
});

test("TurnRow mounts the preserve hook exactly once with the row ref", () => {
	const calls = TURN_ROW_SOURCE.match(/useStreamSelectionPreserve\([^)]*\)/g) ?? [];
	assert.equal(calls.length, 1, "只允许一个挂载点，避免同一行挂两份 observer");
	assert.match(TURN_ROW_SOURCE, /import \{ useStreamSelectionPreserve \} from "\.\.\/\.\.\/\.\.\/hooks\/useStreamSelectionPreserve";/);
	assert.match(TURN_ROW_SOURCE, /useStreamSelectionPreserve\(rowRef\)/);
	// hooks 必须在「无内容提前 return null」之前调用（TurnRow 会先渲染空壳再长出正文）
	const hookIndex = TURN_ROW_SOURCE.indexOf("useStreamSelectionPreserve(rowRef)");
	const earlyReturnIndex = TURN_ROW_SOURCE.indexOf("if (displayItems.length === 0 && allImages.length === 0) return null;");
	assert.ok(hookIndex > 0 && earlyReturnIndex > hookIndex, "hook 必须在提前 return 之前调用");
});
