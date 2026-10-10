/** L2 脚手架：从 0 生成一个能直接运行的宿主插件，作者（或 AI）在它上面改，而不是抄文档。
 *
 * 生成的代码只使用 `window.pideck`，并遵守沙箱约束（页面不直连网络、无 innerHTML、消费主题变量）；
 * 未勾选的权限不会出现在 manifest 里，对应示例代码也不会生成——模板即最小可用包。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostPluginPermission, HostPluginScaffoldInput } from "../../shared/types/hostPlugin";
import { isHostPluginId, isPluginRecord, parseHostPluginManifest } from "./hostPluginManifest";
import { scaffoldNetworkDemo } from "./hostPluginScaffoldNetwork";

const NOTICE = "由 PiDeck 脚手架生成；改完点「重新扫描」，授权指纹会随之失效，需要重新确认。";

/** 面板标题与插件名同源：脚手架只填一个名字，避免表单字段堆成墙。 */
function manifestJson(input: HostPluginScaffoldInput): string {
	return `${JSON.stringify(
		{
			schemaVersion: 1,
			apiVersion: 1,
			id: input.id,
			name: input.name,
			version: "0.1.0",
			description: NOTICE,
			permissions: input.permissions,
			...(input.network ? { network: input.network } : {}),
			contributes: {
				// icon 必须取自 shared/hostPluginIcons 的白名单，否则 manifest 解析就报 invalid-manifest。
				panels: [{ id: "main", title: input.name, entry: "app.html", icon: "message", presentation: input.presentation }],
				commands: [{ id: "open", title: input.name, panelId: "main" }],
			},
		},
		null,
		"\t",
	)}\n`;
}

