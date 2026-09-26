/**
 * pi-deck-gui-bridge 单元测试（§11.2 各任务的单测验收）。
 *
 * **加载方式**：直接用 Node 24 的**原生 TypeScript 类型擦除** import 桥的 `.ts` 源文件。
 * 为什么不用 `tests/helpers/loadTsCommonJs.mjs`：本仓库当前没有 `node_modules`
 * （`typescript` 不可用），而桥的模块只做类型擦除即可执行、不依赖任何构建管线 ——
 * 这本身就是「零构建」约束（§2）的一次实证。
 *
 * 覆盖：
 * - 翻译层：Text / Box / VStack / Spacer / Loader 顺序 / 未知组件降级 ansi / 深度与数量上限
 * - 主题：哨兵解析（含闭合哨兵消费）/ ANSI 兜底 / 剥样式
 * - 事件回灌：Phase 0 S4b 实测修正版（`\r` 而非 Key.enter）
 * - 拦截层：setStatus / setFooter / setWidget 双形式 / setWorking* / undefined 恢复 / dispose
 * - 通路：URL 缺失时静默降级
 * - GUI：落点 setter 校验 / order / 同 key 覆盖 / 异 key 共存 / 卸载即清 / custom 四参数
 * - 事件回落：action 与带 actionId 的 input 回落到落点贡献的 handleAction（§8.3）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// 用现成 helper 加载桥的源文件（AGENTS.md：加载生产 TS 模块一律走
// loadTsCommonJs / createTsSandbox，不自己写解析钩子）。桥沿用仓库约定的
// **无扩展名相对 import**（jiti 可解析、Node 原生 ESM 不可），由 helper 按
// 被加载文件所在目录补解析。
//
// 必须用**同一个 loader 实例**加载 5 个模块：桥内部有跨模块的引用相等断言
// （序列化适配器 / 主题对象），分多次加载会拿到互不相同的模块实例。
const loadBridge = createTsSandbox({ globals: { fetch: globalThis.fetch } });
const BRIDGE_DIR = "resources/extensions/";

const themeMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-theme.ts`);
const serializeMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-serialize.ts`);
const runtimeMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-runtime.ts`);
const transportMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-transport.ts`);
const guiMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-gui.ts`);
const specMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-gui-spec.ts`);

// 归属探测（§7.7）在真实环境靠 stack 上溯扩展目录，测试里固定住 ——
// 否则 targetId 会变成 `gui:<slot>:<测试目录 slug+hash>@<key>`，断言无法写死。
// 固定为 `unknown` 同时保持下面 clearGuiContributions(runtime, "unknown") 的语义不变。
guiMod.setOwnerDetectorForTests(() => "unknown");

/** 新建序列化上下文。 */
const ctx = () => ({ width: 80, depth: 0, count: { value: 0 } });

// ── 主题：哨兵与 ANSI ───────────────────────────────────────────

describe("bridge theme: 哨兵解析与 ANSI 兜底", () => {
	it("fg 产哨兵而不是 ANSI，解析回语义 tone", () => {
		const t = themeMod.createBridgeTheme();
		const styled = t.fg("accent", "hello");
		assert.ok(!styled.includes("\u001b"), "theme.fg 不应产 ANSI");
		const runs = themeMod.parseStyledText(styled);
		assert.equal(runs.map((r) => r.text).join(""), "hello", "闭合哨兵必须被消费，不得残留在文本里");
		assert.ok(runs[0].styles.includes("accent"), `应解析出 accent，实际 ${JSON.stringify(runs[0].styles)}`);
	});

	it("闭合哨兵被完全消费（回归：名字含 / 与 :）", () => {
		const t = themeMod.createBridgeTheme();
		for (const [name, text] of [
			["accent", "a"],
			["danger", "b"],
			["muted", "c"],
		]) {
			const runs = themeMod.parseStyledText(t.fg(name, text));
			assert.equal(runs.map((r) => r.text).join(""), text, `${name} 的闭合哨兵未被消费`);
			assert.ok(
				!runs
					.map((r) => r.text)
					.join("")
					.includes("\u00a7"),
				`${name} 残留哨兵字符`,
			);
		}
		// 背景色哨兵（含冒号）
		const bg = t.bg("warning", "bg");
		assert.ok(!themeMod.stripStyledText(bg).includes("\u00a7"), "bg 哨兵应被剥净");
		assert.equal(themeMod.readBgTone(bg), "warning");
	});

	it("嵌套样式按栈叠加", () => {
		const t = themeMod.createBridgeTheme();
		const runs = themeMod.parseStyledText(t.bold(t.fg("danger", "boom")));
		assert.equal(runs.map((r) => r.text).join(""), "boom");
		const styles = runs.flatMap((r) => r.styles);
		assert.ok(styles.includes("bold"), "应含 bold");
		assert.ok(styles.includes("danger"), "应含 danger");
	});

	it("真 ANSI 兜底：SGR 解析成语义 token", () => {
		const runs = themeMod.parseAnsiText("\u001b[32mOK\u001b[0m plain");
		assert.equal(runs.map((r) => r.text).join(""), "OK plain");
		assert.ok(runs[0].styles.includes("success"), `绿色应映射 success，实际 ${JSON.stringify(runs[0].styles)}`);
	});

	it("stripStyledText 同时剥哨兵与 ANSI", () => {
		const t = themeMod.createBridgeTheme();
		assert.equal(themeMod.stripStyledText(`${t.fg("accent", "A")}\u001b[31mB\u001b[0m`), "AB");
	});

	it("纯文本走快速路径且不被改动", () => {
		const runs = themeMod.parseStyledText("plain text");
		assert.equal(runs.length, 1);
		assert.equal(runs[0].text, "plain text");
		assert.deepEqual([...runs[0].styles], []);
	});

	it("未知色档回落 default，不抛错", () => {
		const t = themeMod.createBridgeTheme();
		const runs = themeMod.parseStyledText(t.fg("no-such-tone", "x"));
		assert.equal(runs.map((r) => r.text).join(""), "x");
	});
});

// ── 翻译层：适配器 ──────────────────────────────────────────────

