/**
 * memoryProfileCsv —— 内存采样数据的 CSV 编解码与聚合（纯函数，无 Electron/Node 依赖）。
 *
 * 为什么单独抽这一层：MemoryMonitor 只管“采”，analyze 脚本只管“看”，
 * 中间的数据契约（表头、行格式、按 pid 聚合）在这里唯一化，保证两侧对得上，
 * 且可以被单测直接覆盖（AGENTS.md：数据转换逻辑必须有测试）。
 *
 * 单位约定：所有内存值一律 KB（与 Electron 的 getAppMetrics / getProcessMemoryInfo 一致），
 * 脚本输出时再换算 MB/GB，避免采样侧反复换算丢精度。
 */

/** 一次采样里单个进程/渲染器的一行数据（未序列化）。null 表示该字段不适用。 */
export interface ProfileRowData {
	/** 采样时间戳（epoch ms） */
	ts: number;
	/** 进程类型：Browser / Tab / GPU / Utility / Zygote / Sandbox helper / webview 等 */
	type: string;
	pid: number;
	/** 可读标识：主进程 / 主窗口 / 浏览器面板#<wcId> 等 */
	label: string;
	/** 物理内存占用（RSS，KB） */
	rssKB: number | null;
	/** 私有内存（KB，win32 才有意义） */
	privateKB: number | null;
	/** 共享内存（KB） */
	sharedKB: number | null;
	/** 历史峰值 RSS（KB，来自 getAppMetrics 的 peakWorkingSetSize） */
	peakRssKB: number | null;
	/** 主进程 V8 堆（KB，来自 process.memoryUsage().heapUsed） */
	heapUsedKB: number | null;
	/** 渲染进程 JS 堆（KB，来自 performance.memory.usedJSHeapSize） */
	jsHeapKB: number | null;
	/** 渲染进程 V8 堆总大小（KB，totalJSHeapSize，含空闲页——判断堆不归还 OS 的关键） */
	totalJSHeapKB: number | null;
	/** 渲染进程 DOM 节点数（来自 document.querySelectorAll('*').length，非渲染进程为 null） */
	domNodes: number | null;
	/** 渲染进程 <img> 数量 */
	imgCount: number | null;
	/** 渲染进程图片解码像素总面积（估算位图内存 = ×4 字节） */
	imgPixels: number | null;
	/** 渲染进程 canvas 像素总面积（backing store 估算） */
	canvasPixels: number | null;
	/** 渲染进程 worker 数（CDP 探测；-1 = 本轮未探测/失败） */
	workerCount: number | null;
	/** 所有 worker 的 V8 堆总和（KB，Runtime.getHeapUsage；主线程 performance.memory 不含 worker） */
	workerJSHeapKB: number | null;
	/** 本轮是否有活跃流式回复（0/1；渲染窗口行才有意义，主进程由调用方注入探针） */
	streaming: number | null;
	/** 主进程 V8 堆总大小（KB，heapTotal——含未归还 OS 的空闲页，与 heapUsed 差值即空闲水位；判断 committed 不还 OS 的直接信号） */
	heapTotalKB: number | null;
	/** 主进程 V8 external 内存（KB，不含 arrayBuffers 的堆外部分） */
	externalKB: number | null;
	/** 主进程 V8 arrayBuffers 内存（KB，TypedArray/ArrayBuffer 专用记账，2026-12 内存排查补采） */
	arrayBuffersKB: number | null;
}

export const MEMORY_PROFILE_HEADER = "ts,type,pid,label,rssKB,privateKB,sharedKB,peakRssKB,heapUsedKB,jsHeapKB,totalJSHeapKB,domNodes,imgCount,imgPixels,canvasPixels,workerCount,workerJSHeapKB,streaming,heapTotalKB,externalKB,arrayBuffersKB";

/** 把一行数据序列化为 CSV 文本（null 输出空串，label 转义逗号/引号）。 */
export function toProfileCsvRow(row: ProfileRowData): string {
	const esc = (v: string): string => (v.includes(",") || v.includes('"') ? `"${v.replaceAll('"', '""')}"` : v);
	return [
		row.ts,
		esc(row.type),
		row.pid,
		esc(row.label),
		row.rssKB ?? "",
		row.privateKB ?? "",
		row.sharedKB ?? "",
		row.peakRssKB ?? "",
		row.heapUsedKB ?? "",
		row.jsHeapKB ?? "",
		row.totalJSHeapKB ?? "",
		row.domNodes ?? "",
		row.imgCount ?? "",
		row.imgPixels ?? "",
		row.canvasPixels ?? "",
		row.workerCount ?? "",
		row.workerJSHeapKB ?? "",
		row.streaming ?? "",
		row.heapTotalKB ?? "",
		row.externalKB ?? "",
		row.arrayBuffersKB ?? "",
	].join(",");
}

/** 解析后的行（数值字段已转 number，空串为 null）。 */
export interface ParsedProfileRow extends Omit<ProfileRowData, "ts"> {
	ts: number;
}

