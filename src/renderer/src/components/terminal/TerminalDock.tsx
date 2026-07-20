import {
	useEffect,
	useRef,
	useState,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { showNotice } from "../../utils/notice";
import { ChevronDown, ChevronUp, MoreHorizontal, Plus, X } from "lucide-react";
import type { PiDesktopApi } from "../../../../preload";
import type { TerminalTab } from "../../../../shared/types";
import { t } from "../../i18n";

const TERMINAL_THEMES = {
	"pi-soft": {
		label: "Pi Soft",
		xterm: {
			background: "#ffffff",
			foreground: "#243244",
			cursor: "#16a34a",
			selectionBackground: "#d9f0e0",
		},
		xtermDark: {
			background: "#15191d",
			foreground: "#d9e2dc",
			cursor: "#35c45a",
			selectionBackground: "#1f3f2b",
		},
	},
	"solarized-light": {
		label: "Solarized Light",
		xterm: {
			background: "#fdf6e3",
			foreground: "#657b83",
			cursor: "#268bd2",
			selectionBackground: "#eee8d5",
		},
	},
	"solarized-dark": {
		label: "Solarized Dark",
		xterm: {
			background: "#002b36",
			foreground: "#839496",
			cursor: "#2aa198",
			selectionBackground: "#073642",
		},
	},
	"one-dark": {
		label: "One Dark",
		xterm: {
			background: "#282c34",
			foreground: "#abb2bf",
			cursor: "#98c379",
			selectionBackground: "#3e4451",
		},
	},
	monokai: {
		label: "Monokai",
		xterm: {
			background: "#272822",
			foreground: "#f8f8f2",
			cursor: "#a6e22e",
			selectionBackground: "#49483e",
		},
	},
} as const;

type TerminalThemeId = keyof typeof TERMINAL_THEMES;

const TERMINAL_OPEN_ANIMATION_MS = 300;

function stripReplayBuffer(tab: TerminalTab): TerminalTab {
	const { buffer: _buffer, ...rest } = tab;
	return rest;
}

export function TerminalDock(props: {
	agentId: string;
	open: boolean;
	closing: boolean;
	collapsed: boolean;
	height: number;
	terminal: PiDesktopApi["terminal"];
	onCollapsedChange: (collapsed: boolean) => void;
	onHeightChange: (height: number) => void;
	onClose: () => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const activeTabIdRef = useRef("");
	const buffersRef = useRef<Record<string, string>>({});
	/* copyNotice 已改用 toast (sonner) 实现 */
	const [tabs, setTabs] = useState<TerminalTab[]>([]);
	const [activeTabId, setActiveTabId] = useState("");
	const [themeId, setThemeId] = useState<TerminalThemeId>("pi-soft");
	const [themeMenuOpen, setThemeMenuOpen] = useState(false);
	const [confirmCloseAllOpen, setConfirmCloseAllOpen] = useState(false);
	/* copyNotice 已改用 toast (sonner) 实现 */
	const [loading, setLoading] = useState(false);
	const [contentReady, setContentReady] = useState(false);
	const [motionOpen, setMotionOpen] = useState(false);
	const [appTheme, setAppTheme] = useState(
		() => document.documentElement.dataset.theme ?? "light",
	);
	const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
	const theme = TERMINAL_THEMES[themeId];
	const xtermTheme =
		themeId === "pi-soft" && appTheme === "dark" && "xtermDark" in theme
			? theme.xtermDark
			: theme.xterm;
	const { open, collapsed } = props;

	useEffect(() => {
		if (props.closing) return;
		const frame = window.requestAnimationFrame(() => setMotionOpen(true));
		return () => window.cancelAnimationFrame(frame);
	}, [props.closing]);

	// Grid 行高每帧变化时，xterm 的首次 fit 和缓冲区回放会抢占主线程。
	// 先完成面板开场动画，再初始化终端，避免入口点击出现掉帧。
	useEffect(() => {
		if (!open) {
			setContentReady(false);
			return;
		}
		const timer = window.setTimeout(
			() => setContentReady(true),
			TERMINAL_OPEN_ANIMATION_MS,
		);
		return () => window.clearTimeout(timer);
	}, [open]);

	useEffect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => {
			setAppTheme(root.dataset.theme ?? "light");
		});
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		activeTabIdRef.current = activeTab?.id ?? "";
	}, [activeTab?.id]);

	useEffect(() => {
		if (!open || !contentReady) return;
		let cancelled = false;
		async function loadTabs() {
			setLoading(true);
			try {
				const nextTabs = await props.terminal.ensure(props.agentId);
				if (cancelled) return;
				buffersRef.current = nextTabs.reduce<Record<string, string>>(
					(current, tab) => ({
						...current,
						[tab.id]: tab.buffer ?? current[tab.id] ?? "",
					}),
					{ ...buffersRef.current },
				);
				setTabs(nextTabs.map(stripReplayBuffer));
				setActiveTabId(nextTabs[0]?.id ?? "");
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		void loadTabs();
		return () => {
			cancelled = true;
		};
	}, [props.agentId, props.terminal, open, contentReady]);

	useEffect(() => {
		const offData = props.terminal.onData((payload) => {
			buffersRef.current[payload.tabId] =
				(buffersRef.current[payload.tabId] ?? "") + payload.data;
			if (payload.tabId === activeTabIdRef.current) {
				xtermRef.current?.write(payload.data);
			}
		});
		const offExit = props.terminal.onExit((payload) => {
			setTabs((current) =>
				current.map((tab) =>
					tab.id === payload.tabId
						? { ...tab, exited: true, exitCode: payload.exitCode }
						: tab,
				),
			);
			const exitText = `\r\n[process exited${payload.exitCode != null ? ` with code ${payload.exitCode}` : ""}]\r\n`;
			buffersRef.current[payload.tabId] =
				(buffersRef.current[payload.tabId] ?? "") + exitText;
			if (payload.tabId === activeTabIdRef.current) xtermRef.current?.write(exitText);
		});
		return () => {
			offData();
			offExit();
		};
	}, [props.terminal]);

	useEffect(() => {
		xtermRef.current = null;
		fitRef.current = null;
		if (collapsed || !contentReady || !activeTab || !containerRef.current) return;

		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily: '"PiDeckCommitMono", "Cascadia Mono", Consolas, monospace',
			fontSize: 13,
			scrollback: 5000,
			theme: xtermTheme,
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(containerRef.current);
		let resizeFrame: number | null = null;
		const dataDisposable = terminal.onData((data) => {
			if (!activeTab.exited) void props.terminal.input(activeTab.id, data);
		});
		const resize = () => {
			fit.fit();
			if (!activeTab.exited) {
				void props.terminal.resize(activeTab.id, terminal.cols, terminal.rows);
			}
		};
		const scheduleResize = () => {
			if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
			resizeFrame = window.requestAnimationFrame(() => {
				resizeFrame = null;
				resize();
			});
		};
		const observer = new ResizeObserver(scheduleResize);
		observer.observe(containerRef.current);
		resize();
		terminal.write(buffersRef.current[activeTab.id] ?? "", () => {
			terminal.scrollToBottom();
			scheduleResize();
		});

		xtermRef.current = terminal;
		fitRef.current = fit;
		const focusFrame = window.requestAnimationFrame(() => {
			scheduleResize();
			terminal.focus();
		});
		return () => {
			if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
			window.cancelAnimationFrame(focusFrame);
			observer.disconnect();
			dataDisposable.dispose();
			terminal.dispose();
		};
	}, [activeTab, collapsed, contentReady, props.terminal, xtermTheme]);

	useEffect(() => {
		fitRef.current?.fit();
		if (activeTab && xtermRef.current && !activeTab.exited) {
			void props.terminal.resize(
				activeTab.id,
				xtermRef.current.cols,
				xtermRef.current.rows,
			);
		}
	}, [props.height, activeTab, props.terminal]);

	useEffect(() => {
		if (collapsed || !contentReady || !activeTab || activeTab.exited) return;
		requestAnimationFrame(() => xtermRef.current?.focus());
	}, [activeTab?.id, activeTab?.exited, collapsed, contentReady]);

	/* copyNotice cleanup 已禁用（改为 toast sonner） */

	async function addTab() {
		const next = await props.terminal.create(props.agentId);
		setTabs((current) => [...current, stripReplayBuffer(next)]);
		setActiveTabId(next.id);
		props.onCollapsedChange(false);
	}

	async function closeTab(tab: TerminalTab) {
		await props.terminal.close(tab.id);
		delete buffersRef.current[tab.id];
		const nextTabs = tabs.filter((item) => item.id !== tab.id);
		setTabs(nextTabs);
		if (nextTabs.length === 0) {
			props.onClose();
			return;
		}
		if (tab.id === activeTab?.id) {
			setActiveTabId(nextTabs[nextTabs.length - 1].id);
		}
	}

	async function closeAllTabs() {
		if (tabs.length === 0) return;
		await Promise.all(tabs.map((tab) => props.terminal.close(tab.id)));
		buffersRef.current = {};
		setTabs([]);
		setConfirmCloseAllOpen(false);
		props.onClose();
	}

	async function copySelectionOnContextMenu(
		event: ReactMouseEvent<HTMLDivElement>,
	) {
		const selection = xtermRef.current?.getSelection();
		if (!selection) return;

		// xterm 默认右键会落到浏览器菜单；选区存在时直接复制，符合桌面终端的右键复制习惯。
		event.preventDefault();
		event.stopPropagation();
		await navigator.clipboard.writeText(selection);
		showNotice(t("terminal.copied"), 1200);
		xtermRef.current?.focus();
	}

	function focusTerminalSoon() {
		window.requestAnimationFrame(() => xtermRef.current?.focus());
	}

	function startResize(event: PointerEvent<HTMLDivElement>) {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = props.height;
		document.body.classList.add("is-terminal-resizing");

		const move = (moveEvent: globalThis.PointerEvent) => {
			const next = Math.min(
				420,
				Math.max(120, startHeight - (moveEvent.clientY - startY)),
			);
			props.onHeightChange(next);
		};
		const up = () => {
			document.body.classList.remove("is-terminal-resizing");
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	return (
		<section
			className={`terminal-dock${collapsed ? " collapsed" : ""}`}
			data-theme={themeId}
			data-open={open}
			data-motion-state={props.closing || !motionOpen ? "hidden" : "visible"}
			style={{ height: collapsed ? 34 : props.height }}
		>
			<div
				className="terminal-resize-handle"
				onPointerDown={startResize}
				title={t("terminal.resize")}
			/>
			<header className="terminal-dock-header">
				<div className="terminal-tabs">
					{tabs.map((tab) => (
						<div
							key={tab.id}
							className={`terminal-tab${tab.id === activeTab?.id ? " active" : ""}`}
						>
							<button
								className="terminal-tab-label"
								onClick={() => {
									setActiveTabId(tab.id);
									props.onCollapsedChange(false);
									focusTerminalSoon();
								}}
								title={tab.cwd}
							>
								{tab.title}
								{tab.exited ? ` · ${t("terminal.exited")}` : ""}
							</button>
							<button
								className="terminal-tab-close"
								onClick={(event) => {
									event.stopPropagation();
									void closeTab(tab);
								}}
								title={t("terminal.closeCurrent")}
							>
								<X size={12} />
							</button>
						</div>
					))}
					<button
						className="terminal-icon-btn"
						onClick={() => void addTab()}
						title={t("terminal.new")}
						disabled={loading || !contentReady}
					>
						<Plus size={14} />
					</button>
				</div>
				<div className="terminal-actions">
					<div
						className="terminal-more-menu"
						onBlur={() => window.setTimeout(() => setThemeMenuOpen(false), 80)}
					>
						<button
							className="terminal-icon-btn"
							onMouseDown={(event) => {
								event.preventDefault();
								setThemeMenuOpen((open) => !open);
							}}
							title={t("terminal.more")}
						>
							<MoreHorizontal size={14} />
						</button>
						{themeMenuOpen && (
							<div className="terminal-theme-menu">
								<strong>{t("terminal.theme")}</strong>
								<span>{t("terminal.themeCurrent")}: {theme.label}</span>
								{Object.entries(TERMINAL_THEMES).map(([id, item]) => (
									<button
										key={id}
										className={id === themeId ? "active" : ""}
										onMouseDown={(event) => {
											event.preventDefault();
											setThemeId(id as TerminalThemeId);
											setThemeMenuOpen(false);
										}}
									>
										{item.label}
									</button>
								))}
							</div>
						)}
					</div>
					<button
						className="terminal-icon-btn"
						onClick={() => {
							props.onCollapsedChange(!collapsed);
							focusTerminalSoon();
						}}
						title={collapsed ? t("terminal.expand") : t("terminal.collapse")}
					>
						{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</button>
					<button
						className="terminal-icon-btn"
						onClick={() => setConfirmCloseAllOpen(true)}
						title={t("terminal.closeAll")}
						disabled={tabs.length === 0}
					>
						<X size={14} />
					</button>
				</div>
			</header>
			{!collapsed && (
				<div
					className="terminal-pane-shell"
					onPointerDownCapture={focusTerminalSoon}
					onContextMenu={(event) => void copySelectionOnContextMenu(event)}
				>
					{(loading || !contentReady) && <div className="terminal-placeholder">{t("terminal.starting")}</div>}
					<div ref={containerRef} className="terminal-xterm" />
					{/* copyNotice 已改用 toast (sonner) 实现 */}
				</div>
			)}
			{confirmCloseAllOpen && (
				<div className="terminal-confirm-backdrop">
					<div className="terminal-confirm">
						<strong>{t("terminal.closeAllConfirm")}</strong>
						<p>{t("terminal.closeAllDescription")}</p>
						<div className="terminal-confirm-actions">
							<button onClick={() => setConfirmCloseAllOpen(false)}>
								{t("common.cancel")}
							</button>
							<button
								className="danger"
								onClick={() => void closeAllTabs()}
							>
								{t("terminal.closeAll")}
							</button>
						</div>
					</div>
				</div>
			)}
		</section>
	);
}
