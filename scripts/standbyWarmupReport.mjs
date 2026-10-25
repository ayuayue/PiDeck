#!/usr/bin/env node
/**
 * standby / pi 预热收益报告：解析 PiDeck 应用日志（userData/logs/app-*.log）量化「预热到底省了多少」。
 *
 * 为什么用日志而不是加遥测：一次 pi 启动 8~50s 的耗时、认领命中、等待时长、重复 spawn 都是
 * 主进程已有的结构化 appLogger 事件（scope/detail JSON），离线聚合即可对比升级前后，不需要
 * 新增上报通道；脚本只读日志，不碰运行时。
 *
 * 指标（括号内是依赖的日志事件）：
 * - pi spawn 耗时分布（agent:Pi process spawned.spawnCallMs）；standby 与真会话分开统计
 * - 新会话激活延迟 & standby 命中率（agent:Standby agent ready + session-perf:Runtime activation*）
 * - 认领等待收益（agent:Standby claim waiting/adopted/fell back，2026-10 起才有）
 * - 启动期预热收益（agent:Startup standby warmup requested → ready → claimed / wasted）
 * - 重复并行 spawn（真会话 spawn 与 standby spawn 窗口重叠）——升级前缺陷基线
 * - DSH host 启动预热（dsh-host:forking host entry → host ready；首次 dsh 使用延迟）
 *
 * 用法：
 *   node scripts/standbyWarmupReport.mjs                     # 最近 30 天
 *   node scripts/standbyWarmupReport.mjs --days 7
 *   node scripts/standbyWarmupReport.mjs --dir <logs 目录> --json
 *   node scripts/standbyWarmupReport.mjs --since 2026-10-01T00:00:00Z --until 2026-10-21T00:00:00Z
 *
 * 对比方法：升级前后各跑一次（或用 --since/--until 切窗口），看 coldSpawn 数、activationMs、
 * claimWait.adopted、startupWarmup.claimed、duplicateParallelSpawns.count 的差值。
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STANDBY_TTL_MS = 10 * 60 * 1000;
const NEW_SESSION_MATCH_MS = 30 * 60 * 1000;
const STARTUP_READY_MATCH_MS = 2 * 60 * 1000;

/** 单行日志 → 事件；坏行（半写/非 JSON）跳过，不抛错。 */
export function parseLogLines(text) {
	const events = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed.time !== "number" || typeof parsed.message !== "string") continue;
		events.push({ t: parsed.time, level: parsed.level, scope: parsed.scope ?? "", message: parsed.message, detail: parsed.detail && typeof parsed.detail === "object" ? parsed.detail : {} });
	}
	return events;
}

/** 读取日志目录下 app-*.log；目录不存在/为空返回 []。 */
export function readLogEvents(dir) {
	let names;
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".log"));
	} catch {
		return [];
	}
	const events = [];
	for (const name of names.sort()) {
		try {
			events.push(...parseLogLines(readFileSync(join(dir, name), "utf8")));
		} catch {
			// 单文件读失败（被轮转/占用）不影响其它日志
		}
	}
	return events.sort((a, b) => a.t - b.t).filter((event) => event.scope !== undefined);
}

function has(event, scope, message) {
	return event.scope === scope && event.message.includes(message);
}