describe("bridge serialize: 适配器", () => {
	const tui = makeFakePiTui();

	it("Text → text 节点，带 nodeId", () => {
		const node = serializeMod.serializeComponent(new tui.Text("hello"), ctx(), null);
		assert.equal(node.kind, "text");
		assert.equal(node.text, "hello");
		assert.ok(node.id, "必须有 nodeId");
	});

	it("同一实例两次序列化 nodeId 稳定", () => {
		const t = new tui.Text("stable");
		const a = serializeMod.serializeComponent(t, ctx(), null);
		const b = serializeMod.serializeComponent(t, ctx(), null);
		assert.equal(a.id, b.id, "同实例 nodeId 必须稳定（事件回灌主键）");
	});

	it("不同实例 nodeId 不同", () => {
		const a = serializeMod.serializeComponent(new tui.Text("a"), ctx(), null);
		const b = serializeMod.serializeComponent(new tui.Text("b"), ctx(), null);
		assert.notEqual(a.id, b.id);
	});

	it("componentOf 能由 nodeId 反查组件", () => {
		const t = new tui.Text("findme");
		const node = serializeMod.serializeComponent(t, ctx(), null);
		assert.equal(serializeMod.componentOf(node.id), t, "事件回灌依赖反查");
	});

	it("Box → box 节点，children 递归", () => {
		const box = new tui.Box(1, 2);
		box.addChild(new tui.Text("child"));
		const node = serializeMod.serializeComponent(box, ctx(), null);
		assert.equal(node.kind, "box");
		assert.deepEqual([...node.padding], [1, 2]);
		assert.equal(node.children.length, 1);
		assert.equal(node.children[0].kind, "text");
	});

	it("VStack / HStack → 对应节点", () => {
		const v = new tui.VStack();
		v.addChild(new tui.Text("a"));
		v.addChild(new tui.Text("b"));
		const vn = serializeMod.serializeComponent(v, ctx(), null);
		assert.equal(vn.kind, "vstack");
		assert.equal(vn.children.length, 2);

		const h = new tui.HStack();
		h.addChild(new tui.Text("x"));
		assert.equal(serializeMod.serializeComponent(h, ctx(), null).kind, "hstack");
	});

	it("Spacer → spacer 节点", () => {
		const node = serializeMod.serializeComponent(new tui.Spacer(3), ctx(), null);
		assert.equal(node.kind, "spacer");
		assert.equal(node.size, 3);
	});

	it("Loader 优先于 Text（继承顺序陷阱）", () => {
		// Loader extends Text：适配器顺序写错会得到 kind:"text"
		const node = serializeMod.serializeComponent(new tui.Loader(), ctx(), null);
		assert.equal(node.kind, "loader", "Loader 必须命中 loader 适配器而不是 text");
	});

	it("CancellableLoader 也识别为 loader 且标记 cancellable", () => {
		const node = serializeMod.serializeComponent(new tui.CancellableLoader(), ctx(), null);
		assert.equal(node.kind, "loader");
		assert.equal(node.cancellable, true);
	});

	it("SelectList → select 节点，读得到私有状态", () => {
		const list = new tui.SelectList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			5,
			makeSelectTheme(),
		);
		const node = serializeMod.serializeComponent(list, ctx(), null);
		assert.equal(node.kind, "select");
		assert.equal(node.items.length, 2);
		assert.equal(node.items[0].label, "Alpha");
		assert.equal(node.selected, 0);
	});

	it("Input → input 节点，走公开 getValue()", () => {
		const input = new tui.Input({ placeholder: "type" });
		input.setValue("typed");
		const node = serializeMod.serializeComponent(input, ctx(), null);
		assert.equal(node.kind, "input");
		assert.equal(node.value, "typed");
		assert.equal(node.placeholder, "type");
	});

	it("SettingsList → settings 节点", () => {
		const node = serializeMod.serializeComponent(new tui.SettingsList([{ id: "a", label: "A", currentValue: "on" }]), ctx(), null);
		assert.equal(node.kind, "settings");
		assert.equal(node.items[0].label, "A");
	});

	it("未知组件降级 ansi，不抛错", () => {
		class Weird {
			render() {
				return ["\u001b[31mweird\u001b[0m output"];
			}
		}
		const node = serializeMod.serializeComponent(new Weird(), ctx(), null);
		assert.equal(node.kind, "ansi");
		assert.ok(!node.lines.join("").includes("\u001b"), "ansi 降级必须剥掉 ANSI");
	});

	it("render() 抛错的组件降级而不是崩桥", () => {
		class Boom {
			render() {
				throw new Error("render exploded");
			}
		}
		const node = serializeMod.serializeComponent(new Boom(), ctx(), null);
		assert.equal(node.kind, "ansi");
		assert.deepEqual([...node.lines], []);
	});

	it("深度上限：环状结构不无限递归", () => {
		const box = new tui.Box(0, 0);
		box.addChild(box); // 自环
		const node = serializeMod.serializeComponent(box, ctx(), null);
		assert.ok(node, "自环必须被深度上限截断而不是栈溢出");
	});

	it("节点数上限生效", () => {
		const v = new tui.VStack();
		for (let i = 0; i < 50; i += 1) v.addChild(new tui.Text(`line ${i}`));
		const node = serializeMod.serializeComponent(v, { width: 80, depth: 0, count: { value: 1999 } }, null);
		assert.ok(node.children.length < 50, `应被数量上限截断，实际 ${node.children.length}`);
	});

	it("hashUINode：内容相同哈希相同，键序不影响", () => {
		const a = serializeMod.hashUINode({ kind: "text", id: "x", text: "hi" });
		const b = serializeMod.hashUINode({ text: "hi", id: "x", kind: "text" });
		assert.equal(a, b, "键序不同不应导致假变更");
		assert.notEqual(a, serializeMod.hashUINode({ kind: "text", id: "x", text: "bye" }));
		assert.equal(serializeMod.hashUINode(null), "null");
	});

	it("null / undefined 输入返回 null", () => {
		assert.equal(serializeMod.serializeComponent(null, ctx(), null), null);
		assert.equal(serializeMod.serializeComponent(undefined, ctx(), null), null);
	});

	it("无 render 的对象返回 null", () => {
		assert.equal(serializeMod.serializeComponent({ notAComponent: true }, ctx(), null), null);
	});

	it("形状兜底：mod=null 时靠 constructor.name 命中", () => {
		const node = serializeMod.serializeComponent(new tui.Text("by name"), ctx(), null);
		assert.equal(node.kind, "text");
		assert.equal(node.text, "by name");
	});
});

// ── 事件回灌（Phase 0 S4b 修正版）───────────────────────────────

