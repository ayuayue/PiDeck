import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { BINARY_IDENTITY, BINARY_PATH, createFakeTextHost, revisionOf, sha256 } from "./helpers/fakeRemoteTextHost.mjs";

const { createRemoteProjectTextTransfer } = loadTsCommonJs("src/main/remote/RemoteProjectTextTransfer.ts");

/**
 * 正文搬运层（SFTP）自己的契约：只测这一层，不经过文本服务。
 *
 * 两件事必须钉住：读只下载一次且与快照摘要对齐；写把本地 0600 临时文件经 stage/commit 原子替换，
 * 并把 helper 的拒绝码翻译成编辑器稳定码（冲突 vs 结果未确认是两种完全不同的处置）。
 */

async function fixture(t, hostOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), "pideck-text-transfer-"));
	const deployRoot = await mkdtemp(join(tmpdir(), "pideck-text-deploy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(deployRoot, { recursive: true, force: true }));
	const path = join(root, "code.ts");
	await writeFile(path, "original\n", { mode: 0o640 });
	const host = createFakeTextHost({ root, deployRoot, ...hostOptions });
	const transfer = createRemoteProjectTextTransfer({ binary: async () => ({ path: BINARY_PATH, identity: BINARY_IDENTITY }), cache: host.cache, probe: host.probe, adapter: host.adapter });
	return { deployRoot, host, path, root, transfer };
}

const target = (f) => ({ session: f.host.session, canonicalRoot: f.root, relative: "code.ts" });

test("download transfers once and returns bytes that match the snapshot exactly", async (t) => {
	const f = await fixture(t);
	const revision = await revisionOf(f.path);
	const bytes = await f.transfer.download({ ...target(f), revision });
	assert.equal(bytes.toString("utf8"), "original\n");
	assert.equal(f.host.calls.downloads.length, 1);
	assert.equal(sha256(bytes), revision.digest);
});

test("download refuses bytes that no longer match the snapshot and leaves temp files behind nowhere", async (t) => {
	const f = await fixture(t, { downloadBytes: (bytes) => Buffer.concat([bytes, Buffer.from("drift")]) });
	const revision = await revisionOf(f.path);
	await assert.rejects(f.transfer.download({ ...target(f), revision }), /REMOTE_FILE_CHANGED/);
	const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith("pideck-remote-text-"));
	assert.deepEqual(leftovers, [], "私有临时目录必须整块删除");
});

test("replace writes the exact bytes through stage/commit with policy replace", async (t) => {
	const f = await fixture(t);
	const expected = await revisionOf(f.path);
	const bytes = Buffer.from("replaced body\n");
	const { revision } = await f.transfer.replace({ ...target(f), capabilities: f.host.capabilities, bytes, expected });
	assert.equal(await readFile(f.path, "utf8"), "replaced body\n");
	// Windows 的 stat 没有 POSIX 权限位（文件恒 0o666），「保留原模式」只在 POSIX 上可验。
	if (process.platform !== "win32") assert.equal((await stat(f.path)).mode & 0o7777, 0o640, "替换保留原文件模式");
	assert.equal(revision.digest, sha256(bytes));
	assert.equal(revision.size, bytes.length);
	assert.equal(f.host.calls.prepare.length, 1);
	assert.equal(f.host.calls.prepare[0].policy, "replace");
	assert.equal(f.host.calls.commit.length, 1);
	assert.deepEqual(
		(await readdir(f.root)).filter((name) => name.endsWith(".pideck-put")),
		[],
	);
});

test("replace maps a stale target to REMOTE_FILE_CHANGED before publishing", async (t) => {
	const f = await fixture(t);
	const expected = await revisionOf(f.path);
	await writeFile(f.path, "someone else\n");
	await assert.rejects(f.transfer.replace({ ...target(f), capabilities: f.host.capabilities, bytes: Buffer.from("mine\n"), expected }), /REMOTE_FILE_CHANGED/);
	assert.equal(await readFile(f.path, "utf8"), "someone else\n");
	assert.equal(f.host.calls.stages.length, 0, "prepare 拒绝时连正文都还没 stage");
});

test("replace reports a lost commit reply as REMOTE_FILE_COMMIT_UNCONFIRMED (unknown, never replayed)", async (t) => {
	const f = await fixture(t, { afterPublish: async ({ target: path }) => writeFile(path, "external after commit\n") });
	const expected = await revisionOf(f.path);
	await assert.rejects(f.transfer.replace({ ...target(f), capabilities: f.host.capabilities, bytes: Buffer.from("mine\n"), expected }), /REMOTE_FILE_COMMIT_UNCONFIRMED/);
	assert.equal(f.host.calls.commit.length, 1);
});

test("replace refuses when the committed body is not the one we asked to write", async (t) => {
	const f = await fixture(t);
	const expected = await revisionOf(f.path);
	// stage 报告的字数与本地正文不符：事务内部就会拒绝，绝不会当成写入成功。
	const broken = createFakeTextHost({ root: f.root, deployRoot: f.deployRoot, stageSha: createHash("sha256").update("other").digest("hex") });
	const transfer = createRemoteProjectTextTransfer({ binary: async () => ({ path: BINARY_PATH, identity: BINARY_IDENTITY }), cache: broken.cache, probe: broken.probe, adapter: broken.adapter });
	await assert.rejects(transfer.replace({ ...target(f), session: broken.session, capabilities: broken.capabilities, bytes: Buffer.from("mine\n"), expected }), /REMOTE_UPLOAD_STAGE_INVALID/);
	assert.equal(await readFile(f.path, "utf8"), "original\n");
	assert.equal(broken.calls.abort.length, 1, "stage 拒绝后 spool 由一次性 token 清理");
});

test("a missing SFTP executor is a stable code, never a shell fallback", async (t) => {
	const f = await fixture(t);
	const transfer = createRemoteProjectTextTransfer({ binary: async () => undefined, cache: f.host.cache, probe: f.host.probe, adapter: f.host.adapter });
	const revision = await revisionOf(f.path);
	await assert.rejects(transfer.download({ ...target(f), revision }), /REMOTE_SFTP_BINARY_UNAVAILABLE/);
	await assert.rejects(transfer.replace({ ...target(f), capabilities: f.host.capabilities, bytes: Buffer.from("x"), expected: revision }), /REMOTE_SFTP_BINARY_UNAVAILABLE/);
	assert.equal(f.host.calls.downloads.length, 0);
	assert.equal(f.host.calls.stages.length, 0);
});

test("a failed capability probe stops before any transfer", async (t) => {
	const f = await fixture(t, { probeResult: { ok: false, code: "REMOTE_SFTP_SUBSYSTEM_UNAVAILABLE" } });
	const revision = await revisionOf(f.path);
	await assert.rejects(f.transfer.download({ ...target(f), revision }), /REMOTE_SFTP_SUBSYSTEM_UNAVAILABLE/);
	assert.equal(f.host.calls.downloads.length, 0);
});
