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
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import type { PiDesktopApi } from "../../../../preload";
import type { TerminalTab } from "../../../../shared/types";

const TERMINAL_THEMES = {
	"pi-soft": {
		label: "Pi Soft",
		xterm: {
			background: "#eef2f7",
			foreground: "#243244",
			cursor: "#16a34a",
			selectionBackground: "#bbf7d0",
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

function stripReplayBuffer(tab: TerminalTab): TerminalTab {
	const { buffer: _buffer, ...rest } = tab;
	return rest;
}

export function TerminalDock(props: {
	agentId: string;
	height: number;
	terminal: PiDesktopApi["terminal"];
	onHeightChange: (height: number) => void;
	onClose: () => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const activeTabIdRef = useRef("");
	const buffersRef = useRef<Record<string, string>>({});
	const copyNoticeTimerRef = useRef<number | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	const [tabs, setTabs] = useState<TerminalTab[]>([]);
	const [activeTabId, setActiveTabId] = useState("");
	const [themeId, setThemeId] = useState<TerminalThemeId>("pi-soft");
	const [confirmCloseAllOpen, setConfirmCloseAllOpen] = useState(false);
	const [copyNotice, setCopyNotice] = useState(false);
	const [loading, setLoading] = useState(false);
	const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
	const theme = TERMINAL_THEMES[themeId];

	useEffect(() => {
		activeTabIdRef.current = activeTab?.id ?? "";
	}, [activeTab?.id]);

	useEffect(() => {
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
	}, [props.agentId, props.terminal]);

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
		xtermRef.current?.dispose();
		xtermRef.current = null;
		fitRef.current = null;
		if (collapsed || !activeTab || !containerRef.current) return;

		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily: '"Cascadia Mono", Consolas, monospace',
			fontSize: 12.5,
			scrollback: 5000,
			theme: theme.xterm,
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
	}, [activeTab, collapsed, props.terminal, theme.xterm]);

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
		if (collapsed || !activeTab || activeTab.exited) return;
		requestAnimationFrame(() => xtermRef.current?.focus());
	}, [activeTab?.id, activeTab?.exited, collapsed]);

	useEffect(
		() => () => {
			if (copyNoticeTimerRef.current) window.clearTimeout(copyNoticeTimerRef.current);
		},
		[],
	);

	async function addTab() {
		const next = await props.terminal.create(props.agentId);
		setTabs((current) => [...current, stripReplayBuffer(next)]);
		setActiveTabId(next.id);
		setCollapsed(false);
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
		setCopyNotice(true);
		if (copyNoticeTimerRef.current) window.clearTimeout(copyNoticeTimerRef.current);
		copyNoticeTimerRef.current = window.setTimeout(
			() => setCopyNotice(false),
			1200,
		);
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
			style={{ height: collapsed ? 34 : props.height }}
		>
			<div
				className="terminal-resize-handle"
				onPointerDown={startResize}
				title="拖动调整终端高度"
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
									setCollapsed(false);
									focusTerminalSoon();
								}}
								title={tab.cwd}
							>
								{tab.title}
								{tab.exited ? " · exited" : ""}
							</button>
							<button
								className="terminal-tab-close"
								onClick={(event) => {
									event.stopPropagation();
									void closeTab(tab);
								}}
								title="关闭当前终端"
							>
								<X size={12} />
							</button>
						</div>
					))}
					<button
						className="terminal-icon-btn"
						onClick={() => void addTab()}
						title="新建终端"
						disabled={loading}
					>
						<Plus size={14} />
					</button>
				</div>
				<div className="terminal-actions">
					<select
						className="terminal-theme-select"
						value={themeId}
						onChange={(event) =>
							setThemeId(event.target.value as TerminalThemeId)
						}
						title="切换终端主题"
					>
						{Object.entries(TERMINAL_THEMES).map(([id, item]) => (
							<option key={id} value={id}>
								{item.label}
							</option>
						))}
					</select>
					<button
						className="terminal-icon-btn"
						onClick={() => {
							setCollapsed((value) => !value);
							focusTerminalSoon();
						}}
						title={collapsed ? "展开终端" : "收起终端"}
					>
						{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</button>
					<button
						className="terminal-icon-btn"
						onClick={() => setConfirmCloseAllOpen(true)}
						title="关闭全部终端"
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
					{loading && <div className="terminal-placeholder">正在启动终端…</div>}
					<div ref={containerRef} className="terminal-xterm" />
					{copyNotice && <div className="terminal-copy-notice">已复制</div>}
				</div>
			)}
			{confirmCloseAllOpen && (
				<div className="terminal-confirm-backdrop">
					<div className="terminal-confirm">
						<strong>关闭全部终端？</strong>
						<p>正在运行的命令会被终止，此操作不能撤销。</p>
						<div className="terminal-confirm-actions">
							<button onClick={() => setConfirmCloseAllOpen(false)}>
								取消
							</button>
							<button
								className="danger"
								onClick={() => void closeAllTabs()}
							>
								关闭全部
							</button>
						</div>
					</div>
				</div>
			)}
		</section>
	);
}
