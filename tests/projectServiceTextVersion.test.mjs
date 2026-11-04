/**
 * T：文本保存令牌纠错（跨平台、无 SSH、无本机 fs 依赖）。
 *
 * 用真实的 main RemoteProjectFileService/RemoteProjectEntryService + 模拟命令传输，验证：
 * - readText 的有效 version 原样传给 save，保存成功并返回新 version；
 * - version 缺失/空串时 provider 零调用拒绝；
 * - entry 令牌不是文本 version，main 拒绝且不写、不消费 entry 令牌；
 * - 跨窗口/跨项目/旧主机身份/过期/重放令牌都被 main 拒绝且文件不变；
 * - unknown 结果只抛一次、不重放、不自动 open/stat。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteProjectFileService: createMainTextService } = loadTsCommonJs("src/main/remote/RemoteProjectFileService.ts");
const { createRemoteProjectEntryService } = loadTsCommonJs("src/main/remote/RemoteProjectEntryService.ts");
const { createProjectServices, PROJECT_SERVICE_CODES, ProjectServiceError } = loadTsCommonJs("src/renderer/src/services/projectServices.ts");

const hostId = "11111111-1111-4111-8111-111111111111";
const root = "/srv/project";
const otherRoot = "/srv/other";
const commandPattern = /\x27([a-z]+)\x27 \x27(PIDECK_FILE_[a-f0-9]{32})\x27 \x27([^\x27]*)\x27 \x27([^\x27]*)\x27 \x27(\{.*\})\x27$/;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function identity(state) {
	const bytes = Buffer.from(state.content, "utf8");
	return { mode: 0o644, size: bytes.length, dev: "1", ino: String(state.ino), uid: "3", gid: "4", mtimeNs: String(state.mtime), ctimeNs: String(state.mtime), digest: sha256(bytes) };
}

function entryRevision(state) {
	const { digest: _digest, ...revision } = identity(state);
	return revision;
}

function textFixture(initial = "hello\n") {
	const state = { content: initial, ino: 10, mtime: 100, hostRevision: 1, now: 0, temporary: new Map(), ops: [], commands: [] };
	const target = { hostId, remotePath: root };
	function dispatch(command) {
		state.commands.push(command);
		const match = commandPattern.exec(command);
		assert.ok(match, "command must keep the fixed argv shape");
		const [, operation, marker, , , raw] = match;
		const args = JSON.parse(raw);
		state.ops.push(operation);
		if (operation === "snapshot") return marker + JSON.stringify({ ok: true, revision: identity(state) });
		if (operation === "read") {
			const bytes = Buffer.from(state.content, "utf8");
			return marker + JSON.stringify({ ok: true, data: bytes.subarray(args.offset, args.offset + args.count).toString("base64") });
		}
		if (operation === "upload") {
			const previous = state.temporary.get(args.temporary) ?? Buffer.alloc(0);
			state.temporary.set(args.temporary, Buffer.concat([previous, Buffer.from(args.data, "base64")]));
			return marker + JSON.stringify({ ok: true });
		}
		if (operation === "commit") {
			const uploaded = state.temporary.get(args.temporary);
			if (uploaded === undefined || uploaded.length !== args.size || sha256(uploaded) !== args.digest) return marker + JSON.stringify({ ok: false, code: "REMOTE_FILE_TRANSFER_INVALID" });
			state.content = uploaded.toString("utf8");
			state.ino += 1;
			state.mtime += 1;
			state.temporary.delete(args.temporary);
			return marker + JSON.stringify({ ok: true, revision: identity(state) });
		}
		return marker + JSON.stringify({ ok: false, code: "REMOTE_FILE_INPUT_INVALID" });
	}
	const service = createMainTextService({
		locator: (id) => (id === "project" ? target : id === "other" ? { hostId, remotePath: otherRoot } : undefined),
		withProject: async (_target, work) => work({ nodePath: "/usr/bin/node", hostRevision: state.hostRevision, runCommand: async (command) => ({ exitCode: 0, stdout: dispatch(command) }) }),
		now: () => state.now,
	});
	return { state, service };
}

function entryFixture(state) {
	const target = { hostId, remotePath: root };
	return createRemoteProjectEntryService({
		locator: (id) => (id === "project" ? target : id === "other" ? { hostId, remotePath: otherRoot } : undefined),
		withProject: async (_target, work) =>
			work({
				nodePath: "/usr/bin/node",
				hostRevision: state.hostRevision,
				async runCommand(command) {
					const marker = /PIDECK_ENTRY_[a-f0-9]{32}/.exec(command)?.[0];
					assert.ok(marker);
					return { exitCode: 0, stdout: marker + JSON.stringify({ ok: true, stat: { kind: "file", bytes: 10, mtimeMs: 1 }, revision: entryRevision(state), relativePath: "renamed.ts" }) };
				},
			}),
	});
}

async function opened(fixture) {
	const document = await fixture.service.open(1, "project", "code.ts");
	assert.equal(document.content, "hello\n");
	assert.match(document.version, /^[a-f0-9]{32}$/);
	return document;
}

test("有效文本 version：原样传给 save，保存成功并返回新 version（跨平台、无 SSH）", async () => {
	const fixture = textFixture();
	const document = await opened(fixture);
	const saved = await fixture.service.save(1, "project", "code.ts", "next\n", document.version);
	assert.match(saved.version, /^[a-f0-9]{32}$/);
	assert.notEqual(saved.version, document.version);
	assert.equal(fixture.state.content, "next\n");
	assert.deepEqual(fixture.state.ops, ["snapshot", "read", "snapshot", "upload", "commit"]);
	// 旧文本 version 不能重放：main 消费令牌并拒绝第二次。
	await assert.rejects(fixture.service.save(1, "project", "code.ts", "again\n", document.version), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(fixture.state.content, "next\n");
	const second = await fixture.service.save(1, "project", "code.ts", "third\n", saved.version);
	assert.equal(fixture.state.content, "third\n");
	assert.match(second.version, /^[a-f0-9]{32}$/);
});

test("entry 令牌不是文本 version：main 拒绝、不写、不消费 entry 令牌", async () => {
	const fixture = textFixture();
	await opened(fixture);
	const entries = entryFixture(fixture.state);
	const grant = await entries.stat(1, "project", "code.ts");
	const before = fixture.state.content;
	const opsBefore = fixture.state.ops.length;
	await assert.rejects(fixture.service.save(1, "project", "code.ts", "entry-token-write\n", grant.version), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(fixture.state.content, before);
	assert.equal(fixture.state.ops.length, opsBefore, "entry 令牌在文本表查不到时，不应开始任何文件命令");
	assert.equal(entries.tokenCount(), 1, "entry 令牌未被文本保存消费");
	const renamed = await entries.rename(1, "project", "code.ts", "renamed.ts", grant.version);
	assert.equal(renamed.relativePath, "renamed.ts");
	assert.equal(entries.tokenCount(), 0);
});

test("错误令牌/另一个文件的 version 都被拒绝，且不产生写", async () => {
	const fixture = textFixture();
	const code = await opened(fixture);
	await assert.rejects(fixture.service.save(1, "project", "code.ts", "wrong-token\n", "0".repeat(32)), /REMOTE_FILE_VERSION_INVALID/);
	const other = await fixture.service.open(1, "project", "other.ts");
	await assert.rejects(fixture.service.save(1, "project", "code.ts", "cross-file\n", other.version), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(fixture.state.content, "hello\n");
	assert.match(code.version, /^[a-f0-9]{32}$/);
});

test("跨窗口/跨项目/旧主机身份/过期文本令牌都被拒绝，且不产生写", async () => {
	const fixture = textFixture();
	const document = await opened(fixture);
	await assert.rejects(fixture.service.save(2, "project", "code.ts", "other-window\n", document.version), /REMOTE_FILE_VERSION_INVALID/);
	await assert.rejects(fixture.service.save(1, "other", "code.ts", "other-project\n", document.version), /REMOTE_FILE_VERSION_INVALID/);
	fixture.state.hostRevision += 1;
	const opsBefore = fixture.state.ops.length;
	await assert.rejects(fixture.service.save(1, "project", "code.ts", "old-host\n", document.version), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(fixture.state.ops.length, opsBefore, "旧主机身份必须在任何命令前拒绝");
	assert.equal(fixture.state.content, "hello\n");
	// 旧主机检查已消费 document 令牌；过期必须用重新 open 得到的新令牌验证 TTL，而不是重放旧令牌。
	const fresh = await fixture.service.open(1, "project", "code.ts");
	const opsAfterOpen = fixture.state.ops.length;
	fixture.state.now = 31 * 60 * 1000;
	await assert.rejects(fixture.service.save(1, "project", "code.ts", "expired\n", fresh.version), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(fixture.state.ops.length, opsAfterOpen, "过期拒绝发生在任何文件命令前");
	assert.equal(fixture.state.content, "hello\n");
});

function providerHarness(mode = "real") {
	const fixture = textFixture();
	const entries = entryFixture(fixture.state);
	const calls = { open: 0, save: 0, stat: 0, saveArgs: [] };
	const project = { id: "project", name: "project", lastOpenedAt: 0, locator: { kind: "ssh", hostId, remotePath: root } };
	const facts = { projectId: "project", locationKind: "ssh", hostId, hostState: "ready", rootStatus: "ok", helperCapabilities: ["fs.watch"], trust: "approved", generation: "g1" };
	const api = {
		files: {},
		git: {},
		remoteTrust: { list: async () => ({ ok: true, value: { entries: [] } }) },
		remoteHosts: {
			async openProjectText(projectId, path) {
				calls.open += 1;
				try {
					return { ok: true, value: { document: await fixture.service.open(1, projectId, path) } };
				} catch (error) {
					return { ok: false, code: error.message, outcome: "rejected" };
				}
			},
			async saveProjectText(projectId, path, content, version) {
				calls.save += 1;
				calls.saveArgs.push([projectId, path, content, version]);
				if (mode === "unknown") return { ok: false, code: "REMOTE_FILE_COMMAND_FAILED", outcome: "unknown" };
				try {
					return { ok: true, value: await fixture.service.save(1, projectId, path, content, version) };
				} catch (error) {
					return { ok: false, code: error.message, outcome: "rejected" };
				}
			},
			async statProjectEntry(projectId, path) {
				calls.stat += 1;
				try {
					return { ok: true, value: await entries.stat(1, projectId, path) };
				} catch (error) {
					return { ok: false, code: error.message, outcome: "rejected" };
				}
			},
		},
	};
	const services = createProjectServices(project, api, { facts });
	return { fixture, entries, calls, services };
}

test("provider：readText 的文本 version 原样交给 save，不自动重新 open/stat", async () => {
	const h = providerHarness();
	const target = { projectId: "project", relativePath: "code.ts" };
	const document = await h.services.files.readText(target);
	assert.equal(h.calls.open, 1);
	const saved = await h.services.files.writeText(target, "provider-next\n", document.version);
	assert.deepEqual(h.calls.saveArgs, [["project", "code.ts", "provider-next\n", document.version]]);
	assert.equal(h.calls.open, 1, "保存不得自动重新 open");
	assert.equal(h.calls.stat, 0, "保存不得取 entry 令牌");
	assert.equal(h.fixture.state.content, "provider-next\n");
	assert.match(saved.version, /^[a-f0-9]{32}$/);
});

test("provider：version 缺失/空串时零调用拒绝（stat/open/save 都不发生）", async () => {
	const h = providerHarness();
	const target = { projectId: "project", relativePath: "code.ts" };
	for (const missing of [undefined, ""]) {
		await assert.rejects(
			() => h.services.files.writeText(target, "next\n", missing),
			(error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.versionRequired,
		);
	}
	assert.deepEqual(h.calls, { open: 0, save: 0, stat: 0, saveArgs: [] });
	assert.equal(h.fixture.state.content, "hello\n");
});

test("provider + 真实 main：entry 令牌当文本 version 被拒绝，且不写文件", async () => {
	const h = providerHarness();
	const target = { projectId: "project", relativePath: "code.ts" };
	const grant = await h.entries.stat(1, "project", "code.ts");
	const before = h.fixture.state.content;
	await assert.rejects(
		() => h.services.files.writeText(target, "entry-token\n", grant.version),
		(error) => error instanceof ProjectServiceError && error.code === "REMOTE_FILE_VERSION_INVALID" && error.outcome === "rejected",
	);
	assert.equal(h.fixture.state.content, before);
	assert.equal(h.calls.save, 1);
	assert.equal(h.calls.stat, 0, "provider 不得自己再签 entry 令牌");
	assert.equal(h.calls.open, 0);
});

test("provider：unknown 只抛一次、不重放、不自动 open/stat", async () => {
	const h = providerHarness("unknown");
	const target = { projectId: "project", relativePath: "code.ts" };
	await assert.rejects(
		() => h.services.files.writeText(target, "next\n", "text-version-1"),
		(error) => error instanceof ProjectServiceError && error.outcome === "unknown",
	);
	assert.equal(h.calls.save, 1);
	assert.equal(h.calls.open, 0);
	assert.equal(h.calls.stat, 0);
});
