import React from "react";
import ReactDOM from "react-dom/client";
import { useState, useEffect } from "react";
import type { PetAggregateState, PetManifest, PetNotification, PetWindowCaps } from "@shared/types";
import { PetOverlay } from "./PetOverlay";
import { PetInteraction } from "./PetInteraction";
import { loadSpriteSheet, type SpriteSheet } from "./PetSpriteSheet";
import "./pet.css";

function PetApp() {
	const [state, setState] = useState<PetAggregateState>({ mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: 0 });
	const [sprite, setSprite] = useState<SpriteSheet | null>(null);
	const [ready, setReady] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [notif, setNotif] = useState<PetNotification | null>(null);
	const [preview, setPreview] = useState<string | null>(null);
	const [caps, setCaps] = useState<PetWindowCaps | null>(null);

	useEffect(() => {
		let cancelled = false;
		const load = async (m: PetManifest | null) => {
			if (!m || cancelled) return;
			try { setSprite(await loadSpriteSheet(m)); } catch { setSprite(null); }
			setReady(true);
		};
		void window.piDesktop.pet.getCurrent().then(load);
		const cleanups = [
			window.piDesktop.pet.onSprite(load),
			window.piDesktop.pet.onState(setState),
			window.piDesktop.pet.onNotify((n) => { setNotif({ ...n, timestamp: performance.now() }); setTimeout(() => setNotif(null), 4000); }),
			window.piDesktop.pet.onPreviewMode((m: string) => setPreview(m || null)),
			window.piDesktop.pet.onCaps(setCaps),
		];
		return () => { cancelled = true; cleanups.forEach(fn => fn?.()); };
	}, []);

	if (!ready) return <div style={{ width: "100%", height: "100%", background: "transparent" }} />;

	return (
		<div className={`pet-root${caps && !caps.transparent ? " pet-root--rounded" : ""}`}>
			<PetOverlay sprite={sprite} manifest={null} state={preview ? { ...state, mode: preview as PetAggregateState["mode"] } : state} dragging={dragging} notification={notif} />
			<PetInteraction state={state} onDragStateChange={setDragging} />
		</div>
	);
}

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><PetApp /></React.StrictMode>);