export function quantiles(values) {
	const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	const at = (q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
	return { n: sorted.length, p50: at(0.5), p75: at(0.75), p90: at(0.9), p99: at(0.99), max: sorted.length ? sorted[sorted.length - 1] : null, sum: sorted.reduce((sum, value) => sum + value, 0) };
}

function round(value) {
	return value === null || value === undefined ? null : Math.round(value);
}

function roundStats(stats) {
	return { n: stats.n, p50: round(stats.p50), p75: round(stats.p75), p90: round(stats.p90), p99: round(stats.p99), max: round(stats.max), sum: round(stats.sum) };
}

/** 事件是否属于「真会话 spawn」（非待命进程）：standby 进程完成后会记 Standby agent ready。 */
function classifySpawns(events) {
	const standbyIds = new Set(events.filter((event) => has(event, "agent", "Standby agent ready")).map((event) => event.detail.agentId));
	const spawns = [];
	for (const event of events) {
		if (!has(event, "agent", "Pi process spawned")) continue;
		const agentId = typeof event.detail.agentId === "string" ? event.detail.agentId : undefined;
		const durationMs = typeof event.detail.spawnCallMs === "number" ? event.detail.spawnCallMs : undefined;
		if (!agentId || durationMs === undefined) continue;
		spawns.push({ agentId, durationMs, endT: event.t, startT: event.t - durationMs, standby: standbyIds.has(agentId) });
	}
	return spawns;
}

/** 去重后的 pi 新会话激活：按 (sessionId, agentId) 取最大 activationMs，且会话此前有草稿。 */
function collectNewSessionActivations(events) {
	const draftBySession = new Map();
	for (const event of events) {
		if (!has(event, "session", "Session draft created")) continue;
		if (typeof event.detail.sessionId === "string") draftBySession.set(event.detail.sessionId, event);
	}
	const byKey = new Map();
	for (const event of events) {
		if (!event.message.includes("Runtime activation")) continue;
		const { sessionId, agentId, activationMs } = event.detail;
		if (typeof activationMs !== "number" || typeof sessionId !== "string" || typeof agentId !== "string") continue;
		if (agentId.startsWith("dsh:") || agentId.startsWith("acp:")) continue;
		const key = sessionId + "|" + agentId;
		const previous = byKey.get(key);
		if (!previous || activationMs > previous.activationMs) byKey.set(key, { t: event.t, sessionId, agentId, activationMs });
	}
	const activations = [];
	for (const activation of byKey.values()) {
		const draft = draftBySession.get(activation.sessionId);
		if (!draft || activation.t < draft.t || activation.t - draft.t > NEW_SESSION_MATCH_MS) continue;
		activations.push({ ...activation, draftT: draft.t, projectId: draft.detail.projectId });
	}
	return activations.sort((a, b) => a.t - b.t);
}

function appRunRanges(events) {
	const starts = events.filter((event) => has(event, "app", "Application started")).map((event) => event.t);
	const end = events.length ? events[events.length - 1].t : Date.now();
	return starts.map((start, index) => ({ start, end: index + 1 < starts.length ? starts[index + 1] : end }));
}

/**
 * 聚合日志 → 报告对象（纯函数，测试可直接构造事件数组）。
 * @param {ReturnType<typeof parseLogLines>} events
 */
export function buildStandbyReport(events) {
	const sorted = [...events].sort((a, b) => a.t - b.t);
	const spawns = classifySpawns(sorted);
	const spawnById = new Map(spawns.map((spawn) => [spawn.agentId, spawn]));
	const activations = collectNewSessionActivations(sorted);
	const standbyReady = sorted.filter((event) => has(event, "agent", "Standby agent ready"));
	const standbyClaimed = sorted.filter((event) => has(event, "agent", "Standby agent claimed"));
	const claimedIds = new Set(standbyClaimed.map((event) => event.detail.agentId));

	// ── 新会话激活：认领命中 vs 冷启动 ──
	const activationClasses = { claimed: [], cold: [], unknown: [] };
	for (const activation of activations) {
		const spawn = spawnById.get(activation.agentId);
		const bucket = !spawn ? activationClasses.unknown : spawn.standby ? activationClasses.claimed : activationClasses.cold;
		bucket.push(activation);
	}
	const activationMsOf = (list) => quantiles(list.map((item) => item.activationMs));
	const coldSpawnMs = quantiles(activationClasses.cold.map((item) => spawnById.get(item.agentId).durationMs));

	// ── 认领等待（2026-10 起的新事件）──
	const claimWaitRequests = sorted.filter((event) => has(event, "agent", "Standby claim waiting for in-flight warmup"));
	const claimWaitAdopted = sorted.filter((event) => has(event, "agent", "Standby claim adopted in-flight warmup"));
	const claimWaitFellBack = sorted.filter((event) => has(event, "agent", "Standby claim wait fell back to regular spawn"));
	const waitedMs = claimWaitAdopted.map((event) => event.detail.waitedMs).filter((value) => typeof value === "number");
	// 典型冷启动成本：优先用本窗口真会话冷启动的 p50；升级后冷启动变少时退回全部 spawn 的 p50
	// （standby 进程与真会话跑的是同一套 pi+扩展，耗时同量级），保证跨窗口可对比。
	const typicalSpawnMs = coldSpawnMs.p50 ?? quantiles(spawns.map((spawn) => spawn.durationMs)).p50 ?? 0;
	const claimWaitSavedMs = claimWaitAdopted.reduce((sum, event) => {
		const waited = typeof event.detail.waitedMs === "number" ? event.detail.waitedMs : 0;
		return sum + Math.max(0, typicalSpawnMs - waited);
	}, 0);

	// ── 启动期预热（2026-10 起的新事件）：requested → ready → claimed / wasted ──
	const startupRequests = sorted.filter((event) => has(event, "agent", "Startup standby warmup requested"));
	const readyAfter = (requestT) => standbyReady.find((event) => event.t > requestT && event.t - requestT <= STARTUP_READY_MATCH_MS);
	const startupSamples = [];
	for (const request of startupRequests) {
		const ready = readyAfter(request.t);
		if (!ready) {
			startupSamples.push({ requestT: request.t, projectId: request.detail.projectId, ready: null });
			continue;
		}
		const agentId = ready.detail.agentId;
		const spawn = spawnById.get(agentId);
		const claimed = standbyClaimed.find((event) => event.detail.agentId === agentId);
		const expired = !claimed && sorted.some((event) => has(event, "agent", "Agent stopped") && event.detail.agentId === agentId && event.t > ready.t);
		startupSamples.push({ requestT: request.t, projectId: request.detail.projectId, agentId, readyT: ready.t, readyDelayMs: ready.t - request.t, spawnMs: spawn?.durationMs, claimed, expired });
	}
	const startupClaims = startupSamples.filter((sample) => sample.claimed);
	const startupWasted = startupSamples.filter((sample) => !sample.claimed && sample.expired);
	const startupClaimedIds = new Set(startupClaims.map((sample) => sample.claimed.detail.agentId));
	// 启动预热的收益：被认领时省掉的是「该会话本来要自己冷启动」的那次 spawn，用同一进程的
	// spawn 耗时做代理（同一台机器同一时段，量级一致）；没等到认领的预热是纯成本。
	const startupSavedMs = startupClaims.reduce((sum, sample) => sum + (sample.spawnMs ?? typicalSpawnMs), 0);
	const startupWastedMs = startupWasted.reduce((sum, sample) => sum + (sample.spawnMs ?? 0), 0);

	// ── 重复并行 spawn（升级前缺陷基线）──
	const standbyWindows = spawns.filter((spawn) => spawn.standby);
	let duplicatePairs = 0;
	for (const real of spawns.filter((spawn) => !spawn.standby)) {
		const overlapped = standbyWindows.some((standby) => Math.max(real.startT, standby.startT) < Math.min(real.endT, standby.endT) - 1000);
		if (overlapped) duplicatePairs += 1;
	}

	// ── DSH host 预热 ──
	const forks = sorted.filter((event) => has(event, "dsh-host", "forking host entry"));
	const hostReady = sorted.filter((event) => has(event, "dsh-host", "host ready"));
	const boots = [];
	for (const ready of hostReady) {
		const fork = forks.filter((event) => event.t < ready.t).pop();
		if (fork && ready.t - fork.t <= 180000) boots.push({ forkT: fork.t, readyT: ready.t, durationMs: ready.t - fork.t });
	}
	const runs = appRunRanges(sorted);
	const dshActivations = sorted.filter((event) => event.detail.agentId && typeof event.detail.agentId === "string" && event.detail.agentId.startsWith("dsh:"));
	let dshRuns = [];
	for (const run of runs) {
		const boot = boots.find((item) => item.forkT >= run.start && item.forkT < run.end);
		const firstDsh = dshActivations.find((event) => event.t >= run.start && event.t < run.end);
		const sinceStart = firstDsh ? firstDsh.t - run.start : null;
		// 预热收益：host ready 之前开始用 DSH 的用户只省下剩余 boot；之后就省掉整轮 boot。
		const savedMs = boot && sinceStart !== null ? Math.round(Math.max(0, Math.min(boot.durationMs, sinceStart - (boot.forkT - run.start)))) : 0;
		dshRuns.push({ runStart: run.start, bootMs: boot?.durationMs ?? null, firstDshSinceStartMs: sinceStart, dshUsed: sinceStart !== null, savedMs });
	}

	return {
		window: { from: sorted.length ? sorted[0].t : null, to: sorted.length ? sorted[sorted.length - 1].t : null, appRuns: runs.length },
		piSpawn: { total: spawns.length, standby: spawns.filter((spawn) => spawn.standby).length, real: spawns.filter((spawn) => !spawn.standby).length, durationMs: roundStats(quantiles(spawns.map((spawn) => spawn.durationMs))) },
		newSessionActivations: {
			total: activations.length,
			claimed: activationClasses.claimed.length,
			cold: activationClasses.cold.length,
			unknown: activationClasses.unknown.length,
			claimedRate: activations.length ? activationClasses.claimed.length / activations.length : null,
			claimedActivationMs: roundStats(activationMsOf(activationClasses.claimed)),
			coldActivationMs: roundStats(activationMsOf(activationClasses.cold)),
			coldSpawnMs: roundStats(coldSpawnMs),
		},
		standbyPool: {
			ready: standbyReady.length,
			claimed: standbyClaimed.length,
			unclaimed: Math.max(0, standbyReady.length - standbyReady.filter((event) => claimedIds.has(event.detail.agentId)).length),
		},
		claimWait: {
			requests: claimWaitRequests.length,
			adopted: claimWaitAdopted.length,
			fellBack: claimWaitFellBack.length,
			adoptedRate: claimWaitRequests.length ? claimWaitAdopted.length / claimWaitRequests.length : null,
			waitedMs: roundStats(quantiles(waitedMs)),
			estimatedSavedMs: Math.round(claimWaitSavedMs),
		},
		startupWarmup: {
			requests: startupRequests.length,
			ready: startupSamples.filter((sample) => sample.readyT).length,
			claimed: startupClaims.length,
			wasted: startupWasted.length,
			claimedRate: startupSamples.length ? startupClaims.length / startupSamples.length : null,
			readyDelayMs: roundStats(quantiles(startupSamples.filter((sample) => typeof sample.readyDelayMs === "number").map((sample) => sample.readyDelayMs))),
			estimatedSavedMs: Math.round(startupSavedMs),
			wastedSpawnMs: Math.round(startupWastedMs),
		},
		duplicateParallelSpawns: { count: duplicatePairs, realSpawns: spawns.filter((spawn) => !spawn.standby).length },
		dshHost: {
			boots: boots.length,
			bootMs: roundStats(quantiles(boots.map((item) => item.durationMs))),
			runsUsingDsh: dshRuns.filter((run) => run.dshUsed).length,
			runsWarmingUnused: dshRuns.filter((run) => run.bootMs !== null && !run.dshUsed).length,
			estimatedSavedMs: dshRuns.reduce((sum, run) => sum + run.savedMs, 0),
		},
	};
}

function formatMs(value) {
	return value === null || value === undefined ? "n/a" : value >= 1000 ? (value / 1000).toFixed(1) + "s" : String(value) + "ms";
}

function formatStats(stats) {
	if (!stats || stats.n === 0) return "n/a";
	return "p50=" + formatMs(stats.p50) + " p90=" + formatMs(stats.p90) + " max=" + formatMs(stats.max) + " (n=" + stats.n + ")";
}

/** 报告对象 → 人读文本。 */
export function formatStandbyReport(report) {
	const lines = [];
	const range = report.window.from ? new Date(report.window.from).toISOString().slice(0, 16) + " → " + new Date(report.window.to).toISOString().slice(0, 16) : "无数据";
	lines.push("窗口: " + range + "，应用启动 " + report.window.appRuns + " 次");
	lines.push("");
	lines.push("pi spawn: 共 " + report.piSpawn.total + "（真会话 " + report.piSpawn.real + " / standby " + report.piSpawn.standby + "），耗时 " + formatStats(report.piSpawn.durationMs));
	lines.push("新会话激活: " + report.newSessionActivations.total + " 次，认领命中 " + report.newSessionActivations.claimed + "（" + (report.newSessionActivations.claimedRate === null ? "n/a" : (report.newSessionActivations.claimedRate * 100).toFixed(1) + "%") + "）");
	lines.push("  认领命中激活延迟: " + formatStats(report.newSessionActivations.claimedActivationMs));
	lines.push("  冷启动次数: " + report.newSessionActivations.cold + "，激活延迟 " + formatStats(report.newSessionActivations.coldActivationMs) + "，其中 spawn " + formatStats(report.newSessionActivations.coldSpawnMs));
	lines.push("standby 池: ready " + report.standbyPool.ready + "，claimed " + report.standbyPool.claimed + "，未认领 " + report.standbyPool.unclaimed);
	lines.push("认领等待（本次改动新增）: 请求 " + report.claimWait.requests + "，认领成功 " + report.claimWait.adopted + "，回退 " + report.claimWait.fellBack + "，等待 " + formatStats(report.claimWait.waitedMs));
	lines.push("  估算省掉的时间: " + formatMs(report.claimWait.estimatedSavedMs) + "（= Σ max(0, 典型冷启动 - 实际等待)）");
	lines.push("启动期预热（本次改动新增）: 请求 " + report.startupWarmup.requests + "，就绪 " + report.startupWarmup.ready + "，被认领 " + report.startupWarmup.claimed + "，过期浪费 " + report.startupWarmup.wasted + "，就绪延迟 " + formatStats(report.startupWarmup.readyDelayMs));
	lines.push("  估算省掉的时间: " + formatMs(report.startupWarmup.estimatedSavedMs) + "（被认领的预热若不存在，对应会话要自己冷启动）；浪费 " + formatMs(report.startupWarmup.wastedSpawnMs));
	lines.push("重复并行 spawn（升级前缺陷基线）: " + report.duplicateParallelSpawns.count + " / " + report.duplicateParallelSpawns.realSpawns + " 次真会话 spawn 与 standby spawn 重叠");
	lines.push("DSH host 预热: boot " + report.dshHost.boots + " 次，耗时 " + formatStats(report.dshHost.bootMs) + "；使用 DSH 的启动 " + report.dshHost.runsUsingDsh + " 次，预热了未使用 " + report.dshHost.runsWarmingUnused + " 次；估算省掉 " + formatMs(report.dshHost.estimatedSavedMs));
	lines.push("");
	lines.push("对比方法：升级前后各跑一次本脚本（或 --since/--until 切窗口），看「冷启动次数 / 冷启动激活延迟」是否下降、「认领等待 adopted / 启动期预热 claimed」是否上升、「重复并行 spawn」是否归零。");
	return lines.join("\n");
}

function defaultLogDir() {
	if (process.env.PIDECK_LOG_DIR) return process.env.PIDECK_LOG_DIR;
	const candidates = [process.env.APPDATA ? join(process.env.APPDATA, "PiDeck", "logs") : null, join(homedir(), "Library", "Application Support", "PiDeck", "logs"), join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "PiDeck", "logs")];
	return candidates.find((candidate) => candidate && readdirSyncSafe(candidate)) ?? candidates[0];
}