/** 解析 CSV 文本；跳过空行与表头；字段数不对的行抛错（防止静默错位分析）。 */
export function parseMemoryCsv(text: string): ParsedProfileRow[] {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
	const rows: ParsedProfileRow[] = [];
	for (const line of lines) {
		if (line.startsWith("ts,")) continue; // 表头
		// 手工切分：label 可能带逗号（被引号包裹），不能简单 split(",")
		const fields = splitCsvLine(line);
		// 兼容旧格式（新列是后加的）；其余字段数一律抛错防静默错位
		if (![10, 11, 14, 15, 17, 18, 21].includes(fields.length)) {
			throw new Error(`memory profile row malformed (${fields.length} fields): ${line.slice(0, 80)}`);
		}
		const num = (v: string | null): number | null => (v === null || v === "" ? null : Number(v));
		const [ts, type, pid, label, rssKB, privateKB, sharedKB, peakRssKB, heapUsedKB, jsHeapKB, ...rest] = fields;
		// 后加列在不同版本插入位置不同（totalJSHeapKB 插在 jsHeapKB 与 domNodes 之间），
		// 不能按固定索引解构，必须按列数分支：
		//   11 列: [domNodes]
		//   14 列: [domNodes, imgCount, imgPixels, canvasPixels]
		//   15 列: [totalJSHeapKB, domNodes, imgCount, imgPixels, canvasPixels]
		//   17 列: 15 列 + [workerCount, workerJSHeapKB]
		//   18 列: 17 列 + [streaming]；21 列再追加行尾 [heapTotalKB, externalKB, arrayBuffersKB]
		const [totalJSHeapKB, domNodes, imgCount, imgPixels, canvasPixels, workerCount, workerJSHeapKB, streaming, heapTotalKB, externalKB, arrayBuffersKB] = rest.length === 1 || rest.length === 4 ? [null, ...rest] : rest;
		rows.push({
			ts: Number(ts),
			type,
			pid: Number(pid),
			label,
			rssKB: num(rssKB),
			privateKB: num(privateKB),
			sharedKB: num(sharedKB),
			peakRssKB: num(peakRssKB),
			heapUsedKB: num(heapUsedKB),
			jsHeapKB: num(jsHeapKB),
			totalJSHeapKB: totalJSHeapKB === undefined ? null : num(totalJSHeapKB),
			domNodes: domNodes === undefined ? null : num(domNodes),
			imgCount: imgCount === undefined ? null : num(imgCount),
			imgPixels: imgPixels === undefined ? null : num(imgPixels),
			canvasPixels: canvasPixels === undefined ? null : num(canvasPixels),
			workerCount: workerCount === undefined ? null : num(workerCount),
			workerJSHeapKB: workerJSHeapKB === undefined ? null : num(workerJSHeapKB),
			streaming: streaming === undefined ? null : num(streaming),
			heapTotalKB: heapTotalKB === undefined ? null : num(heapTotalKB),
			externalKB: externalKB === undefined ? null : num(externalKB),
			arrayBuffersKB: arrayBuffersKB === undefined ? null : num(arrayBuffersKB),
		});
	}
	return rows;
}

/** 处理带引号的 CSV 行（label 含逗号时由 toProfileCsvRow 加引号）。 */
function splitCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inQuote = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuote) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else {
					inQuote = false;
				}
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQuote = true;
		} else if (ch === ",") {
			out.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out;
}

/** 单个进程的聚合结果（分析报告的核心输入）。 */
export interface ProcessSummary {
	pid: number;
	type: string;
	label: string;
	/** 首个采样（启动基线） */
	startRssKB: number | null;
	/** 末尾采样（观察期结束时） */
	endRssKB: number | null;
	/** 观察期内 RSS 峰值 */
	peakRssKB: number | null;
	/** 增长 = 末尾 - 起始；正值意味着进程只涨不缩（泄漏嫌疑按此排序） */
	growthKB: number | null;
	/** 采样点数 */
	samples: number;
	/** 末尾 JS 堆（渲染进程才有） */
	endJsHeapKB: number | null;
	/** 末尾主进程 V8 堆 */
	endHeapUsedKB: number | null;
	/** 末尾 DOM 节点数（渲染进程才有；判断 DOM 累积的直接信号） */
	endDomNodes: number | null;
	/** 末尾主进程 V8 堆总大小（heapTotal；与 endHeapUsedKB 差值即堆内空闲水位） */
	endHeapTotalKB: number | null;
	/** 末尾主进程 V8 external（堆外） */
	endExternalKB: number | null;
	/** 末尾主进程 V8 arrayBuffers */
	endArrayBuffersKB: number | null;
}

