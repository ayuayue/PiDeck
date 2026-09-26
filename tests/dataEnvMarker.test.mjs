/**
 * 决策指针 pideck-env.json 读写与启动期数据环境校验。
 * - readDataEnvDecision：不存在/损坏 → null 且不抛（dev 首启弹窗判定的「无决策」形态）；
 * - writeDataEnvDecision：tmp+rename 原子写，写后读回字段完整；
 * - validateStartupDataEnv：stable 包落在 channel-dev 目录 → mismatch（手动指错目录）；
 *   其余组合 ok；无目录标记的存量目录视为 shared → ok。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DATA_ENV_DECISION_FILENAME, readDataEnvDecision, writeDataEnvDecision, validateStartupDataEnv } = loadTsCommonJs("src/main/dataEnv/dataEnvMarker.ts");

/** 建一次性临时目录，测试结束后清理。 */
function makeTempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-dataenv-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** 构造合法决策对象，避免每个用例重复字段。 */
function decision(dataMode) {
	return { schemaVersion: 1, dataMode, lastAppVersion: "0.8.0-beta.1", createdAt: "2026-09-25T00:00:00.000Z" };
}

test("决策指针文件名固定为 pideck-env.json", () => {
	assert.equal(DATA_ENV_DECISION_FILENAME, "pideck-env.json");
});

test("readDataEnvDecision：文件不存在 → null（dev 首启弹窗判定）", (t) => {
	const dir = makeTempDir(t);
	assert.equal(readDataEnvDecision(dir), null);
});

test("writeDataEnvDecision + readDataEnvDecision：写后读回字段完整", (t) => {
	const dir = makeTempDir(t);
	const written = writeDataEnvDecision(dir, "channel-dev", "0.8.0-beta.1");
	assert.equal(written.schemaVersion, 1);
	assert.equal(written.dataMode, "channel-dev");
	assert.equal(written.lastAppVersion, "0.8.0-beta.1");
	assert.ok(written.createdAt);

	assert.deepEqual(readDataEnvDecision(dir), written);
});

test("readDataEnvDecision：损坏 JSON → null 且不抛", (t) => {
	const dir = makeTempDir(t);
	writeFileSync(join(dir, DATA_ENV_DECISION_FILENAME), "{ not-json", "utf8");
	assert.equal(readDataEnvDecision(dir), null);
});

test("readDataEnvDecision：JSON 合法但 dataMode 越界 → null", (t) => {
	const dir = makeTempDir(t);
	writeFileSync(join(dir, DATA_ENV_DECISION_FILENAME), JSON.stringify({ schemaVersion: 1, dataMode: "magic" }), "utf8");
	assert.equal(readDataEnvDecision(dir), null);
});

test("validateStartupDataEnv：stable 包落在 channel-dev 目录 → mismatch", () => {
	assert.equal(validateStartupDataEnv("stable", decision("channel-dev")), "mismatch");
});

test("validateStartupDataEnv：dev + channel-dev 决策 → ok", () => {
	assert.equal(validateStartupDataEnv("dev", decision("channel-dev")), "ok");
});

test("validateStartupDataEnv：dev + shared 决策 → ok", () => {
	assert.equal(validateStartupDataEnv("dev", decision("shared")), "ok");
});

test("validateStartupDataEnv：stable + shared 决策 → ok", () => {
	assert.equal(validateStartupDataEnv("stable", decision("shared")), "ok");
});

test("validateStartupDataEnv：无目录标记（存量目录）→ ok 且视为 shared", () => {
	assert.equal(validateStartupDataEnv("dev", null), "ok");
	assert.equal(validateStartupDataEnv("stable", null), "ok");
});
