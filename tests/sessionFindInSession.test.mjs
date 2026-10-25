/**
 * 会话内查找（useSessionMessageSearch）的请求生命周期回归。
 *
 * 这条链路是「输入框 → 160ms 防抖 → sessions:search-in-session → 命中列表 → 上下跳」，
 * 出错形态都很安静：切会话后迟到回包贴到新会话、null（索引未就绪）被当成「没有匹配」、
 * 查询清空后旧命中还留在列表里。这里用确定性 React 宿主 + window.piDesktop 替身钉住这些行为。
 *
 * 读状态前必须 h.render()：宿主把 state 快照进返回值，setState 不触发重渲染。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function hookHarness() {
	const host = quickMessageHookHost();
	const calls = [];
	// IPC 入参是 SessionRecord.id（主进程按 catalog 的后端分派 pi/DSH 检索源），不是会话文件路径。
	const windowStub = {
		piDesktop: {
			sessions: {
				searchInSession: (sessionId, query) => {
					const call = { sessionId, query };
					calls.push(call);
					return new Promise((resolve, reject) => {
						call.resolve = resolve;
						call.reject = reject;
					});
				},
			},
		},
	};
	const { useSessionMessageSearch, SESSION_FIND_DEBOUNCE_MS, SESSION_FIND_MIN_QUERY_LENGTH } = loadTsCommonJs("src/renderer/src/hooks/useSessionMessageSearch.ts", {
		stubs: { react: host.react },
		globals: { window: windowStub },
	});

	let state = null;
	const render = (sessionId, query, enabled = true) => (state = host.render(() => useSessionMessageSearch(sessionId, query, enabled)));
	return { host, calls, render, view: () => state, SESSION_FIND_DEBOUNCE_MS, SESSION_FIND_MIN_QUERY_LENGTH };
}

const HIT = {
	sessions: [{ filePath: "C:/s/a.jsonl", updatedAtMs: 1, matches: [{ messageId: "m1", role: "user", timestampMs: 1, snippet: "alpha 命中" }], hitCount: 1 }],
	totalHitSessions: 1,
	truncated: false,
};

test("输入停顿防抖后按会话 id 发起检索，并落命中结果", async () => {
	const h = hookHarness();
	h.render("s1", "alpha");
	await flush();
	// 防抖期内不发请求，且立刻进入「查找中」
	assert.equal(h.calls.length, 0);
	h.render("s1", "alpha");
	assert.equal(h.view().isSearching, true);
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].sessionId, "s1");
	assert.equal(h.calls[0].query, "alpha");
	h.calls[0].resolve(HIT);
	await flush();
	h.render("s1", "alpha");
	assert.equal(h.view().result.sessions[0].matches[0].messageId, "m1");
	assert.equal(h.view().isSearching, false);
	assert.equal(h.view().unavailable, false);
	h.host.unmount();
});

test("主进程返回 null（pi 索引未就绪 / DSH host 不可用）标为 unavailable，而不是「没有匹配」", async () => {
	const h = hookHarness();
	h.render("s1", "alpha");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	h.calls[0].resolve(null);
	await flush();
	h.render("s1", "alpha");
	assert.equal(h.view().result, null);
	assert.equal(h.view().unavailable, true);
	h.host.unmount();
});

test("切会话后迟到回包被丢弃：上一个会话的命中不会贴到新会话", async () => {
	const h = hookHarness();
	h.render("s1", "alpha");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 1);
	// 切到另一个会话（同一关键词）：新一代请求发出
	h.render("s2", "alpha");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[1].sessionId, "s2");
	// 新的一代先回
	h.calls[1].resolve({ ...HIT, sessions: [{ ...HIT.sessions[0], filePath: "C:/s/b.jsonl", matches: [{ ...HIT.sessions[0].matches[0], messageId: "b1" }] }] });
	await flush();
	h.render("s2", "alpha");
	assert.equal(h.view().result.sessions[0].matches[0].messageId, "b1");
	// 旧一代后回：必须被丢弃
	h.calls[0].resolve(HIT);
	await flush();
	h.render("s2", "alpha");
	assert.equal(h.view().result.sessions[0].matches[0].messageId, "b1");
	h.host.unmount();
});

test("空查询与关闭（enabled=false）都不发请求且清空结果", async () => {
	const h = hookHarness();
	h.render("s1", "");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 0);
	assert.equal(h.view().result, null);
	assert.equal(h.view().isSearching, false);

	h.render("s1", "alpha", false);
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 0, "浮层收起时不检索");
	h.host.unmount();
});

test("请求失败只把状态标为 unavailable，不抛出到渲染层", async () => {
	const h = hookHarness();
	h.render("s1", "alpha");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	h.calls[0].reject(new Error("ipc boom"));
	await flush();
	h.render("s1", "alpha");
	assert.equal(h.view().unavailable, true);
	assert.equal(h.view().isSearching, false);
	h.host.unmount();
});

test("渠道与契约接线：IPC 常量、preload 白名单、主进程 handler、快捷键与装配点齐全", async () => {
	const { readFileSync } = await import("node:fs");
	const read = (path) => readFileSync(path, "utf8");
	const ipc = read("src/shared/ipc.ts");
	assert.match(ipc, /sessionsSearchInSession:\s*"sessions:search-in-session"/);
	const preload = read("src/preload/index.ts");
	// 入参是 SessionRecord.id（不是会话文件路径）：路径/后端身份一律由主进程从 catalog 解析
	assert.match(preload, /searchInSession:\s*\(\s*sessionId: string,\s*query: string\s*\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.sessionsSearchInSession,\s*sessionId,\s*query\s*\)/);
	const handler = read("src/main/ipc/sessionIpc.ts");
	assert.match(handler, /ipcMain\.handle\(ipcChannels\.sessionsSearchInSession/);
	// pi 分支：路径从 catalog 取（渲染层传路径不生效），并再兜一道「像会话文件」的校验
	assert.match(handler, /const\s+entry\s*=\s*sessionCatalog\.get\(sessionId\.trim\(\)\)/);
	assert.match(handler, /import\s*\{\s*isSessionSearchFilePath\s*\}\s*from\s*["']\.\.\/sessions\/sessionSearchPath["']/);
	assert.match(handler, /!isSessionSearchFilePath\(entry\.filePath\)\)\s*return null/);
	assert.match(handler, /trimmed\.length > 256/);
	// DSH 分支：没有 pi JSONL，走 host 历史投影（装配点由 dshBackend 分组注入）
	assert.match(handler, /entry\.backend\s*===\s*"dsh"/);
	assert.match(handler, /searchDshSessionMessages/);
	assert.match(handler, /const\s+searcher\s*=\s*deps\.sessionMessageSearch/);
	// 短路：未装配 / 校验不过一律 null（渲染层据此显示不可用态）
	assert.match(handler, /!searcher\s*\|\|\s*!entry\.filePath\s*\|\|\s*!isSessionSearchFilePath\(entry\.filePath\)\)\s*return null/);
	const wiring = read("src/main/index.ts");
	// 会话内检索的降级口径已抽成模块级 sessionMessageSearchInFile（桌面 IPC 与 Web 搜索弹层共用）：
	// 装配点只转发，真正的 sidecar 调用在 helper 里。
	assert.match(wiring, /sessionMessageSearch: async \(sessionPath, query\) => \{[\s\S]{0,200}?sessionMessageSearchInFile\(sessionPath, query\)/);
	// helper 内先取 sessionIndexService 快照为 service，后续各步都走该局部变量（退出清理置空时不炸）
	assert.match(wiring, /function sessionMessageSearchInFile\(sessionPath: string, query: string\): Promise<SessionSearchResult \| null> \{[\s\S]{0,1200}?service\.searchInSession\(roots, sessionPath, query\)/);
	assert.match(wiring, /searchDshSessionMessages:\s*\(\s*dshSessionId,\s*query\s*\)\s*=>\s*dshAgentManager\.searchSessionMessages\(\s*dshSessionId,\s*query\s*\)/);
	// 主进程快捷键分支 + 聚焦栏响应
	assert.match(wiring, /isShortcutInput\("findInSession", input\)[\s\S]{0,200}?"findInSession"/);
	const shortcuts = read("src/shared/shortcuts.ts");
	assert.match(shortcuts, /id: "findInSession"[\s\S]{0,400}?other: "Ctrl\+Shift\+F"/);
	const pane = read("src/renderer/src/components/session/ChatSessionPane.tsx");
	assert.match(pane, /id !== "findInSession"/);
	assert.match(pane, /<SessionFindOverlay/);
	assert.match(pane, /sessionId=\{sessionId\}/);
	assert.doesNotMatch(pane, /record\?\.filePath \?\? sessionId/);
	// 点击命中必须真的跳得过去：命中 id 是会话文件条目 id（meta.entryId），时间线节点
	// 用的是投影 id，controller 必须先归一（否则查不到 DOM，点击毫无反应——2027-02 用户反馈）。
	assert.match(pane, /onJump=\{\(messageId\) => \{[\s\S]{0,80}?sessionTimeline\.jumpToMessage\(messageId\)/);
	const controller = read("src/renderer/src/hooks/useSessionTimelineController.ts");
	assert.match(controller, /resolveJumpMessageIndex\(combinedMessages, messageId\)/);
	assert.match(controller, /resolveJumpMessageIndex\(combinedMessages, pendingJump\.value\.messageId\)/);
	assert.match(controller, /resolveJumpScrollTarget\(/);
	const jumpTarget = read("src/renderer/src/components/session/timeline/jumpTarget.ts");
	assert.match(jumpTarget, /readEntryId\(message\.meta\) === targetId/);

	// 锚点必须是本栏消息区（时间线视口）：锚整栏聊天区会让图标落到窗口关闭键那一行
	assert.match(pane, /anchorRef=\{sessionTimeline\.timelineRef\}/);
	assert.doesNotMatch(pane, /layoutRefs\.chatPaneRef/);
	// Go 侧协议与单文件过滤
	const goMain = read("native/session-index/main.go");
	assert.match(goMain, /case "search-session":/);
	assert.match(goMain, /empty path/);
	const goSearch = read("native/session-index/search.go");
	assert.match(goSearch, /func \(ix \*Indexer\) SearchInSession\(query, sessionPath string, limit int\) searchResult/);
	assert.match(goSearch, /if e\.fileRef == fileID/);
});

// ── 浮层锚点（纯函数）──────────────────────────────────────────────────
// 历史上的搜索弹框就是「落点算到屏幕外」；这里把换算逻辑从组件里抽出来钉住。

test("浮层锚点：聊天区右侧有抽屉时贴聊天区右缘，而不是视口右缘", async () => {
	const { resolveSessionFindAnchor } = loadTsCommonJs("src/renderer/src/components/session/sessionFindAnchor.ts");
	// 视口 1600，聊天区右缘 1200（右侧抽屉 400），顶 48（顶栏）
	const anchor = resolveSessionFindAnchor({ top: 48, right: 1200, width: 800 }, { width: 1600, height: 900 });
	assert.deepEqual({ ...anchor }, { top: 60, right: 412 });
});

test("浮层锚点：锚点未就绪/宽度为 0 时退回视口右上角下方（永不落到屏幕外或压住窗口控件）", async () => {
	const { resolveSessionFindAnchor, SESSION_FIND_TITLEBAR_MIN_TOP } = loadTsCommonJs("src/renderer/src/components/session/sessionFindAnchor.ts");
	assert.deepEqual({ ...resolveSessionFindAnchor(null, { width: 1200, height: 900 }) }, { top: SESSION_FIND_TITLEBAR_MIN_TOP, right: 12 });
	assert.deepEqual({ ...resolveSessionFindAnchor({ top: 100, right: 800, width: 0 }, { width: 1200, height: 900 }) }, { top: SESSION_FIND_TITLEBAR_MIN_TOP, right: 12 });
});

test("浮层锚点：聊天区顶到窗口上沿时也不落进窗口控件条（关闭键位置）", async () => {
	const { resolveSessionFindAnchor, SESSION_FIND_TITLEBAR_MIN_TOP } = loadTsCommonJs("src/renderer/src/components/session/sessionFindAnchor.ts");
	// 自定义标题栏下聊天区矩形 top=0、右缘=视口宽：旧实现在这里把搜索图标叠到关闭键上
	const anchor = resolveSessionFindAnchor({ top: 0, right: 1600, width: 800 }, { width: 1600, height: 900 });
	assert.equal(anchor.right, 12);
	assert.equal(anchor.top, SESSION_FIND_TITLEBAR_MIN_TOP);
	assert.ok(anchor.top >= 40, "必须落在 40px 高的窗口控件条之下");
});

test("浮层锚点：异常矩形被夹在视口内（负 right / 超出高度都不会出屏）", async () => {
	const { resolveSessionFindAnchor } = loadTsCommonJs("src/renderer/src/components/session/sessionFindAnchor.ts");
	// 锚点右缘超过视口宽（窗口刚缩小的陈旧 rect）→ right 收到底线 12
	assert.equal(resolveSessionFindAnchor({ top: 10, right: 5000, width: 800 }, { width: 1200, height: 900 }).right, 12);
	// 锚点 top 超过视口高 → top 收到 height-12
	assert.equal(resolveSessionFindAnchor({ top: 5000, right: 800, width: 800 }, { width: 1200, height: 900 }).top, 888);
});

// ── 入口渲染（真实组件，portal 到 body）────────────────────────────────
// 浮层自身不带入口：常驻放大镜已移到会话头部工具条（SessionHeader actions，见下方接线用例）。
// 早期把入口浮在消息区右上角——压正文，自定义标题栏下还会落到窗口关闭键位置；不要再搬回去。

test("浮层收起态不渲染任何常驻入口：没有 portal、没有可见按钮", async () => {
	const { createElement } = await import("react");
	const { renderToStaticMarkup } = await import("react-dom/server");
	const portals = [];
	const { SessionFindOverlay } = loadTsCommonJs("src/renderer/src/components/session/SessionFindOverlay.tsx", {
		stubs: {
			"../../i18n": { t: (key) => key },
			"../../hooks/useSessionMessageSearch": { SESSION_FIND_MIN_QUERY_LENGTH: 1, useSessionMessageSearch: () => ({ result: null, isSearching: false, unavailable: false }) },
			"../ui-shadcn/button": { Button: ({ children, ...rest }) => createElement("button", rest, children) },
			"../ui-shadcn/input": { Input: (props) => createElement("input", props) },
			"lucide-react": { Search: () => null, ChevronUp: () => null, ChevronDown: () => null, X: () => null },
			"react-dom": {
				createPortal: (children, container) => {
					portals.push({ children, container });
					return null;
				},
			},
		},
		globals: { window: { innerWidth: 1200, innerHeight: 900, addEventListener: () => undefined, removeEventListener: () => undefined }, document: { body: { tag: "body" } } },
	});
	const markup = renderToStaticMarkup(createElement(SessionFindOverlay, { sessionId: "C:/s/a.jsonl", anchorRef: { current: null }, openSignal: 0, onJump: () => undefined }));
	assert.equal(markup, "", "浮层收起态不渲染按钮（入口在会话头部工具条，不在这里）");
	assert.equal(portals.length, 0, "收起态不应挂任何 portal 节点");
});

// ── 入口（#390：快捷键有反应但找不到按钮）────────────────────────────────
// 常驻放大镜放在会话头部工具条（与运行控制/「⋯」同列），点击写「按会话累加的打开请求」，
// 浮层与快捷键读同一份计数。入口与浮层必须共用 supportsSessionFind，否则会出现
// 「按钮点了没反应」（按钮挂上、浮层没挂）或「DSH 会话挂着永远没有匹配的搜索框」。

test("入口判据：pi 已落盘、DSH 已建 host 会话才支持会话内查找", async () => {
	const { supportsSessionFind } = loadTsCommonJs("src/renderer/src/utils/sessionFindSupport.ts");
	assert.equal(supportsSessionFind(undefined), false);
	// 旧 catalog 记录 backend 缺省 = pi
	assert.equal(supportsSessionFind({ backend: undefined, filePath: "C:/s/a.jsonl" }), true);
	assert.equal(supportsSessionFind({ backend: "pi", filePath: "C:/s/a.jsonl" }), true);
	// DSH 没有 pi JSONL，但有 host 会话历史可查（与 pi 走同一条 IPC，主进程按后端分派）
	assert.equal(supportsSessionFind({ backend: "dsh", dshSessionId: "dsh-1" }), true);
	// DSH 草稿还没建 host 会话：没有可检索内容，不挂入口
	assert.equal(supportsSessionFind({ backend: "dsh", dshSessionId: undefined, filePath: "C:/s/a.jsonl" }), false);
	// ACP/生图没有可检索历史源，挂上去只会永远「没有匹配」
	assert.equal(supportsSessionFind({ backend: "acp", filePath: "C:/s/a.jsonl", acpSessionId: "a1" }), false);
	assert.equal(supportsSessionFind({ backend: "imagegen", filePath: "C:/s/a.jsonl" }), false);
	// pi 草稿还没落盘
	assert.equal(supportsSessionFind({ backend: "pi", filePath: undefined }), false);
});

test("打开请求按会话累加：头部按钮与快捷键写同一份计数，不串会话", async () => {
	const { createStore } = await import("jotai/vanilla");
	const { sessionFindOpenRequestsAtom, requestSessionFindAtom } = loadTsCommonJs("src/renderer/src/atoms/session-find-atoms.ts");
	const store = createStore();
	assert.equal(store.get(sessionFindOpenRequestsAtom).s1, undefined, "初始没有任何请求");
	store.set(requestSessionFindAtom, "s1");
	store.set(requestSessionFindAtom, "s1");
	store.set(requestSessionFindAtom, "s2");
	const state = store.get(sessionFindOpenRequestsAtom);
	assert.equal(state.s1, 2, "同一会话累加（每次点击/按键都是新的一次打开请求）");
	assert.equal(state.s2, 1, "别的会话只加自己的那一格");
});

test("放大镜入口常驻头部工具条：按钮写会话级请求，浮层读同一份计数并共用判据", async () => {
	const { readFileSync } = await import("node:fs");
	const read = (path) => readFileSync(path, "utf8");
	const header = read("src/renderer/src/components/session/SessionHeader.tsx");
	const pane = read("src/renderer/src/components/session/ChatSessionPane.tsx");
	const overlay = read("src/renderer/src/components/session/SessionFindOverlay.tsx");
	const atoms = read("src/renderer/src/atoms/session-find-atoms.ts");
	const atomsIndex = read("src/renderer/src/atoms/index.ts");

	// 判据单点：入口与浮层共用同一纯函数，不在两处各抄一份 backend/filePath 判断
	assert.match(header, /supportsSessionFind\(session\)/);
	assert.match(pane, /supportsSessionFind\(record\)/);
	assert.doesNotMatch(pane, /record\?\.backend === "pi"/);
	// 按钮的语义与无障碍名，并往会话级计数里加一次
	assert.match(header, /aria-label=\{t\("sessionFind\.open"\)\}/);
	assert.match(header, /onClick=\{\(\) => requestSessionFind\(sessionId\)\}/);
	assert.match(header, /import \{[^}]*Search[^}]*\} from "lucide-react"/);
	// 请求计数按会话 id 累加（浮层按会话隔离，切会话不会把上一个会话的框带过去）
	assert.match(atoms, /sessionFindOpenRequestsAtom/);
	assert.match(atoms, /\[sessionId\]: \(current\[sessionId\] \?\? 0\) \+ 1/);
	assert.match(atomsIndex, /export \* from "\.\/session-find-atoms"/);
	assert.match(pane, /useAtomValue\(sessionFindOpenRequestsAtom\)\[sessionId\] \?\? 0/);
	assert.match(pane, /requestSessionFind\(sessionId\)/);
	// 浮层仍然只在展开时 portal，不再自带常驻按钮
	assert.match(overlay, /if \(!open\) return null;/);
});

// ── 弹出时机（2027-02 用户反馈「切换会话搜索框就自己弹出来搜」）─────────────
// openSignal 是「每按一次快捷键就自增」的计数器。它有两处会把按键重放成自动弹出：
// 1) 挂载时把已有的非零值当成一次新请求（浮层重挂、findSupported 从 false 变 true 都会触发）；
// 2) 浮层状态没跟会话绑定，单栏 pane 实例跨会话复用时上一个会话的搜索框和关键词原地留下。
// 下面用确定性 hook 宿主 + 真实组件把这两条钉在行为层。

function overlayHarness() {
	const host = quickMessageHookHost();
	const searchCalls = [];
	const reactStub = { ...host.react, useLayoutEffect: host.react.useEffect };
	const { SessionFindOverlay } = loadTsCommonJs("src/renderer/src/components/session/SessionFindOverlay.tsx", {
		stubs: {
			react: reactStub,
			"../../i18n": { t: (key) => key },
			"../../hooks/useSessionMessageSearch": {
				SESSION_FIND_MIN_QUERY_LENGTH: 1,
				useSessionMessageSearch: (sessionId, query, open) => {
					searchCalls.push({ sessionId, query, open });
					return { result: null, isSearching: false, unavailable: false };
				},
			},
			"../ui-shadcn/button": { Button: ({ children, ...rest }) => rest },
			"../ui-shadcn/input": { Input: (props) => props },
			"lucide-react": { Search: () => null, ChevronUp: () => null, ChevronDown: () => null, X: () => null },
			// 浮层走 portal 到 body：这里直接吐出 children，方便读「收起（null）还是面板已展开」
			"react-dom": { createPortal: (children) => children },
		},
		globals: {
			window: { innerWidth: 1200, innerHeight: 900, addEventListener: () => undefined, removeEventListener: () => undefined },
			document: { body: { tag: "body" } },
		},
	});
	const anchorRef = { current: null };
	// 渲染结果 = 收起态 null / 展开态面板元素（props.role = "dialog"）
	const render = (openSignal, sessionId = "s1") => host.render(() => SessionFindOverlay({ sessionId, anchorRef, openSignal, onJump: () => undefined }));
	return { host, render, searchCalls };
}

test("openSignal 只在变化时弹出：挂载时已有非零值不会把上一次按键重放成自动搜索", async () => {
	const { host, render, searchCalls } = overlayHarness();
	// 上一次按过快捷键（signal=1）后被卸载重挂：必须仍然是收起态（什么都不画）
	let node = render(1);
	assert.equal(node, null, "挂载时不得自动展开面板，也不得有常驻入口");
	assert.equal(searchCalls.at(-1)?.open, false, "收起态不得触发会话内检索");
	// 真正按下快捷键（1 → 2）才展开：宿主在 render 末尾 flush effect，需要再渲染一次读状态
	render(2);
	node = render(2);
	assert.equal(node.props.role, "dialog", "signal 自增应展开面板");
	host.unmount();
});

test("会话内查找浮层按会话隔离：单栏 pane 复用换会话时必须重挂，上一个会话的关键词不会跟过去", async () => {
	const { readFileSync } = await import("node:fs");
	const pane = readFileSync("src/renderer/src/components/session/ChatSessionPane.tsx", "utf8");
	// 单栏分支（App.tsx 的 solo 没有 key）复用同一个 ChatSessionPane 实例：浮层不带 key
	// 就会把 open/query 带到新会话，一切会话就自己搜起来。
	const overlayAt = pane.indexOf("<SessionFindOverlay");
	const keyAt = pane.indexOf("key={sessionId}", overlayAt);
	assert.ok(overlayAt > 0, "ChatSessionPane 仍挂载会话内查找浮层");
	assert.ok(keyAt > overlayAt && keyAt - overlayAt < 400, "浮层必须以 sessionId 为 key 重挂，否则搜索框和关键词会跟到下一个会话");
	// 行为侧：同一个实例里 signal 自增确实会展开（说明重放是真的会发生的），
	// 而新会话 = 新 key = 新实例，从收起态开始、不会立刻对新会话发起检索。
	const { host, render } = overlayHarness();
	render(1);
	render(2);
	assert.equal(render(2).props.role, "dialog");
	host.unmount();
	const fresh = overlayHarness();
	const mountedAtSignalTwo = fresh.render(2, "s2");
	assert.equal(mountedAtSignalTwo, null, "新会话挂载时仍是收起态，不渲染浮层");
	assert.equal(fresh.searchCalls.at(-1)?.open, false, "新会话挂载时不得自动检索");
	fresh.host.unmount();
});
