import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { twMerge } from "tailwind-merge";
import { parseTodoSnapshotData } from "../src/shared/sessionTodo.ts";

// 官方 BeUI Todo List 迁移后：组件源码在 agents/todo-list.tsx（官方结构忠实拷贝），
// widget 行→TodoItem 的解析器移入 session/agentTodoParser.ts（纯函数）。
// 本测试验证官方组件结构/行为要点 + 解析器映射行为，不挂载真实 React。

function compile(filePath, stubs = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
			jsx: ts.JsxEmit.ReactJSX,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => stubs[specifier] ?? {};
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
		},
		{ filename: filePath },
	);
	return module.exports;
}

const todoListPath = "src/renderer/src/components/agents/todo-list.tsx";
const parserPath = "src/renderer/src/components/session/agentTodoParser.ts";
const source = (path) => readFileSync(path, "utf8");
const todoListSource = () => source(todoListPath);

test("official BeUI TodoList source is placed in agents/ with official structure", () => {
	const src = todoListSource();
	// 官方导出与 API
	assert.match(src, /export function TodoList\(/);
	assert.match(src, /export type TodoItemStatus/);
	for (const status of ["pending", "in-progress", "completed", "cancelled"]) {
		assert.ok(src.includes(`"${status}"`), `status ${status} must exist in TodoItemStatus`);
	}
	assert.match(src, /export interface TodoItem/);
	assert.match(src, /export interface TodoListProps/);
	assert.match(src, /collapseOnComplete\?: boolean/);
	assert.match(src, /maxHeight\?: number/);
	// 官方依赖的 sibling 源码与共享运动常量
	assert.match(src, /from "@\/components\/agents\/agent-disclosure"/);
	assert.match(src, /from "@\/components\/motion\/action-swap-roll"/);
	assert.match(src, /from "@\/lib\/ease"/);
	assert.match(src, /EASE_OUT/);
	assert.match(src, /SPRING_LAYOUT/);
	assert.match(src, /SPRING_SWAP/);
	// 官方行为要点：完成计数 / 全部完成自动折叠 + 新工作重新展开 / 状态图标动画 / reduced-motion
	assert.match(src, /ActionSwapRollText value=\{String\(completed\)\}/);
	assert.match(src, /previousComplete\.current && !allComplete/);
	assert.match(src, /collapseOnComplete\)\s*\{\s*setOpen\(false\)/);
	assert.match(src, /useReducedMotion/);
	// 产品取舍（2026-12 用户要求）：已完成项去掉官方删除线，对勾标记已足够；
	// 与文件头部适配注释同步，防止 CLI 覆盖/误删时把这条偏离当意外改动
	assert.doesNotMatch(src, /scaleX: status === "completed" \? 1 : 0/);
	assert.match(src, /AnimatePresence initial=\{false\} mode="popLayout"/);
	// 无障碍：disclosure 语义（trigger/content id、aria-expanded、aria-labelledby）
	assert.match(src, /aria-expanded=\{currentOpen\}/);
	assert.match(src, /aria-controls=\{contentId\}/);
	// 用户可见文案必须走 i18n，不允许英文硬编码
	assert.match(src, /t\("app\.todoListTitle"\)/);
	assert.match(src, /t\("app\.todoListEmpty"\)/);
	assert.match(src, /t\("app\.todoListAriaLabel"\)/);
	assert.doesNotMatch(src, />No tasks yet</);
	assert.doesNotMatch(src, />To-dos</);
});

test("compact variant is optional, defaults to official classes, and uses PiDeck tokens", () => {
	const src = todoListSource();
	// compact 是可选开关：接口声明 + 默认 false → 不传时官方类/行为完全不变
	assert.match(src, /compact\?: boolean/);
	assert.match(src, /compact = false/);

	// 抽出所有 `compact ? "紧凑类" : "官方类"` 变体对（允许换行，条目/详情为多行三元），逐一校验
	const pairs = [...src.matchAll(/compact\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"/g)];
	assert.ok(pairs.length >= 7, `expected >= 7 compact ternaries, got ${pairs.length}`);

	// 官方默认分支保留官方原始类（h-11 / text-sm / text-xs / min-h-9 等）
	const official = pairs.map(([, , o]) => o).join(" ");
	assert.match(official, /h-11 gap-2\.5 px-3\.5/);
	assert.match(official, /text-sm/);
	assert.match(official, /text-xs/);
	assert.match(official, /min-h-9 gap-2\.5/);
	assert.match(official, /size-3\.5/);

	// compact 分支禁止使用 raw text-sm/text-xs，必须走 PiDeck 语义字号 token
	for (const [, compactCls] of pairs) {
		assert.ok(!/text-(sm|xs)/.test(compactCls), `compact variant must not use raw text-sm/text-xs: "${compactCls}"`);
	}
	const compact = pairs.map(([c]) => c).join(" ");
	assert.match(compact, /text-widget/); // 标题/空态（比徽章小 1px + vw 收缩）
	assert.match(compact, /text-\[length:var\(--text-widget-item\)\]/); // 条目再小一档（默认 10px）
	assert.match(compact, /text-\[length:var\(--text-widget-detail\)\]/); // 详情最小档（默认 9px）
	assert.match(compact, /text-caption/); // 头部完成计数
	assert.match(compact, /h-9 gap-2 pl-3 pr-8/); // 头部收紧 + 宿主关闭按钮预留角
	assert.match(compact, /min-h-8 gap-2/); // 行距收紧
	// 状态图标随 compact 收两档：官方 size-5（20px）→ size-3.5（14px）
	assert.match(src, /compact \? "size-3\.5" : "size-5"/);

	// 动画 / 自动折叠 / 无障碍语义不受 compact 影响
	assert.match(src, /useReducedMotion/);
	assert.match(src, /previousComplete\.current && !allComplete/);
	assert.match(src, /aria-expanded=\{currentOpen\}/);
	// 已完成项无删除线（2026-12 产品取舍，见文件头部适配注释）
	assert.doesNotMatch(src, /scaleX: status === "completed" \? 1 : 0/);
});

test("tailwind-merge keeps widget font sizes next to status colors", () => {
	// 2027-01 回归：裸 tailwind-merge（默认配置）把自定义 text-widget* 误判为颜色类，
	// 与 text-muted-foreground/* 同组冲突而被丢弃——条目曾退回继承 body 14px
	// （用户反馈“字体特别大”的根因）。组件用 text-[length:var(--text-widget-*)]
	// 显式声明字号类型，默认配置下也能归入 font-size 组与颜色共存。
	// #389 起生产 cn() 已在 lib/tailwindMerge.ts 注册项目字号 token，命名形式同样可用
	// （见 tests/uiFontSizeConsistency.test.mjs）；这里保留裸 twMerge 断言以锁定默认配置边界。
	const item = twMerge("min-w-0 flex-1 break-words text-[length:var(--text-widget-item)] text-muted-foreground/65");
	assert.match(item, /text-\[length:var\(--text-widget-item\)\]/);
	assert.match(item, /text-muted-foreground\/65/);
	const detail = twMerge("shrink-0 text-[length:var(--text-widget-detail)] text-muted-foreground/55");
	assert.match(detail, /text-\[length:var\(--text-widget-detail\)\]/);
	assert.match(detail, /text-muted-foreground\/55/);
	// 顺带锁定：裸 text-widget-item 命名形式仍会被吞，禁止改回去
	const legacy = twMerge("text-widget-item text-muted-foreground/65");
	assert.doesNotMatch(legacy, /text-widget-item/);
});

test("widget popover follows wallpaper translucency, items use foreground text", () => {
	// 2027-01 用户要求：todo 弹层背景跟随壁纸透明度——App.tsx 给所有浮层保留 92%+ 底色，
	// widget 弹层单独降回面板档；条目文字用前景色（黑）而非 muted 灰。
	// 注：chat-header 的 widget chips（SessionWidgetChips）已移除（2026-08），
	// 壁纸规则保留给历史样式一致性；待办统一走输入框上方常驻条。
	const css = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	assert.match(css, /:root\[data-bg-image="on"\] \.widget-popover \{[\s\S]*?--color-bg-popover: color-mix\(in srgb, var\(--wallpaper-base, var\(--color-bg-app\)\) var\(--wallpaper-panel-alpha, 30%\), transparent\);/);
	const src = todoListSource();
	// pending 条目文字用前景色（黑）
	assert.match(src, /status === "pending" && "text-foreground"/);
	// 完成/取消保留淡色弱化（☑ 对勾已足够区分完成态）
	assert.match(src, /status === "completed" && "text-muted-foreground\/60"/);
});

test("official sibling helpers exist with required exports", () => {
	const disclosure = source("src/renderer/src/components/agents/agent-disclosure.tsx");
	assert.match(disclosure, /export function AgentDisclosure/);
	assert.match(disclosure, /inert=\{!open\}/);

	const swap = source("src/renderer/src/components/motion/action-swap.tsx");
	assert.match(swap, /export function ActionSwapButton/);
	assert.match(swap, /export function ActionSwapText/);
	assert.match(swap, /export function ActionSwapIcon/);

	const roll = source("src/renderer/src/components/motion/action-swap-roll.tsx");
	assert.match(roll, /export function ActionSwapRollText/);
	assert.match(roll, /animation="roll"/);

	const ease = source("src/renderer/src/lib/ease.ts");
	assert.match(ease, /export const SPRING_SWAP/);
	assert.match(ease, /export const SPRING_PRESS/);
	assert.match(ease, /export const EASE_OUT_CSS/);
});

// 与 sessionWidgetChips.test.mjs 相同的 TSX 编译替身模式：只测公开 parser 行为。
// agentTodoParser.ts 只 import type（编译期擦除），vm 运行时无外部依赖。
function loadParser() {
	return compile(parserPath, {});
}

test("parser maps widget lines to official TodoItem status shape", () => {
	const { parseAgentTodoItems } = loadParser();
	// 旧版 pi-deck-todo 扩展输出（分组标题 + 带 #id 的条目）：parser 保持向后兼容
	const items = parseAgentTodoItems(["── 待办 ──", "☐ #1 修复登录页样式", "◐ #2 重构请求层", "── 已完成 ──", "☑ #3 审查 PR"]);
	assert.equal(items.length, 3);
	assert.equal(items[0].title, "修复登录页样式");
	assert.equal(items[0].status, "pending");
	assert.equal(items[1].title, "重构请求层");
	assert.equal(items[1].status, "in-progress");
	assert.equal(items[2].title, "审查 PR");
	assert.equal(items[2].status, "completed");
});

test("parser skips summaries and keeps pi-deck-todo metadata scoped to its own widget", () => {
	const { parseAgentTodoItems, stripPiDeckTodoWidgetMetadata } = loadParser();
	// Generic parser keeps existing summary compatibility.
	assert.equal(parseAgentTodoItems(["2/4"]).length, 0);
	const plan = parseAgentTodoItems(["计划进度 1/3", "☑ 1. 设计 schema", "☐ 2. 实现迁移"]);
	assert.equal(plan.length, 2);
	const draft = parseAgentTodoItems(["计划草案 2 步", "☐ 1. 设计 schema", "☐ 2. 实现迁移"]);
	assert.equal(draft.length, 2);
	assert.equal(parseAgentTodoItems(["── 待办 ──", "   ", ""]).length, 0);

	// The plan identity is private to pi-deck-todo. Its filter keeps generic / third-party parsing untouched.
	const todoLines = ["[[pid:todo-plan:branch-a:7]]", "☐ #1 实现迁移"];
	assert.deepEqual(stripPiDeckTodoWidgetMetadata(todoLines), ["☐ #1 实现迁移"]);
	assert.equal(parseAgentTodoItems(todoLines)[0].title, "[[pid:todo-plan:branch-a:7]]");
});

test("parser strips todo #ids and plan numbering from titles", () => {
	const { parseAgentTodoItems } = loadParser();
	const todo = parseAgentTodoItems(["☐ #7 写文档"]);
	assert.equal(todo[0].title, "写文档");
	const plan = parseAgentTodoItems(["☐ 12. 发版"]);
	assert.equal(plan[0].title, "发版");
	// 只有标记没有正文的行不产生列表项
	assert.equal(parseAgentTodoItems(["☑"]).length, 0);
});

test("parser preserves insertion order for completed items (2027-01 widget contract)", () => {
	const { parseAgentTodoItems } = loadParser();
	// pi-deck-todo 扩展新输出：无分组标题，按插入顺序带 ☐/☑ 标记，完成项不沉底
	const items = parseAgentTodoItems(["☐ #1 设计 schema", "☑ #2 写文档", "☐ #3 补测试"]);
	// 完成项在原位：顺序与 widget 行一致，不做任何分组重排
	assert.equal(items.length, 3);
	assert.equal(items[0].title, "设计 schema");
	assert.equal(items[0].status, "pending");
	assert.equal(items[1].title, "写文档");
	assert.equal(items[1].status, "completed");
	assert.equal(items[2].title, "补测试");
	assert.equal(items[2].status, "pending");
	assert.equal(items[1].id, "写文档");
});

test("pi-deck-todo extension emits a stable plan identity and in-order item rows", () => {
	const ext = readFileSync("resources/extensions/pi-deck-todo.ts", "utf8");
	const state = readFileSync("resources/extensions/pi-deck-todo-state.ts", "utf8");
	// 完成项原位保留：不再按状态分组沉底，也不再有「最近完成」区段
	assert.doesNotMatch(ext, /── 已完成 ──/);
	assert.doesNotMatch(ext, /── 最近完成 ──/);
	assert.doesNotMatch(ext, /recentlyDone/);
	assert.doesNotMatch(ext, /cleanupCompleted/);
	// 内置 widget 的计划身份进入原始行数组，renderer 可用它区分相同文本的新计划。
	assert.match(ext, /PLAN_METADATA_PREFIX/);
	assert.match(ext, /planMetadataLine\(nonEmptyString\(ctx\.sessionManager\.getLeafId\(\)\), activePlan\.id\)/);
	// 扩展不再输出自有折叠摘要，展开/折叠统一归 renderer 管理。
	assert.doesNotMatch(ext, /widgetCollapsed/);
	// 三态 widget 行由独立状态模块格式化：☑/◐/☐ + #id + text，纯模块不依赖 pi API
	assert.match(state, /formatTodoWidgetLine/);
	assert.match(state, /☑/);
	assert.match(state, /◐/);
	assert.match(state, /formatTodoStatusMarker/);
	assert.doesNotMatch(state, /from "@earendil-works\/pi/);
	assert.doesNotMatch(state, /from "typebox"/);
	// 旧 toggle/done 契约彻底移除：schema/提示词/来源里都不允许出现
	assert.doesNotMatch(ext, /toggle/);
	assert.doesNotMatch(ext, /\.done/);
	// session_start 不再清理已完成项，只有 replace / clear 显式改变计划边界。
	assert.doesNotMatch(ext, /cleanupCompleted\(ctx\)/);
	assert.match(ext, /case "replace"/);
	assert.match(ext, /case "restore"/);
});

test("text-widget token is one step smaller than the session status badge", () => {
	// 2027-01 用户要求：todo 弹层（含外面 chip）字体比右侧会话上下文徽章再小一档
	const css = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
	assert.match(css, /--text-widget: clamp\(9px, 0\.7vw, calc\(var\(--font-size-caption\) - 1px\)\);/);
	assert.match(css, /--text-widget--line-height: var\(--line-height-caption\);/);
	// 条目/详情再分两档：10px / 9px（均低于标题档 11px 与徽章 12px）
	assert.match(css, /--text-widget-item: clamp\(9px, 0\.7vw, calc\(var\(--font-size-caption\) - 2px\)\);/);
	assert.match(css, /--text-widget-detail: clamp\(8px, 0\.6vw, calc\(var\(--font-size-caption\) - 3px\)\);/);
	// 右侧状态徽章字号：surfaces.css .session-status span 用 caption（比 widget 大 1px）
	const surfacesCss = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
	assert.match(surfacesCss, /\.session-status span \{[\s\S]{0,600}font-size: var\(--font-size-caption\)/);
});

test("parser ids are stable across status toggles and line insertions", () => {
	const { parseAgentTodoItems } = loadParser();
	const pending = parseAgentTodoItems(["☐ #1 修复登录页样式", "☐ #2 补测试"]);
	const completed = parseAgentTodoItems(["☑ #1 修复登录页样式", "☐ #2 补测试"]);
	// 状态切换：id 不变（状态图标动画依赖同 key 元素）
	assert.equal(completed[0].id, pending[0].id);
	// 行插入（新任务置顶）：既有项 id 不变
	const inserted = parseAgentTodoItems(["☐ #3 新任务", "☑ #1 修复登录页样式", "☐ #2 补测试"]);
	assert.equal(inserted[1].id, completed[0].id);
	// 同标题消歧：出现两次时第二个 id 带序号，不会 key 冲突
	const dup = parseAgentTodoItems(["☐ 写文档", "☐ 写文档"]);
	assert.notEqual(dup[0].id, dup[1].id);
});

test("sessionTodoSnapshotToItems maps v3 three states and reuses the widget parse path", () => {
	const { sessionTodoSnapshotToItems } = loadParser();
	// vm 编译模块的 plain object 原型属另一 realm，按字段断言（与同文件既有 parser 测试同口径）。
	const items = sessionTodoSnapshotToItems({
		planId: 2,
		todos: [
			{ id: 15, text: "主进程读取", status: "pending" },
			{ id: 22, text: "文件 tab", status: "in_progress" },
			{ id: 26, text: "发版", status: "completed" },
		],
	});
	assert.equal(items.length, 3);
	// 展开成宿主 realm 数组再 deepEqual，避免 vm realm 的原型差异（同文件既有 parser 测试同口径）。
	assert.deepEqual([...items.map((item) => item.title)], ["主进程读取", "文件 tab", "发版"]);
	assert.deepEqual([...items.map((item) => item.status)], ["pending", "in-progress", "completed"]);
	assert.equal(items[0].id, "主进程读取");
	assert.equal(items[1].id, "文件 tab");
	assert.equal(items[2].id, "发版");
});

test("sessionTodoSnapshotToItems: legacy done shape is no longer supported", () => {
	const { sessionTodoSnapshotToItems } = loadParser();
	// 旧 done 布尔形状在解析链最上游整体丢弃：parseTodoSnapshotData 视为无计划返回
	// undefined，转换器收到 undefined 得到空数组（「旧格式视为无计划」）。
	// 不再直接喂原始 done 形状给 sessionTodoSnapshotToItems——那会把旧项渲染成
	// pending，与旧格式视为无计划矛盾，且真实链路（SessionTodoStrip 只接 parse 结果）不可达。
	const parsed = parseTodoSnapshotData({ todos: [{ id: 7, text: "旧任务", done: true }] });
	assert.equal(parsed, undefined);
	assert.deepEqual([...sessionTodoSnapshotToItems(parsed)], []);
});

test("parser is a pure module without runtime imports (import type only)", () => {
	const compiled = ts.transpileModule(source(parserPath), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
			jsx: ts.JsxEmit.ReactJSX,
		},
		fileName: parserPath,
	}).outputText;
	assert.doesNotMatch(compiled, /require\(/);
});