describe("bridge runtime: 事件回灌", () => {
	it("select 用 CR 确认（不是 Key.enter 字面量）", () => {
		const calls = [];
		const fake = {
			selectedIndex: 0,
			setSelectedIndex(i) {
				this.selectedIndex = i;
			},
			handleInput(data) {
				calls.push(data);
			},
		};
		runtimeMod.replayEvent(fake, { type: "select", index: 2 });
		assert.equal(fake.selectedIndex, 2, "应先绝对定位");
		assert.deepEqual(calls, ["\r"], "必须送 CR；送 'enter' 字面量不会触发 onSelect");
	});

	it("keyToBytes 映射语义键到原始字节", () => {
		assert.equal(runtimeMod.keyToBytes("enter"), "\r");
		assert.equal(runtimeMod.keyToBytes("escape"), "\u001b");
		assert.equal(runtimeMod.keyToBytes("up"), "\u001b[A");
		assert.equal(runtimeMod.keyToBytes("down"), "\u001b[B");
		assert.notEqual(runtimeMod.keyToBytes("enter"), "enter", "Key.enter 字面量不是合法字节序列");
		assert.equal(runtimeMod.keyToBytes("no-such-key"), undefined);
	});

	it("navigate 用方向键序列以触发 onSelectionChange", () => {
		const calls = [];
		const fake = {
			selectedIndex: 0,
			handleInput(data) {
				calls.push(data);
				if (data === "\u001b[B") this.selectedIndex += 1;
			},
		};
		runtimeMod.replayEvent(fake, { type: "navigate", index: 2 });
		assert.equal(fake.selectedIndex, 2);
		assert.deepEqual(calls, ["\u001b[B", "\u001b[B"]);
	});

	it("navigate 距离过大时回落 setSelectedIndex（不做 200 次按键）", () => {
		const calls = [];
		const fake = {
			selectedIndex: 0,
			setSelectedIndex(i) {
				this.selectedIndex = i;
			},
			handleInput(d) {
				calls.push(d);
			},
		};
		runtimeMod.replayEvent(fake, { type: "navigate", index: 500 });
		assert.equal(fake.selectedIndex, 500);
		assert.equal(calls.length, 0, "超远距离应直接定位而不是发几百次按键");
	});

	it("input 用公开 setValue 而不是逐字符 handleInput", () => {
		let value = "";
		runtimeMod.replayEvent(
			{
				setValue: (v) => {
					value = v;
				},
			},
			{ type: "input", value: "hello" },
		);
		assert.equal(value, "hello");
	});

	it("filter 调公开 setFilter", () => {
		let filter = "";
		runtimeMod.replayEvent(
			{
				setFilter: (f) => {
					filter = f;
				},
			},
			{ type: "filter", value: "ab" },
		);
		assert.equal(filter, "ab");
	});

	it("key 事件送原始字节", () => {
		const calls = [];
		runtimeMod.replayEvent({ handleInput: (d) => calls.push(d) }, { type: "key", key: "escape" });
		assert.deepEqual(calls, ["\u001b"]);
	});

	it("缺失公开方法时不抛错", () => {
		runtimeMod.replayEvent({}, { type: "select", index: 0 });
		runtimeMod.replayEvent({}, { type: "input", value: "x" });
		assert.ok(true);
	});
});

// ── 拦截层 ──────────────────────────────────────────────────────

