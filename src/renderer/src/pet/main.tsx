import React from "react";
import ReactDOM from "react-dom/client";
import { useState, useEffect } from "react";
import { DEFAULT_PET_SCALE, type AppFontBaseMode, type AppFontSizeMode, type PetAggregateState, type PetManifest, type PetNotification, type PetWindowCaps } from "@shared/types";
import { effectiveUIFontSize, petFontStack } from "@shared/petNotificationLayout";
import { PetOverlay } from "./PetOverlay";
import { PetInteraction } from "./PetInteraction";
import type { PetDragMode } from "./PetDragDirection";
import { loadSpriteSheet, type SpriteSheet } from "./PetSpriteSheet";
import "./pet.css";

/** 宠物窗需要的窄外观：缩放 + 有效 UI 字号档位 + 气泡字体栈（跟随 PiDeck 字体设置） */
type PetAppearance = { scale: number; fontMode: AppFontSizeMode; fontStack: string };

function readAppearance(s: { petScale?: number; fontSize?: AppFontSizeMode; uiFontSize?: AppFontSizeMode | null; fontFamilyBase?: AppFontBaseMode; fontFamilyBaseCustom?: string }): PetAppearance {
	return {
		scale: s.petScale ?? DEFAULT_PET_SCALE,
		fontMode: effectiveUIFontSize(s.uiFontSize, s.fontSize ?? "medium"),
		fontStack: petFontStack(s.fontFamilyBase ?? "system", s.fontFamilyBaseCustom ?? ""),
	};
}

function PetApp() {
	const [state, setState] = useState<PetAggregateState>({ mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: 0 });
	const [sprite, setSprite] = useState<SpriteSheet | null>(null);
	const [ready, setReady] = useState(false);
	const [dragMode, setDragMode] = useState<PetDragMode | null>(null);
	const [notif, setNotif] = useState<PetNotification | null>(null);
	const [preview, setPreview] = useState<string | null>(null);
	const [caps, setCaps] = useState<PetWindowCaps | null>(null);
	const [appearance, setAppearance] = useState<PetAppearance>({ scale: 1, fontMode: "medium", fontStack: petFontStack("system", "") });

	useEffect(() => {
		let cancelled = false;
		// 无论 manifest 是否为 null、加载是否失败都置 ready：
		// 否则窗口永久全透明且拦截鼠标（「开了没显示」的最隐蔽形态，2026-08 反馈）。
		// sprite 为 null 时 PetOverlay 走 FallbackCanvas emoji 兜底，至少有可见内容。
		const load = async (m: PetManifest | null) => {
			if (cancelled) return;
			if (m) {
				try {
					setSprite(await loadSpriteSheet(m));
				} catch {
					setSprite(null);
				}
			}
			setReady(true);
		};
		void window.piDesktop.pet
			.getCurrent()
			.then(load)
			.catch(() => {
				// IPC 异常（如主进程 handler 缺失）也不得留下透明窗口：兜底渲染
				if (!cancelled) setReady(true);
			});
		const cleanups = [
			window.piDesktop.pet.onSprite(load),
			window.piDesktop.pet.onState(setState),
			// 通知时钟在收到时以 performance.now() 起算（主进程 Date.now() 与本进程时钟域不同）；
			// 主进程负责计时：非持久化提醒 4s 后推 null，waiting 在 pending 清空后推 null
			window.piDesktop.pet.onNotify((n) => {
				if (!n) {
					setNotif(null);
					return;
				}
				setNotif({ ...n, timestamp: performance.now() });
			}),
			window.piDesktop.pet.onPreviewMode((m: string) => setPreview(m || null)),
			window.piDesktop.pet.onCaps(setCaps),
		];
		// 宠物窗只消费缩放与字号：设置变化由 PetSystem.reactToSettings 定向推送到本窗口
		void window.piDesktop.settings.get().then((s) => {
			if (!cancelled) setAppearance(readAppearance(s));
		});
		const offSettings = window.piDesktop.settings.onApplyWindow((s) => setAppearance(readAppearance(s)));
		cleanups.push(offSettings);
		// 通知主进程：所有 IPC 监听器已注册，可安全推送初始状态（避免时序竞态）
		window.piDesktop.pet.ready();
		return () => {
			cancelled = true;
			cleanups.forEach((fn) => fn?.());
		};
	}, []);

	if (!ready) return <div style={{ width: "100%", height: "100%", background: "transparent" }} />;

	// 拖拽方向是本地瞬时显示态；松手后立即恢复最新业务态。preview 仅用于设置页预览。
	const displayMode: PetAggregateState["mode"] = dragMode ?? (preview ? (preview as PetAggregateState["mode"]) : state.mode);
	const displayState: PetAggregateState = { ...state, mode: displayMode };

	return (
		<div className={`pet-root${caps && !caps.transparent ? " pet-root--rounded" : ""}`}>
			<PetOverlay sprite={sprite} manifest={null} state={displayState} notification={notif} scale={appearance.scale} fontMode={appearance.fontMode} fontStack={appearance.fontStack} />
			<PetInteraction state={state} onDragModeChange={setDragMode} canMove={caps?.freePosition !== false} />
		</div>
	);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<PetApp />
	</React.StrictMode>,
);
