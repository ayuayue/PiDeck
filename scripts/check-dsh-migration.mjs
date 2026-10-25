#!/usr/bin/env node
/** 实际 host + RPC 的 V3→V4/fork 门禁：临时 HOME，无模型调用或真实凭据。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";
import * as tar from "tar";
import { buildDshHarness, startDshHarness } from "./dsh-boot-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pideck-dsh-migration-"));
const [input] = process.argv.slice(2);
const installed = input === "--installed";
let host;
const value = (response) => {
	assert.equal(response?.ok, true, JSON.stringify(response));
	return response.value;
};
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const withTimeout = (promise, label, ms = 8_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
};
const compressLine = (line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });

try {
	if (!input) throw new Error("Usage: node scripts/check-dsh-migration.mjs --installed | <runtime.tgz>");
	if (!installed) await tar.x({ file: input, cwd: temp });
	const runtimeRoot = installed ? root : join(temp, "dsh-runtime");
	const resolve = createRequire(join(runtimeRoot, "node_modules", "__migration__.cjs"));
	const { releasedV3SessionFormatCodec: codec } = await import(pathToFileURL(resolve.resolve("@deepseek-ai/dsh-session-format-v2-to-v3")).href);
	const build = await buildDshHarness(temp);
	const require = createRequire(join(build.outdir, "package.json"));
	const { workspaceDirFor, findDshSessionLogFile } = require("./dshSessionPath.js");
	const home = join(temp, "home");
	const cwd = join(temp, "workspace");
	mkdirSync(cwd, { recursive: true });
	const id = "migration-legacy-session";
	const directory = join(home, "sessions", workspaceDirFor(cwd), id);
	mkdirSync(directory, { recursive: true });
	const v3 = join(directory, "session.v3.jsonl.zstd");
	const v4 = join(directory, "session.v4.jsonl.zstd");
	const now = Date.now();
	const header = { version: 3, id, createdAt: now, cwd, isSeeded: false, delegationDepth: 0, agentPreset: "minimal" };
	const eventInputs = [
		{ type: "turn/start", data: { turn: 1 } },
		{ type: "user/message", surfaceOp: "append", data: { role: "user", id: "user-1", content: [{ type: "text", text: "original request" }], source: { kind: "user" } } },
		{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
		{ type: "turn/start", data: { turn: 2 } },
		{ type: "user/message", surfaceOp: "append", data: { role: "user", id: "user-2", content: [{ type: "text", text: "editable second request" }], source: { kind: "user" } } },
		{ type: "turn/end", data: { turn: 2, reason: { kind: "interrupted" } } },
	];
	writeFileSync(v3, Buffer.concat([compressLine(codec.encodeHeader(header, 0)), ...eventInputs.map((event, seq) => compressLine(codec.encodeEvent({ ...event, seq, time: now + seq })))]));
	const originalHash = hash(v3);
	host = await startDshHarness({ build, runtimeRoot, home });
	const cursor = async (sessionId) => value(await (await host.rpc.rawFetch("/pideck-session/rpc", { method: "POST", body: JSON.stringify({ method: "cursor", params: { sessionId } }) })).json()).cursor;
	const page = async (sessionId) => value(await host.rpc.call("session/page", { request: { address: { kind: "session", sessionId }, throughSeq: await cursor(sessionId) } }));
	const users = (history) => history.records.filter((record) => record.event?.type === "user/message").map((record) => record.event.data.content);
	assert.equal(users(await page(id)).length, 2);
	assert.equal(existsSync(v4), false, "read-only page must not promote the session");
	assert.equal(hash(v3), originalHash);

	// rename 是无 LLM 的真实写入口：由上游取得写租约、迁移并落盘。
	value(await host.rpc.call("session/rename", { request: { sessionId: id, title: "Migrated without a model" } }));
	assert.equal(existsSync(v4), true);
	assert.equal(hash(v3), originalHash, "V3 source must remain byte-identical");
	assert.equal(findDshSessionLogFile(directory).path, v4, "PiDeck must select the highest generation");
	const abort = new AbortController();
	const following = host.rpc.openStream("session/follow", { request: { address: { kind: "session", sessionId: id } } }, abort.signal)[Symbol.asyncIterator]();
	assert.equal((await withTimeout(following.next(), "follow snapshot")).value?.type, "snapshot");
	const control = host.rpc.openStream("session/control", {}, abort.signal)[Symbol.asyncIterator]();
	assert.equal((await withTimeout(control.next(), "control baseline")).value?.type, "baseline");
	value(await host.rpc.call("session/cancel", { request: { sessionId: id } }));
	abort.abort();
	await withTimeout(Promise.all([following.return(), control.return()]), "stream cancellation");

	const fork = value(await host.rpc.call("session/fork", { request: { sessionId: id, atSeq: 3 } }));
	assert.deepEqual(users(await page(fork.sessionId)), [[{ type: "text", text: "original request" }]], "inclusive cut before edited user excludes it and synthesizes an open-turn closer");
	await host.stop();
	host = await startDshHarness({ build, runtimeRoot, home });
	assert.equal(users(await page(id)).length, 2);
	assert.deepEqual(users(await page(fork.sessionId)), [[{ type: "text", text: "original request" }]]);
	assert.equal(hash(v3), originalHash);

	// 损坏输入不得发布半个 V4 或改动原文件；不在列表层制造伪成功。
	const corruptDir = join(home, "sessions", workspaceDirFor(cwd), "corrupt");
	mkdirSync(corruptDir);
	const corrupt = join(corruptDir, "session.v3.jsonl.zstd");
	writeFileSync(corrupt, compressLine({ type: "session", version: 3, id: "corrupt" }));
	const badHash = hash(corrupt);
	const failed = await host.rpc.call("session/rename", { request: { sessionId: "corrupt", title: "must fail" } });
	assert.equal(failed.ok, false);
	assert.equal(existsSync(join(corruptDir, "session.v4.jsonl.zstd")), false);
	assert.equal(hash(corrupt), badHash);
	console.log(`MIGRATION OK — V3 cold read/write promotion/V4 restart, source preservation, corrupt input, highest-generation scan, follow/control/fork (${installed ? "installed tree" : "archive"})`);
} catch (error) {
	console.error("MIGRATION FAILED", error);
	if (host) console.error(host.logs());
	process.exitCode = 1;
} finally {
	await host?.stop();
	rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
