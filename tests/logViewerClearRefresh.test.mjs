// 应用日志「删除」后的即时反馈（用户报告：点了删除表格仍停在旧行，只有自己点「刷新」才更新）。
// 组件级行为回归：确认删除 → 主进程清空 → 查看器必须重新查询并渲染新结果，无需手动刷新。
import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const sameDeps = (previous, next) => Boolean(previous && next) && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));

function logEntry(overrides) {
	return { id: overrides.id, time: 1_700_000_000_000, level: "info", scope: "logs", message: "", detail: null, ...overrides };
}

/** 排空微任务队列：「清理全部」串了 4 个 await，纯 Promise.resolve().then 链次数不够，用宏任务兜底。 */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** 收集渲染树里的节点（jsx 替身会把函数组件就地内联，这里只走剩下的宿主元素）。 */
function nodes(view, predicate) {
	if (Array.isArray(view)) return view.flatMap((child) => nodes(child, predicate));
	if (!view || typeof view !== "object") return [];
	return [...(predicate(view) ? [view] : []), ...nodes(view.props?.children, predicate)];
}

/**
 * 「缓存与日志」tab + 应用日志查看器的最小宿主：
 * - 主进程替身记录 listPage 次数，清空后返回新结果（只剩审计行）；
 * - window.setTimeout 改为可手动排空，验证清空后确实排了一次重查；
 * - 函数组件就地内联渲染（LogViewer 由 StorageTab 的 JSX 挂载），hook 序列由 quickMessageHookHost 记录。
 */
function setup() {
	const host = quickMessageHookHost();
	const react = {
		...host.react,
		Fragment: ({ children }) => children,
		// 真实 useMemo 语义：deps 不变必须复用同一个对象。用「每次都对工厂求值」的替身会让 LogViewer 的
		// query/refresh 每次渲染都换身份、effect 每次渲染重跑，于是「清空后是否重查」永远为真，测不出回归。
		useMemo(factory, deps) {
			const ref = host.react.useRef({ deps: null, value: undefined });
			if (!sameDeps(ref.current.deps, deps)) ref.current = { deps, value: factory() };
			return ref.current.value;
		},
	};
	const queries = [];
	let cleared = false;
	const api = {
		logs: {
			clear: async () => {
				cleared = true;
			},
			getSize: async () => 144,
			listPage: async (query) => {
				queries.push(query);
				return cleared ? { entries: [logEntry({ id: "audit", message: "Logs cleared" })], total: 1, page: 0, pageSize: 20, hasMore: false } : { entries: [logEntry({ id: "old-1", message: "old entry one" }), logEntry({ id: "old-2", message: "old entry two" })], total: 2, page: 0, pageSize: 20, hasMore: false };
			},
		},
		// 「清理全部」联动清空的三类：只要可调用即可（本次回归只关心应用日志查看器）
		rpcLogs: { getSize: async () => 0, clear: async () => {} },
		pasteFiles: { getSize: async () => 0, clearAll: async () => {} },
		noticeHistory: { getSize: async () => 0, clear: async () => {} },
	};
	const timers = [];
	const element = (name) => name;
	// 就地内联函数组件：既让 LogViewer 真的被渲染（拿到它自己的 hook 槽位），又不执行 ui-shadcn 替身。
	const jsx = (type, props) => (typeof type === "function" ? type(props) : { type, props });
	const load = createTsSandbox({
		stubs: {
			react,
			"react/jsx-runtime": { jsx, jsxs: jsx, Fragment: ({ children }) => children },
			"lucide-react": { Loader2: element("Loader2") },
			"../../../i18n": { t: (key) => key },
			"../../../desktopApi": { desktopApi: api },
			"../../ui-shadcn/button": { Button: element("Button") },
			"../../ui-shadcn/section-heading": { SectionHeading: ({ children }) => children },
			"../../ui-shadcn/ConfirmDialog": { ConfirmDialog: element("ConfirmDialog") },
			"../../ui-shadcn/input": { Input: element("Input") },
			"../../ui-shadcn/pagination": { Pagination: element("Pagination") },
			"../../ui-shadcn/select": { Select: element("Select"), SelectContent: element("SelectContent"), SelectItem: element("SelectItem"), SelectTrigger: element("SelectTrigger"), SelectValue: element("SelectValue") },
			"../../ui-shadcn/table": { Table: element("Table"), TableBody: element("TableBody"), TableCell: element("TableCell"), TableHead: element("TableHead"), TableHeader: element("TableHeader"), TableRow: element("TableRow") },
			"./SettingRows": { SettingBox: ({ children }) => children, SettingRow: ({ children }) => children },
			"./LogsDateRangePicker": { LogsDateRangePicker: element("LogsDateRangePicker") },
		},
		globals: {
			window: {
				piDesktop: api,
				setTimeout: (callback) => timers.push(callback),
				clearTimeout: () => {},
			},
			// 占用统计的 5s 轮询在测试里不需要真的跑，避免测试进程被计时器拖住
			setInterval: () => 0,
			clearInterval: () => {},
		},
	});
	const { StorageTab } = load("src/renderer/src/components/app/settings/SettingsStorageTab.tsx");
	const render = () => host.render(() => StorageTab({ settings: {}, onChange: () => {} }));
	/** 排空查看器 150ms 防抖重查（window.setTimeout 替身）并结算其 promise */
	async function settle() {
		for (let round = 0; round < 10 && timers.length > 0; round++) {
			const pending = timers.splice(0, timers.length);
			for (const callback of pending) callback();
			await flush();
		}
	}
	return { render, settle, queries, cleanup: () => host.unmount() };
}

