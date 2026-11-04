// 会话分组 / Session Groups — PiDeck 宿主插件（v2.1，工作区级）
// 只用 window.pideck 能力面：context / sessions / storage / workbench / onEvent。
// 会话数据只读；分组关系存插件私有 storage，范围是整个工作区（storage 单键 ≤64KB，所以分组与 id 列表分键存）。
// 视觉只用宿主注入的 --color-* / --radius-* / --font-* 等 token（见 useHostPluginView.ts），
// 与 PiDeck 的按钮、输入框、下拉、列表、弹层保持同一套语汇；每个 token 都带兜底值。
"use strict";

const pideck = window.pideck;

/* ---------- 文案（中英两套，跟随 context.locale） ---------- */

const STR = {
	"zh-CN": {
		workspace: "全部项目",
		statsSep: " · ",
		sessionsUnit: "个会话",
		dirsUnit: "个目录",
		groupsUnit: "个分组",
		newGroup: "新建分组",
		createGroup: "新建分组",
		nameLabel: "分组名称",
		groupNamePlaceholder: "分组名称，如「T6 结账流程」",
		createDirsHead: "按目录添加（可选）",
		createHint: "将加入 {n} 个会话（含已在其他分组的）",
		createHintEmpty: "也可以先建空分组，稍后手动添加会话",
		scopeLabel: "目录范围",
		scopeHint: "本组只收这些目录里的会话；勾别的目录的会话会让该目录自动并入范围。",
		editScope: "编辑目录范围",
		editScopeTitle: "编辑「{name}」的目录范围",
		editScopeHint: "收窄范围会移出不在范围内的会话（会话本身不删）。",
		onlyScope: "只看范围",
		showAllDirs: "显示全部目录",
		fillScope: "按目录补齐",
		fillScopeHint: "把范围目录里还没进来的会话全部加进来",
		filled: "已按目录补齐 {n} 个会话",
		fillEmpty: "范围目录里没有新的会话",
		fillNeedScope: "先编辑目录范围：不限目录时不能按目录补齐",
		pruned: "已按目录范围移出 {n} 个会话",
		extendScope: "已把目录「{dir}」并入本组范围",
		selectAll: "全选",
		selectPage: "本页全选",
		clearAll: "清空",
		ungrouped: "未分组",
		addSessions: "添加会话",
		addSessionsTitle: "添加会话到「{name}」",
		rename: "重命名",
		deleteGroup: "删除分组",
		removeSession: "移出分组",
		confirmDelete: "删除分组「{name}」？只删分组，不会删会话；它们在别的分组里的引用也不受影响。",
		delete: "删除",
		cancel: "取消",
		close: "关闭",
		save: "保存",
		create: "创建",
		searchPlaceholder: "搜索会话标题…",
		filterDir: "全部目录",
		empty: "还没有分组",
		emptyHint: "点右上角「新建分组」，可以直接选目录把整个目录的会话收进来。",
		emptyGroup: "空分组，点「添加会话」放会话进来。",
		ungroupedEmpty: "所有会话都已分组",
		noSessions: "工作区还没有已保存的会话。",
		noMatch: "没有匹配的会话",
		clearFilters: "清除筛选",
		justNow: "刚刚",
		minAgo: " 分钟前",
		hourAgo: " 小时前",
		dayAgo: " 天前",
		loadError: "加载会话目录失败：",
		actionError: "操作失败：",
		modalHint: "勾选只加/减本组，会话可以同时在多个分组里",
		untitled: "（无标题）",
		activeNow: "活跃中",
		currentTag: "当前",
		detailTitle: "会话详情",
		fieldDirectory: "所属目录",
		fieldProject: "项目",
		fieldBackend: "后端",
		fieldModel: "模型",
		fieldGroups: "所属分组",
		fieldCreatedAt: "创建时间",
		fieldUpdatedAt: "更新时间",
		fieldStatus: "状态",
		fieldId: "会话 ID",
		statusSaved: "已保存 · 可读历史",
		statusNoHistory: "已保存 · 无历史文件（直接打开即可）",
		noGroup: "未加入任何分组",
		expandAll: "全部展开",
		collapseAll: "全部收起",
		clearSearch: "清空搜索",
		select: "选择",
		selectedUnit: "已选 {n}",
		removeSelected: "移出本组",
		done: "完成",
		changeColor: "换颜色",
		moveUp: "上移",
		moveDown: "下移",
		collapse: "收起",
		expand: "展开",
		unknownDir: "未知目录",
		allProjectsHint: "跨项目会话可同组，点击自动切换项目",
		groupActions: "分组操作",
		pageLabel: "分页",
		pagePrev: "上一页",
		pageNext: "下一页",
		pageCurrent: "第 {page} 页",
		totalItems: "共 {n} 条",
	},
	"en-US": {
		workspace: "All projects",
		statsSep: " · ",
		sessionsUnit: "sessions",
		dirsUnit: "directories",
		groupsUnit: "groups",
		newGroup: "New group",
		createGroup: "New group",
		nameLabel: "Group name",
		groupNamePlaceholder: "Group name, e.g. “T6 checkout flow”",
		createDirsHead: "Add by directory (optional)",
		createHint: "{n} sessions will join (including ones already in other groups)",
		createHintEmpty: "You can also create an empty group and add sessions later",
		scopeLabel: "Directories",
		scopeHint: "This group only takes sessions from these directories; ticking a session elsewhere adds that directory to the scope.",
		editScope: "Edit directories",
		editScopeTitle: "Edit directories of “{name}”",
		editScopeHint: "Narrowing the scope removes sessions outside it (sessions are not deleted).",
		onlyScope: "Scope only",
		showAllDirs: "Show all directories",
		fillScope: "Fill from directories",
		fillScopeHint: "Add every session in the scoped directories that is not here yet",
		filled: "Filled {n} sessions from directories",
		fillEmpty: "No new sessions in the scoped directories",
		fillNeedScope: "Edit the directories first: fill needs a directory scope",
		pruned: "Removed {n} sessions outside the directory scope",
		extendScope: "Added directory “{dir}” to the group scope",
		selectAll: "All",
		selectPage: "Select page",
		clearAll: "None",
		ungrouped: "Ungrouped",
		addSessions: "Add sessions",
		addSessionsTitle: "Add sessions to “{name}”",
		rename: "Rename",
		deleteGroup: "Delete group",
		removeSession: "Remove from group",
		confirmDelete: "Delete group \"{name}\"? Sessions are not deleted; other groups keep their references.",
		delete: "Delete",
		cancel: "Cancel",
		close: "Close",
		save: "Save",
		create: "Create",
		searchPlaceholder: "Search session titles…",
		filterDir: "All directories",
		empty: "No groups yet",
		emptyHint: "Click “New group” and pick directories to pull a whole directory's sessions in at once.",
		emptyGroup: "Empty group. Use “Add sessions” to fill it.",
		ungroupedEmpty: "Every session is in a group",
		noSessions: "No saved sessions in this workspace yet.",
		noMatch: "No matching sessions",
		clearFilters: "Clear filters",
		justNow: "just now",
		minAgo: " min ago",
		hourAgo: " h ago",
		dayAgo: " d ago",
		loadError: "Failed to load session catalog: ",
		actionError: "Action failed: ",
		modalHint: "Checking only adds/removes this group; a session can live in several groups",
		untitled: "(untitled)",
		activeNow: "Active",
		currentTag: "Current",
		detailTitle: "Session details",
		fieldDirectory: "Directory",
		fieldProject: "Project",
		fieldBackend: "Backend",
		fieldModel: "Model",
		fieldGroups: "Groups",
		fieldCreatedAt: "Created",
		fieldUpdatedAt: "Updated",
		fieldStatus: "Status",
		fieldId: "Session ID",
		statusSaved: "Saved · history readable",
		statusNoHistory: "Saved · no history file (opens directly)",
		noGroup: "Not in any group",
		expandAll: "Expand all",
		collapseAll: "Collapse all",
		clearSearch: "Clear search",
		select: "Select",
		selectedUnit: "{n} selected",
		removeSelected: "Remove from group",
		done: "Done",
		changeColor: "Change color",
		moveUp: "Move up",
		moveDown: "Move down",
		collapse: "Collapse",
		expand: "Expand",
		unknownDir: "Unknown directory",
		allProjectsHint: "Sessions from different projects can share a group; clicking switches project",
		groupActions: "Group actions",
		pageLabel: "Pagination",
		pagePrev: "Previous page",
		pageNext: "Next page",
		pageCurrent: "Page {page}",
		totalItems: "{n} items",
	},
};

let L = STR["zh-CN"];

/* ---------- 常量 ---------- */

