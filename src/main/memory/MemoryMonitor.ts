/**
 * MemoryMonitor —— 周期性采集主进程 + 所有子进程内存，追加写入 CSV。
 *
 * 用途：内存优化的数据底座。开一个分析会话 → 正常操作 → 用 scripts/analyze-memory.mjs
 * 出报告，就能看出“哪个进程在涨、涨了多少、JS 堆是否同步上涨”。
 *
 * 开启方式（默认关闭，生产零开销，符合 AGENTS.md 特性开关原则）：
 *   PIDECK_MEMORY_PROFILE=1 npm run dev          # 默认每 5s 采一次
 *   PIDECK_MEMORY_PROFILE=1 PIDECK_MEMORY_PROFILE_INTERVAL_MS=2000 npm run dev
 * 输出：<userData>/memory-profile/profile-<yyyyMMdd-HHmmss>.csv（长表格式，见 memoryProfileCsv.ts）
 *
 * 为什么每层各采一份：
 * - 进程级 RSS/private：真实物理占用，判断“谁在吃内存”；
 * - 渲染进程 JS 堆（performance.memory）：判断是否 V8 堆泄漏（RSS 涨而 JS 堆不涨
 *   = 多半是 DOM/图片/缓存等 native 侧，反之是 JS 对象泄漏）；
 * - 主进程 V8 堆（process.memoryUsage）：主进程是控制中心，堆泄漏会拖垮全局。
 */

import { app, webContents, type WebContents } from "electron";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMORY_PROFILE_HEADER, toProfileCsvRow, type ProfileRowData } from "./memoryProfileCsv";
import { buildDomAttributionExpression, normalizeDomAttribution, type DomAttributionEntry } from "./domAttribution";

/** 环境变量开关；值非 "1" 一律视为关闭。 */
export function isMemoryProfileEnabled(): boolean {
	return process.env.PIDECK_MEMORY_PROFILE === "1";
}

function intervalMs(): number {
	const raw = Number(process.env.PIDECK_MEMORY_PROFILE_INTERVAL_MS);
	return Number.isFinite(raw) && raw >= 1000 ? raw : 5000;
}

/**
 * 渲染进程 JS 堆（KB）+ DOM 节点数 + 图片/canvas 统计。一次 evaluate 取回。
 * 图片解码位图与 canvas backing store 都在 Blink native 侧（heap snapshot 看不到），
 * 用「数量 × 像素面积」估算其内存占用：位图 ≈ 像素数 × 4 字节。
 */
async function rendererDomMetrics(wc: WebContents): Promise<{
	jsHeapKB: number | null;
	totalJSHeapKB: number | null;
	domNodes: number | null;
	imgCount: number | null;
	imgPixels: number | null;
	canvasPixels: number | null;
}> {
	try {
		const val = (await wc.executeJavaScript(
			"(function(){ const pm = performance.memory; let imgs = 0, imgPx = 0; for (const im of document.images) { imgs++; if (im.naturalWidth && im.naturalHeight) imgPx += im.naturalWidth * im.naturalHeight; } let canvases = 0, cvPx = 0; for (const cv of document.querySelectorAll('canvas')) { canvases++; if (cv.width && cv.height) cvPx += cv.width * cv.height; } return { js: pm ? pm.usedJSHeapSize : null, total: pm ? pm.totalJSHeapSize : null, dom: document.querySelectorAll('*').length, imgs, imgPx, cvPx }; })()",
			true,
		)) as { js: number | null; total: number | null; dom: number; imgs: number; imgPx: number; cvPx: number } | null;
		if (!val || typeof val !== "object") return { jsHeapKB: null, totalJSHeapKB: null, domNodes: null, imgCount: null, imgPixels: null, canvasPixels: null };
		return {
			jsHeapKB: typeof val.js === "number" ? Math.round(val.js / 1024) : null,
			totalJSHeapKB: typeof val.total === "number" ? Math.round(val.total / 1024) : null,
			domNodes: typeof val.dom === "number" ? val.dom : null,
			imgCount: typeof val.imgs === "number" ? val.imgs : null,
			imgPixels: typeof val.imgPx === "number" ? val.imgPx : null,
			canvasPixels: typeof val.cvPx === "number" ? val.cvPx : null,
		};
	} catch {
		return { jsHeapKB: null, totalJSHeapKB: null, domNodes: null, imgCount: null, imgPixels: null, canvasPixels: null };
	}
}

