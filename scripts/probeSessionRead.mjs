#!/usr/bin/env node
/**
 * 会话读取基线探针（`docs/session-data-plane-plan.md` 的 Wave 0）。
 *
 * 目的：给「会话数据面统一 sidecar」提供可复跑的现状数字——侧栏首屏扫描耗时、
 * 打开大会话（全量重建显示索引）耗时、主进程内存增量。只有量出这三项，才能判断
 * 某一波改造值不值得做、以及做完有没有变好。
 *
 * 口径刻意对齐生产实现，避免探针比真实路径「乐观」：
 * - 侧栏扫描照 `src/main/sessions/SessionScanner.ts`：并发 4、每文件只读前 1MiB
 *   （`SUMMARY_PARSE_MAX_BYTES`）、逐行 JSON.parse、目录遍历跳过 `.pideck-archive`
 *   与 `subagent-artifacts`；另跑一个「头 + 尾窗口」变体作为上界（标题未定稿时的路径）。
 * - 打开会话照 `src/main/pi/SessionHistoryReader.ts` 的全量重建：1MiB 定长块 + 行边界
 *   （`src/main/sessions/jsonlLineStream.ts`）、单行超 64MiB 只跳过正文、每 400 行让出
 *   一次事件循环、逐行 JSON.parse。
 *
 * 用法：
 *   node scripts/probeSessionRead.mjs                          # 默认根 + 默认档位
 *   node scripts/probeSessionRead.mjs --root <dir> --root <dir>
 *   node --expose-gc scripts/probeSessionRead.mjs --json        # 带 GC 的内存数字更干净
 *   node scripts/probeSessionRead.mjs --targets 1,10,50 --top 5
 *
 * 只读：仅 stat / open / read，不写任何文件。
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 与 SessionScanner.SUMMARY_PARSE_MAX_BYTES 一致。 */
const HEAD_WINDOW_BYTES = 1024 * 1024;
/** 与 SessionScanner.SUMMARY_READ_CONCURRENCY 一致。 */
const SUMMARY_CONCURRENCY = 4;
/** 与 jsonlLineStream 的 DEFAULT_JSONL_CHUNK_BYTES / DEFAULT_JSONL_YIELD_EVERY_LINES 一致。 */
const CHUNK_BYTES = 1024 * 1024;
const YIELD_EVERY_LINES = 400;
/** 与 jsonlLineStream.MAX_JSONL_LINE_BYTES 一致：超长行不 decode 正文。 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** 扫描时要跳过的目录名（对齐 SessionScanner）。 */
const SKIP_DIR_NAMES = new Set([".pideck-archive", "subagent-artifacts"]);

function parseArgs(argv) {
	const options = { roots: [], json: false, targets: [1, 10, 50], top: 10 };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--root") options.roots.push(resolve(argv[++index] ?? ""));
		else if (arg === "--json") options.json = true;
		else if (arg === "--targets")
			options.targets = (argv[++index] ?? "")
				.split(",")
				.map((value) => Number.parseFloat(value))
				.filter((value) => Number.isFinite(value) && value > 0);
		else if (arg === "--top") options.top = Math.max(1, Number.parseInt(argv[++index] ?? "10", 10) || 10);
		else if (arg === "--help" || arg === "-h") options.help = true;
	}
	return options;
}

/** 递归收集 *.jsonl（照 SessionScanner.collectJsonl 的跳过规则）。 */
async function collectSessionFiles(dir, out = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (!entry.isDirectory()) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
			continue;
		}
		if (SKIP_DIR_NAMES.has(entry.name)) continue;
		await collectSessionFiles(path, out);
	}
	return out;
}