/** 走完一次「选中清理按钮 → 确认弹框 → 等查看器重查」的流程，并在每步断言查看器结果。 */
async function clearAndSettle(tab, pickButton) {
	tab.render();
	await tab.settle();

	const before = tab.render();
	assert.equal(tab.queries.length, 1, "首次挂载应查询一次");
	assert.ok(JSON.stringify(before).includes("old entry one"), "清空前应显示既有日志行");

	pickButton(nodes(before, (node) => node.type === "Button")).props.onClick();
	const dialog = nodes(tab.render(), (node) => node.type === "ConfirmDialog")[0];
	assert.ok(dialog, "清空应弹确认框");
	dialog.props.onConfirm();
	await flush();

	tab.render();
	await tab.settle();
	const after = tab.render();

	assert.equal(tab.queries.length, 2, "清空成功后查看器应自动重查一次");
	const text = JSON.stringify(after);
	assert.ok(text.includes("Logs cleared"), "清空后应显示留痕的审计行");
	assert.ok(!text.includes("old entry one"), "清空后不应再显示已删除的日志行");
	tab.cleanup();
}

/** 应用日志管理行：清理按钮在「打开」右侧（同一 tab 里另有清理全部/界面缓存/RPC/粘贴/通知等同名清理按钮）。 */
function appLogsDeleteButton(buttons) {
	const openIndex = buttons.findIndex((node) => node.props?.children === "common.open");
	assert.ok(openIndex >= 0, "应用日志管理行应有「打开」按钮");
	const button = buttons[openIndex + 1];
	assert.equal(button?.props?.children, "settings.storage.clearButton", "「打开」右侧应是红色清理按钮");
	assert.equal(button?.props?.variant, "destructive", "清理按钮应是危险色");
	return button;
}

test("清空应用日志后查看器立刻换新结果，不需要手动刷新", async () => {
	await clearAndSettle(setup(), appLogsDeleteButton);
});

test("「清理全部」同时清空了应用日志，查看器也要当场换新", async () => {
	await clearAndSettle(setup(), (buttons) => {
		const button = buttons.find((node) => node.props?.children === "settings.storage.clearButton");
		assert.ok(button, "顶部应有「清理全部」按钮");
		return button;
	});
});