/**
 * DOM 归属探针：回答「这些节点花在哪个子树」。
 *
 * 为什么单独一条写盘通道：CSV 是「每进程一行」的宽表，归属是多行结构（一个回合一行），
 * 塞进 CSV 要么破坏既有 18 列契约（parseMemoryCsv 按列数分支解构，加列会误判旧文件），
 * 要么得编码成 JSON 字符串塞单格——两种都会让 analyze-memory.mjs 跟着改。
 * 因此归属数据单独写 `dom-attribution.jsonl`（一行一个采样），CSV 契约零改动。
 *
 * 失败一律返回 null：诊断功能不能影响主采样。
 */
async function domAttributionMetrics(wc: WebContents): Promise<{ total: number; entries: DomAttributionEntry[] } | null> {
	try {
		const raw = await wc.executeJavaScript(buildDomAttributionExpression(), true);
		return normalizeDomAttribution(raw);
	} catch {
		return null;
	}
}

/**
 * 渲染进程 worker 探针（CDP）：枚举 worker target 并量取各自 V8 堆。
 * 为什么需要：@pierre/diffs 的高亮 worker 池常驻内存，其 JS 堆/WASM 不在
 * 主线程 performance.memory 里，会全部算进“native”——不探针就无法区分
 * “worker 吃内存”与“Blink 其他 native 资源”。
 * 每 6 轮才探一次：attach/detach debugger 有开销，且 5 秒级频率没必要。
 * count 为 null 表示本轮未探测（区别于 0 = 探测成功但无 worker）。
 */
let workerProbeRound = 0;

async function workerMetrics(wc: WebContents): Promise<{
	count: number | null;
	jsHeapKB: number | null;
	urls: string[];
}> {
	workerProbeRound++;
	if (workerProbeRound % 6 !== 0) return { count: null, jsHeapKB: null, urls: [] };
	try {
		wc.debugger.attach("1.3");
		try {
			const { targetInfos } = await wc.debugger.sendCommand("Target.getTargets");
			const workers = (targetInfos ?? []).filter((t: { type?: string }) => t.type === "worker");
			let heap = 0;
			let ok = 0;
			const urls: string[] = [];
			for (const w of workers) {
				try {
					const { sessionId } = await wc.debugger.sendCommand("Target.attachToTarget", {
						targetId: w.targetId,
						flatten: true,
					});
					// Runtime.getHeapUsage 取该 worker isolate 的 V8 堆（performance.memory 在 worker 里不可用）
					const { usedSize } = await wc.debugger.sendCommand("Runtime.getHeapUsage", {}, sessionId);
					heap += usedSize;
					ok++;
					urls.push(w.url ?? "?");
				} catch {
					// 单个 worker 探测失败忽略，不影响整体
				}
			}
			return {
				count: workers.length,
				jsHeapKB: ok ? Math.round(heap / 1024) : null,
				urls,
			};
		} finally {
			wc.debugger.detach();
		}
	} catch (error) {
		// attach 失败（DevTools 已占用等），本轮跳过；打日志便于诊断
		console.warn("[memory-profile] worker probe failed:", error);
		return { count: null, jsHeapKB: null, urls: [] };
	}
}

/** 主进程采样行：process.memoryUsage 的 heapUsed 即主进程 V8 堆；heapTotal/external/arrayBuffers
 *  2026-12 内存排查补采——heapTotal 与 heapUsed 的差值是「committed 不还 OS」的直接证据。 */
function mainProcessRow(ts: number): ProfileRowData {
	const m = process.memoryUsage();
	return {
		ts,
		type: "Browser",
		pid: process.pid,
		label: "主进程",
		rssKB: Math.round(m.rss / 1024),
		privateKB: null,
		sharedKB: null,
		peakRssKB: null,
		heapUsedKB: Math.round(m.heapUsed / 1024),
		jsHeapKB: null,
		totalJSHeapKB: null,
		domNodes: null,
		imgCount: null,
		imgPixels: null,
		canvasPixels: null,
		workerCount: null,
		workerJSHeapKB: null,
		streaming: null,
		heapTotalKB: Math.round(m.heapTotal / 1024),
		externalKB: Math.round(m.external / 1024),
		arrayBuffersKB: Math.round(m.arrayBuffers / 1024),
	};
}