// v3：分组数据在宿主 store（<userData>/session-groups.json），经 pideck.sessionGroups.* 读写；
// 侧栏分组树消费同一份数据，这里保存后宿主会广播 session-groups:changed，桌面帧自动刷新。
// 折叠态是纯 UI 偏好，改存本机 localStorage，不再进宿主数据。
const COLLAPSE_KEY = "session-groups.collapsed";
const UNGROUPED = "__ungrouped__";
const COLORS = ["blue", "green", "orange", "purple", "red", "cyan"];
// 每页条数：分组卡片里一次铺 20 条（约两屏），再靠页码条翻页；搜索/筛选会重置页码。
const PAGE_SIZE = 20;
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const COLOR_INDEX = new Map(COLORS.map((name, index) => [name, index]));

/* ---------- 状态 ---------- */

const state = {
	projectId: undefined,
	projectName: undefined,
	currentSessionId: undefined,
	scope: "project",
	locale: "zh-CN",
	sessions: new Map(), // id -> HostPluginSession
	groups: [], // { id, name, color, createdAt, ids: [], dirs: [] }：数组顺序即显示顺序；dirs 为空数组 = 不限目录（旧分组默认）
	collapsed: new Set(),
	ready: false,
};

// 瞬时 UI 状态（不持久化）
let filterQuery = "";
let dirFilter = "";
let draggingId = null;
const pages = new Map(); // 分页键（groupId / UNGROUPED）-> 页码（1 基）
const selection = { groupId: null, ids: new Set() };
const modal = { groupId: null, now: new Set(), dirs: new Set(), allDirs: false };
const createDraft = { dirs: new Set(), mode: "create", groupId: null };
let confirmAction = null;

/* ---------- 图标（内联 SVG，lucide 形态；插件不能引外部资源） ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
	"chevron-down": ["m6 9 6 6 6-6"],
	"chevron-up": ["m18 15-6-6-6 6"],
	"chevron-left": ["m15 18-6-6 6-6"],
	"chevron-right": ["m9 18 6-6-6-6"],
	plus: ["M12 5v14", "M5 12h14"],
	check: ["M20 6 9 17l-5-5"],
	x: ["M18 6 6 18", "m6 6 12 12"],
	more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
	folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
	pencil: ["M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497Z", "m15 5 4 4"],
	trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
	rotate: ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"],
	select: ["m9 11 3 3L22 4", "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"],
	info: ["M12 16v-4", "M12 8h.01", "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"],
	layers: [
		"m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
		"m22 12.18-9.17 4.16a2 2 0 0 1-1.66 0L2 12.18",
		"m22 17.18-9.17 4.16a2 2 0 0 1-1.66 0L2 17.18",
	],
};

function icon(name, size = 16) {
	const node = document.createElementNS(SVG_NS, "svg");
	node.setAttribute("viewBox", "0 0 24 24");
	node.setAttribute("width", String(size));
	node.setAttribute("height", String(size));
	node.setAttribute("fill", "none");
	node.setAttribute("stroke", "currentColor");
	node.setAttribute("stroke-width", "1.75");
	node.setAttribute("stroke-linecap", "round");
	node.setAttribute("stroke-linejoin", "round");
	node.setAttribute("aria-hidden", "true");
	node.setAttribute("focusable", "false");
	for (const shape of ICONS[name] || []) {
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("d", shape);
		node.append(path);
	}
	return node;
}

/* ---------- 工具 ---------- */

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = text;
	return node;
}

function iconBtn(name, title, cls) {
	const node = el("button", "icon-btn" + (cls ? " " + cls : ""));
	node.type = "button";
	node.title = title;
	node.setAttribute("aria-label", title);
	node.append(icon(name, 16));
	return node;
}

function textBtn(label, iconName, cls) {
	const node = el("button", cls || "btn");
	node.type = "button";
	if (iconName) node.append(icon(iconName, 14));
	node.append(el("span", "btn-label", label));
	return node;
}

function checkBoxMark() {
	const box = el("span", "check-box");
	box.append(icon("check", 12));
	return box;
}

/** 独立复选框（会话行批量选择）：原生 input 只做可访问性，外观由 .check-box 画。 */
function checkControl(checked, label, onChange) {
	const wrap = el("label", "check");
	const input = el("input", "check-input");
	input.type = "checkbox";
	input.checked = checked;
	input.setAttribute("aria-label", label);
	input.addEventListener("change", () => onChange(input.checked));
	wrap.append(input, checkBoxMark());
	return wrap;
}

/** 整行可点的勾选行（目录 / 会话选择器）：label 包住 input，点行任意位置即切换。 */
function pickerRow(options) {
	const row = el("label", "picker-row" + (options.checked ? " is-checked" : ""));
	const input = el("input", "check-input");
	input.type = "checkbox";
	input.checked = Boolean(options.checked);
	input.addEventListener("change", () => {
		row.classList.toggle("is-checked", input.checked);
		options.onToggle(input.checked);
	});
	row.append(input, checkBoxMark());
	const text = el("div", "picker-text");
	text.append(el("span", "picker-label", options.title));
	if (options.subtitle) text.append(el("span", "picker-meta", options.subtitle));
	row.append(text);
	if (options.full) row.title = options.full;
	return row;
}

function newGroupId() {
	return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function timeOf(value) {
	const t = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(t) ? t : NaN;
}

function isRecentlyActive(session) {
	const t = timeOf(session.updatedAt);
	return Number.isFinite(t) && Date.now() - t <= ACTIVE_WINDOW_MS;
}

// 把宿主下发的主题 token（--color-* / --radius-* / --font-* …）写到 <html> 内联样式上。
// 不能只依赖宿主的 insertCSS 注入：在 webview 完成导航前插入容易丢失，
// 面板就只剩 CSS 缺省色；内联变量优先级最高且随 context.changed 实时刷新。
function applyTokens(tokens) {
	const style = document.documentElement.style;
	if (!tokens || typeof tokens !== "object") return;
	for (const [name, value] of Object.entries(tokens)) {
		if (typeof name !== "string" || typeof value !== "string" || !value) continue;
		style.setProperty(name.startsWith("--") ? name : "--" + name, value);
	}
}

function fmtTime(ts) {
	const t = timeOf(ts);
	if (!Number.isFinite(t)) return "";
	const diff = Date.now() - t;
	if (diff < 60000) return L.justNow;
	if (diff < 3600000) return Math.floor(diff / 60000) + L.minAgo;
	if (diff < 86400000) return Math.floor(diff / 3600000) + L.hourAgo;
	return Math.floor(diff / 86400000) + L.dayAgo;
}

/** 完整时间（到分钟）：分组页里「什么时候聊的」比「几天前」更有用。 */
function fmtClock(ts) {
	const d = new Date(timeOf(ts));
	if (Number.isNaN(d.getTime())) return "";
	const p = (n) => String(n).padStart(2, "0");
	return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** 目录路径中间省略：D:\\project\\java\\T6 -> D:\\…\\java\\T6，够区分又不占满一行。 */
function shortPath(path) {
	if (!path) return "";
	const parts = String(path).split(/[\\/]+/).filter(Boolean);
	if (parts.length <= 3) return path;
	const drive = /^[a-zA-Z]:$/.test(parts[0]) ? parts[0] : "";
	const tail = parts.slice(-2);
	return drive ? drive + "\\…\\" + tail.join("\\") : "…/" + tail.join("/");
}

let statusTimer = null;
function setStatus(msg, isError) {
	const node = $("status");
	if (!node) return;
	if (!msg) {
		node.hidden = true;
		node.textContent = "";
		return;
	}
	node.textContent = msg;
	node.classList.toggle("status-error", Boolean(isError));
	node.hidden = false;
	clearTimeout(statusTimer);
	if (!isError) statusTimer = setTimeout(() => setStatus(null), 2500);
}

function actionError(err) {
	setStatus(L.actionError + (err && err.message ? err.message : String(err)), true);
}

function debounce(fn, ms) {
	let timer = null;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}

/* ---------- 存储（分键 + 串行写） ---------- */

// 宿主 storage 单键 JSON 上限 64KB，且同一时刻只允许 2 个并发请求：
// 所有读写都串行排队，避免 rate-limited 与互相覆盖。
let ioChain = Promise.resolve();
function queue(fn) {
	ioChain = ioChain.then(fn).catch((err) => actionError(err));
	return ioChain;
}

function normalizeIds(value) {
	return Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && id))] : [];
}

/** 组的宿主载荷：与宿主 SessionGroup 契约同构（ids → sessionIds）。 */
function groupPayload(group) {
	return { id: group.id, name: group.name, color: group.color, createdAt: group.createdAt, sessionIds: group.ids, dirs: groupScope(group) };
}

function groupSig(group) {
	return JSON.stringify(groupPayload(group));
}

// 上次成功落盘的签名：diff 出真正变化的组，避免每次折叠/换色都全量写宿主 store。
let persistedSigs = new Map();

function persistGroup(group) {
	const sig = groupSig(group);
	if (persistedSigs.get(group.id) === sig) return Promise.resolve();
	return pideck.sessionGroups
		.save(groupPayload(group))
		.then(() => {
			persistedSigs.set(group.id, sig);
		})
		.catch((err) => {
			persistedSigs.delete(group.id);
			throw err;
		});
}

