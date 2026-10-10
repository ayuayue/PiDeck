import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { openInSystemBrowser } from "../../utils/openExternal";
import { showNotice } from "../../utils/notice";
import { writeClipboard } from "../../utils/clipboard";
import { ChevronDown, ChevronUp, MoreHorizontal, Plus, X } from "lucide-react";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Button } from "../ui-shadcn/button";
import { BridgeGuiSlot, useBridgeSessionId } from "../bridge/BridgeSlot";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import type { PiDesktopApi } from "../../../../preload";
import type { TerminalShell, TerminalTarget } from "../../../../shared/types";
import type { TerminalConfirmCloseMode, TerminalCursorStyle, TerminalThemeId } from "../../../../shared/types/settings";
import { useTerminalDockTabs } from "../../hooks/useTerminalDockTabs";
import { TERMINAL_THEME_DEFS, resolveTerminalTheme } from "../../terminalThemes";
import { t } from "../../i18n";
import { appendTerminalReplayBuffer } from "../../terminalDockState";

/** 字体族兕底：xterm 需要具体字体串（canvas 测量），不能用 var() */
const TERMINAL_FALLBACK_FONT_FAMILY = '"Cascadia Mono", Consolas, monospace';
/** 字号兜底（px）：与 --font-size-control 的出厂值一致 */
const TERMINAL_FALLBACK_FONT_SIZE = 13;

/** 终端外观设置（AppSettings 子集；由调用方透传，本组件不自己读 settings） */
export type TerminalDockSettings = {
	themeId: TerminalThemeId;
	fontSize: number | null;
	fontFamily: string;
	scrollback: number;
	cursorStyle: TerminalCursorStyle;
	cursorBlink: boolean;
	copyOnSelect: boolean;
	paddingY: number;
	confirmClose: TerminalConfirmCloseMode;
	startupCommand: string;
};

/**
 * 字体解析（终端创建与热更新两处共用）：
 * - 字体族：设置为空则跟随外观的代码字体 token（--font-family-mono）；
 * - 字号：设置为 null 则跟随 UI 字号档（--font-size-control）。
 * xterm 走 canvas 测量，必须拿到具体字体串与像素值，不能传 var()。
 */
function resolveTerminalFont(settings: TerminalDockSettings): { fontFamily: string; fontSize: number } {
	const rootStyle = getComputedStyle(document.documentElement);
	return {
		fontFamily: settings.fontFamily.trim() || rootStyle.getPropertyValue("--font-family-mono").trim() || TERMINAL_FALLBACK_FONT_FAMILY,
		fontSize: settings.fontSize ?? (Number.parseFloat(rootStyle.getPropertyValue("--font-size-control")) || TERMINAL_FALLBACK_FONT_SIZE),
	};
}

const TERMINAL_OPEN_ANIMATION_MS = 300;

