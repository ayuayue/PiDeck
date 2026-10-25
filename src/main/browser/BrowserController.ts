import type { WebContents } from "electron";
import type { CuaActionType, CuaGate } from "../cua/CuaGate";
import { BrowserAgentError, browserAgentErrorCode, errorMessage, mapGateReason } from "./browserErrors";
import { isAllowedBrowserPanelUrl } from "./browserSecurity";
import {
	buildClearOverlaysExpression,
	buildFallbackClickExpression,
	buildFallbackKeyExpression,
	buildFallbackScrollExpression,
	buildFallbackTypeExpression,
	buildFindHighlightExpression,
	buildFocusAndSelectExpression,
	buildFocusExpression,
	buildHighlightExpression,
	buildPageStateExpression,
	buildResolveRefExpression,
	buildScrollIntoViewExpression,
	buildWaitForTextExpression,
} from "./browserPageScripts";
import { formatBrowserSnapshot, normalizeBrowserSnapshot, SNAPSHOT_LIMITS, type BrowserSnapshot } from "./browserSnapshot";
import { buildSnapshotExpression, type SnapshotScriptOptions } from "./browserSnapshotScript";
import { captureBrowserScreenshot, type BrowserScreenshotRequest, type BrowserScreenshotResult } from "./browserScreenshot";
import type { BrowserCdpSession, CdpSend } from "./cdpSession";
import { buttonMask, clamp, KEY_DEFS, modifierMask, readRuntimeValue, withTimeout, type KeyDef } from "./browserControllerSupport";
import type { BrowserGuestCandidate } from "./browserTarget";
import { isRecord, readFiniteNumber, readString, truncateText } from "./valueRead";

/** 目标身份：webContentsId + URL + 标题（主进程拿不到渲染层 tabId，见 docs/browser-agent-plan.md §4）。 */
export type BrowserTargetInfo = { webContentsId: number; url: string; title: string };

/** 写动作的归属：sessionId 必填（只用于门控/审批归属），agentId 与 runtimeGeneration 可选。 */
export type BrowserActionMeta = { sessionId: string; agentId?: string; runtimeGeneration?: number };

export type BrowserViewport = { width: number; height: number };

export type BrowserPageState = {
	url: string;
	title: string;
	viewport: BrowserViewport;
	scroll: { x: number; y: number };
	/** 整页滚动尺寸（CSS px），fullPage 截图的像素预算用。 */
	scrollHeight: number;
	scrollWidth: number;
	devicePixelRatio: number;
	iframeCount: number;
};

export type BrowserStateResult = { target: BrowserTargetInfo; state: BrowserPageState; degraded: boolean; snapshotId: number | null };
export type BrowserSnapshotResult = { target: BrowserTargetInfo; snapshotId: number; text: string; elements: BrowserSnapshot["elements"]; truncated: boolean; totalElements: number; degraded: boolean };
export type BrowserActionResult = { target: BrowserTargetInfo; snapshotId: number | null; degraded: boolean; gate: string; detail: Record<string, unknown> };
export type BrowserScreenshotOutcome = { target: BrowserTargetInfo; image: BrowserScreenshotResult };

export type BrowserControllerDeps = {
	registry: { resolve(): BrowserGuestCandidate<WebContents> | null };
	cdp: BrowserCdpSession;
	gate: CuaGate;
	/** 测试注入点：默认走 browserScreenshot（依赖 electron nativeImage）。 */
	capture?: (guest: WebContents, send: CdpSend, request: BrowserScreenshotRequest, viewport: BrowserViewport, scaleFactor: number) => Promise<BrowserScreenshotResult>;
};

const REF_PATTERN = /^e\d+$/;
const CDP_FALLBACK_CODES = new Set(["cdp_busy", "cdp_unavailable"]);

type ResolvedRef = { visible: boolean; disabled: boolean; name: string; tag: string; rect: { x: number; y: number; width: number; height: number }; degraded: boolean };