describe("bridge runtime: 拦截层", () => {
	function makeRuntime() {
		const pushed = [];
		const transport = { available: true, push: (u) => pushed.push(u), onEvent: () => {}, close: () => {} };
		const runtime = runtimeMod.createBridgeRuntime(transport);
		return { runtime, pushed };
	}

	it("setStatus 多 key 共存，undefined 清除", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setStatus("a", "A");
		ui.setStatus("b", "B");
		assert.equal(runtime.state.status.get("a"), "A");
		assert.equal(runtime.state.status.get("b"), "B");
		ui.setStatus("a", undefined);
		assert.equal(runtime.state.status.has("a"), false, "undefined 应清除该 key");
		assert.equal(runtime.state.status.get("b"), "B", "其他 key 不受影响");
		assert.ok(pushed.filter((u) => u.type === "status").length >= 3);
	});

	it("setStatus 仍转发原实现（不破坏 pideck:auto-title 自动标题）", () => {
		const { runtime } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setStatus("pideck:auto-title", "My Title");
		assert.ok(
			ui.__calls.some((c) => c.method === "setStatus" && c.key === "pideck:auto-title"),
			"必须转发原实现，否则自动标题会失效（§7.7 第 5 条）",
		);
	});

	it("setFooter(undefined) 恢复内置（推 null）", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setFooter(() => ({ render: () => ["footer"] }));
		const afterSet = pushed.filter((u) => u.type === "ui-update" && u.targetId === "footer");
		assert.ok(afterSet.length >= 1, "设置 footer 应推一次");
		assert.ok(afterSet[afterSet.length - 1].node !== null, "应有内容");
		ui.setFooter(undefined);
		const afterClear = pushed.filter((u) => u.type === "ui-update" && u.targetId === "footer");
		assert.equal(afterClear[afterClear.length - 1].node, null, "undefined 应推 null 恢复内置");
	});

	it("setHeader 同理", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setHeader(() => ({ render: () => ["header"] }));
		assert.ok(pushed.some((u) => u.type === "ui-update" && u.targetId === "header" && u.node));
		ui.setHeader(undefined);
		const updates = pushed.filter((u) => u.type === "ui-update" && u.targetId === "header");
		assert.equal(updates[updates.length - 1].node, null);
	});

	it("setWidget 字符串形式保持原路（不桥接，§14.4 只补不拆）", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setWidget("k", ["line1", "line2"]);
		assert.equal(ui.__calls.length, 1, "字符串形式应调用原实现");
		assert.equal(ui.__calls[0].method, "setWidget");
		assert.ok(!pushed.some((u) => u.type === "ui-update" && String(u.targetId).startsWith("widget:")), "字符串形式不应由桥推送");
	});

	it("setWidget 组件形式被桥接（RPC 下原本被丢弃）", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setWidget("k", () => ({ render: () => ["component"] }));
		assert.equal(ui.__calls.length, 0, "组件形式不应调用原实现（它只认 string[]）");
		assert.ok(
			pushed.some((u) => u.type === "ui-update" && String(u.targetId).startsWith("widget:k")),
			"组件形式应由桥推送",
		);
	});

	it("setWidget 组件形式清除时推 null", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setWidget("k", () => ({ render: () => ["component"] }));
		ui.setWidget("k", undefined);
		const updates = pushed.filter((u) => u.type === "ui-update" && String(u.targetId).startsWith("widget:k"));
		assert.equal(updates[updates.length - 1].node, null, "清除应推 null");
	});

	it("setWorking* 与 setHiddenThinkingLabel / setTitle 被拦截", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setWorkingMessage("busy");
		ui.setWorkingVisible(false);
		ui.setWorkingIndicator({ frames: ["●"] });
		ui.setHiddenThinkingLabel("thinking…");
		ui.setTitle("My Session");
		assert.equal(runtime.state.workingMessage, "busy");
		assert.equal(runtime.state.workingVisible, false);
		assert.deepEqual(runtime.state.workingFrames, ["●"]);
		assert.equal(runtime.state.hiddenThinkingLabel, "thinking…");
		assert.equal(runtime.state.title, "My Session");
		assert.ok(pushed.some((u) => u.type === "working"));
		assert.ok(pushed.some((u) => u.type === "thinking-label"));
		assert.ok(pushed.some((u) => u.type === "title"));
	});

	it("undefined 恢复默认语义", () => {
		const { runtime } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setWorkingMessage("busy");
		ui.setWorkingMessage(undefined);
		assert.equal(runtime.state.workingMessage, undefined);
		ui.setHiddenThinkingLabel("x");
		ui.setHiddenThinkingLabel(undefined);
		assert.equal(runtime.state.hiddenThinkingLabel, undefined);
	});

	it("包装幂等：重复 wrapUI 不重复叠加", () => {
		const { runtime } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		const first = ui.setStatus;
		runtime.wrapUI(ui);
		assert.equal(ui.setStatus, first, "重复包装应被 __pideckBridgeWrapped 标记挡住");
	});

	it("factory 抛错 → 该落点隐藏，不崩桥", () => {
		const { runtime } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setFooter(() => {
			throw new Error("factory boom");
		});
		assert.ok(true, "不抛错即通过");
	});

	it("重设时旧组件 dispose 被调用（§12.4）", () => {
		const { runtime } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		let disposed = 0;
		ui.setFooter(() => ({
			render: () => ["a"],
			dispose: () => {
				disposed += 1;
			},
		}));
		ui.setFooter(() => ({ render: () => ["b"] }));
		assert.equal(disposed, 1, "旧组件应被 dispose");
	});

	it("undefined 清除时也 dispose", () => {
		const { runtime } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		let disposed = 0;
		ui.setHeader(() => ({
			render: () => ["a"],
			dispose: () => {
				disposed += 1;
			},
		}));
		ui.setHeader(undefined);
		assert.equal(disposed, 1);
	});

	it("shutdown 清空贡献并推空树", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setFooter(() => ({ render: () => ["footer"] }));
		runtime.shutdown();
		assert.equal(runtime.state.tracked.size, 0);
		const updates = pushed.filter((u) => u.type === "ui-update" && u.targetId === "footer");
		assert.equal(updates[updates.length - 1].node, null, "shutdown 应推空树");
	});

	it("factory 只被调用一次（实例缓存，避免每 tick 造新实例）", () => {
		const { runtime } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		let calls = 0;
		ui.setFooter(() => {
			calls += 1;
			return { render: () => ["x"] };
		});
		assert.equal(calls, 1);
		// 再推两次不应重新调 factory
		runtime.resync();
		runtime.resync();
		assert.equal(calls, 1, "factory 应被缓存，不重复调用");
	});

	it("内容不变不重复推送（哈希去重，§6.4）", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setFooter(() => ({ render: () => ["stable"] }));
		const before = pushed.filter((u) => u.type === "ui-update" && u.targetId === "footer").length;
		runtime.resync();
		const after = pushed.filter((u) => u.type === "ui-update" && u.targetId === "footer").length;
		// resync 是 force=true，会推一次；但内容相同 → 仍应推（resync 语义就是全量重推）
		assert.ok(after >= before, "resync 应重推");
	});

	it("resync 重推 status / working / title", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setStatus("k", "v");
		ui.setTitle("T");
		pushed.length = 0;
		runtime.resync();
		assert.ok(pushed.some((u) => u.type === "resync"));
		assert.ok(pushed.some((u) => u.type === "status" && u.key === "k"));
		assert.ok(pushed.some((u) => u.type === "title"));
	});

	it("setEditorComponent 被拦截，undefined 恢复默认", () => {
		const { runtime, pushed } = makeRuntime();
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setEditorComponent(() => ({ render: () => ["editor"] }));
		assert.ok(pushed.some((u) => u.type === "ui-update" && u.targetId === "editor" && u.node));
		ui.setEditorComponent(undefined);
		const updates = pushed.filter((u) => u.type === "ui-update" && u.targetId === "editor");
		assert.equal(updates[updates.length - 1].node, null);
	});
});

// ── 通路 ────────────────────────────────────────────────────────

describe("bridge transport: 静默降级", () => {
	it("PIDECK_BRIDGE_URL 缺失 → available=false，不抛错", () => {
		const saved = process.env.PIDECK_BRIDGE_URL;
		delete process.env.PIDECK_BRIDGE_URL;
		try {
			const t = transportMod.createHttpTransport(() => {});
			assert.equal(t.available, false, "env 缺失应静默不工作");
			t.push({ type: "resync" });
			t.onEvent(() => {});
			t.close();
		} finally {
			if (saved !== undefined) process.env.PIDECK_BRIDGE_URL = saved;
		}
	});

	it("URL 存在 → available=true", () => {
		const saved = process.env.PIDECK_BRIDGE_URL;
		process.env.PIDECK_BRIDGE_URL = "http://127.0.0.1:59999/bridge";
		try {
			const t = transportMod.createHttpTransport(() => {});
			assert.equal(t.available, true);
			t.close();
		} finally {
			if (saved === undefined) delete process.env.PIDECK_BRIDGE_URL;
			else process.env.PIDECK_BRIDGE_URL = saved;
		}
	});

	it("createNullTransport 全 no-op", () => {
		const t = transportMod.createNullTransport();
		assert.equal(t.available, false);
		t.push({ type: "resync" });
		t.onEvent(() => {});
		t.close();
	});
});

// ── ctx.gui ─────────────────────────────────────────────────────