export function TerminalDock(props: {
	target: TerminalTarget;
	open: boolean;
	closing: boolean;
	collapsed: boolean;
	height: number;
	terminal: PiDesktopApi["terminal"];
	/** 终端外观设置（来自 AppSettings 子集；由调用方透传，本组件不自己读 settings） */
	terminalSettings: TerminalDockSettings;
	/** 终端主题改为可配置后，dock 内的主题菜单写回设置（单一数据源） */
	onThemeChange: (themeId: TerminalThemeId) => void;
	onCollapsedChange: (collapsed: boolean) => void;
	onHeightChange: (height: number) => void;
	onClose: () => void;
	/** 可选：终端归属键（agent:<id> / project:<id>）；缺省时按 target 推导 */
	sessionKey?: string;
}) {
	const dockRef = useRef<HTMLElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	// 桥落点跟随聚焦会话（共享 chrome 策略，见 terminal.toolbar 挂载处注释）
	const bridgeSessionId = useBridgeSessionId();
	const xtermRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const webglRef = useRef<WebglAddon | null>(null);
	const serializeRef = useRef<SerializeAddon | null>(null);
	const activeTabIdRef = useRef("");
	const buffersRef = useRef<Record<string, string>>({});
	/** 待注入启动命令的 tabId：shell 首个提示符输出后注入一次，避免被 shell 初始化覆盖 */
	const pendingStartupCommandRef = useRef<Set<string>>(new Set());
	/** 启动命令走 ref 读取：onData 订阅不能因设置变更重建，重建窗口内到达的数据事件会丢掉首个提示符触发点 */
	const startupCommandRef = useRef(props.terminalSettings.startupCommand);
	// 归属键：决定加载 gate 与 pending 占位判断；project 终端由父级显式传入
	const sessionKey = props.sessionKey ?? (props.target.kind === "agent" ? `agent:${props.target.agentId}` : `project:${props.target.projectId}`);
	const { open, collapsed } = props;
	const [themeMenuOpen, setThemeMenuOpen] = useState(false);
	const [contentReady, setContentReady] = useState(false);
	const [motionOpen, setMotionOpen] = useState(false);
	const [appTheme, setAppTheme] = useState(() => document.documentElement.dataset.theme ?? "light");
	/** 壁纸模式：终端背景跟随输出区同档透明度（canvas/DOM 渲染的背景必须走 JS） */
	const [wallpaperMode, setWallpaperMode] = useState(() => document.documentElement.dataset.bgImage === "on");
	/** 可用 shell 列表 */
	const [shells, setShells] = useState<{ shell: string; label: string; available: boolean }[]>([]);
	const [shellMenuOpen, setShellMenuOpen] = useState(false);
	const { tabs, activeTab, loading, pendingCloseTab, confirmCloseAllOpen, setActiveTabId, setPendingCloseTab, markExited, addTab, closeTab, performCloseTab, requestCloseAllTabs, closeAllTabs, cancelCloseAll } = useTerminalDockTabs({
		target: props.target,
		terminal: props.terminal,
		enabled: open && contentReady && Boolean(sessionKey) && !sessionKey.startsWith("pending-"),
		confirmClose: props.terminalSettings.confirmClose,
		onHydrate(nextTabs) {
			for (const tab of nextTabs) buffersRef.current[tab.id] = tab.buffer ?? buffersRef.current[tab.id] ?? "";
		},
		onCreated(tab) {
			// 启动命令只注入新标签，不对恢复的终端重跑命令。
			if (startupCommandRef.current.trim()) pendingStartupCommandRef.current.add(tab.id);
		},
		onClosed(tabIds) {
			for (const id of tabIds) {
				pendingStartupCommandRef.current.delete(id);
				delete buffersRef.current[id];
			}
		},
		onClose: props.onClose,
		onExpand: () => props.onCollapsedChange(false),
	});
	const themeId = props.terminalSettings.themeId;
	// 主题解析的唯一入口：inherit 按应用明暗取 pi-soft 亮/暗版，显式主题不分明暗。
	const resolvedTheme = useMemo(() => resolveTerminalTheme(themeId, appTheme), [themeId, appTheme]);
	/** 更多菜单里的主题候选：inherit（跟随应用）+ 各显式主题 */
	const themeOptions = useMemo(() => [{ id: "inherit" as TerminalThemeId, label: t("settings.terminal.theme.inherit") }, ...TERMINAL_THEME_DEFS.map((def) => ({ id: def.id as TerminalThemeId, label: def.label }))], []);
	const xtermTheme = useMemo(() => {
		const base = resolvedTheme.xterm;
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
			const raw = getComputedStyle(document.documentElement).getPropertyValue("--wallpaper-panel-alpha").trim();
			const mix = Number.parseFloat(raw);
			const alpha = Number.isFinite(mix) ? Math.min(1, Math.max(0, mix / 100)) : 0.8;
			const alphaHex = Math.round(alpha * 255)
				.toString(16)
				.padStart(2, "0");
			return { ...base, background: `${base.background}${alphaHex}` };
		}
		return base;
	}, [resolvedTheme, wallpaperMode]);

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
		const timer = window.setTimeout(() => setContentReady(true), TERMINAL_OPEN_ANIMATION_MS);
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

	// 主题值从 TypeScript 单一数据源注入 CSS 变量，替代 foundation.css 里按 data-theme
	// 硬编码的 5 套变量块（双份定义会漂移）。壁纸透明规则仍由 CSS 的 !important 负责
	// （inline 变量优先级更高，故那条规则改为 !important）——与改动前行为一致。
	useEffect(() => {
		const el = dockRef.current;
		if (!el) return;
		for (const [key, value] of Object.entries(resolvedTheme.css)) el.style.setProperty(key, value);
		// inherit 暗色主题在 CSS 里原本额外带 box-shadow: none，转为变量保留该例外
		if (resolvedTheme.transparentShadow) el.style.setProperty("--terminal-shadow", "none");
		else el.style.removeProperty("--terminal-shadow");
	}, [resolvedTheme]);

	useEffect(() => {
		activeTabIdRef.current = activeTab?.id ?? "";
	}, [activeTab?.id]);

	useEffect(() => {
		startupCommandRef.current = props.terminalSettings.startupCommand;
	}, [props.terminalSettings.startupCommand]);

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
			// 回放缓冲与主进程对齐截尾到 200K：只作 xterm 重建回放源，不能无限常驻
			buffersRef.current[payload.tabId] = appendTerminalReplayBuffer(buffersRef.current[payload.tabId] ?? "", payload.data);
			if (payload.tabId === activeTabIdRef.current) {
				xtermRef.current?.write(payload.data);
			}
			// 启动命令注入：必须等 shell 自己的首个提示符输出后再写，否则会被 shell 初始化覆盖。
			// 每个 tabId 只注入一次（Set 去重），tab 关闭时从 Set 移除。
			if (pendingStartupCommandRef.current.has(payload.tabId)) {
				pendingStartupCommandRef.current.delete(payload.tabId);
				const command = startupCommandRef.current.trim();
				if (command) void props.terminal.input(payload.tabId, `${command}\r`);
			}
		});
		const offExit = props.terminal.onExit((payload) => {
			pendingStartupCommandRef.current.delete(payload.tabId);
			markExited(payload.tabId, payload.exitCode);
			const exitText = `\r\n[process exited${payload.exitCode != null ? ` with code ${payload.exitCode}` : ""}]\r\n`;
			buffersRef.current[payload.tabId] = appendTerminalReplayBuffer(buffersRef.current[payload.tabId] ?? "", exitText);
			if (payload.tabId === activeTabIdRef.current) xtermRef.current?.write(exitText);
		});
		return () => {
			offData();
			offExit();
		};
	}, [props.terminal, markExited]);

	useEffect(() => {
		// 必须捕获本次 effect 对应的 tab id：cleanup 执行时 activeTab 已切换到新 tab，
		// 读 activeTab.id 会把新 tab 的空内容写进旧 tab 的缓存槽。
		const effectTabId = activeTab?.id;
		xtermRef.current = null;
		fitRef.current = null;
		webglRef.current = null;
		serializeRef.current = null;
		if (collapsed || !contentReady || !activeTab || !containerRef.current) return;

		const { fontFamily, fontSize } = resolveTerminalFont(props.terminalSettings);
		const terminal = new Terminal({
			fontFamily,
			fontSize,
			// scrollback 刻意不进依赖数组：xterm 缩小 scrollback 会立即丢弃历史且不可恢复
			// （实测），所以该项只在「新建终端」时生效，设置页文案已说明。
			scrollback: props.terminalSettings.scrollback,
			cursorStyle: props.terminalSettings.cursorStyle,
			cursorBlink: props.terminalSettings.cursorBlink,
			// Unicode11Addon 依赖 proposed API（否则 loadAddon 抛
			// "You must set the allowProposedApi option to true to use proposed API"）。
			// 本组件只用 unicode.activeVersion 一个 proposed 入口，代价可控。
			allowProposedApi: true,
			theme: xtermTheme,
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		// 渲染器顺序：先 WebGL2（GPU 渲染，大输出量下比 DOM 渲染器流畅得多），
		// 再搜索/回放序列化/Unicode 宽度，最后链接点击。
		// allowTransparency 不设置：PiDeck 走 CSS 层透明（实测 WebGL 下与 DOM 渲染器逐像素一致），
		// 再开 xterm 自己的透明通道是重复实现。
		try {
			const webgl = new WebglAddon();
			// WebGL 上下文可能因 OOM / 系统休眠被浏览器回收；丢失时 dispose 回退 DOM 渲染器，
			// 终端本身不受影响（官方 README 推荐的兜底方式）。
			webgl.onContextLoss(() => {
				if (webglRef.current !== webgl) return;
				webglRef.current = null;
				webgl.dispose();
			});
			terminal.loadAddon(webgl);
			webglRef.current = webgl;
		} catch (error) {
			// 部分 Windows 机器/驱动不支持 WebGL2：静默回退 DOM 渲染器，不给用户报错
			console.warn("[TerminalDock] WebGL renderer unavailable, falling back to DOM renderer", error);
		}
		// SearchAddon 已装配（后续搜索栏 UI 直接可用），本组件暂不持引用
		terminal.loadAddon(new SearchAddon());
		const serialize = new SerializeAddon();
		terminal.loadAddon(serialize);
		serializeRef.current = serialize;
		const unicode11 = new Unicode11Addon();
		terminal.loadAddon(unicode11);
		terminal.unicode.activeVersion = "11";
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
			// 用 SerializeAddon 导出可回放内容（含转义序列），写入缓存供下次挂载恢复。
			// 这替代了主进程 200k 裸字符串截断的乱码问题 —— 后者会切坏转义序列。
			// 主进程原始缓冲仍在（ensure 重水化用），平时 onData 也仍走 200k 截尾：
			// 只有同一次挂载生命周期内的 tab 切换才用序列化快照（见上）。
			if (effectTabId) {
				const snapshot = serializeRef.current?.serialize({ scrollback: props.terminalSettings.scrollback });
				if (snapshot) buffersRef.current[effectTabId] = snapshot;
			}
			if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
			window.cancelAnimationFrame(focusFrame);
			observer.disconnect();
			dataDisposable.dispose();
			// 尽早归还 GPU 资源：上下文丢失路径可能已 dispose，这里只在仍持有时收尾。
			if (webglRef.current) {
				webglRef.current.dispose();
				webglRef.current = null;
			}
			terminal.dispose();
			// 右键复制等异步完成后可能再读 ref；卸载后不允许聚焦已销毁的 xterm。
			if (xtermRef.current === terminal) {
				xtermRef.current = null;
				fitRef.current = null;
				serializeRef.current = null;
			}
		};
		// xtermTheme 刻意不在依赖里：改主题走下面的热更新 effect 更新 options，
		// 否则每次换配色都会销毁重建终端、丢掉 scrollback 与光标位置。
	}, [activeTab, collapsed, contentReady, props.terminal]);

	// 字体/光标/主题热更新：xterm 6.0 支持运行时改 options（实测生效），
	// 无需销毁终端。改完必须 refit —— 字号变化会改变列数/行数，尺寸要同步给 PTY。
	useEffect(() => {
		const terminal = xtermRef.current;
		if (!terminal) return;
		const { fontFamily, fontSize } = resolveTerminalFont(props.terminalSettings);
		terminal.options.fontFamily = fontFamily;
		terminal.options.fontSize = fontSize;
		terminal.options.cursorStyle = props.terminalSettings.cursorStyle;
		terminal.options.cursorBlink = props.terminalSettings.cursorBlink;
		// theme 必须整体换新对象：xterm 按引用比较（实测热更新生效）
		terminal.options.theme = xtermTheme;
		fitRef.current?.fit();
		if (activeTab && !activeTab.exited) void props.terminal.resize(activeTab.id, terminal.cols, terminal.rows);
	}, [props.terminalSettings.fontFamily, props.terminalSettings.fontSize, props.terminalSettings.cursorStyle, props.terminalSettings.cursorBlink, xtermTheme, activeTab, props.terminal]);

	// 选区即复制（可选）：xterm 的 selection 是终端内部数据，只能靠事件回读。
	useEffect(() => {
		const terminal = xtermRef.current;
		if (!terminal || !props.terminalSettings.copyOnSelect) return;
		const disposable = terminal.onSelectionChange(() => {
			const selection = terminal.getSelection();
			if (selection) void writeClipboard(selection);
		});
		return () => disposable.dispose();
		// 必须与 xterm 创建条件同步；折叠、退出或重挂都会换实例，不只是换 tab id。
	}, [props.terminalSettings.copyOnSelect, activeTab, collapsed, contentReady, props.terminal]);

	useEffect(() => {
		fitRef.current?.fit();
		if (activeTab && xtermRef.current && !activeTab.exited) {
			void props.terminal.resize(activeTab.id, xtermRef.current.cols, xtermRef.current.rows);
		}
	}, [props.height, activeTab, props.terminal]);

	useEffect(() => {
		if (collapsed || !contentReady || !activeTab || activeTab.exited) return;
		const frame = requestAnimationFrame(() => xtermRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [activeTab?.id, activeTab?.exited, collapsed, contentReady]);

	/* copyNotice cleanup 已禁用（改为 toast sonner） */

	async function addTabWithShell(shell: string) {
		setShellMenuOpen(false);
		await addTab(shell as TerminalShell);
	}

	async function copySelectionOnContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
		const terminal = xtermRef.current;
		const selection = terminal?.getSelection();
		if (!selection) return;

		// xterm 默认右键会落到浏览器菜单；选区存在时直接复制，符合桌面终端的右键复制习惯。
		event.preventDefault();
		event.stopPropagation();
		const copied = await writeClipboard(selection);
		if (xtermRef.current !== terminal) return;
		if (copied) showNotice(t("terminal.copied"), 1200);
		terminal?.focus();
	}

	function focusTerminalSoon() {
		window.requestAnimationFrame(() => xtermRef.current?.focus());
	}

	// #115 U5：dock 高度由外层 react-resizable-panels 面板持有（分隔条拖拽），
	// 手写 pointer 拖拽与 .terminal-resize-handle 已删除；这里充满父面板即可。
	return (
		<section ref={dockRef} className={`terminal-dock${collapsed ? " collapsed" : ""}`} data-theme={resolvedTheme.dataTheme} data-open={open} data-motion-state={props.closing || !motionOpen ? "hidden" : "visible"} style={{ height: "100%" }}>
			<header className="terminal-dock-header flex shrink-0 items-center justify-between gap-2 border-b px-2">
				{/* Shell 下拉菜单 absolute 向上弹出会超出 terminal-tabs（overflow-hidden）而被裁剪，
			    所以左侧整体包一层无 overflow 的容器，选择器独立于 tabs 滚动域之外 */}
				<div className="flex min-w-0 items-center">
					<div className="terminal-tabs flex min-w-0 items-center gap-0.5 overflow-hidden">
						{tabs.map((tab) => (
							<div key={tab.id} className={`terminal-tab inline-flex max-w-[9rem] items-center gap-0.5 rounded-md px-0.5 pl-2${tab.id === activeTab?.id ? " active" : ""}`}>
								<Button
									variant="ghost"
									size="sm"
									className="terminal-tab-label h-auto min-w-0 flex-1 justify-start truncate px-2 py-0.5 max-w-[6.5rem] min-w-0 flex-1 truncate text-left"
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
									variant="ghost"
									size="icon-xs"
									className="terminal-tab-close size-5 grid size-5 shrink-0 place-items-center rounded-sm opacity-60"
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
						<Button type="button" variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 shrink-0 place-items-center rounded-md" onClick={() => void addTab()} title={t("terminal.new")} disabled={loading || !contentReady}>
							<Plus size={14} />
						</Button>
					</div>
					{/* Shell 选择器：点击创建指定 shell 的终端。必须用 Portal 化的 Popover——
				    dock 挂在 react-resizable-panels 的 Panel 里，Panel 内层是 overflow:auto
				    容器，菜单向上弹出会被裁剪（表现为「下拉没有值」）；Popover 渲染到 body，
				    不受任何祖先 overflow 影响，且自带碰撞翻转与外部点击关闭。 */}
					<Popover open={shellMenuOpen} onOpenChange={setShellMenuOpen}>
						<PopoverTrigger asChild>
							<Button type="button" variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md" title={t("terminal.selectShell")} disabled={loading || !contentReady}>
								<ChevronDown size={12} />
							</Button>
						</PopoverTrigger>
						<PopoverContent side="top" align="start" className="w-44 gap-0.5 p-1.5">
							<strong className="px-1 py-0.5 text-xs">{t("terminal.selectShell")}</strong>
							{shells.length === 0 && <span className="block px-1 py-1 text-micro text-muted-foreground">{t("terminal.shellEmpty")}</span>}
							{shells.map((s) => (
								<Button
									key={s.shell}
									type="button"
									variant="ghost"
									size="sm"
									className={`h-auto w-full justify-start rounded-md px-2 py-1 text-left text-xs hover:bg-accent${s.available ? "" : " unavailable opacity-50"}`}
									onClick={() => {
										if (!s.available) return;
										void addTabWithShell(s.shell);
									}}
									title={s.available ? undefined : t("terminal.shellNotAvailable")}
								>
									{s.label}
								</Button>
							))}
						</PopoverContent>
					</Popover>
				</div>
				<div className="terminal-actions flex shrink-0 items-center gap-0.5">
					<Popover open={themeMenuOpen} onOpenChange={setThemeMenuOpen}>
						<PopoverTrigger asChild>
							<Button type="button" variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md" title={t("terminal.more")}>
								<MoreHorizontal size={14} />
							</Button>
						</PopoverTrigger>
						<PopoverContent side="top" align="end" className="w-48 gap-1 p-2">
							<strong className="px-1 text-xs">{t("terminal.theme")}</strong>
							<span className="px-1 text-micro text-muted-foreground">
								{t("terminal.themeCurrent")}: {themeOptions.find((option) => option.id === themeId)?.label ?? themeId}
							</span>
							{themeOptions.map((option) => (
								<Button
									key={option.id}
									type="button"
									variant="ghost"
									size="sm"
									className={`h-auto w-full justify-start rounded-md px-2 py-1 text-left text-xs hover:bg-accent${option.id === themeId ? " active bg-accent" : ""}`}
									onClick={() => {
										props.onThemeChange(option.id);
										setThemeMenuOpen(false);
									}}
								>
									{option.label}
								</Button>
							))}
						</PopoverContent>
					</Popover>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md"
						onClick={() => {
							props.onCollapsedChange(!collapsed);
							focusTerminalSoon();
						}}
						title={collapsed ? t("terminal.expand") : t("terminal.collapse")}
					>
						{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</Button>
					<Button type="button" variant="ghost" size="icon-xs" className="terminal-icon-btn size-6 inline-grid size-6 place-items-center rounded-md" onClick={() => void requestCloseAllTabs()} title={t("terminal.closeAll")} disabled={tabs.length === 0}>
						<X size={14} />
					</Button>
				</div>
			</header>
			{/* GUI 扩展桥：终端面板头部工具区落点（ctx.gui.setTerminalToolbar）。
			    跟随聚焦会话的贡献（共享 chrome，与 AppHeader titlebar.action 同策略）；无贡献不占位。 */}
			<BridgeGuiSlot sessionId={bridgeSessionId} slot="terminal.toolbar" className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-0.5 text-xs" />
			{!collapsed && (
				<div className="terminal-pane-shell" style={{ paddingTop: props.terminalSettings.paddingY, paddingBottom: props.terminalSettings.paddingY }} onPointerDownCapture={focusTerminalSoon} onContextMenu={(event) => void copySelectionOnContextMenu(event)}>
					{(loading || !contentReady) && <div className="terminal-placeholder">{t("terminal.starting")}</div>}
					<div ref={containerRef} className="terminal-xterm" />
					{/* copyNotice 已改用 toast (sonner) 实现 */}
				</div>
			)}
			{confirmCloseAllOpen && <ConfirmDialog title={t("terminal.closeAllConfirm")} message={t("terminal.closeAllDescription")} confirmLabel={t("terminal.closeAll")} danger onConfirm={() => void closeAllTabs()} onCancel={cancelCloseAll} />}
			{pendingCloseTab && (
				<ConfirmDialog
					title={t("terminal.closeTabConfirm")}
					message={t("terminal.closeTabConfirmDesc")}
					confirmLabel={t("terminal.closeCurrent")}
					danger
					onConfirm={() => {
						const tab = pendingCloseTab;
						setPendingCloseTab(null);
						void performCloseTab(tab);
					}}
					onCancel={() => setPendingCloseTab(null)}
				/>
			)}
		</section>
	);
}
