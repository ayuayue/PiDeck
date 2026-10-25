import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectSessionFileChanges } from "../src/shared/fileChanges.ts";
import { collectRunFileChanges, fileChangeDelta, fileChangeToDiffLines } from "../src/renderer/src/components/session/TimelineFormat.ts";
import { fitOneRow } from "../src/renderer/src/components/session/turn/chipRowFit.ts";

/**
 * 会话文件修改汇总收集逻辑测试：
 * write/edit 工具消息 → 文件列表（去重 + 次数累计 + 最后一次 diff 内容）。
 * 纯函数已迁往 shared/fileChanges，TimelineFormat re-export 保持本测试 import 路径不变。
 */
function toolMessage(overrides = {}) {
	return {
		id: overrides.id ?? `m-${Math.random().toString(36).slice(2)}`,
		agentId: "a",
		role: "assistant",
		text: "",
		timestamp: Date.now(),
		meta: {
			toolName: overrides.toolName ?? "write",
			args: overrides.args ?? {},
		},
	};
}

test("collectSessionFileChanges: write tool yields the file with full content", () => {
	const messages = [toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "export const a = 1;" } })];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/a.ts");
	assert.equal(files[0].content, "export const a = 1;");
	assert.equal(files[0].count, 1);
});

test("collectSessionFileChanges: same file written twice counts twice and keeps the last content", () => {
	const messages = [toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v1" } }), toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v2" } })];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].count, 2);
	assert.equal(files[0].content, "v2");
});

test("collectSessionFileChanges: edit tool captures the changed region", () => {
	const messages = [
		toolMessage({
			path: "src/b.ts",
			toolName: "edit",
			args: {
				file_path: "src/b.ts",
				old_string: "const x = 1;",
				new_string: "const x = 2;",
			},
		}),
	];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/b.ts");
	assert.equal(files[0].originalContent, "const x = 1;");
	assert.equal(files[0].content, "const x = 2;");
});

test("collectSessionFileChanges: non-file tools and file-less args are ignored", () => {
	const messages = [toolMessage({ toolName: "bash", args: { command: "ls" } }), toolMessage({ toolName: "read", args: { file_path: "README.md" } }), toolMessage({ toolName: "write", args: {} })];
	assert.deepEqual(collectSessionFileChanges(messages), []);
});

test("collectSessionFileChanges: different files are kept separately", () => {
	const messages = [toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "a" } }), toolMessage({ path: "src/b.ts", args: { file_path: "src/b.ts", content: "b" } })];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 2);
	assert.deepEqual(files.map((f) => f.path).sort(), ["src/a.ts", "src/b.ts"]);
});