function appHtml(input: HostPluginScaffoldInput): string {
	const permissions = input.permissions;
	const network = scaffoldNetworkDemo(input);
	// 未声明的权限不生成对应界面：模板与 manifest 的 permissions 始终一致（与代码块同一规则）。
	const readsSessions = permissions.includes("sessions.read");
	const search = readsSessions ? '      <input id="search" type="search" autocomplete="off" />\n' : "";
	const main = readsSessions ? '      <section id="list" class="list" aria-label="Sessions"></section>\n' : "";
	return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Plugin panel</title>
    <!-- CSP 由宿主注入：脚本与样式只能来自本包，connect-src 为 none（页面不能联网）。 -->
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header class="bar">
      <div class="titles">
        <h1 id="title"></h1>
        <p id="context" class="muted"></p>
      </div>
${search}${permissions.includes("workbench.openExternal") ? '      <button id="guide" type="button" class="ghost"></button>\n' : ""}    </header>
    <main>
${main}      <section id="detail" class="detail"></section>
${network.html}    </main>
    <p id="status" class="status" role="status"></p>
    <script type="module" src="app.js"></script>
  </body>
</html>
`;
}

/** 可选能力：只有勾了对应权限才生成代码，模板与 manifest 的 permissions 声明保持一致。 */

/** 跳转按钮（renderEntries 内）与顶层 reveal 函数：需要 workbench.navigate。 */
function navigateBlock(permissions: HostPluginPermission[]): { button: string; reveal: string } {
	if (!permissions.includes("workbench.navigate")) return { button: "", reveal: "" };
	return {
		button: `      const open = document.createElement("button");
      open.type = "button";
      open.className = "ghost";
      open.textContent = state.copy.open;
      open.addEventListener("click", () => void reveal(session.id, entry.id));
      article.append(open);
`,
		reveal: `/** 让 PiDeck 工作台打开该会话并定位到条目。 */
async function reveal(sessionId, entryId) {
  await pideck.workbench.navigate(sessionId, entryId);
}

`,
	};
}

/** 外部链接：需要 workbench.openExternal（只允许 https，由系统浏览器打开）。 */
function externalLinkBlock(permissions: HostPluginPermission[]): string {
	if (!permissions.includes("workbench.openExternal")) return "";
	return `/** 打开开发指南：这条能力只开浏览器，页面本身仍然没有网络。 */
async function openGuide() {
  try {
    await pideck.workbench.openExternal("https://github.com/ayuayue/PiDeck/blob/main/docs/host-plugin-dev-guide.md");
  } catch (error) {
    report(error);
  }
}

`;
}

/** 顶部指南按钮的接线：同样只在声明了 openExternal 时生成。 */
function guideWiring(permissions: HostPluginPermission[]): string {
	if (!permissions.includes("workbench.openExternal")) return "";
	return `  const guide = document.getElementById("guide");
  if (guide) guide.addEventListener("click", () => void openGuide());
`;
}

function appJs(input: HostPluginScaffoldInput): string {
	const navigate = navigateBlock(input.permissions);
	const network = scaffoldNetworkDemo(input);
	// sessions.read 是模板主体（会话列表与历史）：没声明就整块不生成，避免生成一份必然报权限错的示例。
	const readsSessions = input.permissions.includes("sessions.read");
	return `// 宿主插件示例：读当前项目的会话目录与历史，并（可选）让工作台跳转。
// 能力边界：只有 window.pideck 一个入口——网络由宿主按授权代发，不能直接 fetch、读文件、执行命令、加载 CDN。
// 数据范围：只有当前项目（context.projectId）下已保存的会话；其他项目一律 session-not-authorized。
const pideck = window.pideck;

const copy = {
  "zh-CN": { title: "${input.name}", search: "搜索会话标题…", empty: "当前项目还没有已保存的会话。", more: "加载更多", loading: "读取中…", open: "在 PiDeck 中打开", last: "上次查看", guide: "开发指南", noPermission: "这个示例没有声明 sessions.read：只演示 context（项目/会话/语言/主题）与 storage。" },
  "en-US": { title: "${input.name}", search: "Search session titles…", empty: "No saved sessions in this project yet.", more: "Load more", loading: "Loading…", open: "Open in PiDeck", last: "Last viewed", guide: "Developer guide", noPermission: "This sample declares no sessions.read: it only demonstrates context (project/session/locale/theme) and storage." },
};

const nodes = {
  title: document.getElementById("title"),
  context: document.getElementById("context"),
  search: document.getElementById("search"),
  list: document.getElementById("list"),
  detail: document.getElementById("detail"),
  status: document.getElementById("status"),
};

/** 插件的全部状态：宿主只提供数据，界面状态归插件自己。 */
const state = { copy: copy["zh-CN"], sessions: [], nextOffset: null, selected: undefined, entries: [], truncated: false, last: undefined };

/** 失败都是带稳定 code 的 Error（permission-denied / session-not-authorized / history-too-large …）。 */
function report(error) {
  nodes.status.textContent = String(error && error.message ? error.message : error);
}

function renderContext(context) {
  state.copy = copy[context.locale] || copy["zh-CN"];
  document.documentElement.lang = context.locale;
  // context.theme 跟随 PiDeck 主题；样式优先消费 tokens 注入的 CSS 变量（见 styles.css）。
  document.documentElement.dataset.theme = context.theme;
  nodes.title.textContent = state.copy.title;
  // 没声明 sessions.read 时页面没有搜索框，所以逐个取节点而不是假定存在。
  if (nodes.search) nodes.search.placeholder = state.copy.search;
  // 当前项目显示名与当前会话标题直接来自 context，不必再查一次。
  nodes.context.textContent = [context.projectName || context.projectId || "", context.sessionTitle || ""].filter(Boolean).join(" · ");
  if (document.getElementById("guide")) document.getElementById("guide").textContent = state.copy.guide;
${network.render}}

${network.code}${
	readsSessions
		? `
function renderSessions() {
  nodes.list.replaceChildren();
  if (state.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = state.copy.empty;
    nodes.list.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = session.id === state.selected ? "row active" : "row";
    row.addEventListener("click", () => void select(session.id).catch(report));
    const title = document.createElement("span");
    title.className = "row-title";
    // 文案一律走 textContent：会话标题是用户数据，拼接 HTML 等于把注入点交给数据。
    title.textContent = session.title;
    const meta = document.createElement("span");
    meta.className = "muted";
    const parts = [session.model, session.readable ? "" : "history-unavailable"];
    if (state.last === session.id) parts.push(state.copy.last);
    meta.textContent = parts.filter(Boolean).join(" · ");
    row.append(title, meta);
    nodes.list.append(row);
  }
  // 分页：nextOffset 为 null 表示到底；一页最多 100 条，不要假设一次拿完。
  if (state.nextOffset !== null) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "row ghost";
    more.textContent = state.copy.more;
    more.addEventListener("click", () => void loadSessions(state.nextOffset).catch(report));
    nodes.list.append(more);
  }
}

function renderEntries(session) {
  nodes.detail.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = session.title;
  nodes.detail.append(heading);
  if (state.truncated) {
    const flag = document.createElement("p");
    flag.className = "muted";
    flag.textContent = "(history truncated)";
    nodes.detail.append(flag);
  }
  for (const entry of state.entries) {
    const article = document.createElement("article");
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = roleOf(entry);
    const body = document.createElement("pre");
    body.textContent = summarize(entry);
    article.append(role, body);
${navigate.button}    nodes.detail.append(article);
  }
}

/** 历史条目的形状由 pi 的会话格式决定；这里只做展示，所以取一个保守摘要。 */
function roleOf(entry) {
  return (entry.message && entry.message.role) || entry.role || entry.type || "entry";
}

function summarize(entry) {
  const message = entry.message || entry;
  const text = message.text || message.content || entry.summary || "";
  const value = typeof text === "string" ? text : JSON.stringify(text);
  return value.length > 400 ? value.slice(0, 400) + "…" : value;
}

/** 列表分页：list 每次最多 100 条，nextOffset 为 null 表示到底。 */
async function loadSessions(offset = 0) {
  const page = await pideck.sessions.list(offset);
  state.sessions = offset === 0 ? page.sessions : state.sessions.concat(page.sessions);
  state.nextOffset = page.nextOffset;
  renderSessions();
}

/** 搜索：新版有 sessions.search（只比标题、不读历史文件），老版本退回本地过滤。 */
async function search(query) {
  if (!query) {
    await loadSessions(0);
    return;
  }
  if (typeof pideck.sessions.search === "function") {
    state.sessions = await pideck.sessions.search(query, 50);
  } else {
    const page = await pideck.sessions.list(0);
    const needle = query.toLocaleLowerCase();
    state.sessions = page.sessions.filter((session) => session.title.toLocaleLowerCase().includes(needle));
  }
  state.selected = undefined;
  state.nextOffset = null;
  renderSessions();
}

async function select(id) {
  // 列表里已经有元信息；要单独取一个会话时用 await pideck.sessions.get(id)。
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  nodes.status.textContent = state.copy.loading;
  state.selected = id;
  state.last = id;
  renderSessions();
  const page = await pideck.sessions.entries(session.id);
  state.entries = page.entries;
  state.truncated = page.truncated === true;
  renderEntries(session);
  // 每插件 1 MiB 小存储：记住上次查看的会话，下次打开面板直接接上。
  await pideck.storage.set("lastSession", session.id);
  nodes.status.textContent = "";
}

${navigate.reveal}${externalLinkBlock(input.permissions)}async function main() {
  renderContext(await pideck.context.get());
  state.last = (await pideck.storage.get("lastSession")) || undefined;
  // 事件是唯一的推送通道：context.changed（语言/主题/当前项目/当前会话）与 sessions.changed（目录变化）。
  pideck.onEvent((event) => {
    if (event.type === "context.changed") {
      renderContext(event.context);
      void loadSessions(0).catch(report);
      return;
    }
    void loadSessions(0).catch(report);
  });
  nodes.search.addEventListener("input", () => void search(nodes.search.value.trim()).catch(report));
${guideWiring(input.permissions)}${network.wiring}  await loadSessions(0);
}

main().catch(report);
`
		: `
async function main() {
  renderContext(await pideck.context.get());
  // 事件是唯一的推送通道：这里只有 context.changed。
  pideck.onEvent((event) => {
    if (event.type === "context.changed") renderContext(event.context);
  });
  // 每插件 1 MiB 小存储：计数只是演示持久化，不需要任何权限。
  await pideck.storage.set("openCount", Number((await pideck.storage.get("openCount")) || 0) + 1);
  nodes.status.textContent = state.copy.noPermission;
${guideWiring(input.permissions)}${network.wiring}}

${externalLinkBlock(input.permissions)}main().catch(report);
`
}
`;
}

function stylesCss(): string {
	return `/* PiDeck 会把语义色注入为 CSS 变量（context.tokens）。这里只消费它们并给出兜底值，
   所以亮色/暗色与主题强调色切换都不需要插件自己判断。 */
:root {
  color-scheme: dark;
  --bg: var(--color-bg-panel, #1c1c1f);
  --bg-input: var(--color-bg-input, #26262b);
  --text: var(--color-text-primary, #f2f2f5);
  --muted: var(--color-text-secondary, #9a9aa5);
  --border: var(--color-border-default, #34343c);
  --accent: var(--color-accent, #4c8dff);
}

:root[data-theme="light"] {
  color-scheme: light;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.5 system-ui, "Segoe UI", sans-serif;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.titles h1 {
  margin: 0;
  font-size: 15px;
}

.muted {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

input[type="search"],
input[type="url"] {
  flex: 0 0 240px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text);
}

main {
  display: grid;
  grid-template-columns: minmax(220px, 320px) 1fr;
  flex: 1;
  min-height: 0;
}

.list,
.detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  overflow-y: auto;
}

.detail {
  border-left: 1px solid var(--border);
}

.row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.row:hover {
  border-color: var(--border);
}

.row.active {
  border-color: var(--accent);
}

.row.ghost {
  color: var(--muted);
}

.row-title {
  font-weight: 600;
}

.detail article {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}

.role {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
}

pre {
  margin: 4px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.status {
  margin: 0;
  padding: 6px 16px;
  color: var(--muted);
  font-size: 12px;
}
`;
}

function readme(input: HostPluginScaffoldInput): string {
	const permissions = input.permissions.length > 0 ? input.permissions.map((permission) => `\`${permission}\``).join("、") : "（无：只能读 context）";
	const lines = [
		`# ${input.name}`,
		"",
		NOTICE,
		"",
		"## 怎么跑起来",
		"",
		"1. 这个目录已经**直接在 PiDeck 插件目录里**（设置 → PiDeck 插件 → 打开插件目录 可定位）。",
		"2. 回到设置页点「重新扫描」，在列表里点「授权并启用」；面板入口出现在同一行的按钮上。",
		"3. 改 `app.html` / `app.js` / `styles.css` 后重复第 2 步即可看到效果——指纹会变，所以要重新授权一次。",
		"",
		"## 这个包的结构",
		"",
		"| 文件 | 作用 |",
		"|------|------|",
		"| `pideck-plugin.json` | 清单：id、面板入口、`permissions`（当前：" + permissions + "） |",
		"| `app.html` | 面板入口页（manifest 的 `contributes.panels[0].entry`） |",
		"| `app.js` | 面板逻辑：只用 `window.pideck`，无框架、无 CDN、页面不直接联网 |",
		"| `styles.css` | 消费 PiDeck 主题变量，亮/暗色自动适配 |",
		"",
		"## 可以用的能力",
		"",
		"- `pideck.context.get()`：当前项目/会话/语言/主题/主题令牌",
		"- `pideck.sessions.list(offset)` / `get(id)` / `search(query, limit)` / `entries(id, cursor)`",
		"- `pideck.storage.get/set/keys/remove`：每插件 1 MiB JSON 小存储",
		"- `pideck.workbench.navigate(sessionId, entryId)`",
	];
	if (input.permissions.includes("workbench.openExternal")) lines.push("- `pideck.workbench.openExternal(url)`：用系统浏览器打开 https 链接");
	lines.push(...scaffoldNetworkDemo(input).readme);
	lines.push("- `pideck.onEvent(listener)`：`context.changed` / `sessions.changed` 推送", "", "完整规则、错误码与预算见仓库开发指南 `docs/host-plugin-dev-guide.md`（官网同页：/guide/host-plugins）。", "", "## 打包给别人", "", "```bash", "node scripts/pack-host-plugin.mjs <本目录> my-plugin.pideck-plugin", "```", "");
	return lines.join("\n");
}

/** 生成的文件集：路径 → 文本内容（与包规则同一套相对路径，读一次就知道会落盘什么）。 */
export function buildHostPluginScaffold(input: HostPluginScaffoldInput): Map<string, string> {
	// 与安装同一解析器：先拒绝越权声明并规范化 origin，再从同一份授权生成页面。
	const manifest = parseHostPluginManifest(JSON.parse(manifestJson(input)));
	const validatedInput = { ...input, network: manifest.network };
	return new Map([
		["pideck-plugin.json", manifestJson(validatedInput)],
		["app.html", appHtml(validatedInput)],
		["app.js", appJs(validatedInput)],
		["styles.css", stylesCss()],
		["README.md", readme(validatedInput)],
	]);
}

/** 在插件目录里落地一个 <id>/ 包；目录已存在即拒绝，绝不覆盖作者已经改过的代码。 */
export async function createHostPluginScaffold(pluginsDirectory: string, input: HostPluginScaffoldInput): Promise<string> {
	if (!isHostPluginId(input.id)) throw new Error("invalid-plugin-id");
	const files = buildHostPluginScaffold(input);
	// 自检：生成的 manifest 必须能通过安装路径的解析，否则脚手架会产出自己都读不了的包。
	parseHostPluginManifest(JSON.parse(files.get("pideck-plugin.json") ?? ""));
	const target = join(pluginsDirectory, input.id);
	try {
		await mkdir(target, { recursive: false });
	} catch (error) {
		if (isPluginRecord(error) && error.code === "EEXIST") throw new Error("already-exists");
		throw error;
	}
	try {
		for (const [asset, content] of files) {
			await mkdir(dirname(join(target, asset)), { recursive: true });
			await writeFile(join(target, asset), content, "utf8");
		}
	} catch (error) {
		// 半成品目录会以 invalid-package 出现在插件列表里，失败就整体撤掉。
		await rm(target, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return target;
}
