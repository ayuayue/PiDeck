import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { pickStandbyWarmupProject } = loadTsCommonJs("src/main/pi/standbyWarmupTarget.ts");

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const PROJECTS = new Set(["p1", "p2", "p3"]);

function entry(projectId, updatedAt, backend) {
	return { projectId, updatedAt, ...(backend === undefined ? {} : { backend }) };
}

function pick(entries, overrides = {}) {
	return pickStandbyWarmupProject({
		entries,
		projectIds: PROJECTS,
		defaultBackend: "pi",
		now: NOW,
		...overrides,
	});
}

test("默认后端 pi：预热 catalog 最近活跃项目（新旧条目混排也取最新）", () => {
	assert.equal(pick([entry("p1", NOW - 3 * DAY), entry("p2", NOW - 1000), entry("p3", NOW - 2 * DAY)]), "p2");
	// 最近条目是 dsh 也照样预热该项目的 pi standby：默认后端 pi 时下一次新会话大概率落在这里。
	assert.equal(pick([entry("p1", NOW - DAY, "pi"), entry("p2", NOW - 1000, "dsh")]), "p2");
});

test("默认后端 pi：已删除项目被跳过，回落到仍存在的最近项目", () => {
	assert.equal(pick([entry("gone", NOW), entry("p1", NOW - DAY)]), "p1");
	// 条目全部指向已删除项目 → 不预热（不能给 getProject 失败的项目起进程）
	assert.equal(pick([entry("gone", NOW), entry("gone2", NOW - DAY)]), undefined);
});

test("默认后端 pi：空 catalog 不预热", () => {
	assert.equal(pick([]), undefined);
});

test("默认后端非 pi：仅为近期确实用过 pi 的项目预热", () => {
	const entries = [entry("p1", NOW - 1000, "dsh"), entry("p2", NOW - 2 * DAY, "pi")];
	assert.equal(pick(entries, { defaultBackend: "dsh" }), "p2");
	assert.equal(pick(entries, { defaultBackend: "acp" }), "p2");
	// 旧 catalog 条目没有 backend 字段 → 按 pi 语义（与 SessionCatalogEntry.backend 兼容约定一致）
	assert.equal(pick([entry("p1", NOW - 1000)], { defaultBackend: "dsh" }), "p1");
});

test("默认后端非 pi：窗口外的 pi 会话或纯 dsh 历史 → 不预热", () => {
	const stale = [entry("p1", NOW - 30 * DAY, "pi"), entry("p2", NOW - 1000, "dsh")];
	assert.equal(pick(stale, { defaultBackend: "dsh" }), undefined);
	assert.equal(pick([entry("p1", NOW - 1000, "dsh")], { defaultBackend: "dsh" }), undefined);
	// 窗口可注入：把窗口放宽到 60 天后同一批条目就能命中
	assert.equal(pick(stale, { defaultBackend: "dsh", recentPiWindowMs: 60 * DAY }), "p1");
});

test("默认后端非 pi：窗口内多个 pi 项目取最新", () => {
	const entries = [entry("p1", NOW - 3 * DAY, "pi"), entry("p2", NOW - 2 * 60_000, "pi"), entry("p3", NOW - 1000, "dsh")];
	assert.equal(pick(entries, { defaultBackend: "dsh" }), "p2");
});

test("非法时间戳不参与选择（不会把 NaN 当成最新）", () => {
	assert.equal(pick([entry("p1", NOW - DAY), entry("p2", Number.NaN)]), "p1");
	assert.equal(pick([entry("p1", Number.NaN)]), undefined);
});

test("非法窗口（NaN/负数）不放宽判定：等价于不预热", () => {
	const entries = [entry("p1", NOW - DAY, "pi")];
	assert.equal(pick(entries, { defaultBackend: "dsh", recentPiWindowMs: Number.NaN }), undefined);
	assert.equal(pick(entries, { defaultBackend: "dsh", recentPiWindowMs: -1 }), undefined);
});
test("startup wiring: pi standby warmup runs after WSL config sync and drives ensureStandbyAgent", () => {
	// 启动期预热必须在 syncWslConfig().then 内：WSL 项目的 spawn 参数依赖 agentManager 的
	// WSL 快照，早于它预热会用错环境；同时它不能挡在 createWindow 之前（装配只在 then 内调用）。
	const main = readFileSync("src/main/index.ts", "utf8");
	assert.match(main, /void syncWslConfig\(\)[\s\S]{0,400}warmStandbyAgentAtStartup\(\)/);
	assert.match(main, /function warmStandbyAgentAtStartup\(\): void \{[\s\S]{0,1200}pickStandbyWarmupProject\(/);
	assert.match(main, /function warmStandbyAgentAtStartup\(\): void \{[\s\S]{0,1600}agentManager\.ensureStandbyAgent\(target\)/);
});
