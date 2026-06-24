import React from "react";
import ReactDOM from "react-dom/client";
import { useState, useEffect, useCallback } from "react";
import type { PetAggregateState, PetManifest } from "@shared/types";
import { PetOverlay } from "./PetOverlay";
import { PetInteraction } from "./PetInteraction";
import { loadSpriteSheet, type SpriteSheet } from "./PetSpriteSheet";
import "./pet.css";

/**
 * 宠物窗根组件：
 *  1. 启动时读取当前 settings.petId 对应的 PetManifest，加载 spritesheet；
 *  2. 订阅 pet:state 推送，驱动 PetOverlay 按聚合状态切帧。
 *
 * sprite 加载失败时 PetOverlay 自动降级为程序化状态绘制，保证无素材也能显示。
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
	const [dragging, setDragging] = useState(false);

	// 挂载时主动拉取当前选中宠物 manifest 加载 sprite，避免主进程推送早于监听注册而丢失
	useEffect(() => {
		let cancelled = false;
		const load = async (manifest: PetManifest | null) => {
			if (!manifest || cancelled) return;
			try {
				setSprite(await loadSpriteSheet(manifest));
			} catch {
				setSprite(null); // 加载失败降级为程序化状态绘制
			}
		};
		void window.piDesktop.pet.getCurrent().then(load);
		const off = window.piDesktop.pet.onSprite(load);
		const offState = window.piDesktop.pet.onState((s) => setState(s));
		return () => { cancelled = true; off(); offState(); };
	}, []);

	return (
		<div className="pet-root">
			<PetOverlay sprite={sprite} manifest={null} state={state} dragging={dragging} />
			<PetInteraction state={state} onDragStateChange={setDragging} />
		</div>
	);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<PetApp />
	</React.StrictMode>,
);