function readdirSyncSafe(dir) {
	try {
		return readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

function parseArgs(argv) {
	const options = { dir: null, days: 30, since: null, until: null, json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--dir") options.dir = argv[++index] ?? null;
		else if (arg === "--days") options.days = Math.max(1, Number(argv[++index]) || 30);
		else if (arg === "--since") options.since = Date.parse(argv[++index]);
		else if (arg === "--until") options.until = Date.parse(argv[++index]);
		else if (arg === "--json") options.json = true;
	}
	return options;
}

export function filterByWindow(events, { since, until, days }) {
	const untilT = Number.isFinite(until) ? until : undefined;
	const sinceT = Number.isFinite(since) ? since : days ? Date.now() - days * 24 * 60 * 60 * 1000 : undefined;
	return events.filter((event) => (sinceT === undefined || event.t >= sinceT) && (untilT === undefined || event.t <= untilT));
}

function main(argv) {
	const options = parseArgs(argv);
	const dir = options.dir ? resolve(options.dir) : defaultLogDir();
	const events = filterByWindow(readLogEvents(dir), options);
	const report = buildStandbyReport(events);
	if (options.json) {
		process.stdout.write(JSON.stringify({ dir, ...report }, null, 2) + "\n");
		return;
	}
	process.stdout.write("日志目录: " + dir + "\n\n" + formatStandbyReport(report) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2));
}