/** 全量对账：名字/颜色/顺序/折叠可能一次变多处；只写签名变过的组，再落显示顺序与折叠态。 */
function saveMeta() {
	return queue(async () => {
		for (const group of state.groups) await persistGroup(group);
		try {
			localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...state.collapsed]));
		} catch {}
		if (state.groups.length > 0) await pideck.sessionGroups.reorder(state.groups.map((g) => g.id));
	});
}

function saveGroup(group) {
	return queue(() => persistGroup(group));
}

async function loadWorkspaceData() {
	state.groups = [];
	state.collapsed = new Set();
	persistedSigs = new Map();
	// 宿主 store 是唯一数据源（启动时宿主已从插件 v2 私有 storage 一次性迁入）。
	let list = [];
	try {
		list = await pideck.sessionGroups.list();
	} catch {
		list = [];
	}
	for (const item of Array.isArray(list) ? list : []) {
		if (!item || typeof item.id !== "string" || typeof item.name !== "string") continue;
		const group = {
			id: item.id,
			name: item.name,
			color: COLORS.includes(item.color) ? item.color : COLORS[state.groups.length % COLORS.length],
			createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
			dirs: Array.isArray(item.dirs) ? item.dirs.filter((key) => typeof key === "string" && key.length > 0 && key.length <= 200).slice(0, 64) : [],
			ids: normalizeIds(item.sessionIds),
		};
		state.groups.push(group);
		persistedSigs.set(group.id, groupSig(group));
	}
	// 折叠态只在本机：不再随宿主数据走（跨设备同步折叠没有意义）。
	try {
		const raw = localStorage.getItem(COLLAPSE_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === "string") state.collapsed.add(id);
	} catch {}
}

/* ---------- 会话目录 ---------- */

/** 分页拉全工作区会话目录（每页 100；nextOffset 不前进就停，防死循环）。 */
async function loadCatalog() {
	const map = new Map();
	let offset = 0;
	let guard = 0;
	while (guard++ < 5000) {
		const page = await pideck.sessions.list(offset);
		for (const session of page.sessions || []) map.set(session.id, session);
		if (page.nextOffset == null || page.nextOffset === offset) break;
		offset = page.nextOffset;
	}
	state.sessions = map;
}

/** 会话被删/替代后清掉失效引用；分组/折叠集合随之收敛（只写有变化的部分）。 */
function pruneState() {
	let changed = false;
	for (const group of state.groups) {
		const before = group.ids.length;
		group.ids = group.ids.filter((id) => state.sessions.has(id));
		if (group.ids.length !== before) {
			changed = true;
			void saveGroup(group);
		}
	}
	const valid = new Set([UNGROUPED, ...state.groups.map((group) => group.id)]);
	for (const id of [...state.collapsed]) {
		if (!valid.has(id)) {
			state.collapsed.delete(id);
			changed = true;
		}
	}
	if (changed) void saveMeta();
	return changed;
}

async function reloadCatalog() {
	try {
		await loadCatalog();
		pruneState();
		render();
	} catch (err) {
		setStatus(L.loadError + (err && err.message ? err.message : ""), true);
	}
}

const scheduleReload = debounce(() => void reloadCatalog(), 600);

/* ---------- 数据模型 ---------- */

function groupById(id) {
	return state.groups.find((group) => group.id === id) ?? null;
}

function groupsOf(sessionId) {
	return state.groups.filter((group) => group.ids.includes(sessionId));
}

function ungroupedIds() {
	const grouped = new Set();
	for (const group of state.groups) for (const id of group.ids) grouped.add(id);
	return [...state.sessions.keys()].filter((id) => !grouped.has(id));
}

function addToGroup(group, sessionId) {
	if (!group || group.ids.includes(sessionId)) return false;
	group.ids.push(sessionId);
	// 拖进/手工加进来的会话可能不属于现有目录范围：连带把目录并入，避免组内容与范围不一致。
	const session = state.sessions.get(sessionId);
	if (session && extendScope(group, session)) {
		void saveMeta();
		setStatus(L.extendScope.replace("{dir}", scopeLabelOf(dirKeyOf(session))));
	}
	void saveGroup(group);
	return true;
}

function removeFromGroup(group, sessionId) {
	const before = group.ids.length;
	group.ids = group.ids.filter((id) => id !== sessionId);
	if (group.ids.length === before) return false;
	void saveGroup(group);
	return true;
}

function removeFromAll(sessionId) {
	let changed = false;
	for (const group of state.groups) if (removeFromGroup(group, sessionId)) changed = true;
	return changed;
}

/** 会话的目录身份：优先宿主给的目录，退化到项目名（旧目录里没有 directory 字段）。 */
function dirKeyOf(session) {
	if (!session) return "unknown";
	if (session.directory) return session.directory;
	if (session.projectName) return "name:" + session.projectName;
	if (session.projectId) return "project:" + session.projectId;
	return "unknown";
}

function dirLabelOf(key, sample) {
	if (key === "unknown") return L.unknownDir;
	if (key.startsWith("name:")) return key.slice(5);
	if (key.startsWith("project:")) return L.unknownDir;
	return (sample && sample.projectName) || key;
}

/** 目录范围：空数组 = 不限（旧分组与「先建空分组」都走这里）。key 长度上限与宿主契约一致（200）。 */
function groupScope(group) {
	return Array.isArray(group.dirs) ? group.dirs.filter((key) => typeof key === "string" && key.length > 0 && key.length <= 200).slice(0, 64) : [];
}

/** 把会话所在目录并入范围：手工放进来的会话不能让组处于「范围外」的不一致状态。 */
function extendScope(group, session) {
	const key = dirKeyOf(session);
	const scope = groupScope(group);
	if (scope.length === 0 || scope.includes(key)) return false;
	group.dirs = [...scope, key];
	return true;
}

/** 按目录补齐全部分组的范围目录（不动其他分组）。 */
async function fillGroupFromDirs(group) {
	const scope = groupScope(group);
	if (scope.length === 0) {
		setStatus(L.fillNeedScope);
		return;
	}
	const before = group.ids.length;
	for (const entry of dirEntries()) {
		if (!scope.includes(entry.key)) continue;
		for (const id of entry.ids) if (!group.ids.includes(id)) group.ids.push(id);
	}
	const added = group.ids.length - before;
	if (added === 0) {
		setStatus(L.fillEmpty);
		return;
	}
	group.ids = sortByUpdated(group.ids);
	await saveGroup(group);
	setStatus(L.filled.replace("{n}", String(added)));
	render();
}

function scopeLabelOf(key) {
	if (key === "unknown") return L.unknownDir;
	if (key.startsWith("name:")) return key.slice(5);
	if (key.startsWith("project:")) return L.unknownDir;
	return shortPath(key) || key;
}

/** 目录分节：按会话数降序，用来做「按目录添加」和行上的归属说明。 */
function dirEntries(ids) {
	const map = new Map();
	const source = ids ? ids.map((id) => state.sessions.get(id)).filter(Boolean) : [...state.sessions.values()];
	for (const session of source) {
		const key = dirKeyOf(session);
		let entry = map.get(key);
		if (!entry) {
			entry = { key, label: dirLabelOf(key, session), short: shortPath(session.directory) || dirLabelOf(key, session), directory: session.directory || "", projectName: session.projectName, ids: [] };
			map.set(key, entry);
		}
		entry.ids.push(session.id);
	}
	// 同名项目靠路径区分：显示用短路径，完整路径放 title
	return [...map.values()].sort((a, b) => b.ids.length - a.ids.length || a.short.localeCompare(b.short));
}

function matchesFilters(session) {
	if (!session) return false;
	if (dirFilter && dirKeyOf(session) !== dirFilter) return false;
	if (!filterQuery) return true;
	return (session.title || "").toLowerCase().includes(filterQuery);
}

function sortByUpdated(ids) {
	return [...ids].sort((a, b) => {
		const sa = state.sessions.get(a);
		const sb = state.sessions.get(b);
		const ta = timeOf(sa && sa.updatedAt);
		const tb = timeOf(sb && sb.updatedAt);
		if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
		return String(a).localeCompare(String(b));
	});
}

function visibleIds(ids) {
	return sortByUpdated(ids.filter((id) => matchesFilters(state.sessions.get(id))));
}

/* ---------- 分页 ---------- */

function resetPages() {
	pages.clear();
}

/** 取分组当前页并就地收敛（会话被移出后页码可能越界）。 */
function pageInfo(key, total) {
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const page = Math.min(Math.max(pages.get(key) || 1, 1), totalPages);
	pages.set(key, page);
	const start = (page - 1) * PAGE_SIZE;
	return { page, totalPages, start, end: start + PAGE_SIZE };
}