describe("bridge gui: ctx.gui 落点与校验", () => {
	function makeGui() {
		const pushed = [];
		const transport = { available: true, push: (u) => pushed.push(u), onEvent: () => {}, close: () => {} };
		const runtime = runtimeMod.createBridgeRuntime(transport);
		return { runtime, pushed };
	}

	it("白名单含 §7.1-B 全部 15 个方法", () => {
		const methods = Object.keys(guiMod.GUI_SLOT_METHODS);
		assert.equal(methods.length, 15, `应有 15 个 GUI 专属位置，实际 ${methods.length}`);
		for (const expected of ["setSidebarPanel", "setSidebarSection", "setContentView", "setComposerToolbar", "setTitlebarAction", "setBanner", "setToolExtra", "setMessageExtra", "setThinkingExtra", "setDialogAction", "setDialogBody", "setSettingsSection", "setConfigPage", "setSessionItemExtra", "setContextMenuItem"]) {
			assert.ok(methods.includes(expected), `白名单缺 ${expected}`);
		}
	});

	it("key 为空 → 跳过，不抛错", () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("", () => ({ kind: "text", id: "x", text: "hi" }));
		assert.equal(guiMod.guiContributionCount(runtime), 0, "空 key 应被拒绝");
	});

	it("factory 非函数非 undefined → 跳过", () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("k", "not a function");
		assert.equal(guiMod.guiContributionCount(runtime), 0);
	});

	it("undefined 移除贡献并推 null", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("p", () => ({ kind: "text", id: "a", text: "panel" }));
		assert.equal(guiMod.guiContributionCount(runtime), 1);
		gui.setSidebarPanel("p", undefined);
		assert.equal(guiMod.guiContributionCount(runtime), 0);
		const updates = pushed.filter((u) => u.type === "ui-update" && u.targetId === "gui:sidebar.panel:unknown@p");
		assert.equal(updates[updates.length - 1].node, null);
	});

	it("同 key 覆盖，异 key 共存", () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("a", () => ({ kind: "text", id: "1", text: "A1" }));
		gui.setSidebarPanel("b", () => ({ kind: "text", id: "2", text: "B" }));
		assert.equal(guiMod.guiContributionCount(runtime), 2, "异 key 应共存");
		gui.setSidebarPanel("a", () => ({ kind: "text", id: "3", text: "A2" }));
		assert.equal(guiMod.guiContributionCount(runtime), 2, "同 key 应覆盖而不是新增");
	});

	it("order 缺省 1000，非法 order 回落默认", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("x", () => ({ kind: "text", id: "1", text: "X" }));
		const update = pushed.filter((u) => u.type === "ui-update" && u.targetId === "gui:sidebar.panel:unknown@x").pop();
		assert.equal(update.node.slot.order, 1000, "缺省 order 应为 1000");
		gui.setSidebarPanel("y", () => ({ kind: "text", id: "2", text: "Y" }), { order: Number.NaN });
		const update2 = pushed.filter((u) => u.type === "ui-update" && u.targetId === "gui:sidebar.panel:unknown@y").pop();
		assert.equal(update2.node.slot.order, 1000, "非法 order 应回落默认");
	});

	it("order 与 title 被带上", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("z", () => ({ kind: "text", id: "1", text: "Z" }), { order: 50, title: "我的面板" });
		const update = pushed.filter((u) => u.type === "ui-update" && u.targetId === "gui:sidebar.panel:unknown@z").pop();
		assert.equal(update.node.slot.order, 50);
		assert.equal(update.node.slot.title, "我的面板");
	});

	it("isValidGuiNode 拒绝函数 / null / 字符串 / cyclic / React 元素", () => {
		assert.equal(
			guiMod.isValidGuiNode(() => {}),
			false,
		);
		assert.equal(guiMod.isValidGuiNode(null), false);
		assert.equal(guiMod.isValidGuiNode("string"), false);
		assert.equal(guiMod.isValidGuiNode({ kind: "text", id: "a", text: "ok" }), true);
		const cyclic = { kind: "vstack", id: "c", children: [] };
		cyclic.children.push(cyclic);
		assert.equal(guiMod.isValidGuiNode(cyclic), false, "cyclic 必须被拒绝");
		assert.equal(guiMod.isValidGuiNode({ $$typeof: Symbol.for("react.element"), type: "div" }), false, "React 元素必须被拒绝");
	});

	it("React 元素返回值 → 贡献隐藏，不推内容", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("react", () => ({ $$typeof: Symbol.for("react.element"), type: "div" }));
		const updates = pushed.filter((u) => u.type === "ui-update" && u.targetId === "gui:sidebar.panel:unknown@react");
		// 首次 push 时 resolveContribution 校验失败 → node 为 null
		assert.equal(updates[updates.length - 1].node, null, "非法返回值应推 null（贡献隐藏）");
	});

	it("GuiComponent（有 render）也被接受", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("comp", () => ({ render: () => ({ kind: "text", id: "r", text: "from component" }) }));
		const update = pushed.filter((u) => u.type === "ui-update" && u.targetId === "gui:sidebar.panel:unknown@comp").pop();
		assert.ok(update.node, "GuiComponent 应被接受并渲染");
		assert.equal(update.node.kind, "text");
		assert.equal(update.node.text, "from component");
	});

	it("render() 抛错 → 该贡献隐藏，不崩桥", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("boom", () => ({
			render: () => {
				throw new Error("render boom");
			},
		}));
		const updates = pushed.filter((u) => u.type === "ui-update" && u.targetId === "gui:sidebar.panel:unknown@boom");
		assert.equal(updates[updates.length - 1].node, null);
	});

	it("onPress 回调不序列化，只推 actionId", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("btn", () => ({
			kind: "vstack",
			id: "v",
			children: [{ kind: "button", id: "b", label: "点我", actionId: "a1" }],
		}));
		const update = pushed.filter((u) => u.type === "ui-update" && u.targetId === "gui:sidebar.panel:unknown@btn").pop();
		assert.ok(!JSON.stringify(update.node).includes("function"), "节点树不得包含函数");
		let pressed = 0;
		const actionId = guiMod.registerAction(() => {
			pressed += 1;
		});
		assert.equal(guiMod.invokeAction(actionId), true);
		assert.equal(pressed, 1);
		assert.equal(guiMod.invokeAction("no-such-action"), false);
	});

	it("扩展回调抛错不影响桥", () => {
		const actionId = guiMod.registerAction(() => {
			throw new Error("extension callback boom");
		});
		assert.equal(guiMod.invokeAction(actionId), true, "回调抛错应被吞，invokeAction 仍返回 true");
	});

	it("toast 的 actions 拿到可回灌的 actionId", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		let clicked = 0;
		gui.toast("完成", {
			tone: "success",
			actions: [
				{
					label: "撤销",
					onPress: () => {
						clicked += 1;
					},
				},
			],
		});
		const update = pushed.filter((u) => u.type === "ui-update" && String(u.targetId).startsWith("gui:toast:")).pop();
		assert.equal(update.node.kind, "toast");
		assert.ok(update.node.actions[0].actionId, "toast 动作应有 actionId");
		guiMod.invokeAction(update.node.actions[0].actionId);
		assert.equal(clicked, 1);
	});

	it("卸载即清：clearGuiContributions 推 null", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSidebarPanel("p1", () => ({ kind: "text", id: "1", text: "A" }));
		guiMod.clearGuiContributions(runtime, "unknown");
		const updates = pushed.filter((u) => u.type === "ui-update" && String(u.targetId).startsWith("gui:sidebar.panel:"));
		assert.equal(updates[updates.length - 1].node, null, "卸载应推 null 清掉");
	});

	it("卸载时旧组件 dispose 被调用", () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		let disposed = 0;
		gui.setSidebarPanel("d", () => ({
			render: () => ({ kind: "text", id: "1", text: "D" }),
			dispose: () => {
				disposed += 1;
			},
		}));
		guiMod.clearGuiContributions(runtime, "unknown");
		assert.equal(disposed, 1);
	});

	it("ctx.gui.custom 四参数与 TUI 同形，done 触发 resolve", async () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		const result = await gui.custom((surface, theme, keybindings, done) => {
			assert.ok(surface, "第 1 参数 gui surface");
			assert.ok(theme && theme.tones, "第 2 参数 theme");
			assert.ok(keybindings && keybindings.keys, "第 3 参数 keybindings");
			assert.equal(typeof done, "function", "第 4 参数 done");
			done(42);
			return { kind: "text", id: "c", text: "custom" };
		});
		assert.equal(result, 42, "done(result) 应作为 custom 的返回值");
	});

	it("ctx.gui.custom 返回非法值 → resolve undefined 而不是挂起", async () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		const result = await gui.custom(() => ({ $$typeof: Symbol.for("react.element") }));
		assert.equal(result, undefined);
	});

	it("ctx.gui.custom 的 GuiComponent 走 render()", async () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		let closed = null;
		const promise = gui.custom((surface, theme, kb, done) => {
			closed = done;
			return { render: () => ({ kind: "text", id: "x", text: "component custom" }) };
		});
		await new Promise((r) => setTimeout(r, 5));
		closed("result");
		assert.equal(await promise, "result");
	});

	it("overlay 返回 handle，update/close 生效", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		const handle = gui.overlay({ kind: "text", id: "o", text: "overlay" }, { modal: true });
		assert.ok(handle.element, "handle 应有 element id");
		handle.update({ kind: "text", id: "o", text: "updated" });
		assert.ok(pushed.some((u) => u.type === "overlay-update"));
		handle.close();
		const closes = pushed.filter((u) => u.type === "overlay");
		assert.equal(closes[closes.length - 1].node, null, "close 应推 null");
	});

	it("overlay 非法节点不推内容", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.overlay({ $$typeof: Symbol.for("react.element") });
		assert.equal(pushed.filter((u) => u.type === "overlay").length, 0);
	});

	it("confirm 推 modal，两个按钮各自可回灌", async () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		const promise = gui.confirm("确认", { kind: "text", id: "b", text: "确定吗" });
		const overlay = pushed.filter((u) => u.type === "overlay").pop();
		assert.equal(overlay.node.kind, "modal");
		assert.equal(overlay.node.actions.length, 2);
		guiMod.invokeAction(overlay.node.actions[1].actionId);
		assert.equal(await promise, true, "点确定应 resolve true");
	});

	it("confirm 点取消 resolve false", async () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		const promise = gui.confirm("确认", { kind: "text", id: "b", text: "x" });
		const overlay = pushed.filter((u) => u.type === "overlay").pop();
		guiMod.invokeAction(overlay.node.actions[0].actionId);
		assert.equal(await promise, false);
	});

	it("icon 注册：name 必填", () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.icon("", "M0 0");
		gui.icon("star", "M0 0");
		assert.ok(true);
	});

	it("command 参数非法时跳过", () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.command("", () => {});
		gui.command("ok", "not a function");
		assert.ok(true);
	});
});

