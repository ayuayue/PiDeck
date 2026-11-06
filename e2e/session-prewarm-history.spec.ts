import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const project = makeSeedProject("prewarm-history");
const title = "Prewarm history";
const entries: unknown[] = [{ type: "session", version: 3, id: "prewarm-header", parentId: null, name: title, cwd: project.path, timestamp: new Date(Date.now() - 60_000).toISOString() }];
for (let index = 1; index <= 12; index += 1) {
	entries.push(
		{ type: "message", id: `prewarm-u${index}`, parentId: index === 1 ? "prewarm-header" : `prewarm-a${index - 1}`, timestamp: new Date(Date.now() - 55_000 + index * 1_000).toISOString(), message: { role: "user", content: [{ type: "text", text: `history-question-${index}` }] } },
		{ type: "message", id: `prewarm-a${index}`, parentId: `prewarm-u${index}`, timestamp: new Date(Date.now() - 54_500 + index * 1_000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `history-answer-${index}\n${"persisted context line\n".repeat(8)}` }], stopReason: "stop" } },
	);
}

test.use({ seedProjects: [project], seedSessionFiles: [{ projectPath: project.path, entries }], seedSettings: { sessionTabOpenMode: "permanent", processGroupDisplay: true } });

for (const delayHistory of [false, true])
	test(`typing to prewarm loaded history preserves rows, the composer and settled animations${delayHistory ? " during an empty runtime window" : ""}`, async ({ app, window }) => {
		await app.evaluate(({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes("selection-tool"));
			if (win?.isMaximized()) win.unmaximize();
			win?.setBounds({ width: 1000, height: 650 });
		});
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await window.getByRole("tab", { name: "项目", exact: true }).click();
		await window
			.getByRole("button", { name: new RegExp(project.name) })
			.first()
			.press("Enter");
		await window
			.getByRole("button", { name: new RegExp(title) })
			.first()
			.click();
		await expect(window.locator(".message-timeline")).toContainText("history-answer-12", { timeout: 20_000 });
		await window.waitForTimeout(350); // 初次读盘的合法入场动画完成后才观测预热。
		const sessionId = await window.locator('[role="tab"][data-session-id][aria-selected="true"]').getAttribute("data-session-id");
		expect(sessionId).toBeTruthy();
		expect(await window.evaluate(() => window.piDesktop.sessions.listRuntimes())).toHaveLength(0);
		const probe = await window.evaluateHandle(() => {
			const composer = document.querySelector<HTMLElement>(".composer .rich-input");
			const rows = Array.from(document.querySelectorAll<HTMLElement>(".message-timeline .turn-row"));
			const animations: string[] = [];
			let loading = false;
			let empty = false;
			let lostRows = false;
			let lostComposer = false;
			let lostEditable = false;
			let trackingFocus = false;
			let focusOuts = 0;
			let flushes = 0;
			const observe = () => {
				loading ||= Boolean(document.querySelector(".history-loading"));
				empty ||= Boolean(document.querySelector(".session-start-surface"));
				lostRows ||= rows.some((row) => !row.isConnected);
				lostComposer ||= !composer?.isConnected;
				if (trackingFocus) lostEditable ||= !composer?.isContentEditable;
			};
			const onFocusOut = () => {
				if (trackingFocus) focusOuts += 1;
			};
			composer?.addEventListener("focusout", onFocusOut);
			const readSelection = () => {
				const selection = document.getSelection();
				if (!composer || !selection?.anchorNode || !selection.focusNode || !composer.contains(selection.anchorNode) || !composer.contains(selection.focusNode)) return null;
				const offset = (node: Node, position: number) => {
					const range = document.createRange();
					range.selectNodeContents(composer);
					range.setEnd(node, position);
					return range.toString().length;
				};
				return { anchor: offset(selection.anchorNode, selection.anchorOffset), focus: offset(selection.focusNode, selection.focusOffset), collapsed: selection.isCollapsed };
			};
			const observer = new MutationObserver(observe);
			observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "contenteditable"] });
			const onAnimation = (event: AnimationEvent) => {
				if (event.target instanceof Element && event.target.closest(".message-timeline-host")) animations.push(event.animationName);
			};
			document.addEventListener("animationstart", onAnimation, true);
			let emptyFlushes = 0;
			const unsubscribe = window.piDesktop.sessions.onRuntimeEvent((event) => {
				if (event.sourceChannel !== "agents:message" && event.sourceChannel !== "sessions:messages") return;
				flushes += 1;
				if (event.payload && typeof event.payload === "object" && "messages" in event.payload && Array.isArray(event.payload.messages) && event.payload.messages.length === 0) emptyFlushes += 1;
			});
			return {
				armFocusTracking: () => {
					trackingFocus = true;
					return document.activeElement === composer;
				},
				read: () => ({ loading, empty, lostRows, lostComposer, lostEditable, focusOuts, selection: readSelection(), flushes, emptyFlushes, animations, rowCount: rows.length, focused: document.activeElement === composer }),
				dispose: () => {
					observer.disconnect();
					unsubscribe();
					composer?.removeEventListener("focusout", onFocusOut);
					document.removeEventListener("animationstart", onAnimation, true);
				},
			};
		});
		if (delayHistory)
			await app.evaluate(({ BrowserWindow }, id) => {
				const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes("selection-tool"));
				if (!win) throw new Error("main window missing");
				const send = win.webContents.send.bind(win.webContents);
				const held: unknown[][] = [];
				// 放大真实启动时序：先发布空窗口，历史投影延迟到回收定时器之后才到。
				win.webContents.send = (channel: string, ...args: unknown[]) => {
					const event = args[0];
					if (channel !== "sessions:runtime-event" || !event || typeof event !== "object" || !("sessionId" in event) || event.sessionId !== id || !("sourceChannel" in event) || (event.sourceChannel !== "agents:message" && event.sourceChannel !== "sessions:messages")) {
						send(channel, ...args);
						return;
					}
					held.push(args);
					if (held.length !== 1) return;
					send(channel, { ...event, payload: { messages: [], totalLength: 0 } });
					setTimeout(() => {
						win.webContents.send = send;
						for (const snapshot of held) send(channel, ...snapshot);
					}, 2600);
				};
			}, sessionId);
		try {
			const composer = window.locator(".composer .rich-input");
			await composer.click();
			expect(await probe.evaluate((handle) => handle.armFocusTracking())).toBe(true);
			// 只聚焦一次；之后全用页面键盘，避免 locator 自动补焦掩盖瞬时失焦。
			await window.keyboard.type("draft tail");
			if (delayHistory) await expect.poll(() => probe.evaluate((handle) => handle.read().emptyFlushes)).toBeGreaterThan(0);
			for (let index = 0; index < " tail".length; index += 1) await window.keyboard.press("ArrowLeft");
			expect((await probe.evaluate((handle) => handle.read())).selection).toEqual({ anchor: 5, focus: 5, collapsed: true });
			const inserted = " continuously during prewarm";
			await window.keyboard.type(inserted, { delay: 110 }); // 连续输入跨过延迟历史的接管时刻，且光标不在文末。
			await expect.poll(() => window.evaluate(async (id) => (await window.piDesktop.sessions.listRuntimes()).find((runtime) => runtime.sessionId === id)?.status, sessionId), { timeout: 20_000 }).toBe("idle");
			await window.waitForTimeout(2000); // 覆盖历史接管后的 1.5s 前缀回收。
			const trace = await probe.evaluate((handle) => handle.read());
			expect(trace.flushes).toBeGreaterThan(0);
			if (delayHistory) expect(trace.emptyFlushes).toBeGreaterThan(0);
			expect(trace.rowCount).toBeGreaterThan(0);
			expect(trace.loading).toBe(false);
			expect(trace.empty).toBe(false);
			expect(trace.lostRows).toBe(false);
			expect(trace.lostComposer).toBe(false);
			expect(trace.lostEditable).toBe(false);
			expect(trace.focusOuts).toBe(0);
			expect(trace.animations).toEqual([]);
			expect(trace.focused).toBe(true);
			expect(trace.selection).toEqual({ anchor: 5 + inserted.length, focus: 5 + inserted.length, collapsed: true });
			await expect(composer).toHaveText(`draft${inserted} tail`);
			await expect(window.locator(".message-timeline")).toContainText("history-answer-12");
		} finally {
			await probe.evaluate((handle) => handle.dispose());
			await probe.dispose();
		}
	});