/**
 * 内置浏览器动作编排。
 *
 * 分层：
 * - 只读动作（state/snapshot/find/wait/screenshot）不走 gate；
 * - 写动作（click/type/press_key/navigate/scroll）先解析目标、再审批、最后执行（fail-closed）；
 * - CDP 不可用（DevTools/内存探针占用）时，快照与点击/输入/滚动降级到 executeJavaScript，并回 degraded=true。
 */
export class BrowserController {
	private snapshotCounter = 0;
	private lastSnapshot: BrowserSnapshot | null = null;
	private lastTargetId: number | null = null;

	constructor(private readonly deps: BrowserControllerDeps) {}

	async getState(): Promise<BrowserStateResult> {
		const target = this.requireTarget();
		const { value, degraded } = await this.evaluateWithFallback(target.guest, buildPageStateExpression());
		const record = isRecord(value) ? value : {};
		const viewport = isRecord(record.viewport) ? record.viewport : {};
		const scroll = isRecord(record.scroll) ? record.scroll : {};
		return {
			target: this.targetInfo(target),
			degraded,
			snapshotId: this.lastSnapshot?.snapshotId ?? null,
			state: {
				url: readString(record.url, target.url),
				title: readString(record.title, target.title),
				viewport: { width: readFiniteNumber(viewport.width, 0), height: readFiniteNumber(viewport.height, 0) },
				scroll: { x: readFiniteNumber(scroll.x, 0), y: readFiniteNumber(scroll.y, 0) },
				scrollHeight: Math.max(0, readFiniteNumber(record.scrollHeight, 0)),
				scrollWidth: Math.max(0, readFiniteNumber(record.scrollWidth, 0)),
				devicePixelRatio: readFiniteNumber(record.devicePixelRatio, 1),
				iframeCount: Math.max(0, Math.floor(readFiniteNumber(record.iframeCount, 0))),
			},
		};
	}

	async snapshot(options: { maxElements?: number; includeBoxes?: boolean; overlay?: boolean } = {}): Promise<BrowserSnapshotResult> {
		const target = this.requireTarget();
		const scriptOptions: SnapshotScriptOptions = {
			maxElements: clamp(options.maxElements ?? SNAPSHOT_LIMITS.maxElements, 1, SNAPSHOT_LIMITS.maxElements),
			includeBoxes: options.includeBoxes ?? true,
			// 识别可视化默认开：页面上框出本轮识别的元素 + ref 标签（用户可见的「选取效果」）。
			renderOverlay: options.overlay !== false,
		};
		const { value, degraded } = await this.evaluateWithFallback(target.guest, buildSnapshotExpression(scriptOptions));
		const snapshot = normalizeBrowserSnapshot(value, { maxElements: scriptOptions.maxElements });
		snapshot.snapshotId = this.nextSnapshotId(target);
		if (!snapshot.url) snapshot.url = target.url;
		if (!snapshot.title) snapshot.title = target.title;
		this.lastSnapshot = snapshot;
		return {
			target: this.targetInfo(target),
			snapshotId: snapshot.snapshotId,
			text: formatBrowserSnapshot(snapshot),
			elements: snapshot.elements,
			truncated: snapshot.truncated,
			totalElements: snapshot.totalElements,
			degraded,
		};
	}