/** 页码窗口（与宿主 Pagination 同策略，窄一档）：首尾常驻 + 当前页两侧各 1 页 + 省略号。 */
function pageWindow(page, totalPages) {
	if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
	const items = [];
	const start = Math.max(1, page - 1);
	const end = Math.min(totalPages, page + 1);
	if (start > 1) {
		items.push(1);
		if (start > 2) items.push("gap");
	}
	for (let index = start; index <= end; index += 1) items.push(index);
	if (end < totalPages) {
		if (end < totalPages - 1) items.push("gap");
		items.push(totalPages);
	}
	return items;
}

function goPage(key, page) {
	pages.set(key, page);
	render();
	// 翻页后把目标卡片滚回顶部：否则从第 1 页底部翻页会停在列表尾部。
	const card = [...$("groups").querySelectorAll(".card")].find((node) => (key === UNGROUPED ? node.classList.contains("card-ungrouped") : node.dataset.groupId === key));
	if (card) card.scrollIntoView({ block: "start" });
}

/** 页码条：左侧总数，右侧上一页 / 页码窗口 / 下一页。只有一页时不渲染。 */
function pager(key, total) {
	const info = pageInfo(key, total);
	const page = info.page;
	const totalPages = info.totalPages;
	if (totalPages <= 1) return null;
	const nav = el("nav", "pager");
	nav.setAttribute("aria-label", L.pageLabel);
	nav.append(el("span", "pager-count", L.totalItems.replace("{n}", String(total))));
	const pagesBox = el("div", "pager-pages");
	const prev = el("button", "pager-btn");
	prev.type = "button";
	prev.disabled = page <= 1;
	prev.title = L.pagePrev;
	prev.setAttribute("aria-label", L.pagePrev);
	prev.append(icon("chevron-left", 14));
	prev.addEventListener("click", () => goPage(key, page - 1));
	pagesBox.append(prev);
	for (const item of pageWindow(page, totalPages)) {
		if (item === "gap") {
			pagesBox.append(el("span", "pager-gap", "…"));
			continue;
		}
		const button = el("button", "pager-btn" + (item === page ? " is-current" : ""), String(item));
		button.type = "button";
		button.setAttribute("aria-label", L.pageCurrent.replace("{page}", String(item)));
		if (item === page) button.setAttribute("aria-current", "page");
		button.addEventListener("click", () => goPage(key, item));
		pagesBox.append(button);
	}
	const next = el("button", "pager-btn");
	next.type = "button";
	next.disabled = page >= totalPages;
	next.title = L.pageNext;
	next.setAttribute("aria-label", L.pageNext);
	next.append(icon("chevron-right", 14));
	next.addEventListener("click", () => goPage(key, page + 1));
	pagesBox.append(next);
	nav.append(pagesBox);
	return nav;
}

/* ---------- 菜单 / 确认弹层 ---------- */

let menuState = null;

function closeMenu(refocus = true) {
	if (!menuState) return false;
	const current = menuState;
	document.removeEventListener("pointerdown", current.onPointerDown, true);
	window.removeEventListener("scroll", current.onScroll, true);
	window.removeEventListener("resize", current.onResize);
	current.anchor.removeAttribute("aria-expanded");
	current.node.remove();
	menuState = null;
	if (refocus && current.anchor.isConnected) current.anchor.focus({ preventScroll: true });
	return true;
}

/**
 * 通用浮层菜单：下拉筛选与分组操作共用。
 * fixed 定位贴住锚点（滚动/缩放即关闭），键盘 ↑↓ Home End Esc 可操作。
 */
function openMenu(anchor, items, options = {}) {
	closeMenu(false);
	const menu = el("div", "menu");
	menu.tabIndex = -1;
	menu.setAttribute("role", options.role || "menu");
	if (options.matchWidth) menu.classList.add("menu-match");
	for (const item of items) {
		if (item.separator) {
			menu.append(el("div", "menu-sep"));
			continue;
		}
		const row = el("button", "menu-item" + (item.danger ? " is-danger" : ""));
		row.type = "button";
		row.disabled = Boolean(item.disabled);
		row.setAttribute("role", options.role === "listbox" ? "option" : "menuitem");
		if (item.hint) row.title = item.hint;
		if (options.role === "listbox") row.setAttribute("aria-selected", item.checked ? "true" : "false");
		if (item.icon) row.append(icon(item.icon, 15));
		row.append(el("span", "menu-label", item.label));
		if (item.checked) row.append(icon("check", 15));
		row.addEventListener("click", () => {
			closeMenu(false);
			item.onSelect();
		});
		menu.append(row);
	}
	document.body.append(menu);
	const rect = anchor.getBoundingClientRect();
	const width = options.matchWidth ? Math.max(rect.width, 160) : Math.max(menu.offsetWidth, options.minWidth || 180);
	if (options.matchWidth) menu.style.width = width + "px";
	const height = menu.offsetHeight;
	let top = rect.bottom + 6;
	if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
	const left = options.align === "start" ? Math.min(rect.left, window.innerWidth - width - 8) : Math.max(8, rect.right - width);
	menu.style.top = top + "px";
	menu.style.left = Math.max(8, left) + "px";
	anchor.setAttribute("aria-expanded", "true");

	const onPointerDown = (event) => {
		if (menu.contains(event.target) || anchor.contains(event.target)) return;
		closeMenu(false);
	};
	// 滚动事件可能在菜单打开之后才投递（例如点击前刚把卡片滚进视口）：
	// 只有锚点真的位移了才关闭，否则会把刚打开的面板误关。
	const onScroll = (event) => {
		if (menu.contains(event.target)) return;
		const now = anchor.getBoundingClientRect();
		if (Math.abs(now.top - rect.top) < 1 && Math.abs(now.left - rect.left) < 1) return;
		closeMenu(false);
	};
	const onResize = () => closeMenu(false);
	// 捕获阶段监听：面板内滚动容器（.groups）不冒泡到 window，必须 capture 才能收到。
	document.addEventListener("pointerdown", onPointerDown, true);
	window.addEventListener("scroll", onScroll, true);
	window.addEventListener("resize", onResize);
	menuState = { node: menu, anchor, onPointerDown, onScroll, onResize };

	menu.addEventListener("keydown", (event) => {
		const buttons = [...menu.querySelectorAll(".menu-item:not(:disabled)")];
		const index = buttons.indexOf(document.activeElement);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			// 方向键在可用条目间循环；焦点若还在菜单容器（无可用项）就从首/尾开始。
			const current = index >= 0 ? index : event.key === "ArrowDown" ? -1 : 0;
			const next = event.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
			buttons[next]?.focus({ preventScroll: true });
		} else if (event.key === "Home") {
			event.preventDefault();
			buttons[0]?.focus({ preventScroll: true });
		} else if (event.key === "End") {
			event.preventDefault();
			buttons[buttons.length - 1]?.focus({ preventScroll: true });
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeMenu();
		} else if (event.key === "Tab") {
			closeMenu(false);
		}
	});
	// 下拉优先聚焦当前选中项（方向键从它继续），操作菜单聚焦第一个可用项；
	// preventScroll 避免聚焦本身把页面滚动、触发 scroll 监听把菜单关掉。
	const initial = options.role === "listbox" ? [...menu.querySelectorAll(".menu-item")].find((node) => node.getAttribute("aria-selected") === "true") : null;
	(initial || menu.querySelector(".menu-item:not(:disabled)") || menu).focus({ preventScroll: true });
}

function openConfirm(options) {
	confirmAction = options.onConfirm;
	$("confirm-title").textContent = options.title;
	$("confirm-text").textContent = options.message;
	$("confirm-ok").textContent = options.confirmLabel || L.delete;
	$("confirm-overlay").hidden = false;
	$("confirm-cancel").focus();
}

function closeConfirm() {
	$("confirm-overlay").hidden = true;
	confirmAction = null;
}

/* ---------- 上下文 / 事件 ---------- */

async function applyContext(context) {
	const previousLocale = state.locale;
	const previousProjectId = state.projectId;
	state.projectId = context.projectId;
	state.projectName = context.projectName;
	state.currentSessionId = context.sessionId;
	state.scope = context.scope === "workspace" ? "workspace" : "project";
	state.locale = context.locale === "en-US" ? "en-US" : "zh-CN";
	L = STR[state.locale];
	// 把主题写到 <html data-theme>，CSS 据此联动兜底色板（token 注入缺失时也不会串色）
	document.documentElement.dataset.theme = context.theme === "light" ? "light" : "dark";
	applyTokens(context.tokens);
	if (!state.ready) {
		await loadWorkspaceData();
		await reloadCatalog();
	} else if (state.scope !== "workspace" && previousProjectId !== state.projectId) {
		// 没拿到工作区范围时退回旧行为：切项目重载（分组数据同一份，不会被覆盖）
		await reloadCatalog();
	}
	render();
}