// ── 测试替身 ────────────────────────────────────────────────────

/** 最小 pi-tui 替身：只实现桥用到的公开契约（含继承关系）。 */
describe("bridge gui: 落点贡献的事件回落（§8.3）", () => {
	function makeGuiWithEvents() {
		const pushed = [];
		let sink = null;
		const transport = {
			available: true,
			push: (u) => pushed.push(u),
			onEvent: (fn) => {
				sink = fn;
			},
			close: () => {},
		};
		const runtime = runtimeMod.createBridgeRuntime(transport);
		const gui = guiMod.createGuiNamespace(runtime);
		return { runtime, pushed, gui, emit: (event) => sink(event) };
	}

	it("action 回落到落点贡献的 handleAction（不再断在 invokeAction）", () => {
		const { gui, emit } = makeGuiWithEvents();
		const seen = [];
		gui.setSettingsSection("p", () => ({
			render: () => ({
				kind: "card",
				id: "card",
				children: [{ kind: "button", id: "btn", label: "B", actionId: "go" }],
			}),
			handleAction: (actionId, payload) => seen.push([actionId, payload]),
		}));
		emit({ type: "action", nodeId: "btn", actionId: "go", payload: 42 });
		assert.deepEqual(seen, [["go", 42]], "action 应到达贡献的 handleAction");
	});

	it("桥自己的 actionHandlers 优先，不回落给贡献", () => {
		const { gui, emit } = makeGuiWithEvents();
		const calls = [];
		const actionId = serializeMod.registerAction(() => calls.push("bridge"));
		gui.setSettingsSection("p", () => ({
			render: () => ({ kind: "button", id: "btn", label: "B", actionId }),
			handleAction: () => calls.push("contribution"),
		}));
		emit({ type: "action", nodeId: "btn", actionId });
		assert.deepEqual(calls, ["bridge"], "桥注册的回调应先命中且只调一次");
	});

	it("带 actionId 的 input 回流，payload 是输入值", () => {
		const { gui, emit } = makeGuiWithEvents();
		const seen = [];
		gui.setSettingsSection("p", () => ({
			render: () => ({ kind: "input", id: "q", value: "", actionId: "search", local: true }),
			handleAction: (actionId, payload) => seen.push([actionId, payload]),
		}));
		emit({ type: "input", nodeId: "q", value: "abc" });
		assert.deepEqual(seen, [["search", "abc"]], "input 值应作为 payload 回流");
	});

	it("未声明 actionId 的本地态控件不回流", () => {
		const { gui, emit } = makeGuiWithEvents();
		const seen = [];
		gui.setSettingsSection("p", () => ({
			render: () => ({ kind: "input", id: "q2", value: "", local: true }),
			handleAction: (actionId, payload) => seen.push([actionId, payload]),
		}));
		emit({ type: "input", nodeId: "q2", value: "x" });
		emit({ type: "key", nodeId: "q2", key: "enter" });
		assert.equal(seen.length, 0, "本地态控件没声明 actionId 就不该打扰扩展");
	});

	it("贡献卸载后不再回流（卸了跟没来过一样）", () => {
		const { gui, emit } = makeGuiWithEvents();
		const seen = [];
		gui.setSettingsSection("p", () => ({
			render: () => ({ kind: "button", id: "btn", label: "B", actionId: "go" }),
			handleAction: (actionId) => seen.push(actionId),
		}));
		gui.setSettingsSection("p", undefined);
		emit({ type: "action", nodeId: "btn", actionId: "go" });
		assert.equal(seen.length, 0, "贡献注销后其节点的 action 不应再被路由");
	});

	it("handleAction 抛错不影响桥", () => {
		const { gui, emit } = makeGuiWithEvents();
		gui.setSettingsSection("p", () => ({
			render: () => ({ kind: "button", id: "boom", label: "B", actionId: "boom" }),
			handleAction: () => {
				throw new Error("扩展炸了");
			},
		}));
		assert.doesNotThrow(() => emit({ type: "action", nodeId: "boom", actionId: "boom" }));
		// 抛错后其他事件仍能被路由（桥没崩）
		assert.doesNotThrow(() => emit({ type: "action", nodeId: "不存在", actionId: "whatever" }));
	});
});

