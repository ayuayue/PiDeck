#!/usr/bin/env node
/**
 * 轨迹事实读取探针（计划 docs/trajectory-session-consumer-plan.md §8.2）。
 *
 * 用法：node scripts/probeTrajectoryRead.mjs <会话文件.jsonl>
 *
 * 只读。输出索引构建、事实正文读取次数/字节、结果序列化量与版本稳定性；
 * 不打印提示词正文与任何私有路径片段（只打印 basename 与数字）。
 * 每个阶段 10 秒超时，失败即退出，不换路径反复试。
 */
import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";

const file = process.argv[2];
if (!file) {
	console.error("usage: node scripts/probeTrajectoryRead.mjs <session.jsonl>");
	process.exit(2);
}

const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
const { createTrajectoryFactsReader } = loadTsCommonJs("src/main/sessions/trajectoryFactsReader.ts");

const reader = new SessionHistoryReader({
	toHostPath: (sessionPath) => sessionPath,
	convertMessages: () => [],
	trimMessages: (raw) => raw,
	translate: (key) => String(key),
});

const facts = createTrajectoryFactsReader({
	source: {
		getSessionFactIndex: (sessionPath) => reader.getSessionFactIndex(sessionPath),
		readSessionFactLines: (sessionPath, entries) => reader.readSessionFactLines(sessionPath, entries),
	},
});

function ms(start) {
	return Math.round((performance.now() - start) * 10) / 10;
}

async function timed(label, task) {
	const started = performance.now();
	const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), 10_000));
	const value = await Promise.race([task(), timeout]);
	return { value, elapsed: ms(started) };
}

const info = await stat(file);
console.log(`file: ${basename(file)} (${(info.size / 1024 / 1024).toFixed(1)}MB)`);

const indexPhase = await timed("index", () => reader.getSessionFactIndex(file));
console.log(`index: ${indexPhase.elapsed}ms, entries ${indexPhase.value.entries.length}`);

const cold = await timed("cold", () => facts.read(file));
const coldBytes = Buffer.byteLength(JSON.stringify(cold.value), "utf8");
console.log(`cold read: ${cold.elapsed}ms, events ${cold.value.events.length}, payload ${(coldBytes / 1024).toFixed(1)}KB`);
console.log(`  prompts ${cold.value.events.filter((event) => event.kind === "systemPrompt").length}`);
console.log(`  coverage fromStart=${cold.value.coverage.fromStart} chainComplete=${cold.value.coverage.chainComplete} readComplete=${cold.value.coverage.readComplete} eventsTrimmed=${cold.value.coverage.eventsTrimmed}`);
const afterCold = facts.stats();
console.log(`  body reads ${afterCold.bodyReads}, bytes ${(afterCold.bodyBytes / 1024).toFixed(1)}KB`);

const warm = await timed("warm", () => facts.read(file));
const afterWarm = facts.stats();
console.log(`warm read: ${warm.elapsed}ms, extra body reads ${afterWarm.bodyReads - afterCold.bodyReads}`);
console.log(`version stable: ${warm.value.version === cold.value.version}`);