function handleEvent(event) {
	if (!event || !event.type) return;
	if (event.type === "context.changed") {
		void applyContext(event.context || {}).catch(actionError);
		return;
	}
	if (event.type !== "sessions.changed") return;
	const detail = event.detail || {};
	if (detail.catalogChanged) {
		scheduleReload();
		return;
	}
	if (!detail.sessionId) return;
	// 单条变化（改名/更新/删除）：就地刷新，不必重拉整张目录
	const id = detail.sessionId;
	void pideck.sessions
		.get(id)
		.then((session) => {
			if (session) state.sessions.set(session.id, session);
			else state.sessions.delete(id);
			render();
		})
		.catch(() => scheduleReload());
}

/* ---------- 渲染：静态文本 ---------- */

function renderStaticText() {
	document.documentElement.lang = state.locale;
	const title = $("scope-title");
	title.textContent = state.scope === "workspace" ? L.workspace : state.projectName || L.workspace;
	title.title = L.allProjectsHint;
	$("btn-toggle-all").textContent = anyCollapsed() ? L.expandAll : L.collapseAll;
	const newBtn = $("btn-new");
	newBtn.replaceChildren(icon("plus", 14), document.createTextNode(L.newGroup));
	$("search-input").placeholder = L.searchPlaceholder;
	$("search-input").setAttribute("aria-label", L.searchPlaceholder);
	const clear = $("search-clear");
	clear.title = L.clearSearch;
	clear.setAttribute("aria-label", L.clearSearch);
	if (!clear.firstChild) clear.append(icon("x", 14));
	$("dir-filter-trigger").setAttribute("aria-label", L.filterDir);
	$("create-name-label").textContent = L.nameLabel;
	$("create-name").placeholder = L.groupNamePlaceholder;
	$("create-dirs-head").textContent = createDraft.mode === "edit" ? L.scopeLabel : L.createDirsHead;
	$("create-dirs-all").textContent = L.selectAll;
	$("create-dirs-none").textContent = L.clearAll;
	$("create-note").hidden = createDraft.mode !== "edit";
	$("create-note").textContent = createDraft.mode === "edit" ? L.editScopeHint : "";
	$("create-cancel").textContent = L.cancel;
	$("create-ok").textContent = createDraft.mode === "edit" ? L.save : L.create;
	$("create-close").title = L.close;
	$("create-close").setAttribute("aria-label", L.close);
	$("modal-search").placeholder = L.searchPlaceholder;
	$("modal-search").setAttribute("aria-label", L.searchPlaceholder);
	$("modal-cancel").textContent = L.cancel;
	$("modal-save").textContent = L.save;
	$("modal-close").title = L.close;
	$("modal-close").setAttribute("aria-label", L.close);
	$("info-close").title = L.close;
	$("info-close").setAttribute("aria-label", L.close);
	$("confirm-cancel").textContent = L.cancel;
	for (const id of ["create-close", "modal-close", "info-close"]) {
		const node = $(id);
		if (!node.firstChild) node.append(icon("x", 16));
	}
	$("search-clear").hidden = filterQuery.length === 0;
}

function renderStats() {
	const dirs = dirEntries().length;
	$("scope-stats").textContent = [state.sessions.size + " " + L.sessionsUnit, dirs + " " + L.dirsUnit, state.groups.length + " " + L.groupsUnit].join(L.statsSep);
}

function renderDirFilter() {
	const entries = dirEntries();
	if (dirFilter && !entries.some((entry) => entry.key === dirFilter)) dirFilter = "";
	const root = $("dir-filter");
	root.hidden = entries.length <= 1;
	const current = entries.find((entry) => entry.key === dirFilter);
	$("dir-filter-value").textContent = current ? current.short : L.filterDir;
	$("dir-filter-trigger").title = current ? current.directory || current.label : L.filterDir;
	$("dir-filter-trigger").setAttribute("aria-expanded", menuState && menuState.anchor === $("dir-filter-trigger") ? "true" : "false");
}

function setDirFilter(value) {
	if (dirFilter === value) return;
	dirFilter = value;
	resetPages();
	render();
}

function openDirFilter() {
	const trigger = $("dir-filter-trigger");
	if (menuState && menuState.anchor === trigger) {
		closeMenu();
		return;
	}
	const entries = dirEntries();
	const items = [
		{
			label: L.filterDir + "（" + state.sessions.size + "）",
			checked: dirFilter === "",
			onSelect: () => setDirFilter(""),
		},
	];
	for (const entry of entries) {
		items.push({
			label: entry.short + "（" + entry.ids.length + "）",
			hint: entry.directory || entry.label,
			checked: dirFilter === entry.key,
			onSelect: () => setDirFilter(entry.key),
		});
	}
	openMenu(trigger, items, { role: "listbox", align: "start", matchWidth: true, minWidth: 180 });
}

/* ---------- 渲染：会话行 ---------- */

/** 非 pi 后端才显示徽标（与宿主会话列表一致：pi 是默认运行时，不额外加噪点）。 */
function backendBadge(session) {
	const backend = (session && session.backend) || "pi";
	if (backend === "pi") return null;
	const labels = { dsh: "DSH", acp: "ACP", imagegen: "IMG", videogen: "VID" };
	const label = labels[backend];
	if (!label) return null;
	const media = backend === "imagegen" || backend === "videogen";
	const badge = el("span", "badge" + (media ? " badge-media" : ""), label);
	badge.title = backend;
	badge.setAttribute("data-backend", backend);
	return badge;
}

function sessionRow(sessionId, groupId, inSelection) {
	const session = state.sessions.get(sessionId);
	if (!session) return null;
	const current = sessionId === state.currentSessionId;
	const checked = inSelection && selection.ids.has(sessionId);
	const row = el("div", "row" + (current ? " is-current" : "") + (checked ? " is-checked" : ""));
	row.dataset.sessionId = sessionId;

	if (inSelection) {
		row.append(
			checkControl(checked, session.title || L.untitled, (value) => {
				if (value) selection.ids.add(sessionId);
				else selection.ids.delete(sessionId);
				render();
			}),
		);
	}

	const main = el("div", "row-main");
	main.tabIndex = 0;
	main.setAttribute("role", "button");
	main.setAttribute("aria-label", session.title || L.untitled);

	const line = el("div", "row-line");
	if (isRecentlyActive(session)) {
		const dot = el("span", "active-dot");
		dot.title = L.activeNow;
		line.append(dot);
	}
	const title = el("span", "row-title", session.title || L.untitled);
	title.title = session.title || L.untitled;
	line.append(title);
	if (current) line.append(el("span", "chip chip-current", L.currentTag));
	line.append(el("span", "row-time", fmtClock(session.updatedAt)));
	main.append(line);

	const meta = el("div", "row-line row-meta");
	const badge = backendBadge(session);
	if (badge) meta.append(badge);
	if (session.model) {
		const model = el("span", "row-model", session.model);
		model.title = session.model;
		meta.append(model);
	}
	const dirText = session.directory || session.projectName || L.unknownDir;
	const dir = el("span", "row-dir", shortPath(dirText));
	dir.title = dirText;
	meta.append(dir);
	meta.append(el("span", "row-rel", fmtTime(session.updatedAt)));
	main.append(meta);

	const open = () => {
		if (inSelection) {
			if (selection.ids.has(sessionId)) selection.ids.delete(sessionId);
			else selection.ids.add(sessionId);
			render();
			return;
		}
		void pideck.workbench.navigate(sessionId).catch(actionError);
	};
	main.addEventListener("click", open);
	main.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			open();
		}
	});
	row.append(main);

	const tools = el("div", "row-actions");
	const info = iconBtn("info", L.detailTitle, "action-btn");
	info.addEventListener("click", (event) => {
		event.stopPropagation();
		openInfoModal(sessionId);
	});
	tools.append(info);
	if (groupId) {
		const remove = iconBtn("x", L.removeSession, "action-btn");
		remove.addEventListener("click", (event) => {
			event.stopPropagation();
			const group = groupById(groupId);
			selection.ids.delete(sessionId);
			if (group && removeFromGroup(group, sessionId)) render();
		});
		tools.append(remove);
	}
	row.append(tools);

	row.draggable = true;
	row.addEventListener("dragstart", (event) => {
		draggingId = sessionId;
		if (event.dataTransfer) {
			event.dataTransfer.setData("text/plain", sessionId);
			event.dataTransfer.effectAllowed = "move";
		}
		row.classList.add("is-dragging");
	});
	row.addEventListener("dragend", () => {
		draggingId = null;
		row.classList.remove("is-dragging");
	});
	return row;
}

/* ---------- 渲染：分组卡片 ---------- */

function nextColor(color) {
	const index = COLOR_INDEX.has(color) ? COLOR_INDEX.get(color) : -1;
	return COLORS[(index + 1) % COLORS.length];
}

function toggleGroup(id) {
	if (state.collapsed.has(id)) state.collapsed.delete(id);
	else state.collapsed.add(id);
	void saveMeta();
	render();
}