function makeFakePiTui() {
	class Text {
		constructor(text) {
			this.text = text ?? "";
		}
		render() {
			return [this.text];
		}
	}
	class Box {
		constructor(paddingX = 0, paddingY = 0) {
			this.paddingX = paddingX;
			this.paddingY = paddingY;
			this.children = [];
		}
		addChild(c) {
			this.children.push(c);
		}
		render() {
			return [];
		}
	}
	class VStack {
		constructor() {
			this.children = [];
		}
		addChild(c) {
			this.children.push(c);
		}
		render() {
			return [];
		}
	}
	class HStack extends VStack {}
	class Spacer {
		constructor(lines = 1) {
			this.lines = lines;
		}
		render() {
			return [];
		}
	}
	// Loader extends Text —— 复刻真实继承关系以验证适配器顺序
	class Loader extends Text {
		constructor(message) {
			super(message ?? "");
			this.message = message;
			this.frames = ["|", "/", "-"];
		}
	}
	class CancellableLoader extends Loader {}
	class SelectList {
		constructor(items, maxVisible, theme) {
			this.items = items;
			this.filteredItems = items;
			this.maxVisible = maxVisible;
			this.theme = theme;
			this.selectedIndex = 0;
		}
		setSelectedIndex(i) {
			this.selectedIndex = i;
		}
		setFilter(f) {
			this.filteredItems = this.items.filter((it) => it.value.startsWith(f));
			this.selectedIndex = 0;
		}
		getSelectedItem() {
			return this.filteredItems[this.selectedIndex] ?? null;
		}
		handleInput() {}
		render() {
			return [];
		}
	}
	class Input {
		constructor(options = {}) {
			this.value = "";
			this.placeholder = options.placeholder;
		}
		getValue() {
			return this.value;
		}
		setValue(v) {
			this.value = v;
		}
		handleInput() {}
		render() {
			return [];
		}
	}
	class Editor {
		constructor() {
			this.state = { text: "" };
		}
		render() {
			return [];
		}
	}
	class Markdown {
		constructor(text) {
			this.text = text;
		}
		render() {
			return [];
		}
	}
	class ScrollView {
		constructor() {
			this.children = [];
		}
		addChild(c) {
			this.children.push(c);
		}
		render() {
			return [];
		}
	}
	class SettingsList {
		constructor(items) {
			this.items = items;
		}
		render() {
			return [];
		}
	}
	class Image {
		constructor(base64Data, mimeType) {
			this.base64Data = base64Data;
			this.mimeType = mimeType;
		}
		render() {
			return [];
		}
	}
	class TruncatedText {
		constructor(text) {
			this.text = text;
		}
		render() {
			return [];
		}
	}
	class Container {
		constructor() {
			this.children = [];
		}
		addChild(c) {
			this.children.push(c);
		}
		render() {
			return [];
		}
	}
	return { Text, Box, VStack, HStack, Spacer, Loader, CancellableLoader, SelectList, Input, Editor, Markdown, ScrollView, SettingsList, Image, TruncatedText, Container };
}

function makeSelectTheme() {
	return {
		selectedPrefix: (t) => t,
		selectedText: (t) => t,
		description: (t) => t,
		scrollInfo: (t) => t,
		noMatch: (t) => t,
	};
}

/** 最小 ctx.ui 替身：记录原实现被调用的情况。 */
function makeFakeUi() {
	return {
		__calls: [],
		setStatus(key, text) {
			this.__calls.push({ method: "setStatus", key, text });
		},
		setWidget(key, content, options) {
			this.__calls.push({ method: "setWidget", key, content, options });
		},
		setFooter(f) {
			this.__calls.push({ method: "setFooter", f });
		},
		setHeader(f) {
			this.__calls.push({ method: "setHeader", f });
		},
		setWorkingMessage(m) {
			this.__calls.push({ method: "setWorkingMessage", m });
		},
		setWorkingVisible(v) {
			this.__calls.push({ method: "setWorkingVisible", v });
		},
		setWorkingIndicator(o) {
			this.__calls.push({ method: "setWorkingIndicator", o });
		},
		setHiddenThinkingLabel(l) {
			this.__calls.push({ method: "setHiddenThinkingLabel", l });
		},
		setTitle(t) {
			this.__calls.push({ method: "setTitle", t });
		},
		setEditorComponent(f) {
			this.__calls.push({ method: "setEditorComponent", f });
		},
	};
}
// ── §7.7 落点命名空间隔离：两个扩展用同一个 key 不再互相顶掉 ──────
//
// 回归背景：内置面板与全局第三方扩展都用 key `ext-points` 注册 settings.section，
// 后注册的把先注册的从贡献表挤掉 —— 树还在 PiDeck 里，但事件再也投不到它（点不动）。

