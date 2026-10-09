/** PiDeck-owned browser plugins. This API never proxies pi SDK or runtime commands. */
export type HostPluginPermission = "sessions.read" | "workbench.navigate" | "workbench.openExternal";
/** 面板呈现方式：modal = 大弹框（默认，兼容既有插件）；page = 工作区内联页面（非模态，覆盖会话区）。 */
export type HostPluginPanelPresentation = "modal" | "page";
export type HostPluginManifest = {
	schemaVersion: 1;
	apiVersion: 1;
	id: string;
	name: string;
	version: string;
	description?: string;
	permissions: HostPluginPermission[];
	contributes: {
		panels: Array<{ id: string; title: string; entry: string; icon?: string; presentation?: HostPluginPanelPresentation }>;
		commands: Array<{ id: string; title: string; panelId: string }>;
	};
};

export type HostPluginInfo = {
	manifest: HostPluginManifest;
	fingerprint: string;
	enabled: boolean;
	/** Code changes invalidate consent; rescan never silently grants new code access. */
	requiresConsent: boolean;
};
export type HostPluginCatalog = { directory: string; plugins: HostPluginInfo[]; issues: Array<{ directory: string; code: string }> };
export type HostPluginResult<T> = { ok: true; value: T } | { ok: false; code: string };

/** Scope is assigned by PiDeck, not by plugin input. IDs are durable catalog identities. */
export type HostPluginContext = {
	projectId?: string;
	/** 当前项目显示名：面板标题/文案直接可用，不必再绕一次 API。 */
	projectName?: string;
	sessionId?: string;
	/** 当前会话标题（同 sessions.get 的 title，便于构建标题栏）。 */
	sessionTitle?: string;
	locale: "zh-CN" | "en-US";
	theme: "light" | "dark";
	/** Host-owned visual tokens, not arbitrary plugin CSS injected into the workbench. */
	tokens?: Record<string, string>;
};
export type HostPluginSession = {
	id: string;
	projectId: string;
	title: string;
	updatedAt: number;
	createdAt: number;
	model?: string;
	readable: boolean;
};
export type HostPluginSessionPage = { sessions: HostPluginSession[]; nextOffset: number | null };
export type HostPluginEntryCursor = { before: number; version: string };
export type HostPluginEntriesPage = {
	entries: Record<string, unknown>[];
	nextCursor: HostPluginEntryCursor | null;
	version: string;
	/** Large entries/images are omitted or bounded, never silently presented as complete. */
	truncated: boolean;
};
/** Granular change detail lets adapters invalidate one session instead of refetching everything. */
export type HostPluginSessionsChangedDetail = { catalogChanged: boolean; sessionId?: string };
export type HostPluginEvent = { type: "context.changed"; context: HostPluginContext } | { type: "sessions.changed"; detail?: HostPluginSessionsChangedDetail };
export type HostPluginRequest =
	| { method: "context.get" }
	| { method: "sessions.list"; offset?: number }
	| { method: "sessions.get"; sessionId: string }
	| { method: "sessions.search"; query: string; limit?: number }
	| { method: "sessions.entries"; sessionId: string; cursor?: HostPluginEntryCursor }
	| { method: "storage.get"; key: string }
	| { method: "storage.set"; key: string; value: unknown }
	| { method: "storage.keys" }
	| { method: "storage.delete"; key: string }
	| { method: "workbench.navigate"; sessionId: string; entryId?: string }
	| { method: "workbench.openExternal"; url: string };
export type HostPluginResponse = HostPluginResult<unknown>;
export type HostPluginMountInput = { pluginId: string; panelId: string; context: HostPluginContext };
export type HostPluginMount = { instanceId: string; entryUrl: string };
export type HostPluginNavigateInput = { projectId: string; sessionId: string; entryId?: string };
/** 脚手架输入：生成一个能直接运行的最小插件，作者（或 AI）在它上面改。 */
export type HostPluginScaffoldInput = {
	id: string;
	name: string;
	permissions: HostPluginPermission[];
	presentation: HostPluginPanelPresentation;
};

/** Management methods are available only to the trusted desktop renderer, never to plugin pages. */
export type HostPluginDesktopApi = {
	list: () => Promise<HostPluginResult<HostPluginCatalog>>;
	rescan: () => Promise<HostPluginResult<HostPluginCatalog>>;
	/** 在插件目录里生成 <id>/ 模板（已存在则拒绘，不会覆盖作者代码）。 */
	scaffold: (input: HostPluginScaffoldInput) => Promise<HostPluginResult<HostPluginCatalog>>;
	setEnabled: (id: string, enabled: boolean, fingerprint: string) => Promise<HostPluginResult<HostPluginCatalog>>;
	openDirectory: () => Promise<HostPluginResult<void>>;
	/** Pick and install a `.pideck-plugin` archive; file selection happens in the main process dialog, renderer passes no paths. */
	install: () => Promise<HostPluginResult<HostPluginCatalog>>;
	/** Pick and install an unpacked plugin directory (same dialog rule: the renderer never supplies a path). */
	installDirectory: () => Promise<HostPluginResult<HostPluginCatalog>>;
	mount: (input: HostPluginMountInput) => Promise<HostPluginResult<HostPluginMount>>;
	update: (instanceId: string, context: HostPluginContext) => Promise<HostPluginResult<void>>;
	unmount: (instanceId: string) => Promise<HostPluginResult<void>>;
	onChanged: (listener: () => void) => () => void;
	/** Plugin-initiated navigation is dispatched by the desktop frame, never executed in the plugin view. */
	onNavigate: (listener: (input: HostPluginNavigateInput) => void) => () => void;
};

/** The only object exposed to a plugin page by its dedicated preload. */
export type HostPluginApi = {
	apiVersion: 1;
	/** 新增能力都是加法：老插件不受影响，新插件用 `typeof pideck.sessions.search === "function"` 探测。 */
	context: { get: () => Promise<HostPluginContext> };
	sessions: {
		list: (offset?: number) => Promise<HostPluginSessionPage>;
		/** 单个会话元信息（同 list 的条目）：标题栏/详情页不必先翻页找。 */
		get: (sessionId: string) => Promise<HostPluginSession>;
		/** 按标题子串搜索当前项目会话（大小写不敏感，不读历史文件）。 */
		search: (query: string, limit?: number) => Promise<HostPluginSession[]>;
		entries: (sessionId: string, cursor?: HostPluginEntryCursor) => Promise<HostPluginEntriesPage>;
	};
	storage: {
		get: (key: string) => Promise<unknown>;
		set: (key: string, value: unknown) => Promise<void>;
		/** 自己的键名列表（不能读别的插件命名空间）。 */
		keys: () => Promise<string[]>;
		remove: (key: string) => Promise<void>;
	};
	workbench: {
		navigate: (sessionId: string, entryId?: string) => Promise<void>;
		/** 用系统浏览器打开 https 链接；需 manifest 声明 workbench.openExternal。 */
		openExternal: (url: string) => Promise<void>;
	};
	onEvent: (listener: (event: HostPluginEvent) => void) => () => void;
};

/** Revision snapshot the view host diffs between polls; opaque outside HostPluginSessions. */
export type HostPluginSessionsRevision = { catalog: string; active?: { sessionId: string; file: string } };