function moveGroup(index, delta) {
	const target = index + delta;
	if (target < 0 || target >= state.groups.length) return;
	const [group] = state.groups.splice(index, 1);
	state.groups.splice(target, 0, group);
	void saveMeta();
	render();
}

function toggleSelection(groupId) {
	if (selection.groupId === groupId) {
		selection.groupId = null;
		selection.ids.clear();
	} else {
		selection.groupId = groupId;
		selection.ids = new Set();
	}
	render();
}

function beginRename(group, titles) {
	// 不用 window.prompt：Electron 的渲染器不支持 prompt，改名走行内输入。
	const input = el("input", "input rename-input");
	input.type = "text";
	input.value = group.name;
	input.maxLength = 80;
	input.setAttribute("aria-label", L.rename);
	titles.replaceChildren(input);
	input.focus();
	input.select();
	let settled = false;
	const finish = (commit) => {
		if (settled) return;
		settled = true;
		const next = input.value.trim();
		if (commit && next && next !== group.name) {
			group.name = next.slice(0, 80);
			void saveMeta();
		}
		render();
	};
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			finish(true);
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			finish(false);
		}
	});
	input.addEventListener("blur", () => finish(true));
}

/** 删除分组：只删宿主 store 里的这一组，会话本身与别的分组不受影响。 */
function deleteGroup(group) {
	state.groups = state.groups.filter((item) => item.id !== group.id);
	state.collapsed.delete(group.id);
	pages.delete(group.id);
	persistedSigs.delete(group.id);
	if (selection.groupId === group.id) {
		selection.groupId = null;
		selection.ids.clear();
	}
	void queue(() => pideck.sessionGroups.delete(group.id).catch(() => {}));
	void saveMeta();
	render();
}

function groupMenu(group, index, titles, anchor) {
	const scoped = groupScope(group).length > 0;
	openMenu(
		anchor,
		[
			{ label: L.moveUp, icon: "chevron-up", disabled: index === 0, onSelect: () => moveGroup(index, -1) },
			{ label: L.moveDown, icon: "chevron-down", disabled: index === state.groups.length - 1, onSelect: () => moveGroup(index, 1) },
			{ separator: true },
			{ label: L.fillScope, icon: "rotate", hint: L.fillScopeHint, disabled: !scoped, onSelect: () => void fillGroupFromDirs(group) },
			{ label: L.editScope, icon: "folder", onSelect: () => openScopeEditor(group.id) },
			{ label: L.rename, icon: "pencil", onSelect: () => beginRename(group, titles) },
			{ separator: true },
			{
				label: L.deleteGroup,
				icon: "trash",
				danger: true,
				onSelect: () =>
					openConfirm({
						title: L.deleteGroup,
						message: L.confirmDelete.replace("{name}", group.name),
						confirmLabel: L.delete,
						onConfirm: () => deleteGroup(group),
					}),
			},
		],
		{ align: "end", minWidth: 200 },
	);
}

function emptyState(text, actionLabel, onAction, big, hint) {
	const box = el("div", "empty-state" + (big ? "" : " is-compact"));
	if (big) box.append(icon("layers", 22));
	box.append(el("p", "empty-text", text));
	if (hint) box.append(el("p", "empty-hint", hint));
	if (actionLabel) {
		const button = textBtn(actionLabel, null, "btn btn-outline btn-sm");
		button.addEventListener("click", onAction);
		box.append(button);
	}
	return box;
}

function clearFilters() {
	filterQuery = "";
	dirFilter = "";
	$("search-input").value = "";
	$("search-clear").hidden = true;
	resetPages();
	render();
}

function selectionBar(group, pageIds) {
	const bar = el("div", "select-bar");
	bar.append(el("span", "select-count", L.selectedUnit.replace("{n}", String(selection.ids.size))));
	const all = textBtn(L.selectPage, null, "btn btn-ghost btn-xs");
	all.addEventListener("click", () => {
		for (const id of pageIds) selection.ids.add(id);
		render();
	});
	const none = textBtn(L.clearAll, null, "btn btn-ghost btn-xs");
	none.addEventListener("click", () => {
		selection.ids.clear();
		render();
	});
	const remove = textBtn(L.removeSelected, null, "btn btn-danger-ghost btn-xs");
	remove.disabled = selection.ids.size === 0;
	remove.addEventListener("click", () => {
		for (const id of selection.ids) removeFromGroup(group, id);
		selection.groupId = null;
		selection.ids.clear();
		render();
	});
	const done = textBtn(L.done, null, "btn btn-outline btn-xs");
	done.addEventListener("click", () => {
		selection.groupId = null;
		selection.ids.clear();
		render();
	});
	bar.append(all, none, remove, done);
	return bar;
}

function attachDropTarget(node, onDrop) {
	node.addEventListener("dragover", (event) => {
		if (!draggingId) return;
		event.preventDefault();
		node.classList.add("is-drop-target");
	});
	node.addEventListener("dragleave", () => node.classList.remove("is-drop-target"));
	node.addEventListener("drop", (event) => {
		event.preventDefault();
		node.classList.remove("is-drop-target");
		const sessionId = draggingId || (event.dataTransfer ? event.dataTransfer.getData("text/plain") : "");
		draggingId = null;
		if (sessionId && state.sessions.has(sessionId)) onDrop(sessionId);
	});
}

function groupCard(group, index, forceExpand) {
	const collapsed = !forceExpand && state.collapsed.has(group.id);
	const card = el("section", "card" + (collapsed ? " is-collapsed" : ""));
	card.dataset.groupId = group.id;
	card.setAttribute("aria-label", group.name);

	const head = el("div", "card-head");
	const toggle = iconBtn(collapsed ? "chevron-right" : "chevron-down", collapsed ? L.expand : L.collapse, "tool-btn head-toggle");
	toggle.addEventListener("click", () => toggleGroup(group.id));
	head.append(toggle);

	const dotBtn = el("button", "dot-btn");
	dotBtn.type = "button";
	dotBtn.title = L.changeColor;
	dotBtn.setAttribute("aria-label", L.changeColor);
	dotBtn.append(el("span", "dot color-" + group.color));
	dotBtn.addEventListener("click", () => {
		group.color = nextColor(group.color);
		void saveMeta();
		render();
	});
	head.append(dotBtn);

	const titles = el("div", "card-titles");
	const nameRow = el("div", "card-name-row");
	nameRow.append(el("h2", "card-name", group.name));
	const dirs = new Set(group.ids.map((id) => dirKeyOf(state.sessions.get(id))));
	nameRow.append(el("span", "card-meta", group.ids.length + " " + L.sessionsUnit + L.statsSep + dirs.size + " " + L.dirsUnit));
	titles.append(nameRow);
	const scope = groupScope(group);
	if (scope.length > 0) {
		const scopeRow = el("div", "card-scope");
		for (const key of scope.slice(0, 3)) scopeRow.append(el("span", "scope-chip", scopeLabelOf(key)));
		if (scope.length > 3) scopeRow.append(el("span", "scope-chip", "+" + (scope.length - 3)));
		scopeRow.title = L.scopeLabel + ": " + scope.join("\n");
		titles.append(scopeRow);
	} else {
		titles.title = L.scopeHint;
	}
	head.append(titles);

	const tools = el("div", "card-tools");
	const add = textBtn(L.addSessions, "plus", "btn btn-outline btn-sm");
	// 窄窗只留加号图标，文字隐藏后仍要保留可访问名称。
	add.title = L.addSessions;
	add.setAttribute("aria-label", L.addSessions);
	add.addEventListener("click", () => openAddModal(group.id));
	tools.append(add);
	const select = iconBtn("select", L.select, "tool-btn" + (selection.groupId === group.id ? " is-active" : ""));
	select.addEventListener("click", () => toggleSelection(group.id));
	tools.append(select);
	const more = iconBtn("more", L.groupActions, "tool-btn");
	more.setAttribute("aria-haspopup", "menu");
	more.addEventListener("click", () => groupMenu(group, index, titles, more));
	tools.append(more);
	head.append(tools);
	card.append(head);

	attachDropTarget(card, (sessionId) => {
		if (addToGroup(group, sessionId)) render();
	});

	if (collapsed) return card;

	const body = el("div", "card-body");
	const ids = visibleIds(group.ids);
	const info = pageInfo(group.id, ids.length);
	const pageIds = ids.slice(info.start, info.end);
	if (selection.groupId === group.id) body.append(selectionBar(group, pageIds));
	if (ids.length === 0) {
		if (group.ids.length > 0 && (filterQuery || dirFilter)) body.append(emptyState(L.noMatch, L.clearFilters, clearFilters));
		else body.append(emptyState(L.emptyGroup, L.addSessions, () => openAddModal(group.id)));
	} else {
		for (const id of pageIds) {
			const row = sessionRow(id, group.id, selection.groupId === group.id);
			if (row) body.append(row);
		}
		const nav = pager(group.id, ids.length);
		if (nav) body.append(nav);
	}
	card.append(body);
	return card;
}