async function readPrefix(filePath, maxBytes) {
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function readSuffix(filePath, maxBytes, fileSize) {
	const handle = await open(filePath, "r");
	try {
		const bytesToRead = Math.min(maxBytes, fileSize);
		const buffer = Buffer.allocUnsafe(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, bytesToRead, Math.max(0, fileSize - bytesToRead));
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** 数一遍「按行 parse」的成本；返回行数与成功解析数。 */
function parseLines(text, counter) {
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		counter.lines++;
		try {
			JSON.parse(line);
			counter.parsed++;
		} catch {
			counter.malformed++;
		}
	}
}

/** 流式逐行扫描（照 jsonlLineStream：定长块 + 行边界 + 超长行守卫）。 */
async function scanFileLines(filePath, counter) {
	const handle = await open(filePath, "r");
	try {
		const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
		let carry = Buffer.alloc(0);
		let bytes = 0;
		let yieldCounter = 0;
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null);
			if (bytesRead === 0) break;
			bytes += bytesRead;
			const combined = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : Buffer.from(chunk.subarray(0, bytesRead));
			let start = 0;
			for (;;) {
				const newline = combined.indexOf(0x0a, start);
				if (newline < 0) break;
				const line = combined.subarray(start, newline);
				if (line.length > 0 && line.length <= MAX_LINE_BYTES) {
					counter.lines++;
					try {
						JSON.parse(line.toString("utf8"));
						counter.parsed++;
					} catch {
						counter.malformed++;
					}
				}
				start = newline + 1;
				if (++yieldCounter % YIELD_EVERY_LINES === 0) await new Promise((done) => setTimeout(done, 0));
			}
			// 超长行（巨型内联附件）按生产口径丢弃正文，避免把堆打穿。
			carry = combined.subarray(start).length > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(combined.subarray(start));
		}
		return { bytes, trailingPartial: carry.length };
	} finally {
		await handle.close();
	}
}

function memorySnapshot() {
	if (typeof global.gc === "function") global.gc();
	const usage = process.memoryUsage();
	return { heapUsedMb: usage.heapUsed / 1048576, rssMb: usage.rss / 1048576 };
}

function trackPeakRss(peaks) {
	const rssMb = process.memoryUsage().rss / 1048576;
	if (rssMb > peaks.rssMb) peaks.rssMb = rssMb;
}

async function probeRoot(root, options) {
	const before = memorySnapshot();
	const peaks = { rssMb: before.rssMb };
	const files = [];
	for (const filePath of await collectSessionFiles(root)) {
		try {
			const info = await stat(filePath);
			files.push({ path: filePath, size: info.size });
		} catch {
			// 会话在扫描期间被删除属正常，忽略。
		}
	}
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

	// 1) 侧栏首屏扫描：并发 4、每文件头部窗口、逐行 parse。
	const headCounter = { lines: 0, parsed: 0, malformed: 0 };
	let headBytes = 0;
	const headStartedAt = Date.now();
	for (let index = 0; index < files.length; index += SUMMARY_CONCURRENCY) {
		const batch = files.slice(index, index + SUMMARY_CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (file) => {
				const head = await readPrefix(file.path, Math.min(HEAD_WINDOW_BYTES, file.size));
				parseLines(head.toString("utf8"), headCounter);
				return head.length;
			}),
		);
		for (const bytes of results) headBytes += bytes;
		trackPeakRss(peaks);
		if (index + SUMMARY_CONCURRENCY < files.length) await new Promise((done) => setTimeout(done, 0));
	}
	const headSweepMs = Date.now() - headStartedAt;
	const afterSweep = memorySnapshot();

	// 2) 头 + 尾窗口变体（标题未定稿路径）：大会话还要多读一份尾部窗口。
	const tailCounter = { lines: 0, parsed: 0, malformed: 0 };
	let tailBytes = 0;
	const tailStartedAt = Date.now();
	for (const file of files) {
		if (file.size <= HEAD_WINDOW_BYTES) continue;
		const tail = await readSuffix(file.path, HEAD_WINDOW_BYTES, file.size);
		parseLines(tail.toString("utf8"), tailCounter);
		tailBytes += tail.length;
		trackPeakRss(peaks);
	}
	const tailSweepMs = Date.now() - tailStartedAt;

	// 3) 打开大会话：按目标体积挑最接近的真实文件，跑全量重建口径。
	const sorted = [...files].sort((a, b) => a.size - b.size);
	const opened = [];
	for (const targetMb of options.targets) {
		const targetBytes = targetMb * 1048576;
		let closest = null;
		for (const file of sorted) {
			if (closest === null || Math.abs(file.size - targetBytes) < Math.abs(closest.size - targetBytes)) closest = file;
		}
		if (!closest || closest.size === 0) continue;
		const counter = { lines: 0, parsed: 0, malformed: 0 };
		const startedAt = Date.now();
		const scanned = await scanFileLines(closest.path, counter);
		const elapsedMs = Date.now() - startedAt;
		trackPeakRss(peaks);
		opened.push({
			targetMb,
			path: closest.path,
			sizeMb: closest.size / 1048576,
			elapsedMs,
			lines: counter.lines,
			parsed: counter.parsed,
			malformed: counter.malformed,
			readBytes: scanned.bytes,
			trailingPartial: scanned.trailingPartial,
		});
	}

	const after = memorySnapshot();
	return {
		root,
		files: files.length,
		totalMb: totalBytes / 1048576,
		headSweepMs,
		headReadMb: headBytes / 1048576,
		headLines: headCounter.lines,
		headMalformed: headCounter.malformed,
		perFileMs: files.length > 0 ? headSweepMs / files.length : 0,
		tailSweepMs,
		tailReadMb: tailBytes / 1048576,
		heapDeltaMb: after.heapUsedMb - before.heapUsedMb,
		heapAfterSweepMb: afterSweep.heapUsedMb,
		rssDeltaMb: after.rssMb - before.rssMb,
		peakRssMb: peaks.rssMb,
		largest: sorted
			.slice(-options.top)
			.reverse()
			.map((file) => file.size / 1048576),
		opened,
	};
}

