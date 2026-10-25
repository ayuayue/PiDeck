#!/usr/bin/env node
/**
 * analyze-memory.mjs —— 内存采样 CSV 分析报告生成器。
 *
 * 用法：
 *   node scripts/analyze-memory.mjs                    # 自动找最新一份采样（dev/正式 userData 都找）
 *   node scripts/analyze-memory.mjs <path/to/csv>      # 指定文件
 *   node scripts/analyze-memory.mjs <csv1> <csv2>      # 对比两次会话（可选）
 *
 * 输出：进程级 起始→末尾/峰值/增长 排行 + 全体 RSS 趋势 + JS 堆趋势。
 * 判读口诀：
 *   - growth 为正且持续 = 该进程在观察期内只涨不缩（泄漏嫌疑）；
 *   - 渲染进程 RSS 涨而 jsHeap 不涨 = 问题在 DOM/图片/缓存等 native 侧；
 *   - 两者同涨 = JS 对象泄漏（优先查全局 state / 未清理 listener / 未销毁组件）。
 *
 * 注意：解析逻辑与 src/main/memory/memoryProfileCsv.ts 的 parseMemoryCsv 保持同步，
 * 修改一侧必须同步另一侧（tests/memoryProfileCsv.test.mjs 会回归验证脚本行为）。
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const KB = 1024;
const MB = KB * 1024; // 1048576：1GB 的 KB 数（变量名沿旧，勿被误导）

function fmtKB(kb) {
	if (kb === null || kb === undefined) return "-";
	// kb 以 KB 计：<1GB 时除以 1024 得 MB；>=1GB 时除以 1048576 得 GB（此前 1.4GB 被显示成 1.4MB）
	if (kb >= MB) return (kb / MB).toFixed(1) + " GB";
	return (kb / KB).toFixed(1) + " MB";
}

/** 与 memoryProfileCsv.ts 一致的解析（长表：ts,type,pid,label,rssKB,privateKB,sharedKB,peakRssKB,heapUsedKB,jsHeapKB） */
function parseCsv(text) {
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || line.startsWith("ts,")) continue;
		const fields = splitCsvLine(line);
		if (![10, 11, 14, 15, 17, 18, 21].includes(fields.length)) throw new Error(`malformed row: ${line.slice(0, 60)}`);
		const num = (v) => (v === "" ? null : Number(v));
		const [ts, type, pid, label, rssKB, privateKB, sharedKB, peakRssKB, heapUsedKB, jsHeapKB, ...rest] = fields;
		// 后加列插入位置随版本变化（totalJSHeapKB 插在 jsHeapKB 与 domNodes 之间），
		// 按列数分支对齐：11 列 [domNodes]；14 列 [domNodes,img,imgPx,cvPx]；15/17 列带 totalJSHeapKB；
		// 18 列再带 streaming；21 列行尾追加 [heapTotalKB,externalKB,arrayBuffersKB]
		const [totalJSHeapKB, domNodes, imgCount, imgPixels, canvasPixels, workerCount, workerJSHeapKB, , heapTotalKB, externalKB, arrayBuffersKB] = rest.length === 1 || rest.length === 4 ? [null, ...rest] : rest;
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
			heapTotalKB: heapTotalKB === undefined ? null : num(heapTotalKB),
			externalKB: externalKB === undefined ? null : num(externalKB),
			arrayBuffersKB: arrayBuffersKB === undefined ? null : num(arrayBuffersKB),
		});
	}
	return rows;
}

function splitCsvLine(line) {
	const out = [];
	let cur = "";
	let inQuote = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuote) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else inQuote = false;
			} else cur += ch;
		} else if (ch === '"') inQuote = true;
		else if (ch === ",") {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

/** 清洗 RSS 序列：剔除启动/退出瞬间假读数（与 memoryProfileCsv.sanitizeRssReadings 一致） */
function sanitizeRss(values) {
	if (values.length < 3) return values;
	const sorted = [...values].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];
	const baseline = [...values.slice(0, 3)].sort((a, b) => a - b)[1];
	if (median <= 0 || baseline <= 0) return values;
	const hi = Math.min(median * 3, baseline * 6);
	const lo = Math.min(median / 3, baseline / 3);
	return values.filter((v) => v >= lo && v <= hi);
}