function ungroupedCard(forceExpand) {
	const collapsed = !forceExpand && state.collapsed.has(UNGROUPED);
	const card = el("section", "card card-ungrouped" + (collapsed ? " is-collapsed" : ""));
	card.setAttribute("aria-label", L.ungrouped);

	const ids = visibleIds(ungroupedIds());
	const head = el("div", "card-head");
	const toggle = iconBtn(collapsed ? "chevron-right" : "chevron-down", collapsed ? L.expand : L.collapse, "tool-btn head-toggle");
	toggle.addEventListener("click", () => toggleGroup(UNGROUPED));
	head.append(toggle, el("span", "dot dot-none"));
	const titles = el("div", "card-titles");
	const nameRow = el("div", "card-name-row");
	nameRow.append(el("h2", "card-name", L.ungrouped));
	const dirs = new Set(ids.map((id) => dirKeyOf(state.sessions.get(id))));
	nameRow.append(el("span", "card-meta", ids.length + " " + L.sessionsUnit + L.statsSep + dirs.size + " " + L.dirsUnit));
	titles.append(nameRow);
	head.append(titles);
	card.append(head);

	attachDropTarget(card, (sessionId) => {
		if (removeFromAll(sessionId)) render();
	});
	if (collapsed) return card;

	const body = el("div", "card-body");
	const info = pageInfo(UNGROUPED, ids.length);
	if (ids.length === 0) {
		const filtering = filterQuery || dirFilter;
		body.append(emptyState(filtering ? L.noMatch : L.ungroupedEmpty, filtering ? L.clearFilters : null, clearFilters));
	} else {
		for (const id of ids.slice(info.start, info.end)) {
			const row = sessionRow(id, null, false);
			if (row) body.append(row);
		}
		const nav = pager(UNGROUPED, ids.length);
		if (nav) body.append(nav);
	}
	card.append(body);
	return card;
}

function anyCollapsed() {
	if (state.collapsed.has(UNGROUPED)) return true;
	return state.groups.some((group) => state.collapsed.has(group.id));
}

function render() {
	if (!state.ready) return;
	closeMenu(false);
	renderStaticText();
	renderStats();
	renderDirFilter();

	const container = $("groups");
	const scrollTop = container.scrollTop;
	container.replaceChildren();
	if (state.sessions.size === 0) {
		container.append(emptyState(L.noSessions, null, null, true));
		container.scrollTop = scrollTop;
		return;
	}

	if (filterQuery || dirFilter) {
		// 过滤时自动展开：结构还在，但有命中的组必须露出来（不写回折叠状态）
		const matched = new Set(visibleIds([...state.sessions.keys()]));
		let any = false;
		state.groups.forEach((group, index) => {
			if (!group.ids.some((id) => matched.has(id))) return;
			any = true;
			container.append(groupCard(group, index, true));
		});
		if (ungroupedIds().some((id) => matched.has(id))) {
			any = true;
			container.append(ungroupedCard(true));
		}
		if (!any) container.append(emptyState(L.noMatch, L.clearFilters, clearFilters, true));
		container.scrollTop = scrollTop;
		return;
	}

	if (state.groups.length === 0) container.append(emptyState(L.empty, L.newGroup, openCreateModal, true, L.emptyHint));
	state.groups.forEach((group, index) => container.append(groupCard(group, index, false)));
	container.append(ungroupedCard(false));
	container.scrollTop = scrollTop;
}

/* ---------- 新建分组弹层（按目录添加） ---------- */

function openCreateModal() {
	createDraft.mode = "create";
	createDraft.groupId = null;
	createDraft.dirs = new Set();
	$("create-name").value = "";
	renderCreateDirs();
	$("create-overlay").hidden = false;
	$("create-name").focus();
}

/** 编辑已有分组的目录范围：收窄时把范围外的会话移出（会话本身不删）。 */
function openScopeEditor(groupId) {
	const group = groupById(groupId);
	if (!group) return;
	createDraft.mode = "edit";
	createDraft.groupId = groupId;
	createDraft.dirs = new Set(groupScope(group));
	$("create-name").value = group.name;
	renderCreateDirs();
	$("create-overlay").hidden = false;
	$("create-name").focus();
}

function closeCreateModal() {
	$("create-overlay").hidden = true;
}

function createSelectedCount() {
	let count = 0;
	for (const entry of dirEntries()) if (createDraft.dirs.has(entry.key)) count += entry.ids.length;
	return count;
}

function renderCreateDirs() {
	const container = $("create-dirs");
	container.replaceChildren();
	container.scrollTop = 0;
	const entries = dirEntries();
	if (entries.length === 0) container.append(el("p", "empty-text", L.noSessions));
	for (const entry of entries) {
		container.append(
			pickerRow({
				checked: createDraft.dirs.has(entry.key),
				title: entry.short,
				subtitle: (entry.projectName || L.unknownDir) + L.statsSep + entry.ids.length + " " + L.sessionsUnit,
				full: entry.directory || entry.label,
				onToggle: (value) => {
					if (value) createDraft.dirs.add(entry.key);
					else createDraft.dirs.delete(entry.key);
					updateCreateHint();
				},
			}),
		);
	}
	updateCreateHint();
}

function updateCreateHint() {
	const count = createSelectedCount();
	$("create-hint").textContent = count > 0 ? L.createHint.replace("{n}", String(count)) : L.createHintEmpty;
	$("create-ok").disabled = !$("create-name").value.trim();
	$("create-note").hidden = createDraft.mode !== "edit";
	$("create-note").textContent = createDraft.mode === "edit" ? L.editScopeHint : "";
	$("create-title").textContent = createDraft.mode === "edit" ? L.editScopeTitle.replace("{name}", $("create-name").value.trim() || L.scopeLabel) : L.createGroup;
}

async function submitCreateModal() {
	const name = $("create-name").value.trim();
	if (!name) {
		$("create-name").focus();
		return;
	}
	const scope = [...createDraft.dirs];

	if (createDraft.mode === "edit") {
		const group = groupById(createDraft.groupId);
		if (!group) {
			closeCreateModal();
			return;
		}
		group.name = name.slice(0, 80);
		group.dirs = scope;
		let removed = 0;
		if (scope.length > 0) {
			const kept = [];
			for (const id of group.ids) {
				const session = state.sessions.get(id);
				if (session && scope.includes(dirKeyOf(session))) kept.push(id);
				else removed += 1;
			}
			group.ids = kept;
		}
		await saveGroup(group);
		await saveMeta();
		closeCreateModal();
		if (removed > 0) setStatus(L.pruned.replace("{n}", String(removed)));
		render();
		return;
	}

	const group = { id: newGroupId(), name: name.slice(0, 80), color: COLORS[state.groups.length % COLORS.length], createdAt: Date.now(), ids: [], dirs: scope };
	if (scope.length > 0) {
		for (const entry of dirEntries()) {
			if (!scope.includes(entry.key)) continue;
			for (const id of entry.ids) if (!group.ids.includes(id)) group.ids.push(id);
		}
		group.ids = sortByUpdated(group.ids);
	}
	state.groups.push(group);
	await saveGroup(group);
	await saveMeta();
	pages.delete(group.id);
	closeCreateModal();
	render();
}

/* ---------- 添加会话弹层（多组归属） ---------- */

function openAddModal(groupId) {
	const group = groupById(groupId);
	if (!group) return;
	modal.groupId = groupId;
	modal.now = new Set(group.ids);
	modal.dirs = new Set(groupScope(group));
	modal.allDirs = false;
	$("modal-title").textContent = L.addSessionsTitle.replace("{name}", group.name);
	$("modal-search").value = "";
	$("overlay").hidden = false;
	renderAddList(true);
	$("modal-search").focus();
}

function closeAddModal() {
	modal.groupId = null;
	modal.now = new Set();
	modal.dirs = new Set();
	modal.allDirs = false;
	$("overlay").hidden = true;
}

/** 勾选不合法（跨范围）时就地把目录并入范围，保证「组内会话 属于 目录范围」。 */
function addToDraft(id) {
	modal.now.add(id);
	if (modal.dirs.size === 0) return false;
	const session = state.sessions.get(id);
	if (!session) return false;
	const key = dirKeyOf(session);
	if (modal.dirs.has(key)) return false;
	modal.dirs.add(key);
	return true;
}

function updateAddHint() {
	$("modal-hint").textContent = L.selectedUnit.replace("{n}", String(modal.now.size)) + L.statsSep + L.modalHint;
}

