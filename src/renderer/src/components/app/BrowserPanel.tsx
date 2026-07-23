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

/**
 * 浏览器状态要跨"抽屉模式/弹框模式"保留。
 * 这里用模块级状态保存轻量 tab 元数据，避免切换容器时丢 URL/标题/设备模式。
 * 真正的 WebContents 仍随组件挂载重建，避免同时运行两个 webview 实例。
 */
const moduleState: { tabs: TabEntry[]; activeTabId: string | null; device: DeviceType; navigateKey: number } = {
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
 * 如果没有标签页则创建一个，然后切换到该标签页并加载 URL。
 * 通过递增 navigateKey 触发 BrowserPanel 的 useEffect 执行导航。
 */
export function navigateTo(url: string) {
	ensureInitialTab();
	if (moduleState.activeTabId) {
		const activeTab = moduleState.tabs.find((t) => t.id === moduleState.activeTabId);
		if (activeTab) {
			activeTab.url = url;
		}
	} else {
		const id = genTabId();
		moduleState.tabs.push({ id, title: "PiDeck", url });
		moduleState.activeTabId = id;
	}
	moduleState.navigateKey += 1;
}

type WebviewEvent<T extends string> = T extends "did-navigate"
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
}) {
	const { onClose, onMinimize, onToggleFullscreen } = props;
	const initialTab = getInitialActiveTab();
	const webviewRef = useRef<any>(null);
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

	const applyDeviceUserAgent = useCallback((wv: any, nextDevice: DeviceType) => {
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
			wv.loadURL(targetUrl);
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

		let navigatedOnce = false;
		const onDomReady = () => {
			webviewReadyRef.current = true;
			// 仅首次 dom-ready 时消费外部导航（navigateTo 调用），
			// 避免后续每次页面加载都触发 loadURL 导致无限刷新。
			if (!navigatedOnce && moduleState.navigateKey > 0) {
				navigatedOnce = true;
				moduleState.navigateKey = 0;
				const activeTab = moduleState.tabs.find((t) => t.id === moduleState.activeTabId);
				if (activeTab) {
					applyDeviceUserAgent(wv, moduleState.device);
					wv.loadURL(activeTab.url);
				}
			}
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
		const onProgress = (event: Event) => {
			const progress = (event as unknown as WebviewEvent<"load-progress">).progress;
			setLoadProgress(progress);
		};
		const onPageTitleUpdated = (event: Event) => {
			const title = (event as unknown as WebviewEvent<"page-title-updated">).title;
			updateActiveTab({ title: title || url || DEFAULT_HOME });
		};
		const onNewWindow = (event: Event) => {
			const evt = event as unknown as WebviewEvent<"new-window">;
			if (!evt.url.startsWith("http://") && !evt.url.startsWith("https://")) {
				evt.preventDefault();
				void window.piDesktop.browser.openExternal(evt.url);
			}
		};

		wv.addEventListener("did-navigate", onDidNavigate);
		wv.addEventListener("did-navigate-in-page", onDidNavigateInPage);
		wv.addEventListener("did-start-loading", onDidStartLoading);
		wv.addEventListener("did-stop-loading", onDidStopLoading);
		wv.addEventListener("load-progress", onProgress);
		wv.addEventListener("page-title-updated", onPageTitleUpdated);
		wv.addEventListener("new-window", onNewWindow);

		return () => {
			wv.removeEventListener("dom-ready", onDomReady);
			wv.removeEventListener("did-navigate", onDidNavigate);
			wv.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
			wv.removeEventListener("did-start-loading", onDidStartLoading);
			wv.removeEventListener("did-stop-loading", onDidStopLoading);
			wv.removeEventListener("load-progress", onProgress);
			wv.removeEventListener("page-title-updated", onPageTitleUpdated);
			wv.removeEventListener("new-window", onNewWindow);
			webviewReadyRef.current = false;
		};
	}, [applyDeviceUserAgent, updateActiveTab, url]);

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
	const [navigateKey, setNavigateKey] = useState(0);
	useEffect(() => {
		if (moduleState.navigateKey === 0) return;
		setNavigateKey(moduleState.navigateKey);
	}, [navigateKey]);

	const closeTab = useCallback(
		(tabId: string, event: React.MouseEvent) => {
			event.stopPropagation();
			const current = moduleState.tabs;
			if (current.length <= 1) {
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
			<div className="browser-tabbar">
				{tabs.map((tab) => (
					<div
						key={tab.id}
						className={`browser-tab${tab.id === activeTabId ? " active" : ""}`}
						onClick={() => switchTab(tab.id)}
					>
						<span className="browser-tab-title">{tab.title || tab.url}</span>
						<button className="browser-tab-close" onClick={(event) => closeTab(tab.id, event)} title={t("browser.closeTab")}>
							<X size={11} />
						</button>
					</div>
				))}
				<button className="browser-tab-add" onClick={addTab} title={t("browser.newTab")}>
					<Plus size={14} />
				</button>
				{!props.isFullscreen && (
					<div className="browser-tabbar-actions">
						<button className="browser-tabbar-btn" onClick={onClose} title={t("common.close")}>
							<X size={14} />
						</button>
						<button className="browser-tabbar-btn" onClick={onToggleFullscreen} title={t("browser.fullscreen")}>
							<Maximize2 size={13} />
						</button>
					</div>
				)}
			</div>

			<div className="browser-toolbar">
				<button className="browser-nav-btn" disabled={!canGoBack} onClick={() => webviewRef.current?.goBack()} title={t("browser.back")}>
					<ArrowLeft size={15} />
				</button>
				<button className="browser-nav-btn" disabled={!canGoForward} onClick={() => webviewRef.current?.goForward()} title={t("browser.forward")}>
					<ArrowRight size={15} />
				</button>
				<button className="browser-nav-btn" onClick={() => webviewRef.current?.reload()} title={t("browser.reload")}>
					<RefreshCw size={15} />
				</button>
				<button className="browser-nav-btn" onClick={() => loadUrl(DEFAULT_HOME)} title={t("browser.home")}>
					<Home size={15} />
				</button>
				<div className="browser-url-bar">
					<input
						type="text"
						className="browser-url-input"
						value={inputValue}
						onChange={(event) => setInputValue(event.target.value)}
						onKeyDown={handleKeyDown}
						onFocus={(event) => event.target.select()}
						placeholder={t("browser.urlPlaceholder")}
					/>
				</div>
				<div className="browser-device-wrapper" ref={deviceMenuRef}>
					<button
						type="button"
						className={`browser-device-trigger${deviceMenuOpen ? " active" : ""}`}
						onClick={() => setDeviceMenuOpen((open) => !open)}
						title={t("browser.deviceLabel")}
					>
						{deviceIcon}
						<span>{t(activeDevicePreset.label as any)}</span>
					</button>
					{deviceMenuOpen && (
						<div className="browser-device-menu">
							{DEVICE_PRESETS.map((preset) => (
								<button
									key={preset.id}
									type="button"
									className={`browser-device-menu-item${preset.id === device ? " active" : ""}`}
									onClick={() => selectDevice(preset.id)}
								>
									{preset.id === "mobile" ? <Smartphone size={13} /> : preset.id === "tablet" ? <Tablet size={13} /> : <span className="browser-device-pc-dot" />}
									<span>{t(preset.label as any)}</span>
								</button>
							))}
						</div>
					)}
				</div>
				{props.isFullscreen ? (
					<>
						<button className="browser-nav-btn" onClick={onMinimize} title={t("browser.minimize")}>
							<Minus size={15} />
						</button>
						<button className="browser-nav-btn" onClick={onClose} title={t("browser.close")}>
							<X size={15} />
						</button>
					</>
				) : null}
			</div>

			{isLoading && (
				<div className="browser-loading-bar">
					<div className="browser-loading-fill" style={{ width: `${Math.max(5, loadProgress * 100)}%` }} />
				</div>
			)}

			<div className="browser-webview-stage">
				<webview ref={webviewRef} className="browser-webview" src={moduleState.navigateKey > 0 ? "about:blank" : initialTab.url} allowpopups={"true" as any} />
			</div>
		</div>
	);
}