	/** 在最近一次快照里查找（不重新取页面），用于省 token 定位元素。 */
	async find(input: { text?: string; regex?: string }): Promise<{ target: BrowserTargetInfo; snapshotId: number; matches: Array<{ ref: string; role: string; name: string; disabled: boolean }> }> {
		if (!this.lastSnapshot) await this.snapshot();
		const target = this.requireTarget();
		const snapshot = this.lastSnapshot;
		if (!snapshot) throw new BrowserAgentError("browser_not_open", "页面快照为空，请先调用 browser_snapshot");
		const text = (input.text ?? "").toLowerCase();
		let regex: RegExp | null = null;
		if (input.regex) {
			try {
				regex = new RegExp(input.regex);
			} catch (error) {
				throw new BrowserAgentError("invalid_input", `正则无效：${errorMessage(error)}`);
			}
		}
		const matches = snapshot.elements
			.filter((element) => {
				const haystack = `${element.name} ${element.value ?? ""} ${element.role} ${element.tag}`.toLowerCase();
				if (regex) return regex.test(haystack);
				return text.length > 0 && haystack.includes(text);
			})
			.map((element) => ({ ref: element.ref, role: element.role, name: element.name, disabled: element.disabled }));
		// 匹配可视化：把命中的元素在页面上批量框出来（用户看到的「找到了哪些」）。纯视觉，失败不影响查找结果。
		if (matches.length > 0) {
			try {
				await this.evaluateWithFallback(target.guest, buildFindHighlightExpression(matches.slice(0, 50).map((element) => element.ref)));
			} catch {
				// 高亮失败不影响查找。
			}
		}
		return { target: this.targetInfo(target), snapshotId: snapshot.snapshotId, matches: matches.slice(0, 50) };
	}