function formatNumber(value, digits = 1) {
	return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function printReport(reports) {
	let totalFiles = 0;
	let totalMb = 0;
	let totalHeadMs = 0;
	for (const report of reports) {
		totalFiles += report.files;
		totalMb += report.totalMb;
		totalHeadMs += report.headSweepMs;
		console.log(`\n■ ${report.root}`);
		console.log(`  文件 ${report.files} / ${formatNumber(report.totalMb)} MiB；最大 ${report.largest.length} 个(MiB)：${report.largest.map((value) => formatNumber(value)).join(", ") || "-"}`);
		console.log(`  侧栏首屏扫描(并发4, 头窗口 1MiB)：${report.headSweepMs} ms（每文件 ${formatNumber(report.perFileMs, 2)} ms；头读 ${formatNumber(report.headReadMb)} MiB；行 ${report.headLines}；坏行 ${report.headMalformed}）`);
		console.log(`  头+尾窗口变体(>1MiB 文件)：${report.tailSweepMs} ms（多读 ${formatNumber(report.tailReadMb)} MiB）`);
		console.log(`  内存：heapUsed ${formatNumber(report.heapDeltaMb)} MiB / 扫描后 ${formatNumber(report.heapAfterSweepMb)} MiB；rss Δ${formatNumber(report.rssDeltaMb)} MiB；rss 峰值 ${formatNumber(report.peakRssMb)} MiB`);
		for (const item of report.opened) {
			console.log(`  打开会话(目标 ${item.targetMb} MiB)：实际 ${formatNumber(item.sizeMb)} MiB → ${item.elapsedMs} ms（行 ${item.lines}；读 ${formatNumber(item.readBytes / 1048576)} MiB；末尾残行 ${item.trailingPartial} 字节）`);
			console.log(`    ${item.path}`);
		}
	}
	console.log(`\n合计：${totalFiles} 文件 / ${formatNumber(totalMb)} MiB；侧栏扫描总耗时 ${totalHeadMs} ms（未并行时）`);
	console.log("提示：单机数字仅供同机前后对比；改实现后用同一命令复跑。");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log("用法：node scripts/probeSessionRead.mjs [--root <dir>]... [--json] [--targets 1,10,50] [--top 10]");
		return;
	}
	const roots = options.roots.length > 0 ? options.roots : [join(homedir(), ".pi", "agent", "sessions"), join(process.cwd(), ".pi", "sessions")];
	const reports = [];
	for (const root of roots) {
		const report = await probeRoot(root, options).catch((error) => ({ root, error: error instanceof Error ? error.message : String(error) }));
		reports.push(report);
	}
	if (options.json) {
		console.log(JSON.stringify({ generatedAt: new Date().toISOString(), roots: reports }, null, 2));
		return;
	}
	printReport(reports);
}

await main();