/** 按 pid 聚合（与 memoryProfileCsv.aggregateMemoryProfile 对齐，含 RSS 清洗） */
function aggregate(rows) {
	const byPid = new Map();
	for (const r of rows) {
		if (!byPid.has(r.pid)) byPid.set(r.pid, []);
		byPid.get(r.pid).push(r);
	}
	const out = [];
	for (const [pid, list] of byPid) {
		const last = list[list.length - 1];
		const rss = sanitizeRss(list.map((r) => r.rssKB).filter((v) => v !== null));
		const jsHeap =
			list
				.map((r) => r.jsHeapKB)
				.filter((v) => v !== null)
				.pop() ?? null;
		const heapUsed =
			list
				.map((r) => r.heapUsedKB)
				.filter((v) => v !== null)
				.pop() ?? null;
		const domNodes =
			list
				.map((r) => r.domNodes)
				.filter((v) => v !== null)
				.pop() ?? null;
		const workerCount =
			list
				.map((r) => r.workerCount)
				.filter((v) => v !== null && v >= 0)
				.pop() ?? null;
		const workerJSHeap =
			list
				.map((r) => r.workerJSHeapKB)
				.filter((v) => v !== null)
				.pop() ?? null;
		const heapTotal =
			list
				.map((r) => r.heapTotalKB)
				.filter((v) => v !== null)
				.pop() ?? null;
		const external =
			list
				.map((r) => r.externalKB)
				.filter((v) => v !== null)
				.pop() ?? null;
		const arrayBuffers =
			list
				.map((r) => r.arrayBuffersKB)
				.filter((v) => v !== null)
				.pop() ?? null;
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
			endJsHeapKB: jsHeap,
			endHeapUsedKB: heapUsed,
			endDomNodes: domNodes,
			endWorkerCount: workerCount,
			endWorkerJSHeapKB: workerJSHeap,
			endHeapTotalKB: heapTotal,
			endExternalKB: external,
			endArrayBuffersKB: arrayBuffers,
		});
	}
	out.sort((a, b) => (b.growthKB ?? -Infinity) - (a.growthKB ?? -Infinity));
	return out;
}

/** 每个采样时刻的全体 RSS 总和（趋势；先按 pid 清洗异常读数再求和） */
function totalSeries(rows) {
	const byPid = new Map();
	for (const r of rows) {
		if (r.rssKB === null) continue;
		if (!byPid.has(r.pid)) byPid.set(r.pid, []);
		byPid.get(r.pid).push(r.rssKB);
	}
	const cleanSet = new Map();
	for (const [pid, values] of byPid) cleanSet.set(pid, new Set(sanitizeRss(values)));
	const byTs = new Map();
	for (const r of rows) {
		if (r.rssKB === null) continue;
		if (!cleanSet.get(r.pid)?.has(r.rssKB)) continue;
		byTs.set(r.ts, (byTs.get(r.ts) ?? 0) + r.rssKB);
	}
	return [...byTs.entries()].map(([ts, totalKB]) => ({ ts, totalKB })).sort((a, b) => a.ts - b.ts);
}

/** 自动定位最新采样 CSV：dev/正式 userData 都找，取最新的 */
async function findLatestCsv() {
	const candidates = [];
	for (const dir of ["pi-desktop-dev", "pi-desktop"]) {
		const base = join(os.homedir(), "AppData", "Roaming", dir, "memory-profile");
		if (!existsSync(base)) continue;
		const { readdir } = await import("node:fs/promises");
		for (const f of (await readdir(base)).filter((f) => f.endsWith(".csv"))) {
			candidates.push(join(base, f));
		}
	}
	if (!candidates.length) return null;
	candidates.sort(); // 文件名带时间戳，字典序即时间序
	return candidates[candidates.length - 1];
}