function renderAddList(resetScroll = false) {
	const container = $("modal-list");
	const scrollTop = resetScroll ? 0 : container.scrollTop;
	container.replaceChildren();
	const group = groupById(modal.groupId);
	if (!group) return;
	const limited = modal.dirs.size > 0;
	const showAll = !limited || modal.allDirs;

	if (limited) {
		const bar = el("div", "scope-bar");
		bar.append(el("span", "scope-bar-label", L.scopeLabel));
		for (const key of [...modal.dirs].slice(0, 4)) bar.append(el("span", "scope-chip", scopeLabelOf(key)));
		if (modal.dirs.size > 4) bar.append(el("span", "scope-chip", "+" + (modal.dirs.size - 4)));
		const toggle = textBtn(showAll ? L.onlyScope : L.showAllDirs, null, "btn btn-ghost btn-xs");
		toggle.addEventListener("click", () => {
			modal.allDirs = !modal.allDirs;
			renderAddList(true);
		});
		bar.title = L.scopeHint;
		bar.append(toggle);
		container.append(bar);
	}

	const query = $("modal-search").value.trim().toLowerCase();
	const sections = dirEntries().filter((entry) => showAll || modal.dirs.has(entry.key));
	let total = 0;
	for (const entry of sections) {
		const ids = entry.ids
			.filter((id) => {
				const session = state.sessions.get(id);
				if (!session) return false;
				if (!query) return true;
				return (session.title || "").toLowerCase().includes(query);
			})
			.sort((a, b) => {
				const ta = timeOf((state.sessions.get(a) || {}).updatedAt);
				const tb = timeOf((state.sessions.get(b) || {}).updatedAt);
				return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
			});
		if (ids.length === 0) continue;
		total += ids.length;
		const section = el("div", "picker-section");
		const head = el("div", "picker-head");
		const label = el("span", "picker-name", entry.short + L.statsSep + ids.length);
		if (entry.directory) label.title = entry.directory;
		head.append(label);
		const allBtn = textBtn(L.selectAll, null, "btn btn-ghost btn-xs");
		allBtn.addEventListener("click", () => {
			for (const id of ids) addToDraft(id);
			renderAddList();
		});
		const noneBtn = textBtn(L.clearAll, null, "btn btn-ghost btn-xs");
		noneBtn.addEventListener("click", () => {
			for (const id of ids) modal.now.delete(id);
			renderAddList();
		});
		head.append(allBtn, noneBtn);
		section.append(head);

		for (const id of ids) {
			const session = state.sessions.get(id);
			if (!session) continue;
			const others = groupsOf(id).filter((item) => item.id !== group.id);
			const subtitle = [fmtClock(session.updatedAt), others.length > 0 ? others.map((item) => item.name).join(" / ") : ""].filter(Boolean).join(L.statsSep);
			const row = pickerRow({
				checked: modal.now.has(id),
				title: session.title || L.untitled,
				subtitle,
				full: session.title || L.untitled,
				onToggle: (value) => {
					if (value) {
						// 勾了范围外的会话会顺带把目录并入范围：重绘一次让范围条同步。
						if (addToDraft(id)) {
							renderAddList();
							return;
						}
					} else {
						modal.now.delete(id);
					}
					updateAddHint();
				},
			});
			section.append(row);
		}
		container.append(section);
	}
	if (total === 0) container.append(el("p", "empty-text", L.noMatch));
	container.scrollTop = scrollTop;
	updateAddHint();
}

async function submitAddModal() {
	const group = groupById(modal.groupId);
	if (!group) {
		closeAddModal();
		return;
	}
	group.dirs = [...modal.dirs];
	group.ids = sortByUpdated([...modal.now]);
	await saveGroup(group);
	await saveMeta();
	closeAddModal();
	render();
}

/* ---------- 详情弹层 ---------- */

function infoRow(label, value, title, mono) {
	const row = el("div", "info-row");
	row.append(el("span", "info-label", label));
	const text = el("span", "info-value" + (mono ? " is-mono" : ""), value);
	if (title) text.title = title;
	row.append(text);
	return row;
}

function openInfoModal(sessionId) {
	const session = state.sessions.get(sessionId);
	if (!session) return;
	$("info-title").textContent = L.detailTitle;
	$("info-overlay").hidden = false;
	const body = $("info-body");
	body.replaceChildren();
	body.append(el("p", "info-title-text", session.title || L.untitled));
	const groupNames = groupsOf(sessionId).map((group) => group.name);
	body.append(infoRow(L.fieldDirectory, session.directory || L.unknownDir, session.directory, true));
	if (session.projectName) body.append(infoRow(L.fieldProject, session.projectName));
	body.append(infoRow(L.fieldBackend, session.backend || "pi"));
	if (session.model) body.append(infoRow(L.fieldModel, session.model));
	body.append(infoRow(L.fieldGroups, groupNames.length > 0 ? groupNames.join(" / ") : L.noGroup));
	body.append(infoRow(L.fieldCreatedAt, fmtClock(session.createdAt)));
	body.append(infoRow(L.fieldUpdatedAt, fmtClock(session.updatedAt)));
	body.append(infoRow(L.fieldStatus, session.readable ? L.statusSaved : L.statusNoHistory));
	body.append(infoRow(L.fieldId, session.id, session.id, true));
}

function closeInfoModal() {
	$("info-overlay").hidden = true;
}

/* ---------- 事件绑定 ---------- */

function closeTopOverlay() {
	if (!$("confirm-overlay").hidden) return closeConfirm();
	if (!$("info-overlay").hidden) return closeInfoModal();
	if (!$("create-overlay").hidden) return closeCreateModal();
	if (!$("overlay").hidden) return closeAddModal();
	return false;
}

function bindStaticControls() {
	$("btn-new").addEventListener("click", openCreateModal);
	$("btn-toggle-all").addEventListener("click", () => {
		if (anyCollapsed()) {
			state.collapsed.clear();
		} else {
			for (const group of state.groups) state.collapsed.add(group.id);
			state.collapsed.add(UNGROUPED);
		}
		void saveMeta();
		render();
	});

	const search = $("search-input");
	const applyFilter = debounce(() => {
		filterQuery = search.value.trim().toLowerCase();
		$("search-clear").hidden = filterQuery.length === 0;
		resetPages();
		render();
	}, 120);
	search.addEventListener("input", applyFilter);
	$("search-clear").addEventListener("click", () => {
		search.value = "";
		filterQuery = "";
		$("search-clear").hidden = true;
		resetPages();
		render();
		search.focus();
	});
	$("dir-filter-trigger").addEventListener("click", openDirFilter);

	$("create-close").addEventListener("click", closeCreateModal);
	$("create-cancel").addEventListener("click", closeCreateModal);
	$("create-ok").addEventListener("click", () => void submitCreateModal().catch(actionError));
	$("create-name").addEventListener("input", updateCreateHint);
	$("create-name").addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void submitCreateModal().catch(actionError);
		}
	});
	$("create-dirs-all").addEventListener("click", () => {
		for (const entry of dirEntries()) createDraft.dirs.add(entry.key);
		renderCreateDirs();
	});
	$("create-dirs-none").addEventListener("click", () => {
		createDraft.dirs.clear();
		renderCreateDirs();
	});

	$("modal-close").addEventListener("click", closeAddModal);
	$("modal-cancel").addEventListener("click", closeAddModal);
	$("modal-save").addEventListener("click", () => void submitAddModal().catch(actionError));
	$("modal-search").addEventListener("input", () => renderAddList(true));
	$("info-close").addEventListener("click", closeInfoModal);

	$("confirm-cancel").addEventListener("click", closeConfirm);
	$("confirm-ok").addEventListener("click", () => {
		const action = confirmAction;
		closeConfirm();
		if (action) action();
	});

	for (const id of ["create-overlay", "overlay", "info-overlay", "confirm-overlay"]) {
		$(id).addEventListener("click", (event) => {
			if (event.target === event.currentTarget) closeTopOverlay();
		});
	}
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (closeMenu()) {
			event.preventDefault();
			return;
		}
		if (closeTopOverlay() !== false) {
			event.preventDefault();
			return;
		}
		if (filterQuery) {
			$("search-input").value = "";
			filterQuery = "";
			$("search-clear").hidden = true;
			resetPages();
			render();
		}
	});
}

/* ---------- 启动 ---------- */

/** 60s 静默重绘会打断正在进行的改名/勾选与弹层输入：这些时刻跳过。 */
function isInteracting() {
	if (menuState) return true;
	if (["create-overlay", "overlay", "info-overlay", "confirm-overlay"].some((id) => !$(id).hidden)) return true;
	const active = document.activeElement;
	if (!active) return false;
	return active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.closest(".overlay") !== null;
}

async function boot() {
	bindStaticControls();
	state.ready = false;
	try {
		const context = await pideck.context.get();
		await applyContext(context || {});
	} catch (err) {
		setStatus(L.loadError + (err && err.message ? err.message : ""), true);
	}
	state.ready = true;
	render();
	pideck.onEvent(handleEvent);
	// 活跃点与相对时间会随时间漂移：每分钟静默重绘一次（不重新请求数据）
	setInterval(() => {
		if (!isInteracting()) render();
	}, 60000);
}

void boot();
