import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { openInSystemBrowser } from "../../utils/openExternal";
import { showNotice } from "../../utils/notice";
import { writeClipboard } from "../../utils/clipboard";
import { ChevronDown, ChevronUp, MoreHorizontal, Plus, X } from "lucide-react";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Button } from "../ui-shadcn/button";
import type { PiDesktopApi } from "../../../../preload";
import type { SessionRuntimeTarget, TerminalTab } from "../../../../shared/types";
import { t } from "../../i18n";

const TERMINAL_THEMES = {
	"pi-soft": {
		label: "Pi Soft",
		xterm: {
			background: "#ffffff",
			foreground: "#243244",
			cursor: "#18181b",
			selectionBackground: "#e4e4e7",
		},
		xtermDark: {
			background: "#09090b",
			foreground: "#e4e4e7",
			cursor: "#fafafa",
			selectionBackground: "#3f3f46",
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
	target: SessionRuntimeTarget;
	open: boolean;
	closing: boolean;
	collapsed: boolean;
	height: number;
	terminal: PiDesktopApi["terminal"];
	onCollapsedChange: (collapsed: boolean) => void;
	onHeightChange: (height: number) => void;
	onClose: () => void;
	/** 可选：终端 owner 键；缺省时用 agentId */
	sessionKey?: string;
	/** 无 agent 时作为 CWD 的项目路径 */
	projectCwd?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const activeTabIdRef = useRef("");
	const buffersRef = useRef<Record<string, string>>({});
	const sessionKey = props.sessionKey ?? props.target.agentId;
	const effectiveCwd =
		sessionKey && sessionKey.startsWith("cwd:") ? props.projectCwd : undefined;
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
	/** 壁纸模式：终端背景跟随输出区同档透明度（canvas/DOM 渲染的背景必须走 JS） */
	const [wallpaperMode, setWallpaperMode] = useState(
		() => document.documentElement.dataset.bgImage === "on",
	);
	/** 可用 shell 列表 */
	const [shells, setShells] = useState<
		{ shell: string; label: string; available: boolean }[]
	>([]);
	const [shellMenuOpen, setShellMenuOpen] = useState(false);
	const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
	const theme = TERMINAL_THEMES[themeId];
	const xtermTheme = useMemo(() => {
		const base =
			themeId === "pi-soft" && appTheme === "dark" && "xtermDark" in theme
				? theme.xtermDark
				: theme.xterm;
		if (!wallpaperMode || !base.background.startsWith("#")) return base;
		// 注：xterm 的颜色解析只支持 hex（含 9 位 #RRGGBBAA），
		// "transparent"/rgba() 会解析失败回退黑色——必须输出 hex+alpha。
		if (base.background.length === 7) {
			const hex = base.background.slice(1);
			const r = Number.parseInt(hex.slice(0, 2), 16);
			const g = Number.parseInt(hex.slice(2, 4), 16);
			const b = Number.parseInt(hex.slice(4, 6), 16);
			const isLight = (r + g + b) / 3 > 128;
			if (isLight) {
				// 浅色主题：全透明（#RRGGBB00），透出 chat-pane 单层，与输出区同透明度。
				return { ...base, background: `${base.background}00` };
			}
			// 深色主题：保留主题底色 + 全局面板档 alpha（深底深透，浅字仍可读）。
			const raw = getComputedStyle(document.documentElement)
				.getPropertyValue("--wallpaper-panel-alpha")
				.trim();
			const mix = Number.parseFloat(raw);
			const alpha = Number.isFinite(mix) ? Math.min(1, Math.max(0, mix / 100)) : 0.8;
			const alphaHex = Math.round(alpha * 255)
				.toString(16)
				.padStart(2, "0");
			return { ...base, background: `${base.background}${alphaHex}` };
		}
		return base;
	}, [themeId, appTheme, wallpaperMode]);
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
			setWallpaperMode(root.dataset.bgImage === "on");
		});
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["data-theme", "data-bg-image"],
		});
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		activeTabIdRef.current = activeTab?.id ?? "";
	}, [activeTab?.id]);

	useEffect(() => {
		if (!open || !contentReady || !sessionKey) return;
		// pending-* 是渲染层占位，主进程还没有对应 agent runtime
		if (sessionKey.startsWith("pending-")) return;
		let cancelled = false;
		async function loadTabs() {
			setLoading(true);
			try {
				const nextTabs = await props.terminal.ensure(props.target);
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
			} catch (error) {
				// ensure 失败不能变成 unhandled rejection：Mac 上会表现为启动 agent 后终端报错/像闪退
				if (!cancelled) {
					setTabs([]);
					setActiveTabId("");
					const message = error instanceof Error ? error.message : String(error);
					// Agent 尚未就绪时的竞态：静默跳过，等真实 agentId 再挂载
					if (!/Agent not found/i.test(message)) {
						showNotice(message, 4000, "error");
					}
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		void loadTabs();
		return () => {
			cancelled = true;
		};
	}, [
		props.target.sessionId,
		props.target.agentId,
		props.target.runtimeGeneration,
		props.terminal,
		open,
		contentReady,
	]);

	// 独立加载可用 shell 列表，避免与 loadTabs 耦合
	useEffect(() => {
		if (!open || !contentReady) return;
		let cancelled = false;
		void props.terminal
			.shells()
			.then((list) => {
				if (!cancelled) setShells(list);
			})
			.catch(() => {
				// shell 列表失败不阻断终端主体
				if (!cancelled) setShells([]);
			});
		return () => {
			cancelled = true;
		};
	}, [props.terminal, open, contentReady]);

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
		// 终端内 URL 可点：交给系统浏览器，与消息区链接策略一致（#115 U3）
		terminal.loadAddon(new WebLinksAddon((_event, uri) => openInSystemBrowser(uri)));
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

	async function addTabWithShell(_shell: string) {
		// 当前 preload API 仅支持 create(target)；shell 选择先走默认 create，后续再扩展参数。
		setShellMenuOpen(false);
		await addTab();
	}

	async function addTab() {
		const next = await props.terminal.create(props.target);
		setTabs((current) => [...current, stripReplayBuffer(next)]);
		setActiveTabId(next.id);
		props.onCollapsedChange(false);
	}

	async function closeTab(tab: TerminalTab) {
		try {
			await props.terminal.close(tab.id);
		} catch {
			// tab 可能已退出；继续做本地清理
		}
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
		await writeClipboard(selection);
		showNotice(t("terminal.copied"), 1200);
		xtermRef.current?.focus();
	}

	function focusTerminalSoon() {
		window.requestAnimationFrame(() => xtermRef.current?.focus());
	}


	// #115 U5：dock 高度由外层 react-resizable-panels 面板持有（分隔条拖拽），
	// 手写 pointer 拖拽与 .terminal-resize-handle 已删除；这里充满父面板即可。
	return (
		<section
			className={`terminal-dock${collapsed ? " collapsed" : ""}`}
			data-theme={themeId}
			data-open={open}
			data-motion-state={props.closing || !motionOpen ? "hidden" : "visible"}
			style={{ height: "100%" }}
		>
		<header className="terminal-dock-header flex shrink-0 items-center justify-between gap-2 border-b px-2">
			<div className="terminal-tabs flex min-w-0 items-center gap-0.5 overflow-hidden">
				{tabs.map((tab) => (
					<div
						key={tab.id}
						className={`terminal-tab inline-flex max-w-[9rem] items-center gap-0.5 rounded-md px-0.5 pl-2${tab.id === activeTab?.id ? " active" : ""}`}
					>
						<Button
							variant="ghost" size="sm" className="terminal-tab-label h-auto min-w-0 flex-1 justify-start truncate px-2 py-0.5 max-w-[6.5rem] min-w-0 flex-1 truncate text-left"
							onClick={() => {
								setActiveTabId(tab.id);
								props.onCollapsedChange(false);
								focusTerminalSoon();
							}}
							title={tab.cwd}
						>
							{tab.title}
							{tab.exited ? ` · ${t("terminal.exited")}` : ""}
						</Button>
						<Button
							type="button"
							variant="ghost" size="icon-xs" className="terminal-tab-close size-5 grid size-5 shrink-0 place-items-center rounded-sm opacity-60"
							onClick={(event) => {
								event.stopPropagation();
								void closeTab(tab);
							}}
							title={t("terminal.closeCurrent")}
						>
							<X size={12} />
						</Button>
					</div>
				))}
				<Button
					type="button"
					variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 shrink-0 place-items-center rounded-md"
					onClick={() => void addTab()}
					title={t("terminal.new")}
					disabled={loading || !contentReady}
				>
					<Plus size={14} />
				</Button>
				{/* Shell 选择器：点击创建指定 shell 的终端 */}
				<div
					className="relative grid place-items-center"
				>
					<Button
						type="button"
						variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md"
						onClick={() => setShellMenuOpen((open) => !open)}
						title={t("terminal.selectShell")}
						disabled={loading || !contentReady}
					>
						<ChevronDown size={12} />
					</Button>
					{shellMenuOpen && (
						<div className="terminal-shell-menu absolute bottom-[calc(100%+6px)] left-0 z-[120] grid w-44 gap-0.5 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-md">
							<strong className="px-1 text-xs">{t("terminal.selectShell")}</strong>
							{shells.length === 0 && (
								<span className="terminal-shell-menu-empty" />
							)}
							{shells.map((s) => (
								<Button
									key={s.shell}
									type="button"
									variant="ghost"
									size="sm"
									className={`h-auto w-full justify-start rounded-md px-2 py-1 px-2 py-1 text-left text-xs hover:bg-accent${s.available ? "" : " unavailable opacity-50"}`}
									onClick={() => {
										if (!s.available) return;
										void addTabWithShell(s.shell);
									}}
									title={s.available ? undefined : t("terminal.shellNotAvailable")}
								>
									{s.label}
								</Button>
							))}
						</div>
					)}
					{/* 点击菜单外部关闭 */}
					{shellMenuOpen && (
						<div
							className="fixed inset-0 z-[119]"
							onClick={() => setShellMenuOpen(false)}
						/>
					)}
				</div>
			</div>
			<div className="terminal-actions flex shrink-0 items-center gap-0.5">
				<div
					className="terminal-more-menu relative grid place-items-center"
					onBlur={() => window.setTimeout(() => setThemeMenuOpen(false), 80)}
				>
					<Button
						type="button"
						variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md"
						onMouseDown={(event) => {
							event.preventDefault();
							setThemeMenuOpen((open) => !open);
						}}
						title={t("terminal.more")}
					>
						<MoreHorizontal size={14} />
					</Button>
					{themeMenuOpen && (
						<div className="terminal-theme-menu absolute right-0 bottom-[calc(100%+6px)] z-[120] grid w-48 gap-1 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md">
							<strong className="px-1 text-xs">{t("terminal.theme")}</strong>
							<span className="px-1 text-[11px] text-muted-foreground">{t("terminal.themeCurrent")}: {theme.label}</span>
							{Object.entries(TERMINAL_THEMES).map(([id, item]) => (
								<Button
									key={id}
									type="button"
									variant="ghost"
									size="sm"
									className={`h-auto w-full justify-start rounded-md px-2 py-1 px-2 py-1 text-left text-xs hover:bg-accent${id === themeId ? " active bg-accent" : ""}`}
									onMouseDown={(event) => {
										event.preventDefault();
										setThemeId(id as TerminalThemeId);
										setThemeMenuOpen(false);
									}}
								>
									{item.label}
								</Button>
							))}
						</div>
					)}
				</div>
				<Button
					type="button"
					variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md"
					onClick={() => {
						props.onCollapsedChange(!collapsed);
						focusTerminalSoon();
					}}
					title={collapsed ? t("terminal.expand") : t("terminal.collapse")}
				>
					{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
				</Button>
				<Button
					type="button"
					variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md"
					onClick={() => setConfirmCloseAllOpen(true)}
					title={t("terminal.closeAll")}
					disabled={tabs.length === 0}
				>
					<X size={14} />
				</Button>
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
				<ConfirmDialog
					title={t("terminal.closeAllConfirm")}
					message={t("terminal.closeAllDescription")}
					confirmLabel={t("terminal.closeAll")}
					danger
					onConfirm={() => void closeAllTabs()}
					onCancel={() => setConfirmCloseAllOpen(false)}
				/>
			)}
		</section>
	);
}