	async click(input: { ref: string; button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: string[]; snapshotId?: number }, meta: BrowserActionMeta): Promise<BrowserActionResult> {
		const target = this.requireTarget();
		const ref = this.requireRef(input.ref);
		this.assertSnapshotFresh(input.snapshotId);
		const resolved = await this.resolveRef(target.guest, ref);
		this.assertActionable(resolved, ref);
		this.assertRefIdentity(resolved, ref);
		const button = input.button ?? "left";
		const clickCount = Math.round(clamp(input.clickCount ?? 1, 1, 3));
		const gate = await this.approve("browser_click", meta, { url: truncateText(target.url, 200), title: truncateText(target.title, 80), ref, element: resolved.name, tag: resolved.tag, button, clickCount });
		if (resolved.degraded) {
			await this.highlightRef(target.guest, ref, resolved.name);
			const clicked = await target.guest.executeJavaScript(buildFallbackClickExpression(ref), true);
			if (clicked !== true) throw new BrowserAgentError("stale_ref", `元素引用 ${ref} 已失效，请重新调用 browser_snapshot`);
			return this.actionResult(target, gate, true, { ref, degraded: true });
		}
		// 单租约执行段：滚动定位 → 重读 rect → 高亮 → Input 序列共用一次 CDP attach。
		// 此前每步各开一次租约（一次 click 最多 5 次 attach/detach），既浪费也在间隙暴露给 DevTools 抢占，
		// 动作中途被抢占会让 degraded 标志前后不一致；内嵌的 highlightRef/pressKeyInternal 经引用计数复用同一租约。
		let point = { x: 0, y: 0 };
		try {
			await this.deps.cdp.withGuest(target.guest, async (send) => {
				await this.evaluateVia(send, buildScrollIntoViewExpression(ref));
				const rect = this.parseResolvedRef(await this.evaluateVia(send, buildResolveRefExpression(ref)), ref, false).rect;
				await this.highlightRef(target.guest, ref, resolved.name);
				point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
				await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers: modifierMask(input.modifiers) });
				for (let index = 1; index <= clickCount; index += 1) {
					const params = { x: point.x, y: point.y, button, buttons: buttonMask(button), clickCount: index, modifiers: modifierMask(input.modifiers) };
					await send("Input.dispatchMouseEvent", { ...params, type: "mousePressed" });
					await send("Input.dispatchMouseEvent", { ...params, type: "mouseReleased" });
				}
			});
			return this.actionResult(target, gate, false, { ref, x: point.x, y: point.y, clickCount });
		} catch (error) {
			const code = browserAgentErrorCode(error);
			if (!code || !CDP_FALLBACK_CODES.has(code)) throw error;
			// 执行段 CDP 被占（解析与执行之间打开了 DevTools）：整段降级 DOM click。
			await this.highlightRef(target.guest, ref, resolved.name);
			const clicked = await target.guest.executeJavaScript(buildFallbackClickExpression(ref), true);
			if (clicked !== true) throw new BrowserAgentError("stale_ref", `元素引用 ${ref} 已失效，请重新调用 browser_snapshot`);
			return this.actionResult(target, gate, true, { ref, degraded: true });
		}
	}

	async type(input: { ref: string; text: string; clear?: boolean; submit?: boolean; snapshotId?: number }, meta: BrowserActionMeta): Promise<BrowserActionResult> {
		const target = this.requireTarget();
		const ref = this.requireRef(input.ref);
		this.assertSnapshotFresh(input.snapshotId);
		const resolved = await this.resolveRef(target.guest, ref);
		this.assertActionable(resolved, ref);
		this.assertRefIdentity(resolved, ref);
		const gate = await this.approve("browser_type", meta, { url: truncateText(target.url, 200), ref, element: resolved.name, textPreview: truncateText(input.text, 200), textLength: input.text.length, clear: input.clear === true, submit: input.submit === true });
		if (resolved.degraded) {
			await this.highlightRef(target.guest, ref, resolved.name);
			if (input.clear) await target.guest.executeJavaScript(buildFocusAndSelectExpression(ref), true);
			const typed = await target.guest.executeJavaScript(buildFallbackTypeExpression(ref, input.text, input.clear === true), true);
			if (typed !== true) throw new BrowserAgentError("stale_ref", `元素引用 ${ref} 已失效，请重新调用 browser_snapshot`);
			if (input.submit) await target.guest.executeJavaScript(buildFallbackKeyExpression("Enter"), true);
			return this.actionResult(target, gate, true, { ref, textLength: input.text.length });
		}
		// 单租约执行段（同 click）：滚动 → 高亮 → 聚焦 → 输入 → 回车共用一次 attach。
		try {
			await this.deps.cdp.withGuest(target.guest, async (send) => {
				await this.evaluateVia(send, buildScrollIntoViewExpression(ref));
				await this.highlightRef(target.guest, ref, resolved.name);
				await this.evaluateVia(send, input.clear ? buildFocusAndSelectExpression(ref) : buildFocusExpression(ref));
				await send("Input.insertText", { text: input.text });
				if (input.submit) await this.pressKeyInternal(target.guest, KEY_DEFS.enter, []);
			});
			return this.actionResult(target, gate, false, { ref, textLength: input.text.length, submitted: input.submit === true });
		} catch (error) {
			const code = browserAgentErrorCode(error);
			if (!code || !CDP_FALLBACK_CODES.has(code)) throw error;
			// 执行段 CDP 被占：整段降级 executeJavaScript 输入。
			await this.highlightRef(target.guest, ref, resolved.name);
			if (input.clear) await target.guest.executeJavaScript(buildFocusAndSelectExpression(ref), true);
			const typed = await target.guest.executeJavaScript(buildFallbackTypeExpression(ref, input.text, input.clear === true), true);
			if (typed !== true) throw new BrowserAgentError("stale_ref", `元素引用 ${ref} 已失效，请重新调用 browser_snapshot`);
			if (input.submit) await target.guest.executeJavaScript(buildFallbackKeyExpression("Enter"), true);
			return this.actionResult(target, gate, true, { ref, textLength: input.text.length });
		}
	}

	async pressKey(input: { key: string; modifiers?: string[]; snapshotId?: number }, meta: BrowserActionMeta): Promise<BrowserActionResult> {
		const target = this.requireTarget();
		this.assertSnapshotFresh(input.snapshotId);
		const keyDef = KEY_DEFS[input.key.trim().toLowerCase()];
		if (!keyDef) throw new BrowserAgentError("unsupported_key", `不支持的按键：${input.key}（可用：${Object.keys(KEY_DEFS).join(", ")}）`);
		const gate = await this.approve("browser_press_key", meta, { url: truncateText(target.url, 200), key: keyDef.key, modifiers: input.modifiers ?? [] });
		await this.pressKeyInternal(target.guest, keyDef, input.modifiers ?? []);
		return this.actionResult(target, gate, false, { key: keyDef.key });
	}

	async navigate(input: { url: string; timeoutMs?: number }, meta: BrowserActionMeta): Promise<BrowserActionResult> {
		const target = this.requireTarget();
		const url = input.url.trim();
		if (!isAllowedBrowserPanelUrl(url)) throw new BrowserAgentError("url_not_allowed", "只允许 http/https（或 about:blank）");
		const gate = await this.approve("browser_navigate", meta, { from: truncateText(target.url, 200), to: truncateText(url, 200) });
		try {
			await withTimeout(target.guest.loadURL(url), clamp(input.timeoutMs ?? 15_000, 1_000, 60_000), `导航超时：${url}`);
		} catch (error) {
			throw new BrowserAgentError("navigation_failed", errorMessage(error));
		}
		// 导航后旧 ref 全部失效；snapshotId 保持单调，避免旧 id 被误认成新快照。
		this.lastSnapshot = null;
		return this.actionResult(target, gate, false, { url });
	}

	async scroll(input: { ref?: string; deltaX?: number; deltaY?: number; snapshotId?: number }, meta: BrowserActionMeta): Promise<BrowserActionResult> {
		const target = this.requireTarget();
		this.assertSnapshotFresh(input.snapshotId);
		const deltaX = Math.round(clamp(input.deltaX ?? 0, -2400, 2400));
		// CDP/DOM 语义：deltaY 正值向下滚（与 WheelEvent 一致）。默认 +120 = 向下一个滚轮刻度。
		const deltaY = Math.round(clamp(input.deltaY ?? 120, -2400, 2400));
		let point = { x: 0, y: 0 };
		let ref: string | undefined;
		let refName = "";
		if (input.ref) {
			ref = this.requireRef(input.ref);
			const resolved = await this.resolveRef(target.guest, ref);
			this.assertActionable(resolved, ref);
			this.assertRefIdentity(resolved, ref);
			refName = resolved.name;
			point = { x: Math.round(resolved.rect.x + resolved.rect.width / 2), y: Math.round(resolved.rect.y + resolved.rect.height / 2) };
		} else {
			const state = await this.getState();
			point = { x: Math.round(state.state.viewport.width / 2), y: Math.round(state.state.viewport.height / 2) };
		}
		const gate = await this.approve("browser_scroll", meta, { url: truncateText(target.url, 200), ref: ref ?? null, deltaX, deltaY });
		if (ref) await this.highlightRef(target.guest, ref, refName);
		try {
			await this.deps.cdp.withGuest(target.guest, async (send) => {
				await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY, modifiers: 0 });
			});
			return this.actionResult(target, gate, false, { x: point.x, y: point.y, deltaX, deltaY });
		} catch (error) {
			const code = browserAgentErrorCode(error);
			if (!code || !CDP_FALLBACK_CODES.has(code)) throw error;
			await target.guest.executeJavaScript(buildFallbackScrollExpression(deltaX, deltaY), true);
			return this.actionResult(target, gate, true, { x: point.x, y: point.y, deltaX, deltaY });
		}
	}

	/** fullPage 捕获的像素预算：超长页（无限滚动可达数万 px）全分辨率捕获+解码会瞬间吃掉上百 MB 主进程内存。 */
	private static readonly MAX_CAPTURE_PIXELS = 16_000_000;

	/** 截图：优先 CDP 当前帧，失败退 capturePage（可能过期，source 字段会标出来）。 */
	async screenshot(input: { fullPage?: boolean; maxLongEdge?: number; quality?: number } = {}): Promise<BrowserScreenshotOutcome> {
		const target = this.requireTarget();
		const state = await this.getState();
		const request: BrowserScreenshotRequest = {
			maxLongEdge: Math.round(clamp(input.maxLongEdge ?? 1280, 64, 4096)),
			quality: Math.round(clamp(input.quality ?? 75, 1, 100)),
			fullPage: input.fullPage === true,
		};
		if (request.fullPage) {
			const dpr = Math.max(1, state.state.devicePixelRatio || 1);
			const width = Math.max(1, state.state.viewport.width || 1, state.state.scrollWidth || 1);
			const pageHeight = Math.max(state.state.viewport.height, state.state.scrollHeight);
			const maxHeightCss = Math.floor(BrowserController.MAX_CAPTURE_PIXELS / (width * dpr));
			if (pageHeight > maxHeightCss && maxHeightCss >= state.state.viewport.height) {
				// 超预算：clip 到顶部 maxHeightCss 区域（CDP clip 为 CSS px），结果标 clipped 让模型知道不完整。
				request.clip = { width: Math.max(1, state.state.viewport.width), height: maxHeightCss };
			} else if (pageHeight > maxHeightCss) {
				request.fullPage = false;
			}
		}
		const capture = this.deps.capture ?? captureBrowserScreenshot;
		let image: BrowserScreenshotResult;
		try {
			image = await this.deps.cdp.withGuest(target.guest, async (send) => {
				// 先清可视化覆盖层：识别框/查找框/高亮框只服务用户，不该进入模型的截图视野。
				try {
					await this.evaluateVia(send, buildClearOverlaysExpression());
				} catch {
					// 清理失败只影响画面干净度，不阻断截图。
				}
				return capture(target.guest, send, request, state.state.viewport, state.state.devicePixelRatio);
			});
		} catch (error) {
			const code = browserAgentErrorCode(error);
			if (!code || !CDP_FALLBACK_CODES.has(code)) throw error;
			const unavailable: CdpSend = async () => {
				throw new BrowserAgentError("cdp_unavailable", "CDP 不可用，改用 capturePage");
			};
			image = await capture(target.guest, unavailable, request, state.state.viewport, state.state.devicePixelRatio);
		}
		return { target: this.targetInfo(target), image };
	}

	/** 等待文本出现或固定时长（轮询页面文本，只读）。 */
	async waitFor(input: { text?: string; timeMs?: number; timeoutMs?: number }): Promise<{ target: BrowserTargetInfo; matched: boolean; elapsedMs: number; degraded?: boolean }> {
		const target = this.requireTarget();
		const startedAt = Date.now();
		const timeoutMs = Math.round(clamp(input.timeoutMs ?? 10_000, 100, 30_000));
		const expected = input.text ?? "";
		const waitMs = Math.round(clamp(input.timeMs ?? 0, 0, 30_000));
		if (!expected) {
			await new Promise((resolve) => setTimeout(resolve, waitMs));
			return { target: this.targetInfo(target), matched: true, elapsedMs: Date.now() - startedAt };
		}
		// 单租约轮询：整个等待只占用一次 withGuest（一次 CDP attach/detach）。此前每 250ms 一轮
		// attach/detach，30s 上限下最多 120 次调试器抖动，既浪费也与工具描述的「操作期间勿开 DevTools」相冲。
		// 匹配在页面内完成，只回布尔（不把整页 innerText 每 250ms 拉回主进程序列化）。
		const pollExpression = buildWaitForTextExpression(expected);
		const poll = async (evaluate: () => Promise<unknown>): Promise<boolean> => {
			while (Date.now() - startedAt < timeoutMs) {
				// 表达式在页面内完成 includes，只回布尔。
				if ((await evaluate()) === true) return true;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			return false;
		};
		try {
			const matched = await this.deps.cdp.withGuest(target.guest, async (send) => poll(async () => readRuntimeValue(await send("Runtime.evaluate", { expression: pollExpression, returnByValue: true, awaitPromise: true }))));
			return { target: this.targetInfo(target), matched, elapsedMs: Date.now() - startedAt };
		} catch (error) {
			const code = browserAgentErrorCode(error);
			if (!code || !CDP_FALLBACK_CODES.has(code)) throw error;
			// CDP 被占用（DevTools/内存探针）：整段降级 executeJavaScript 轮询，结果标 degraded。
			const matched = await poll(() => target.guest.executeJavaScript(pollExpression, true));
			return { target: this.targetInfo(target), matched, elapsedMs: Date.now() - startedAt, degraded: true };
		}
	}

	/**
	 * 动作可视化：在页面上短暂高亮 agent 正在操作的目标元素（琥珀色框 + ref·名称标签）。
	 * 纯视觉、best-effort：页面 DOM 异常/CSP 限制时静默跳过，绝不阻断动作本身。
	 */
	private async highlightRef(guest: WebContents, ref: string, name: string): Promise<void> {
		try {
			await this.evaluateWithFallback(guest, buildHighlightExpression(ref, truncateText(`${ref} · ${name}`, 60)));
		} catch {
			// 高亮失败不影响动作。
		}
	}

	/** 页面导航/面板关闭后调用：旧 ref 全部失效。lastSnapshot 含页面输入值等敏感文本，不留驻内存。 */
	invalidateSnapshot(): void {
		this.lastSnapshot = null;
	}

	private requireTarget(): BrowserGuestCandidate<WebContents> {
		const target = this.deps.registry.resolve();
		if (!target) {
			this.lastSnapshot = null;
			throw new BrowserAgentError("browser_not_open", "内置浏览器没有打开的页面：请先打开浏览器面板并加载目标页面");
		}
		return target;
	}

	private targetInfo(target: BrowserGuestCandidate<WebContents>): BrowserTargetInfo {
		// url/title 都是页面可控值：SPA 可以塞 1MB hash，截断防撑爆工具输出与审批详情。
		return { webContentsId: target.id, url: truncateText(target.url, 500), title: truncateText(target.title, 160) };
	}

	private requireRef(ref: string): string {
		const value = ref.trim();
		if (!REF_PATTERN.test(value)) throw new BrowserAgentError("invalid_input", `ref 形态非法：${ref}（应形如 e1）`);
		return value;
	}

	private assertSnapshotFresh(snapshotId: number | undefined): void {
		if (snapshotId === undefined) return;
		if (!this.lastSnapshot || this.lastSnapshot.snapshotId !== snapshotId) {
			throw new BrowserAgentError("stale_ref", `snapshotId ${snapshotId} 已过期，请重新调用 browser_snapshot`);
		}
	}

	/**
	 * ref 身份校验：data-pideck-ref 是页面内的可变属性，而页面是不可信输入——
	 * 快照与动作之间隔着模型思考时间，恶意页面可以把属性搬到别的元素（把点击重定向到转账/删除按钮）。
	 * 这里把 resolveRef 的结果与当前快照条目比对：无对应条目、tag 变化或名称明显变化都按 stale_ref 拒绝。
	 * 名称比对用 40 字符前缀容忍（截断差异与轻微文案更新），宁可多一次重新快照也不放过换元素。
	 */
	private assertRefIdentity(resolved: ResolvedRef, ref: string): void {
		const expected = this.lastSnapshot?.elements.find((element) => element.ref === ref);
		if (!expected) throw new BrowserAgentError("stale_ref", `ref ${ref} 不在当前快照中，请先调用 browser_snapshot`);
		if (expected.tag !== resolved.tag) throw new BrowserAgentError("stale_ref", `元素 ${ref} 的类型已变化（${expected.tag} → ${resolved.tag}），请重新快照`);
		const expectedName = expected.name.trim();
		const resolvedName = resolved.name.trim();
		if (expectedName.length > 0 && resolvedName.length > 0) {
			const head = Math.min(40, expectedName.length, resolvedName.length);
			if (expectedName.slice(0, head) !== resolvedName.slice(0, head)) {
				throw new BrowserAgentError("stale_ref", `元素 ${ref} 的名称已变化，页面可能已更新，请重新快照`);
			}
		}
	}

	private assertActionable(resolved: ResolvedRef, ref: string): void {
		if (!resolved.visible) throw new BrowserAgentError("element_not_visible", `元素 ${ref} 当前不可见`);
		if (resolved.disabled) throw new BrowserAgentError("element_disabled", `元素 ${ref} 处于禁用状态`);
	}

	private nextSnapshotId(target: BrowserGuestCandidate<WebContents>): number {
		// 计数器全局单调不清零：guest 重建后从 1 重数会与旧代快照撞号，
		// assertSnapshotFresh 会对跨代旧 id 放行（叠加页面自植 ref 属性即可指错元素）。
		if (this.lastTargetId !== target.id) {
			this.lastTargetId = target.id;
			this.lastSnapshot = null;
		}
		this.snapshotCounter += 1;
		return this.snapshotCounter;
	}

	private async resolveRef(guest: WebContents, ref: string): Promise<ResolvedRef> {
		const { value, degraded } = await this.evaluateWithFallback(guest, buildResolveRefExpression(ref));
		return this.parseResolvedRef(value, ref, degraded);
	}

	private parseResolvedRef(value: unknown, ref: string, degraded: boolean): ResolvedRef {
		if (!isRecord(value) || value.found !== true) throw new BrowserAgentError("stale_ref", `元素引用 ${ref} 已失效，请重新调用 browser_snapshot`);
		const rect = isRecord(value.rect) ? value.rect : {};
		return {
			visible: value.visible === true,
			disabled: value.disabled === true,
			name: readString(value.name),
			tag: readString(value.tag),
			degraded,
			rect: {
				x: readFiniteNumber(rect.x, 0),
				y: readFiniteNumber(rect.y, 0),
				width: readFiniteNumber(rect.width, 0),
				height: readFiniteNumber(rect.height, 0),
			},
		};
	}

	/** 在已持有的 CDP 租约内执行页面表达式（复用租约，不再 attach/detach）。 */
	private async evaluateVia(send: CdpSend, expression: string): Promise<unknown> {
		return readRuntimeValue(await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }));
	}

	private async approve(action: CuaActionType, meta: BrowserActionMeta, detail: Record<string, unknown>): Promise<string> {
		const decision = await this.deps.gate.check(action, meta.sessionId, detail, { agentId: meta.agentId, runtimeGeneration: meta.runtimeGeneration });
		if (!decision.allowed) throw new BrowserAgentError(mapGateReason(decision.reason), `操作未被批准（${decision.reason ?? "approval_denied"}）`);
		return decision.reason ?? "approved";
	}

	private async pressKeyInternal(guest: WebContents, keyDef: KeyDef, modifiers: readonly string[]): Promise<void> {
		await this.deps.cdp.withGuest(guest, async (send) => {
			const base = { key: keyDef.key, code: keyDef.code, windowsVirtualKeyCode: keyDef.vk, nativeVirtualKeyCode: keyDef.vk, modifiers: modifierMask(modifiers) };
			await send("Input.dispatchKeyEvent", { type: keyDef.text ? "keyDown" : "rawKeyDown", ...base, ...(keyDef.text ? { text: keyDef.text } : {}) });
			await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
		});
	}

	private actionResult(target: BrowserGuestCandidate<WebContents>, gate: string, degraded: boolean, detail: Record<string, unknown>): BrowserActionResult {
		return { target: this.targetInfo(target), snapshotId: this.lastSnapshot?.snapshotId ?? null, degraded, gate, detail };
	}

	private async evaluate(guest: WebContents, expression: string): Promise<unknown> {
		return this.deps.cdp.withGuest(guest, async (send) => readRuntimeValue(await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })));
	}

	private async evaluateWithFallback(guest: WebContents, expression: string): Promise<{ value: unknown; degraded: boolean }> {
		try {
			return { value: await this.evaluate(guest, expression), degraded: false };
		} catch (error) {
			const code = browserAgentErrorCode(error);
			if (!code || !CDP_FALLBACK_CODES.has(code)) throw error;
			const value = await guest.executeJavaScript(expression, true);
			return { value, degraded: true };
		}
	}
}