/** 一次完整采样：主进程 + getAppMetrics 子进程 + 每个 webContents 的明细。 */
async function collectSnapshot(streamingProbe?: () => boolean): Promise<ProfileRowData[]> {
	const ts = Date.now();
	// 按 pid 去重：getAppMetrics 会把渲染进程列为 type="Tab"，webContents 路径又会对同 pid
	// 输出一条带 JS 堆的行——重复入表会让总 RSS 被高估。这里以 pid 为键合并，
	// 同进程只保留一行，JS 堆由 webContents 路径补全。
	const rows = new Map<number, ProfileRowData>();

	// 主进程行（getAppMetrics 的 Browser 行跳过，上面已有更细数据）
	const mainRow = mainProcessRow(ts);
	rows.set(process.pid, mainRow);

	// getAppMetrics：全部子进程（GPU/Utility/zygote/Tab 等）。
	// 同时建立 pid → 内存索引，供下方 webContents 匹配（webContents.getProcessMemoryInfo 已在
	// 新版本移除，按 pid 从 getAppMetrics 取是等价的唯一途径）。
	const metrics = app.getAppMetrics();
	const memByPid = new Map(metrics.map((m) => [m.pid, m.memory]));
	for (const metric of metrics) {
		if (metric.type === "Browser") continue;
		const mem = metric.memory;
		rows.set(metric.pid, {
			ts,
			type: metric.type,
			pid: metric.pid,
			label: metric.type,
			rssKB: mem.workingSetSize,
			privateKB: mem.privateBytes ?? null,
			sharedKB: null,
			peakRssKB: mem.peakWorkingSetSize,
			heapUsedKB: null,
			jsHeapKB: null,
			totalJSHeapKB: null,
			domNodes: null,
			imgCount: null,
			imgPixels: null,
			canvasPixels: null,
			workerCount: null,
			workerJSHeapKB: null,
			streaming: null,
			heapTotalKB: null,
			externalKB: null,
			arrayBuffersKB: null,
		});
	}

	// webContents 明细：进程级 RSS/private + 渲染 JS 堆。
	// guest（webview 浏览器面板）也包含在内——它是吃内存大户，必须可观测。
	// 同 pid 已存在（来自 getAppMetrics 的 Tab 行）时只补 JS 堆与语义化 label，不追加新行。
	const wcs = webContents.getAllWebContents();
	await Promise.all(
		wcs.map(async (wc) => {
			try {
				const pid = wc.getOSProcessId();
				const mem = memByPid.get(pid);
				const { jsHeapKB, totalJSHeapKB, domNodes, imgCount, imgPixels, canvasPixels } = await rendererDomMetrics(wc);
				const { count: workerCount, jsHeapKB: workerJSHeapKB, urls } = await workerMetrics(wc);
				const streaming = streamingProbe?.() ? 1 : 0;
				if (urls.length) {
					console.log("[memory-profile] workers:", urls.join(" | "));
				}
				const isWebview = wc.getType() === "webview";
				const existing = rows.get(pid);
				if (existing) {
					// 同一渲染进程：补 JS 堆 / DOM 节点 / 图片统计，label 换成语义化名称（渲染窗口/浏览器面板）
					existing.jsHeapKB = jsHeapKB;
					existing.totalJSHeapKB = totalJSHeapKB;
					existing.domNodes = domNodes;
					existing.imgCount = imgCount;
					existing.imgPixels = imgPixels;
					existing.canvasPixels = canvasPixels;
					existing.workerCount = workerCount;
					existing.workerJSHeapKB = workerJSHeapKB;
					existing.streaming = streaming;
					existing.label = `${isWebview ? "浏览器面板" : "渲染窗口"}#${wc.id}`;
				} else {
					rows.set(pid, {
						ts,
						type: isWebview ? "webview" : "Tab",
						pid,
						label: `${isWebview ? "浏览器面板" : "渲染窗口"}#${wc.id}`,
						rssKB: mem?.workingSetSize ?? null,
						privateKB: mem?.privateBytes ?? null,
						sharedKB: null,
						peakRssKB: mem?.peakWorkingSetSize ?? null,
						heapUsedKB: null,
						jsHeapKB,
						totalJSHeapKB,
						domNodes,
						imgCount,
						imgPixels,
						canvasPixels,
						workerCount,
						workerJSHeapKB,
						streaming,
						heapTotalKB: null,
						externalKB: null,
						arrayBuffersKB: null,
					});
				}
			} catch {
				// 单个 webContents 采样失败不影响整轮（页面可能正在销毁）
			}
		}),
	);
	return [...rows.values()];
}