test("collectRunFileChanges: gathers file changes from one run only", () => {
	const run = {
		kind: "agent-run",
		id: "run-1",
		startedAt: 1000,
		endedAt: 2000,
		items: [
			{ kind: "message", message: { role: "user", id: "u1", text: "hi", timestamp: 1100 } },
			{
				kind: "tool-group",
				id: "tg-1",
				messages: [toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v1" } }), toolMessage({ toolName: "bash", args: { command: "ls" } })],
			},
			{ kind: "thinking-group", id: "th-1", text: "", startedAt: 1200, endedAt: 1300, messages: [] },
			{ kind: "message", message: { role: "assistant", id: "a1", text: "done", timestamp: 1900 } },
		],
	};
	const files = collectRunFileChanges(run);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/a.ts");
	assert.equal(files[0].count, 1);
});

test("fileChangeToDiffLines: write yields all-added lines, edit yields removed+added", () => {
	const writeLines = fileChangeToDiffLines({ originalContent: "", content: "a\nb" });
	assert.deepEqual(writeLines, [
		{ id: "added-0", type: "added", content: "a" },
		{ id: "added-1", type: "added", content: "b" },
	]);
	const editLines = fileChangeToDiffLines({ originalContent: "old1\nold2", content: "new1" });
	assert.deepEqual(editLines, [
		{ id: "removed-0", type: "removed", content: "old1" },
		{ id: "removed-1", type: "removed", content: "old2" },
		{ id: "added-0", type: "added", content: "new1" },
	]);
});

test("file changes render as a per-turn chip row at the end of each turn", () => {
	// 2027-02 位置迁移：文件修改从 composer 上方的常驻卡片（SessionFilesStrip）改为每轮末尾的
	// chip 行（turn/TurnFileChanges，形态参考 Proma TurnFileChangesSummary）。
	// 旧卡片本身已删除，因此断言改为「轮末 chip 行存在 + 旧卡片不存在」。
	const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.ok(!timeline.includes("TurnFileChanges"), "timeline should not own the file strip");

	const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
	// 轮末 chip 行挂在 TurnRow：正文（finalItems）之后、操作栏之前。
	// 位置锚点只用真实代码（不能用注释文本当锚——注释被改写就会假红，
	// 而组件顺序可能完全正确）。
	assert.match(turnRow, /<TurnFileChanges run=\{run\}/);
	assert.ok(turnRow.indexOf("<TurnFileChanges") > turnRow.indexOf("{finalItems.map"), "chip row must render after the final answer");
	assert.ok(turnRow.indexOf("<TurnFileChanges") < turnRow.indexOf("{((mergedText && !editing) || showDuration || showTurnModel) && ("), "chip row must render before the action bar");

	// 组件本体：Proma 形态（虚线分隔 + chip 横排），但左对齐要按 PiDeck 自己的基准
	const chip = readFileSync("src/renderer/src/components/session/turn/TurnFileChanges.tsx", "utf8");
	assert.match(chip, /data-testid="turn-file-changes"/);
	// 2027-02 观感 bug：Proma 的 pl-[46px] 是因为它的正文缩进在头像右侧，
	// 而 PiDeck 的 TurnRow 正文/操作栏从 0 开始——照搬会凭空多缩进 46px。
	// 只检查 JSX className（注释里会提到这个旧取值的来历，不该被当成代码命中）。
	const classNameAttrs = chip.match(/className="[^"]*"/g) ?? [];
	assert.ok(classNameAttrs.length > 0, "chip row 必须能定位到 className");
	for (const attr of classNameAttrs) {
		assert.doesNotMatch(attr, /pl-\[46px\]/, "chip row must not indent past the answer column (PiDeck body starts at 0, unlike Proma)");
	}
	assert.match(chip, /<div className="mt-3" data-testid="turn-file-changes">/, "chip row aligns with body/action bar (no extra left padding)");
	assert.match(chip, /border-t-2 border-dashed/, "chip row uses a dashed divider instead of a card frame");
	assert.match(chip, /collectRunFileChanges\(props\.run\)/, "chip row aggregates per run, not by session-wide latest turn");
	assert.match(chip, /fileChangeDelta\(/, "chip row shows +N/-N per file");
	assert.doesNotMatch(chip, /ComposerWidgetFrame/, "chip row is not a composer card any more");

	// composer 上方不再挂文件条；引导页无轮次，也不挂
	const sessionView = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
	assert.doesNotMatch(sessionView, /SessionFilesStrip/);
	const startSurface = readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
	assert.doesNotMatch(startSurface, /SessionFilesStrip/);

	// 右侧状态面板的「文件」tab 也已移除：轮末 chip 行是唯一入口，面板只留待办/子代理。
	// 只断言 import 与 JSX —— 注释里会提到这些名字（说明「为什么不再需要」），不该被命中断言。
	const statusContent = readFileSync("src/renderer/src/components/session/statusPanel/SessionStatusContent.tsx", "utf8");
	const statusImports = statusContent.match(/^import .*$/gm) ?? [];
	for (const line of statusImports) {
		assert.doesNotMatch(line, /useSessionFileChanges|sessionLatestAgentRunAtomFamily/, "panel must not import file-change data sources any more");
	}
	assert.doesNotMatch(statusContent, /<StatusFilesTab/, "files tab content removed from the panel JSX");
	const statusTabs = readFileSync("src/renderer/src/components/session/statusPanel/StatusTabs.tsx", "utf8");
	assert.doesNotMatch(statusTabs, /export function StatusFilesTab/, "StatusFilesTab deleted");
	assert.doesNotMatch(statusTabs, /^import .*FileEntry.*$/m, "FileEntry no longer imported");
});

/**
 * 轮末 chip 行的 +N / −N（fileChangeDelta）。
 * 口径与抽屉里的「约 N 行」（changedLines）分开：后者是「最大行数」估算，拆不出加减。
 */
test("fileChangeDelta: write yields all-added lines and no removals", () => {
	assert.deepEqual(fileChangeDelta({ originalContent: "", content: "a\nb\nc" }), { added: 3, removed: 0 });
});

test("fileChangeDelta: edit splits the changed region into added and removed", () => {
	assert.deepEqual(fileChangeDelta({ originalContent: "old1\nold2", content: "new1\nnew2\nnew3" }), { added: 3, removed: 2 });
});

test("fileChangeDelta: empty content counts as zero lines, CRLF is handled", () => {
	assert.deepEqual(fileChangeDelta({ originalContent: "", content: "" }), { added: 0, removed: 0 });
	assert.deepEqual(fileChangeDelta({ originalContent: "a\r\nb", content: "c\r\nd\r\ne" }), { added: 3, removed: 2 });
});

/**
 * 轮末 chip 行只在该轮结束、且确实改过文件时渲染（2027-02 位置迁移后）。
 */
test("TurnFileChanges: renders per run, hidden while streaming, tolerates runs without file changes", () => {
	const chip = readFileSync("src/renderer/src/components/session/turn/TurnFileChanges.tsx", "utf8");
	// 只用本 run 的消息聚合（不是会话级「最新一轮」）
	assert.match(chip, /collectRunFileChanges\(props\.run\)/);
	// 流式中返回 null：文件列表还在长，逐条冒出来会让正文区持续抖动
	assert.match(chip, /if \(props\.streaming\) return null;/);
	assert.match(chip, /if \(files\.length === 0\) return null;/);
	// 左键默认开 diff、右键菜单给「预览打开」（用户调整后的交互契约）：
	// 轮末 chip 的默认意图是「这轮改了什么」，打开文件本体降到右键二级入口。
	assert.match(chip, /const canDiff = !props\.noInteract && Boolean\(props\.onDiffFile\)/, "diff 入口按是否注入 onDiffFile 判定");
	assert.match(chip, /onClick=\{props\.noInteract \? undefined : canDiff \? handleOpenDiff : handleOpenFile\}/, "左键主操作是 diff；缺 onDiffFile 的宿主面退回打开文件，chip 不能变成死按钮");
	assert.match(chip, /const handleOpenDiff = \(\) => props\.onDiffFile\?\.\(entry\.path, entry\.originalContent, entry\.content\)/, "diff 入口要带本轮 diff 内容（不是重新读盘）");
	assert.match(chip, /const handleOpenFile = \(\) => props\.onOpenFile\?\.\(entry\.path\)/, "预览入口打开文件本体");
	// 右键菜单仍提供「预览打开」（预览 tab / 图片预览），并按可用性渲染：空菜单比没有菜单更糟
	assert.match(chip, /\{canOpen && <ContextMenuItem onSelect=\{handleOpenFile\}>\{t\("sessionFiles\.previewFile"\)\}<\/ContextMenuItem>\}/, "右键菜单必须有「预览打开」");
	assert.match(chip, /if \(!canDiff && !canOpen\) return chip;/, "两个入口都不可用时不套空菜单");
	// 修改次数与增删量都要展示
	assert.match(chip, /entry\.count > 1/);
	assert.match(chip, /fileChangeDelta\(entry\)/);
});

/**
 * 轮末 chip 的视觉契约（2027-02 用户确认的定稿）。
 *
 * 配色选 F：底色走主题 accent（随 data-accent 变），文字走 text-secondary。
 * 为什么不用 accent 当文字色：accent 在 PiDeck 里是「面」不是「字」，
 * 6 个主题实测 green 4.38 / blue 4.37 / amber 4.25 / rose 3.89，四个不到 WCAG AA 4.5。
 * 为什么不用 --color-chip-file：它是固定蓝，6 个 accent 主题一个都不覆盖，
 * 切绿/紫/玫主题时它是界面上唯一不变的颜色（用户反馈的「颜色不适配」根因）。
 */
test("TurnFileChanges: accent-tinted chip with secondary text, 16px icon (no fixed chip-file blue)", () => {
	const chip = readFileSync("src/renderer/src/components/session/turn/TurnFileChanges.tsx", "utf8");

	// 底色来自主题 accent，不是固定身份色。
	// 6% 是调过的：10% 在 neutral 主题下得 #e8e8e8，白底上像一块深灰「阴影」，
	// 用户反馈「阴影有点深」；6% 得 #f1f1f1，几乎与页面同层。
	assert.match(chip, /bg-\[color:color-mix\(in_srgb,var\(--color-accent\)_6%,transparent\)\]/, "chip background must derive from --color-accent (6% to stay unobtrusive)");
	assert.doesNotMatch(chip, /bg-chip-file|text-chip-file/, "fixed chip-file blue is the bug being fixed");

	// 行高不要手写覆盖类：text-control 这个 token 自带 --line-height-control
	//（五档字号下 18/20/22/23/24px，约为字号的 1.5 倍），完全盖得住字形墨迹。
	// 原代码的 leading-none 把它压成 1.0，实测字形上下各被裁 2px。
	// 实测（5 档字号 × 4 档缩放 = 20 种组合）：不写 leading-* 余量 0.67~2px，全部完整。
	assert.doesNotMatch(chip, /text-control leading-/, "do not override the token line-height: text-control already carries --line-height-control (hand-written leading-none clipped glyphs by 2px)");

	// 文字色：secondary（产物比正文弱一档），hover 提到 primary
	assert.match(chip, /text-text-secondary/, "chip text uses secondary (F scheme)");
	assert.match(chip, /hover:text-text-primary/, "hover promotes text to primary instead of changing hue");

	// 图标 16px：原 12px 比 13px 的文件名还小
	assert.match(chip, /className="inline-flex size-4 shrink-0/, "file type glyph must be 16px (size-4)");
	assert.doesNotMatch(chip, /inline-flex size-3 shrink-0/, "12px glyph was too small next to 13px text");

	// +N/−N 用状态色，跨主题恒定（不跟 accent 走）
	assert.match(chip, /text-success.*\+\{delta\.added\}/s);
	assert.match(chip, /text-danger.*−\{delta\.removed\}/s);
});

/**
 * 轮末 chip 行单行装箱规则（fitOneRow）。
 *
 * 规则来源：一轮可能改几十个文件，全铺开会把轮末撑成一坨；也不能只横向滚动
 * （滚动条隐藏后不知道右边还有东西，鼠标滚轮默认也不动横向）。
 * 定案：只显示一行，放不下的收进 +N，点 +N 就地展开成多行。
 */
test("fitOneRow: packs chips left to right and reserves room for the +N button", () => {
	// 100px chip × 3，gap 6，+N 约 40px
	const w = [100, 100, 100];
	// 206 放 2 个后 + 6 + 40 = 252 ≤ 300 → 放 2 个
	assert.equal(
		fitOneRow(w, 6, 300, () => 40),
		2,
	);
	// 312 ≤ 400 → 3 个全放得下，不需要 +N
	assert.equal(
		fitOneRow(w, 6, 400, () => 40),
		3,
	);
});

test("fitOneRow: degenerate inputs never place a chip", () => {
	assert.equal(
		fitOneRow([], 6, 300, () => 40),
		0,
		"空列表",
	);
	assert.equal(
		fitOneRow([100, 100], 6, 0, () => 40),
		0,
		"零可用宽度",
	);
	assert.equal(
		fitOneRow([500, 100], 6, 300, () => 40),
		0,
		"第一个 chip 就超宽",
	);
	assert.equal(
		fitOneRow([100], 6, 60, () => 40),
		0,
		"单 chip 也放不下",
	);
});

test("fitOneRow: the last chip does not reserve room for a +N button", () => {
	// 只有一个 chip 且刚好放得下：不该因为预留 +N 而退回 0
	assert.equal(
		fitOneRow([100], 6, 100, () => 40),
		1,
	);
	assert.equal(
		fitOneRow([100, 100], 6, 206, () => 40),
		2,
	);
});

test("fitOneRow: never overflows the available width across random inputs", () => {
	// 属性测试：2000 组随机宽度/可用宽度，装箱结果必须始终「已用 + +N」不超宽、
	// 且数量在合法范围内。这是这条规则唯一的硬约束。
	let checked = 0;
	for (let trial = 0; trial < 2000; trial += 1) {
		const count = Math.floor(Math.random() * 15);
		const widths = Array.from({ length: count }, () => 40 + Math.random() * 200);
		const available = 200 + Math.random() * 700;
		const gap = 6;
		const moreWidth = () => 40;
		const placed = fitOneRow(widths, gap, available, moreWidth);

		assert.ok(placed >= 0 && placed <= count, `越界：placed=${placed} count=${count}`);
		const used = widths.slice(0, placed).reduce((sum, w, index) => sum + w + (index > 0 ? gap : 0), 0);
		const remaining = count - placed;
		const reserved = remaining > 0 ? moreWidth() + gap : 0;
		assert.ok(used + reserved <= available + 0.5, `超宽：used=${used} + reserved=${reserved} > available=${available}`);
		checked += 1;
	}
	assert.equal(checked, 2000);
});

test("chip row collapses to one line and expands in place", () => {
	const source = readFileSync("src/renderer/src/components/session/turn/TurnFileChanges.tsx", "utf8");
	// 单行：折叠态不换行
	assert.match(source, /flex-nowrap/, "collapsed row must not wrap");
	// 展开态才换行
	assert.match(source, /flex-wrap/, "expanded row wraps into multiple lines");
	// 装箱规则来自纯函数
	assert.match(source, /fitOneRow\(/);
	// 关键陷阱：折叠态行里只有 visibleCount 个 chip，从可见行量宽度会把装箱锁死
	// 在首帧结果上（量到的永远只是当前已显示的那几个）。必须从不含裁切的测量层量。
	assert.match(source, /const probe = probeRef\.current;/, "measurement must read the probe layer, not the visible row");
	assert.match(source, /probe\.querySelectorAll<HTMLElement>\("\[data-file-chip\]"\)/, "chip widths come from the probe layer");
	assert.doesNotMatch(source, /row\.querySelectorAll<HTMLElement>\("\[data-file-chip\]"\)/, "visible row must not be the width source (it is already truncated)");
	// +N 是被用户确认的样式：虚线边框 chip
	assert.match(source, /border-dashed/, "+N button uses the dashed outline chip style");
	// 点击就地展开（同一组件内状态），不跳转、不弹浮层
	assert.match(source, /const toggle = useCallback\(\(\) => setExpanded\(\(previous\) => !previous\), \[\]\);/, "+N toggles in-place expansion");
	assert.match(source, /onClick=\{toggle\}/, "+N button is wired to the toggle");
	// 不给 +N 用浮层 / Popover：就地展开是定案
	assert.doesNotMatch(source, /Popover|createPortal/, "expansion stays inline (no popover layer)");
});

test("chip row overflow copy exists in all three locale dictionaries", () => {
	for (const locale of ["zh-CN", "zh-TW", "en-US"]) {
		const copy = readFileSync(`src/renderer/src/i18n/rendererCopy.${locale}.ts`, "utf8");
		// +N 是数字标识，三语同一个形态；提示文案才是翻译的
		assert.match(copy, /"sessionFiles\.moreChips": "\+\{count\}"/, `${locale} 缺 moreChips`);
		assert.match(copy, /"sessionFiles\.moreChipsHint": /, `${locale} 缺 moreChipsHint`);
		// chip 右键菜单的「预览打开」三语都要有（默认点击改成 diff 后，预览只剩这个入口）
		assert.match(copy, /"sessionFiles\.previewFile": /, `${locale} 缺 previewFile`);
	}
});
