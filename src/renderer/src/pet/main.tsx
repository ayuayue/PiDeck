import React from "react";
import ReactDOM from "react-dom/client";
import { useState, useEffect } from "react";
import type { PetAggregateState, PetManifest, PetNotification, PetWindowCaps } from "@shared/types";
import { PetOverlay } from "./PetOverlay";
import { PetInteraction } from "./PetInteraction";
import { loadSpriteSheet, type SpriteSheet } from "./PetSpriteSheet";
import "./pet.css";

/**
 * 宠物窗根组件：
 *  1. 启动时读取当前 settings.petId 对应的 PetManifest，加载 spritesheet；
 *  2. 订阅 pet:state 推送，驱动 PetOverlay 按聚合状态切帧。
 *
 * sprite 加载完成前不渲染任何可见内容（透明占位），杜绝「先闪错误宠物」的问题。
 */
function PetApp() {
	const [state, setState] = useState<PetAggregateState>({
		mode: "idle",
		runningCount: 0,
		errorCount: 0,
		activeAgentId: null,
		timestamp: 0,
	});
	const [sprite, setSprite] = useState<SpriteSheet | null>(null);
	const [spriteReady, setSpriteReady] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [notification, setNotification] = useState<PetNotification | null>(null);
	const [previewMode, setPreviewMode] = useState<string | null>(null);
	const [caps, setCaps] = useState<PetWindowCaps | null>(null);

	// 挂载时主动拉取当前选中宠物 manifest 加载 sprite，避免主进程推送早于监听注册而丢失
	useEffect(() => {
		let cancelled = false;
		const load = async (manifest: PetManifest | null) => {
			if (!manifest || cancelled) return;
			try {
				setSprite(await loadSpriteSheet(manifest));
			} catch {
				setSprite(null);
			}
			setSpriteReady(true);
		};
		void window.piDesktop.pet.getCurrent().then(load);
		const off = window.piDesktop.pet.onSprite(load);
		const offState = window.piDesktop.pet.onState((s) => setState(s));
		const offNotify = window.piDesktop.pet.onNotify((n) => {
			// 用 performance.now() 打时间戳，与 PetOverlay 内淡入淡出计算同源
			setNotification({ ...n, timestamp: performance.now() });
			setTimeout(() => setNotification(null), 4000);
		});
		const offPreview = window.piDesktop.pet.onPreviewMode((mode: string) => { setPreviewMode(mode || null); });
		const offCaps = window.piDesktop.pet.onCaps((c) => { setCaps(c); });
		return () => { cancelled = true; off(); offState(); offNotify(); offPreview?.(); offCaps?.(); };
	}, []);

	// sprite 加载完成前不渲染任何可见内容——杜绝启动时闪现错误宠物或 FallbackCanvas
	if (!spriteReady) {
		return <div style={{ width: "100%", height: "100%", background: "transparent" }} />;
	}

	return (
		<div className={`pet-root${caps && !caps.transparent ? " pet-root--rounded" : ""}`}>
			<PetOverlay
				sprite={sprite}
				manifest={null}
				state={previewMode ? { ...state, mode: previewMode as PetAggregateState["mode"] } : state}
				dragging={dragging}
				notification={notification}
			/>
			<PetInteraction state={state} onDragStateChange={setDragging} />
		</div>
	);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<PetApp />
	</React.StrictMode>,
);