/**
 * 清洗 RSS 序列：剔除进程启动/退出瞬间的假读数（如 taskkill 时读到 1.4GB）。
 * 策略：以「前 3 个采样（进程常态基线）与全序列中位数」共同约束上下界——
 * 真实使用中 RSS 可涨到中位数的数倍（如 239MB → 1.4GB），单纯用中位数会把
 * 正常增长误判为异常、也会放跑退出瞬间的假值；基线约束保证两种场景都覆盖。
 */
export function sanitizeRssReadings(values: number[]): number[] {
	if (values.length < 3) return values;
	const sorted = [...values].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];
	// 基线：进程启动初期的常态值（前 3 个采样取中位数）
	const baseline = [...values.slice(0, 3)].sort((a, b) => a - b)[1];
	if (median <= 0 || baseline <= 0) return values;
	// 上界取两者较小：真增长最多到基线 6 倍或中位数 3 倍（超出即异常）
	const hi = Math.min(median * 3, baseline * 6);
	// 下界同样取较小者，避免基线/中位数偏高时误杀正常低值
	const lo = Math.min(median / 3, baseline / 3);
	return values.filter((v) => v >= lo && v <= hi);
}

/**
 * 按 pid 聚合全部采样。聚合键用 pid 而非 label：同一进程的 label 可能因
 * webContents 标题变化而不同，而 pid 在进程存活期内稳定。
 */
export function aggregateMemoryProfile(rows: ParsedProfileRow[]): ProcessSummary[] {
	const byPid = new Map<number, ParsedProfileRow[]>();
	for (const r of rows) {
		const list = byPid.get(r.pid);
		if (list) list.push(r);
		else byPid.set(r.pid, [r]);
	}
	const out: ProcessSummary[] = [];
	for (const [pid, list] of byPid) {
		// 取最后一次出现的 label/type：进程可能被复用（label 已更新）
		const last = list[list.length - 1];
		// 清洗后再算首/尾/峰值，避免进程退出瞬间的假读数污染趋势
		const rss = sanitizeRssReadings(list.map((r) => r.rssKB).filter((v): v is number => v !== null));
		const jsHeap = list
			.map((r) => r.jsHeapKB)
			.filter((v): v is number => v !== null)
			.pop();
		const heapUsed = list
			.map((r) => r.heapUsedKB)
			.filter((v): v is number => v !== null)
			.pop();
		const domNodes = list
			.map((r) => r.domNodes)
			.filter((v): v is number => v !== null)
			.pop();
		const heapTotal = list
			.map((r) => r.heapTotalKB)
			.filter((v): v is number => v !== null)
			.pop();
		const external = list
			.map((r) => r.externalKB)
			.filter((v): v is number => v !== null)
			.pop();
		const arrayBuffers = list
			.map((r) => r.arrayBuffersKB)
			.filter((v): v is number => v !== null)
			.pop();
		const startRss = rss.length ? rss[0] : null;
		const endRss = rss.length ? rss[rss.length - 1] : null;
		out.push({
			pid,
			type: last.type,
			label: last.label,
			startRssKB: startRss,
			endRssKB: endRss,
			peakRssKB: rss.length ? Math.max(...rss) : null,
			growthKB: startRss !== null && endRss !== null ? endRss - startRss : null,
			samples: list.length,
			endJsHeapKB: jsHeap ?? null,
			endHeapUsedKB: heapUsed ?? null,
			endDomNodes: domNodes ?? null,
			endHeapTotalKB: heapTotal ?? null,
			endExternalKB: external ?? null,
			endArrayBuffersKB: arrayBuffers ?? null,
		});
	}
	// 按增长从大到小排：泄漏嫌疑最重的排最前
	out.sort((a, b) => (b.growthKB ?? -Infinity) - (a.growthKB ?? -Infinity));
	return out;
}

/**
 * 观察期内全体进程 RSS 总和（趋势判断用：总内存只涨不缩 = 全局泄漏）。
 * 先按 pid 清洗异常读数再求和，防止进程退出瞬间的单点假值拉高整轮总和。
 */
export function totalRssSeries(rows: ParsedProfileRow[]): { ts: number; totalKB: number }[] {
	// 按 pid 分组清洗
	const byPid = new Map<number, number[]>();
	for (const r of rows) {
		if (r.rssKB === null) continue;
		const list = byPid.get(r.pid);
		if (list) list.push(r.rssKB);
		else byPid.set(r.pid, [r.rssKB]);
	}
	const cleanSet = new Map<number, Set<number>>();
	for (const [pid, values] of byPid) {
		cleanSet.set(pid, new Set(sanitizeRssReadings(values)));
	}
	const byTs = new Map<number, number>();
	for (const r of rows) {
		if (r.rssKB === null) continue;
		if (!cleanSet.get(r.pid)?.has(r.rssKB)) continue; // 异常读数不计入总和
		byTs.set(r.ts, (byTs.get(r.ts) ?? 0) + r.rssKB);
	}
	return [...byTs.entries()].map(([ts, totalKB]) => ({ ts, totalKB })).sort((a, b) => a.ts - b.ts);
}
