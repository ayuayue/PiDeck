import { useEffect, useState } from "react";
import { Pin, Minus, Square, X } from "lucide-react";
import { t } from "../i18n";
import { BridgeGuiSlot, useBridgeChromeSessionId } from "./bridge/BridgeSlot";

type Props = {
	useNativeTitleBar: boolean;
	/** mac 用系统红绿灯，不再渲染右侧 Win 风格 min/max/close。 */
	platform: NodeJS.Platform;
	toggleAlwaysOnTop: () => Promise<boolean>;
	/** 读取主进程当前是否置顶（初始化按钮态，避免与实际状态错位） */
	isWindowAlwaysOnTop: () => Promise<boolean>;
	minimizeWindow: () => void;
	/** 切换最大化并返回切换后是否最大化 */
	toggleMaximizeWindow: () => Promise<boolean>;
	isWindowMaximized: () => Promise<boolean>;
	onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
	closeWindow: () => void;
};

/** Windows 风格「还原」图标：前后错位的两个方框（最大化态显示）。 */
function RestoreIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none">
			<rect x="3.25" y="1.75" width="6.5" height="6.5" stroke="currentColor" strokeWidth="1.35" />
			<rect x="1.75" y="3.75" width="6.5" height="6.5" stroke="currentColor" strokeWidth="1.35" fill="var(--color-bg-sidebar, #fff)" />
		</svg>
	);
}

export function AppHeader({ useNativeTitleBar, platform, toggleAlwaysOnTop, isWindowAlwaysOnTop, minimizeWindow, toggleMaximizeWindow, isWindowMaximized, onWindowMaximizedChange, closeWindow }: Props) {
	const [windowAlwaysOnTop, setWindowAlwaysOnTop] = useState(false);
	const [maximized, setMaximized] = useState(false);
	// GUI 扩展桥：标题栏是应用级单实例 chrome，按「当前聚焦会话」取桥状态。
	// （桥的运行时状态本就按 runtimeGeneration 存，detach 即清，见 §7.7。）
	const bridgeChromeSessionId = useBridgeChromeSessionId();

	useEffect(() => {
		if (useNativeTitleBar) return;
		let alive = true;
		// 置顶按钮态必须向主进程读取真实状态：若窗口已置顶而按钮硬编码 false，
		// 会出现「开关显示关、实际置顶」，且点击一次只是取消置顶却显示仍是关。
		void isWindowAlwaysOnTop().then((value) => {
			if (alive) setWindowAlwaysOnTop(value);
		});
		void isWindowMaximized().then((value) => {
			if (alive) setMaximized(value);
		});
		const unsubscribe = onWindowMaximizedChange((value) => {
			if (alive) setMaximized(value);
		});
		return () => {
			alive = false;
			unsubscribe();
		};
	}, [useNativeTitleBar, isWindowAlwaysOnTop, isWindowMaximized, onWindowMaximizedChange]);

	if (useNativeTitleBar) return null;

	// hiddenInset 已经画了系统红绿灯；再画一套 Win 控件就是「左右都有关闭键」。
	const showWinWindowControls = platform !== "darwin";

	return (
		<>
			<div className="window-drag-layer" aria-hidden="true" />
			{/* GUI 扩展桥：窗口/标签栏动作落点（ctx.gui.setTitlebarAction）。
			    必须显式 `-webkit-app-region: no-drag` —— app-region **不继承**，
			    祖先的 drag 会让点击被 Electron 的拖拽命中规则吞掉（§8.2 titlebar 注意事项）。
			    无贡献时返回 null，不占位、不吃拖拽区。 */}
			<BridgeGuiSlot sessionId={bridgeChromeSessionId} slot="titlebar.action" className="window-controls flex items-center gap-1" />
			{showWinWindowControls ? (
				<div className="window-controls" aria-label={t("app.windowControls")}>
					<button
						type="button"
						className={`window-control pin${windowAlwaysOnTop ? " active" : ""}`}
						aria-label={windowAlwaysOnTop ? t("app.windowUnpin") : t("app.windowPin")}
						title={windowAlwaysOnTop ? t("app.windowUnpin") : t("app.windowPin")}
						onClick={async () => {
							const next = await toggleAlwaysOnTop();
							setWindowAlwaysOnTop(next);
						}}
					>
						<Pin size={12} strokeWidth={2.2} aria-hidden="true" />
					</button>
					<button type="button" className="window-control" aria-label={t("app.windowMinimize")} title={t("app.windowMinimize")} onClick={() => minimizeWindow()}>
						<Minus size={12} strokeWidth={2.2} aria-hidden="true" />
					</button>
					<button
						type="button"
						className="window-control"
						aria-label={maximized ? t("app.windowRestore") : t("app.windowMaximize")}
						title={maximized ? t("app.windowRestore") : t("app.windowMaximize")}
						onClick={() => {
							// 只采信主进程返回的意图态；maximize/unmaximize 事件用事件名推送，
							// 不再乐观翻转（否则会与迟到/过期的 isMaximized 读数互踩成「要点两次」）。
							void toggleMaximizeWindow().then((next) => setMaximized(next));
						}}
					>
						{maximized ? <RestoreIcon /> : <Square size={11} strokeWidth={2} aria-hidden="true" />}
					</button>
					<button type="button" className="window-control close" aria-label={t("app.windowClose")} title={t("app.windowClose")} onClick={() => closeWindow()}>
						<X size={13} strokeWidth={2.2} aria-hidden="true" />
					</button>
				</div>
			) : null}
		</>
	);
}