function report(rows, label) {
	const tsList = [...new Set(rows.map((r) => r.ts))].sort((a, b) => a - b);
	const first = tsList[0];
	const last = tsList[tsList.length - 1];
	const duration = last - first;
	const totals = totalSeries(rows);
	const tStart = totals[0]?.totalKB ?? null;
	const tEnd = totals[totals.length - 1]?.totalKB ?? null;
	const tPeak = totals.length ? Math.max(...totals.map((t) => t.totalKB)) : null;
	const aggs = aggregate(rows);

	const lines = [];
	lines.push(`## ${label}`);
	lines.push(`- 采样点数：${rows.length}（${tsList.length} 轮，间隔约 ${duration ? Math.round(duration / tsList.length / 1000) : "-"}s）`);
	lines.push(`- 全体进程 RSS：起始 ${fmtKB(tStart)} → 末尾 ${fmtKB(tEnd)}，峰值 ${fmtKB(tPeak)}，增长 ${fmtKB(tEnd !== null && tStart !== null ? tEnd - tStart : null)}`);
	lines.push("");
	// 主进程 V8 明细（2026-12 补采列）：heapTotal 与 heapUsed 差值即堆内空闲水位，
	// external/arrayBuffers 是堆外增长的归因依据；旧格式 CSV 无这些列时跳过
	const mainAgg = aggs.find((a) => a.type === "Browser");
	if (mainAgg && mainAgg.endHeapTotalKB !== null) {
		lines.push(`- 主进程 V8（末）：heap ${fmtKB(mainAgg.endHeapUsedKB)} / ${fmtKB(mainAgg.endHeapTotalKB)}，external ${fmtKB(mainAgg.endExternalKB)}，arrayBuffers ${fmtKB(mainAgg.endArrayBuffersKB)}`);
	}
	lines.push("| 进程 | 起始 RSS | 末尾 RSS | 峰值 | 增长 | V8堆(末) | DOM(末) | worker(末) | 采样数 |");
	lines.push("|---|---|---|---|---|---|---|---|---|");
	for (const a of aggs) {
		if (a.growthKB === null) continue;
		// V8 堆：Browser 行显示主进程 V8 堆（heapUsed），其余显示 JS 堆（jsHeap）
		const v8Heap = a.type === "Browser" ? a.endHeapUsedKB : a.endJsHeapKB;
		// DOM 节点数：仅渲染进程有；千分位分隔便于读数
		const dom = a.endDomNodes === null ? "-" : a.endDomNodes.toLocaleString("en-US");
		// worker：count(JS 堆合计)；count -1 表示未探测
		const wk = a.endWorkerCount === null || a.endWorkerCount < 0 ? "-" : `${a.endWorkerCount}(${fmtKB(a.endWorkerJSHeapKB)})`;
		lines.push(`| ${a.label}#${a.pid} (${a.type}) | ${fmtKB(a.startRssKB)} | ${fmtKB(a.endRssKB)} | ${fmtKB(a.peakRssKB)} | ${fmtKB(a.growthKB)} | ${fmtKB(v8Heap)} | ${dom} | ${wk} | ${a.samples} |`);
	}
	return lines.join("\n");
}

async function main() {
	const args = process.argv.slice(2);
	let files = args;
	if (!files.length) {
		const latest = await findLatestCsv();
		if (!latest) {
			console.error("未找到采样 CSV。先开启采样运行应用：PIDECK_MEMORY_PROFILE=1 npm run dev");
			process.exit(1);
		}
		files = [latest];
	}

	const parts = [];
	for (const f of files) {
		const text = await readFile(f, "utf8");
		const rows = parseCsv(text);
		parts.push(report(rows, `报告：${f}`));
	}
	console.log(parts.join("\n\n"));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