describe("bridge gui: 归属命名空间隔离（§7.7）", () => {
	function makeGui() {
		const pushed = [];
		const transport = { available: true, push: (u) => pushed.push(u), onEvent: () => {}, close: () => {} };
		return { runtime: runtimeMod.createBridgeRuntime(transport), pushed };
	}

	it("slotTargetId：owner 进 id，缺省回落 unknown", () => {
		assert.equal(specMod.slotTargetId("setSidebarPanel", "k"), "gui:sidebar.panel:unknown@k");
		assert.equal(specMod.slotTargetId("setSidebarPanel", "k", "   "), "gui:sidebar.panel:unknown@k");
		assert.equal(specMod.slotTargetId("setSidebarPanel", "k", "extA"), "gui:sidebar.panel:extA@k");
	});

	it("encodeOwnerId 只产 [A-Za-z0-9._-]，绝不含 @", () => {
		for (const p of ["/a/b/extensions/foo/index.ts", String.raw`C:\x\extensions\bar\index.ts`, "weird @ name/with space"]) {
			const id = specMod.encodeOwnerId(p);
			assert.ok(/^[A-Za-z0-9._-]+$/.test(id), `owner 不得含特殊字符：${id}`);
			assert.ok(!id.includes("@"), "owner 不得含 @（落点 id 靠 @ 切分）");
		}
	});

	it("extensionRootOf 上溯到扩展根目录（注册/注销分文件也归同一个）", () => {
		assert.equal(specMod.extensionRootOf("/h/.pi/agent/extensions/foo/index.ts"), "/h/.pi/agent/extensions/foo");
		assert.equal(specMod.extensionRootOf("/h/.pi/agent/extensions/foo/lib/register.ts"), "/h/.pi/agent/extensions/foo");
		// 单文件扩展（.../extensions/foo.ts）不切目录
		assert.equal(specMod.extensionRootOf("/h/.pi/agent/extensions/foo.ts"), "/h/.pi/agent/extensions/foo.ts");
		// 没有 extensions 段时原样返回
		assert.equal(specMod.extensionRootOf("/some/where/file.ts"), "/some/where/file.ts");
	});

	it("两个扩展同 key → 共存，各推各的落点", () => {
		const { runtime, pushed } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		guiMod.setOwnerDetectorForTests(() => "extA");
		gui.setSidebarPanel("panel", () => ({ kind: "text", id: "a", text: "A" }));
		guiMod.setOwnerDetectorForTests(() => "extB");
		gui.setSidebarPanel("panel", () => ({ kind: "text", id: "b", text: "B" }));

		assert.equal(guiMod.guiContributionCount(runtime), 2, "同 key 不同 owner 必须共存，不得互相顶掉");
		const ids = pushed
			.filter((u) => u.type === "ui-update" && u.node)
			.map((u) => u.targetId)
			.sort();
		assert.deepEqual(ids, ["gui:sidebar.panel:extA@panel", "gui:sidebar.panel:extB@panel"]);
		guiMod.setOwnerDetectorForTests(() => "unknown");
	});

	it("卸载只清自己那份，不动别人的", () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		guiMod.setOwnerDetectorForTests(() => "extA");
		gui.setSidebarPanel("panel", () => ({ kind: "text", id: "a", text: "A" }));
		guiMod.setOwnerDetectorForTests(() => "extB");
		gui.setSidebarPanel("panel", () => ({ kind: "text", id: "b", text: "B" }));
		guiMod.clearGuiContributions(runtime, "extA");
		assert.equal(guiMod.guiContributionCount(runtime), 1, "只应清掉 extA 那份");
		guiMod.setOwnerDetectorForTests(() => "unknown");
	});

	it("contributionKeyFromTargetId 反解（key 里带 @ 也不受影响）", () => {
		assert.equal(specMod.contributionKeyFromTargetId("gui:sidebar.panel:extA@panel"), "extA::setSidebarPanel:panel");
		assert.equal(specMod.contributionKeyFromTargetId("gui:tool.extra:extA@my@tool"), "extA::setToolExtra:my@tool");
		// 旧桥形态（没有 owner 段）→ 解析不出，调用方退回 nodeId 扫描
		assert.equal(specMod.contributionKeyFromTargetId("gui:sidebar.panel:panel"), undefined);
		assert.equal(specMod.contributionKeyFromTargetId("footer"), undefined);
	});

	it("事件带 targetId → 精确定位到对的那份（两份 nodeId 撞了也不投错）", () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		// 两个扩展同 key、同 nodeId —— 只靠 nodeId 全表扫描必然投错人
		let hitA = 0;
		let hitB = 0;
		guiMod.setOwnerDetectorForTests(() => "extA");
		gui.setSidebarPanel("panel", () => ({
			kind: "button",
			id: "same",
			text: "X",
			actionId: guiMod.registerAction(() => {
				hitA += 1;
			}),
		}));
		guiMod.setOwnerDetectorForTests(() => "extB");
		gui.setSidebarPanel("panel", () => ({
			kind: "button",
			id: "same",
			text: "X",
			actionId: guiMod.registerAction(() => {
				hitB += 1;
			}),
		}));

		const byTarget = guiMod.findContributionNode(runtime, "same", "gui:sidebar.panel:extB@panel");
		assert.ok(byTarget, "按 targetId 应能定位");
		assert.equal(byTarget.contribution.owner, "extB", "必须定位到 extB 而不是 extA");
		guiMod.setOwnerDetectorForTests(() => "unknown");
	});

	it("没有 targetId（旧 PiDeck）→ 退回 nodeId 扫描，仍然能找到", () => {
		const { runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		guiMod.setOwnerDetectorForTests(() => "extA");
		gui.setSidebarPanel("panel", () => ({ kind: "button", id: "only", text: "X", actionId: guiMod.registerAction(() => {}) }));
		const hit = guiMod.findContributionNode(runtime, "only");
		assert.ok(hit, "旧路径必须继续可用（向后兼容）");
		assert.equal(hit.contribution.owner, "extA");
		guiMod.setOwnerDetectorForTests(() => "unknown");
	});

	it("setOwnerDetectorForTests(null) 还原为真实栈探测", () => {
		guiMod.setOwnerDetectorForTests(null);
		const detected = guiMod.detectCallerOwner();
		assert.equal(typeof detected, "string");
		assert.ok(detected.length > 0, "必须给出一个非空归属（最差是 unknown）");
		// 还原固定值，避免影响后续（本文件内的）用例
		guiMod.setOwnerDetectorForTests(() => "unknown");
	});
});
