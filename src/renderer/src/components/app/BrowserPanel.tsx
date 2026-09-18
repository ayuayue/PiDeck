import { useCallback, useEffect, useRef, useState } from "react";
import {
	ArrowLeft,
	ArrowRight,
	Home,
	Maximize2,
	Minus,
	Plus,
	RefreshCw,
	Smartphone,
	Tablet,
	X,
} from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";

// Button 收口状态（P0）：工具栏/导航/UA 菜单按钮已换 shadcn Button（ghost/outline + 原尺寸 class 保留）。
// 保留原生：.browser-tab-close（16px 微型关闭钮，Button 最小档 icon-xs 24px 无法替代）。

const DEFAULT_HOME = "https://ayuayue.github.io/PiDeck/";

type DeviceType = "pc" | "mobile" | "tablet";

interface TabEntry {
	id: string;
	title: string;
	url: string;
}

interface DevicePreset {
	id: DeviceType;
	label: string;
	userAgent: string | null;
}

const DEVICE_PRESETS: DevicePreset[] = [
	{ id: "pc", label: "browser.devicePC", userAgent: null },
	{
		id: "mobile",
		label: "browser.deviceMobile",
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	},
	{
		id: "tablet",
		label: "browser.deviceTablet",
		userAgent:
			"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	},
];

let nextTabId = 1;
function genTabId(): string {
	return `tab-${nextTabId++}`;
}

/** Chromium 用 -3 表示旧导航被新导航替换，这是 webview 正常生命周期，不应冒泡成全局异常。 */
export function isExpectedNavigationAbort(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /ERR_ABORTED|error code:?\s*-3|\(-3\)/i.test(message);
}

/**
 * 浏览器状态要跨"抽屉模式/弹框模式"保留。
 * 这里用模块级状态保存轻量 tab 元数据，避免切换容器时丢 URL/标题/设备模式。
 * 真正的 WebContents 仍随组件挂载重建，避免同时运行两个 webview 实例。
 */
export const moduleState: { tabs: TabEntry[]; activeTabId: string | null; device: DeviceType; navigateKey: number } = {
	tabs: [],
	activeTabId: null,
	device: "pc",
	navigateKey: 0,
};

function ensureInitialTab() {
	if (moduleState.tabs.length > 0) return;
	const id = genTabId();
	moduleState.tabs = [{ id, title: "PiDeck", url: DEFAULT_HOME }];
	moduleState.activeTabId = id;
}

function getInitialActiveTab(): TabEntry {
	ensureInitialTab();
	return (
		moduleState.tabs.find((tab) => tab.id === moduleState.activeTabId) ??
		moduleState.tabs[0]
	);
}

/**
 * 供外部（App.tsx）调用：在浏览器侧栏/弹框中导航到指定 URL。
 * 如果没有标签页则创建一个，然后切换到该标签页并加载 URL。
 */
/**
 * 供外部（App.tsx）调用：在浏览器侧栏/弹框中导航到指定 URL。
 * 每次都新建 tab，避免多个外部链接复用同一个 tab。
 */
/** 待消费的外部导航 URL，BrowserPanel 通过轮询检测。 */
let pendingNavigateUrl: string | null = null;

export function navigateTo(url: string) {
	// 每次外部导航创建新 tab，避免多个链接复用同一个 tab
	const id = genTabId();
	// 初始 title 留空，tab 渲染 fallback 到 url，等 page-title-updated 更新真实标题
	moduleState.tabs.push({ id, title: "", url });
	moduleState.activeTabId = id;
	moduleState.navigateKey += 1;
	// 直接设 pendingUrl，轮询会立即检测到，无需等 re-render
	pendingNavigateUrl = url;
}

type WebviewEvent<T extends string> = T extends "did-fail-load"
	? { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
	: T extends "did-navigate"
	? { url: string }
	: T extends "did-navigate-in-page"
		? { url: string; isMainFrame: boolean }
		: T extends "page-title-updated"
			? { title: string }
			: T extends "new-window"
				? { url: string; preventDefault: () => void }
				: T extends "load-progress"
					? { progress: number }
					: Event;

export function BrowserPanel(props: {
	isFullscreen?: boolean;
	onClose?: () => void;
	onToggleFullscreen?: () => void;
	/** 最小化：关闭全屏弹框，回到抽屉模式。 */
	onMinimize?: () => void;
	/** 嵌入右侧统一 Tab 栏时隐藏关闭按钮，避免与 drawer-chrome 重复 */
	hideChromeClose?: boolean;
}) {
	const { onClose, onMinimize, onToggleFullscreen } = props;
	const [initialTab] = useState(() => getInitialActiveTab());
	const webviewRef = useRef<WebviewElement | null>(null);
	const defaultUARef = useRef<string | null>(null);
	const [tabs, setTabs] = useState<TabEntry[]>(() => [...moduleState.tabs]);
	const [activeTabId, setActiveTabId] = useState<string | null>(
		() => moduleState.activeTabId,
	);
	const [url, setUrl] = useState(initialTab.url);
	const [inputValue, setInputValue] = useState(initialTab.url);
	const [canGoBack, setCanGoBack] = useState(false);
	const [canGoForward, setCanGoForward] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [loadProgress, setLoadProgress] = useState(0);
	const [device, setDevice] = useState<DeviceType>(() => moduleState.device);
	const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
	const deviceMenuRef = useRef<HTMLDivElement | null>(null);

	const persistTabs = useCallback((nextTabs: TabEntry[], nextActiveId: string | null) => {
		moduleState.tabs = nextTabs;
		moduleState.activeTabId = nextActiveId;
		setTabs([...nextTabs]);
		setActiveTabId(nextActiveId);
	}, []);

	const applyDeviceUserAgent = useCallback((wv: WebviewElement | null, nextDevice: DeviceType) => {
		if (!wv) return;
		const preset = DEVICE_PRESETS.find((item) => item.id === nextDevice);
		if (preset?.userAgent) {
			wv.setUserAgent(preset.userAgent);
		} else if (defaultUARef.current) {
			wv.setUserAgent(defaultUARef.current);
		}
	}, []);

	const updateActiveTab = useCallback(
		(patch: Partial<TabEntry>) => {
			if (!moduleState.activeTabId) return;
			const nextTabs = moduleState.tabs.map((tab) =>
				tab.id === moduleState.activeTabId ? { ...tab, ...patch } : tab,
			);
			moduleState.tabs = nextTabs;
			setTabs([...nextTabs]);
		},
		[],
	);

	const loadUrl = useCallback(
		(targetUrl: string, nextDevice = moduleState.device) => {
			const wv = webviewRef.current;
			if (!wv) return;
			applyDeviceUserAgent(wv, nextDevice);
			setUrl(targetUrl);
			setInputValue(targetUrl);
			// loadURL 返回 Promise；切 tab、刷新或连续跳转会让旧请求以 ERR_ABORTED reject。
			// 这里必须在 webview 边界消费该可预期取消，否则会触发 renderer unhandledrejection。
			void wv.loadURL(targetUrl).catch((error: unknown) => {
				if (!isExpectedNavigationAbort(error)) {
					setIsLoading(false);
				}
			});
		},
		[applyDeviceUserAgent],
	);

	useEffect(() => {
		const wv = webviewRef.current;
		if (!wv) return;

		if (!defaultUARef.current) {
			try {
				defaultUARef.current = wv.getUserAgent();
			} catch {
				defaultUARef.current = null;
			}
		}
		applyDeviceUserAgent(wv, moduleState.device);

		const onDomReady = () => {
			webviewReadyRef.current = true;
		};
		wv.addEventListener("dom-ready", onDomReady);

		const onDidNavigate = (event: Event) => {
			const nextUrl = (event as unknown as WebviewEvent<"did-navigate">).url;
			setUrl(nextUrl);
			setInputValue(nextUrl);
			setCanGoBack(wv.canGoBack());
			setCanGoForward(wv.canGoForward());
			updateActiveTab({ url: nextUrl });
		};
		const onDidNavigateInPage = (event: Event) => {
			const evt = event as unknown as WebviewEvent<"did-navigate-in-page">;
			if (!evt.isMainFrame) return;
			setUrl(evt.url);
			setInputValue(evt.url);
			updateActiveTab({ url: evt.url });
		};
		const onDidStartLoading = () => setIsLoading(true);
		const onDidStopLoading = () => {
			setIsLoading(false);
			setLoadProgress(0);
			setCanGoBack(wv.canGoBack());
			setCanGoForward(wv.canGoForward());
		};
		const onDidFailLoad = (event: Event) => {
			const failure = event as unknown as WebviewEvent<"did-fail-load">;
			if (!failure.isMainFrame) return;
			// -3 是导航被替换/取消，不展示错误页，也不向全局异常处理器传播。
			if (failure.errorCode === -3) {
				setIsLoading(false);
				setLoadProgress(0);
			}
		};
		const onProgress = (event: Event) => {
			const progress = (event as unknown as WebviewEvent<"load-progress">).progress;
			setLoadProgress(progress);
		};
		// page-title-updated 只接收真实 title，不 fallback 到 url/DEFAULT_HOME，
		// 避免 tab 标题闪烁。初始空 title 由 tab 渲染 fallback 到 url。
		const onPageTitleUpdated = (event: Event) => {
			const title = (event as unknown as WebviewEvent<"page-title-updated">).title;
			if (title) {
				updateActiveTab({ title });
			}
		};
		const onNewWindow = (event: Event) => {
			const evt = event as unknown as WebviewEvent<"new-window">;
			// 始终阻止默认弹窗行为，由我们接管分发
			evt.preventDefault();
			if (evt.url.startsWith("http://") || evt.url.startsWith("https://")) {
				// 页面内 target="_blank" 或 window.open 链接在浏览器新 tab 中打开
				navigateTo(evt.url);
			} else {
				// 非 http 协议（mailto: 等）走系统默认浏览器
				void window.piDesktop.browser.openExternal(evt.url);
			}
		};

		wv.addEventListener("did-navigate", onDidNavigate);
		wv.addEventListener("did-navigate-in-page", onDidNavigateInPage);
		wv.addEventListener("did-start-loading", onDidStartLoading);
		wv.addEventListener("did-stop-loading", onDidStopLoading);
		wv.addEventListener("did-fail-load", onDidFailLoad);
		wv.addEventListener("load-progress", onProgress);
		wv.addEventListener("page-title-updated", onPageTitleUpdated);
		wv.addEventListener("new-window", onNewWindow);

		return () => {
			wv.removeEventListener("dom-ready", onDomReady);
			wv.removeEventListener("did-navigate", onDidNavigate);
			wv.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
			wv.removeEventListener("did-start-loading", onDidStartLoading);
			wv.removeEventListener("did-stop-loading", onDidStopLoading);
			wv.removeEventListener("did-fail-load", onDidFailLoad);
			wv.removeEventListener("load-progress", onProgress);
			wv.removeEventListener("page-title-updated", onPageTitleUpdated);
			wv.removeEventListener("new-window", onNewWindow);
			webviewReadyRef.current = false;
		};
	}, [applyDeviceUserAgent, updateActiveTab, url]);

	// 不再在卸载时清空 moduleState：折叠抽屉、切换面板后重新打开仍保留之前的 tab 状态。
	// 关闭最后一个 tab 时 closeTab 已处理 moduleState 清理并调用 onClose。
	// 组件首次挂载时如果 tabs 为空，ensureInitialTab 会创建默认页面。

	const navigate = useCallback(
		(targetUrl?: string) => {
			let finalUrl = targetUrl ?? inputValue.trim();
			if (!finalUrl) return;
			if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(finalUrl)) {
				finalUrl = `https://${finalUrl}`;
			}
			loadUrl(finalUrl);
		},
		[inputValue, loadUrl],
	);

	const switchTab = useCallback(
		(tabId: string) => {
			const tab = moduleState.tabs.find((item) => item.id === tabId);
			if (!tab) return;
			moduleState.activeTabId = tabId;
			setActiveTabId(tabId);
			loadUrl(tab.url);
		},
		[loadUrl],
	);

	const addTab = useCallback(() => {
		const id = genTabId();
		const newTab = { id, title: t("browser.newTab"), url: DEFAULT_HOME };
		persistTabs([...moduleState.tabs, newTab], id);
		loadUrl(DEFAULT_HOME);
	}, [loadUrl, persistTabs]);

	// webview 是否已触发 dom-ready，用于延迟外部导航直到 webview 就绪。
	const webviewReadyRef = useRef(false);

	// 轮询检测 navigateTo 设置的 pendingNavigateUrl（module 变量不触发 React 重渲染）
	useEffect(() => {
		const interval = window.setInterval(() => {
			if (!pendingNavigateUrl) return;
			const url = pendingNavigateUrl;
			moduleState.navigateKey = 0;
			const wv = webviewRef.current;
			if (!wv) return;
			// 如果 webview 正在加载中，跳过本次轮询保留 pendingNavigateUrl，
			// 下次轮询会重试，避免 URL 被静默丢弃
			if (wv.isLoading && wv.isLoading()) return;
			// 通过加载检查后才消费 URL，防止加载中时丢请求
			pendingNavigateUrl = null;
			const activeTab = moduleState.tabs.find((t) => t.id === moduleState.activeTabId);
			if (activeTab) {
				applyDeviceUserAgent(wv, moduleState.device);
				setTabs([...moduleState.tabs]);
				setActiveTabId(moduleState.activeTabId);
				wv.loadURL(url).catch(() => {});
			}
		}, 50);
		return () => window.clearInterval(interval);
	}, [applyDeviceUserAgent, isLoading, loadUrl]);

	const closeTab = useCallback(
		(tabId: string, event: React.MouseEvent) => {
			event.stopPropagation();
			const current = moduleState.tabs;
			if (current.length <= 1) {
				// 关闭最后一个 tab：清空 moduleState 与本地 tabs 状态，避免旧 tab 残留显示
				// （onClose 触发的 state 更新可能是同值 no-op，React 会跳过重渲染，必须显式同步）。
				// onClose 语义 = 关闭整个浏览器面板：抽屉模式收起侧边栏，全屏模式退出全屏并收起侧边栏。
				moduleState.tabs = [];
				moduleState.activeTabId = null;
				moduleState.navigateKey = 0;
				pendingNavigateUrl = null;
				setTabs([]);
				setActiveTabId(null);
				onClose?.();
				return;
			}
			const index = current.findIndex((tab) => tab.id === tabId);
			const nextTabs = current.filter((tab) => tab.id !== tabId);
			let nextActiveId = moduleState.activeTabId;
			if (nextActiveId === tabId) {
				nextActiveId = nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null;
			}
			persistTabs(nextTabs, nextActiveId);
			const nextTab = nextTabs.find((tab) => tab.id === nextActiveId);
			if (nextTab) loadUrl(nextTab.url);
		},
		[loadUrl, onClose, persistTabs],
	);

	const selectDevice = useCallback(
		(nextDevice: DeviceType) => {
			moduleState.device = nextDevice;
			setDevice(nextDevice);
			setDeviceMenuOpen(false);
			// 仅改 UA 不会触发布局变化；同时切换 browser-panel 的 device class 限制 webview 视口宽度。
			loadUrl(url || DEFAULT_HOME, nextDevice);
		},
		[loadUrl, url],
	);

	useEffect(() => {
		if (!deviceMenuOpen) return;
		const handleMouseDown = (event: MouseEvent) => {
			if (!deviceMenuRef.current?.contains(event.target as Node)) {
				setDeviceMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [deviceMenuOpen]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			navigate();
		},
		[navigate],
	);

	const panelClass = `browser-panel${props.isFullscreen ? " is-fullscreen" : ""} device-${device}`;
	const activeDevicePreset = DEVICE_PRESETS.find((preset) => preset.id === device) ?? DEVICE_PRESETS[0];
	const deviceIcon = device === "mobile" ? <Smartphone size={13} /> : device === "tablet" ? <Tablet size={13} /> : null;

	return (
		<div className={panelClass} onClick={(event) => event.stopPropagation()}>
			<div className="flex shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-border/40 bg-bg-subtle [scrollbar-width:thin]">
				{tabs.map((tab) => (
					<div
						key={tab.id}
						className={`flex max-w-[180px] shrink-0 cursor-pointer items-center gap-1 border-r border-border/30 px-2.5 py-1 text-xs whitespace-nowrap select-none text-text-tertiary${tab.id === activeTabId ? " border-b-2 border-[var(--color-accent)] -mb-px bg-bg-panel text-text-primary" : ""}`}
						onClick={() => switchTab(tab.id)}
					>
						<span className="min-w-0 truncate">{tab.title || tab.url}</span>
						<Button variant="ghost" size="icon-sm" className="browser-tab-close" onClick={(event) => closeTab(tab.id, event)} title={t("browser.closeTab")}>
							<X size={11} />
						</Button>
					</div>
				))}
<Button variant="ghost" size="icon-sm" className="size-[30px] text-text-tertiary hover:text-[color:var(--color-accent)]" onClick={addTab} title={t("browser.newTab")}>
					<Plus size={14} />
				</Button>
				{!props.isFullscreen && (
					<div className="ml-auto flex shrink-0 items-center gap-0.5 pr-1">
<Button variant="ghost" size="icon-sm" className="size-[26px] rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary" onClick={onToggleFullscreen} title={t("browser.fullscreen")}>
							<Maximize2 size={13} />
						</Button>
						{/* 统一 drawer chrome 已提供关闭；此处仅在独立/旧布局时保留 */}
						{!props.hideChromeClose && (
<Button variant="ghost" size="icon-sm" className="size-[26px] rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary" onClick={onClose} title={t("common.close")}>
								<X size={14} />
							</Button>
						)}
					</div>
				)}
			</div>

			<div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5">
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" disabled={!canGoBack} onClick={() => webviewRef.current?.goBack()} title={t("browser.back")}>
					<ArrowLeft size={15} />
				</Button>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" disabled={!canGoForward} onClick={() => webviewRef.current?.goForward()} title={t("browser.forward")}>
					<ArrowRight size={15} />
				</Button>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" onClick={() => webviewRef.current?.reload()} title={t("browser.reload")}>
					<RefreshCw size={15} />
				</Button>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" onClick={() => loadUrl(DEFAULT_HOME)} title={t("browser.home")}>
					<Home size={15} />
				</Button>
				<div className="min-w-0 flex-1">
					<Input
						type="text"
						className="h-[30px] w-full rounded-md border border-border-subtle bg-bg-input px-2.5 text-[13px] text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
						value={inputValue}
						onChange={(event) => setInputValue(event.target.value)}
						onKeyDown={handleKeyDown}
						onFocus={(event) => event.target.select()}
						placeholder={t("browser.urlPlaceholder")}
					/>
				</div>
				<div className="relative flex shrink-0 items-center text-text-tertiary" ref={deviceMenuRef}>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className={`h-7 min-w-[68px] gap-1 border border-border-subtle bg-bg-panel px-2 text-xs text-text-secondary outline-none focus-visible:shadow-[var(--focus-ring)]${deviceMenuOpen ? " border-[var(--color-accent)] bg-bg-hover text-[color:var(--color-accent)]" : ""} hover:border-[var(--color-accent)] hover:bg-bg-hover hover:text-[color:var(--color-accent)]`}
						onClick={() => setDeviceMenuOpen((open) => !open)}
						title={t("browser.deviceLabel")}
					>
						{deviceIcon}
						<span>{t(activeDevicePreset.label as any)}</span>
					</Button>
					{deviceMenuOpen && (
						<div className="absolute top-[calc(100%+6px)] right-0 z-30 min-w-[112px] rounded-md border border-border-subtle bg-bg-panel p-1 shadow-[var(--shadow-popover)]">
							{DEVICE_PRESETS.map((preset) => (
								<Button
									key={preset.id}
									type="button"
									variant="ghost"
									size="sm"
									className={`h-[30px] w-full items-center gap-[7px] rounded-sm px-2 text-xs text-text-secondary text-left${preset.id === device ? " bg-bg-active text-[color:var(--color-accent)]" : ""} hover:bg-bg-hover hover:text-[color:var(--color-accent)]`}
									onClick={() => selectDevice(preset.id)}
								>
									{preset.id === "mobile" ? <Smartphone size={13} /> : preset.id === "tablet" ? <Tablet size={13} /> : <span className="size-[13px] rounded-[3px] border border-current" />}
									<span>{t(preset.label as any)}</span>
								</Button>
							))}
						</div>
					)}
				</div>
				{props.isFullscreen ? (
					<>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" onClick={onMinimize} title={t("browser.minimize")}>
							<Minus size={15} />
						</Button>
<Button variant="ghost" size="icon-sm" className="size-[30px] rounded-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" onClick={onClose} title={t("browser.close")}>
							<X size={15} />
						</Button>
					</>
				) : null}
			</div>

			{isLoading && (
				<div className="h-0.5 shrink-0 overflow-hidden bg-bg-subtle">
					<div className="h-full bg-[var(--color-accent)] transition-[width] duration-150" style={{ width: `${Math.max(5, loadProgress * 100)}%` }} />
				</div>
			)}

			<div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-bg-subtle">
				<webview ref={(el) => { webviewRef.current = el; }} className="browser-webview" src={initialTab.url} />
			</div>
		</div>
	);
}