/**
 * 采集并追加 DOM 归属样本。
 *
 * 只对渲染窗口（type === "Tab" 且非 webview）采样：归属锚点是会话时间线的
 * data-message-id / data-process-group-id，浏览器面板里没有这些东西，采了也是空的。
 *
 * 失败静默：归属是诊断增强项，任何异常都不能让主采样报错或漏写 CSV。
 */
async function appendDomAttribution(path: string, rows: readonly ProfileRowData[]): Promise<void> {
	try {
		const targets = new Map(rows.filter((r) => r.type === "Tab").map((r) => [r.pid, r] as const));
		if (targets.size === 0) return;
		const samples: DomAttributionSample[] = [];
		for (const wc of webContents.getAllWebContents()) {
			if (wc.getType() === "webview") continue;
			const row = targets.get(wc.getOSProcessId());
			if (!row) continue;
			const attribution = await domAttributionMetrics(wc);
			if (!attribution) continue;
			samples.push({ ts: Date.now(), pid: row.pid, label: row.label, total: attribution.total, entries: attribution.entries });
		}
		if (samples.length === 0) return;
		await appendFile(path, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
	} catch (error) {
		console.error("[memory-profile] dom attribution failed:", error);
	}
}

export interface MemoryProfileHandle {
	stop: () => void;
	/** 当前 CSV 文件路径（便于脚本直接分析） */
	filePath: string;
	/** DOM 归属数据路径（一行一个采样；无归属数据时不产生该文件） */
	domAttributionPath: string;
}

/** 一次 DOM 归属采样的落盘形态（一行一条 JSON）。 */
export type DomAttributionSample = {
	ts: number;
	/** 渲染进程 pid */
	pid: number;
	label: string;
	/** 页面节点总数 */
	total: number;
	/** 占用最高的若干子树（已按节点数降序） */
	entries: DomAttributionEntry[];
};

/**
 * 启动内存采样。返回句柄，app quit 时必须调用 stop()（生命周期配对）。
 * 采样期间通过 inFlight 锁防重入：一次采样超过间隔时跳过下一轮而不是叠采。
 * streamingProbe：返回当前是否有活跃流式回复（主进程 AgentManager 注入），
 * 用于把采样轮与流式时段对齐，判断内存增长是否发生在流式期间。
 */
export async function startMemoryProfile(streamingProbe?: () => boolean): Promise<MemoryProfileHandle> {
	const dir = join(app.getPath("userData"), "memory-profile");
	await mkdir(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filePath = join(dir, `profile-${stamp}.csv`);
	const domAttributionPath = join(dir, `dom-attribution-${stamp}.jsonl`);
	await appendFile(filePath, MEMORY_PROFILE_HEADER + "\n");

	const interval = intervalMs();
	let inFlight = false;
	// DOM 归属遍历整棵树，比总量统计贵一个量级；每 6 轮采一次（5s 间隔下约 30s 一次），
	// 与 workerProbeRound 同一节奏——定位「节点花在哪」不需要 5 秒级分辨率。
	let attributionRound = 0;
	const timer = setInterval(() => {
		if (inFlight) return; // 上一轮还没采完，跳过本轮
		inFlight = true;
		attributionRound += 1;
		const withAttribution = attributionRound % 6 === 0;
		void (async () => {
			try {
				// 10s 超时兜底：executeJavaScript 在页面导航/忙碌时可能永不 resolve，
				// 不兜底会锁死 inFlight，后续轮次全部跳过（历史采样“提前停”的根因）。
				const rows = await Promise.race([
					collectSnapshot(streamingProbe),
					new Promise<never>((_, reject) => {
						const t = setTimeout(() => reject(new Error("sample timed out")), 10_000);
						t.unref();
					}),
				]);
				await appendFile(filePath, rows.map(toProfileCsvRow).join("\n") + "\n");
				if (withAttribution) {
					await appendDomAttribution(domAttributionPath, rows);
				}
			} catch (error) {
				// 采样是诊断工具，失败不崩应用，只丢一轮
				console.error("[memory-profile] sample failed:", error);
			} finally {
				inFlight = false;
			}
		})();
	}, interval);
	timer.unref(); // 不阻塞应用退出

	console.log(`[memory-profile] sampling every ${interval}ms → ${filePath} (PIDECK_MEMORY_PROFILE=1)`);
	return {
		stop: () => clearInterval(timer),
		filePath,
		domAttributionPath,
	};
}
