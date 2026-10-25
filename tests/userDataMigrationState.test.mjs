import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const MODULE = "src/main/projects/userDataNameMigration.ts";
const STATE_FILE = "user-data-name-migration.json";
const { runUserDataNameMigration, encodeSessionDirName } = loadTsCommonJs(MODULE);

/** 临时数据模拟首次迁移与旧版本已改目录、尚未补完内容的两种状态。 */
function fixture(t, { alreadyMigrated = false, oldName = "pi-desktop", newName = "PiDeck" } = {}) {
	const root = fs.mkdtempSync(join(tmpdir(), "pideck-migration-state-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const appDataDir = join(root, "appData");
	const homeDir = join(root, "home");
	const oldRoot = join(appDataDir, oldName);
	const newRoot = join(appDataDir, newName);
	const oldCwd = join(oldRoot, "chat-workspace");
	const newCwd = join(newRoot, "chat-workspace");
	const sessionsRoot = join(homeDir, ".pi", "agent", "sessions");
	const oldSessionDir = join(sessionsRoot, encodeSessionDirName(oldCwd));
	const newSessionDir = join(sessionsRoot, encodeSessionDirName(newCwd));
	const sourceRoot = alreadyMigrated ? newRoot : oldRoot;
	const sourceDir = alreadyMigrated ? newSessionDir : oldSessionDir;
	fs.mkdirSync(join(sourceRoot, "chat-workspace"), { recursive: true });
	fs.mkdirSync(sourceDir, { recursive: true });
	fs.writeFileSync(join(sourceRoot, "settings.json"), JSON.stringify({ runtime: join(oldRoot, "pi-runtime") }));
	fs.writeFileSync(join(sourceRoot, "session-catalog.json"), JSON.stringify({ sessions: [{ filePath: join(sourceDir, "chat.jsonl") }] }));
	fs.writeFileSync(join(sourceDir, "chat.jsonl"), `${JSON.stringify({ type: "session", cwd: oldCwd })}\n{"text":"历史正文"}\n`);
	const input = { appDataDir, homeDir, legacyUserDataName: oldName, userDataPathOverride: newRoot };
	return { root, oldRoot, newRoot, oldCwd, newCwd, sessionsRoot, oldSessionDir, newSessionDir, file: join(newSessionDir, "chat.jsonl"), state: join(newRoot, STATE_FILE), input };
}

function readState(fx) {
	return JSON.parse(fs.readFileSync(fx.state, "utf8"));
}

/** 文件系统故障明确区分权限错误与不存在，不能把暂时不可读当成已经完成。 */
function denied() {
	return Object.assign(new Error("simulated permission denial"), { code: "EACCES" });
}

for (const [oldName, newName] of [
	["pi-desktop", "PiDeck"],
	["pi-desktop-dev", "PiDeck-dev"],
	["pi-desktop-channel-dev", "PiDeck-channel-dev"],
]) {
	test(`${newName} 全链路成功后记录完成，状态绑定目录与会话根`, (t) => {
		const fx = fixture(t, { oldName, newName });
		assert.equal(runUserDataNameMigration(fx.input).kind, "migrated");
		const state = readState(fx);
		assert.equal(state.schemaVersion, 1);
		assert.equal(state.migrationVersion, 1);
		assert.equal(state.status, "completed");
		assert.equal(state.oldRoot, fx.oldRoot);
		assert.equal(state.newRoot, fx.newRoot);
		assert.equal(state.sessionsRoot, fx.sessionsRoot);
		assert.equal(state.platform, process.platform);
		assert.equal(JSON.parse(fs.readFileSync(fx.file, "utf8").split("\n")[0]).cwd, fx.newCwd);
		assert.equal(JSON.parse(fs.readFileSync(join(fx.newRoot, "settings.json"), "utf8")).runtime, join(fx.newRoot, "pi-runtime"));
	});
}

test("完成后的启动只读小状态文件，不扫描目录、不读配置/JSONL、不再写盘", (t) => {
	const fx = fixture(t);
	runUserDataNameMigration(fx.input);
	const stateBefore = fs.readFileSync(fx.state, "utf8");
	const stateDescriptors = new Set();
	const fast = loadTsCommonJs(MODULE, {
		stubs: {
			"node:fs": {
				...fs,
				readdirSync() {
					throw new Error("completed migration must not enumerate directories");
				},
				readFileSync(path, ...args) {
					assert.equal(String(path), fx.state);
					return fs.readFileSync(path, ...args);
				},
				openSync(path, ...args) {
					assert.equal(String(path), fx.state, "只能打开完成记录，不能打开 JSONL");
					const fd = fs.openSync(path, ...args);
					stateDescriptors.add(fd);
					return fd;
				},
				readSync(fd, buffer, offset, length, position) {
					assert.ok(stateDescriptors.has(fd));
					assert.ok(length <= 16 * 1024 + 1);
					return fs.readSync(fd, buffer, offset, length, position);
				},
				writeFileSync() {
					throw new Error("completed migration must not write files");
				},
				renameSync() {
					throw new Error("completed migration must not rename files");
				},
			},
		},
	});
	const result = fast.runUserDataNameMigration(fx.input);
	assert.equal(result.kind, "skipped");
	assert.equal(result.reason, "already-migrated");
	assert.equal(fs.readFileSync(fx.state, "utf8"), stateBefore);
});

test("已改名但没有完成记录的存量用户仍补修 header 和配置，不能直接跳过", (t) => {
	const fx = fixture(t, { alreadyMigrated: true });
	const result = runUserDataNameMigration(fx.input);
	assert.equal(result.kind, "skipped");
	assert.equal(result.reason, "already-migrated");
	assert.equal(JSON.parse(fs.readFileSync(fx.file, "utf8").split("\n")[0]).cwd, fx.newCwd);
	assert.equal(readState(fx).status, "completed");
});

for (const fault of ["root-scan", "chat-path-read", "config-read", "config-write", "config-publish", "session-scan", "session-rename", "header-open", "header-publish", "feishu-scan", "draft-scan", "state-write", "state-publish"]) {
	test(`${fault} 失败不报成功、不记完成，下一次启动能补齐`, (t) => {
		const fx = fixture(t);
		if (fault === "chat-path-read") fs.writeFileSync(join(fx.oldRoot, "chat-path.json"), JSON.stringify({ path: fx.oldCwd }));
		if (fault === "feishu-scan") fs.mkdirSync(join(fx.oldRoot, "feishu"));
		if (fault === "draft-scan") fs.mkdirSync(join(fx.oldRoot, "drafts"));
		const blocked = loadTsCommonJs(MODULE, {
			stubs: {
				"node:fs": {
					...fs,
					readFileSync(path, ...args) {
						if ((fault === "config-read" && String(path) === join(fx.newRoot, "settings.json")) || (fault === "chat-path-read" && String(path) === join(fx.newRoot, "chat-path.json"))) throw denied();
						return fs.readFileSync(path, ...args);
					},
					writeFileSync(path, ...args) {
						if ((fault === "config-write" && String(path).startsWith(`${join(fx.newRoot, "settings.json")}.`)) || (fault === "state-write" && String(path).startsWith(`${fx.state}.`))) throw denied();
						return fs.writeFileSync(path, ...args);
					},
					readdirSync(path, ...args) {
						if ((fault === "root-scan" && String(path) === fx.newRoot) || (fault === "session-scan" && String(path) === fx.sessionsRoot) || (fault === "feishu-scan" && String(path) === join(fx.newRoot, "feishu")) || (fault === "draft-scan" && String(path) === join(fx.newRoot, "drafts"))) throw denied();
						return fs.readdirSync(path, ...args);
					},
					openSync(path, ...args) {
						if (fault === "header-open" && String(path) === fx.file) throw denied();
						return fs.openSync(path, ...args);
					},
					renameSync(from, to) {
						if ((fault === "session-rename" && String(from) === fx.oldSessionDir) || (fault === "config-publish" && String(to) === join(fx.newRoot, "settings.json")) || (fault === "header-publish" && String(to) === fx.file) || (fault === "state-publish" && String(to) === fx.state)) throw denied();
						return fs.renameSync(from, to);
					},
				},
			},
		});
		const failed = blocked.runUserDataNameMigration(fx.input);
		assert.equal(failed.kind, "failed");
		assert.equal(failed.userDataPath, fx.newRoot, "根已改名时继续使用新根，不能回退到已消失的旧路径");
		assert.equal(fs.existsSync(fx.state), false);
		assert.ok(!fs.readdirSync(fx.newRoot).some((name) => name.startsWith(`${STATE_FILE}.`) || name.startsWith("settings.json.")), "失败不残留临时配置或完成记录");
		if (fault === "config-write" || fault === "config-publish") assert.equal(JSON.parse(fs.readFileSync(join(fx.newRoot, "settings.json"), "utf8")).runtime, join(fx.oldRoot, "pi-runtime"), "写入或发布失败保留旧配置");
		const retried = runUserDataNameMigration(fx.input);
		assert.equal(retried.kind, "skipped");
		assert.equal(readState(fx).status, "completed");
		assert.equal(fs.readFileSync(fx.file, "utf8"), `${JSON.stringify({ type: "session", cwd: fx.newCwd })}\n{"text":"历史正文"}\n`);
		assert.equal(JSON.parse(fs.readFileSync(join(fx.newRoot, "session-catalog.json"), "utf8")).sessions[0].filePath, fx.file);
	});
}

test("新旧会话目录冲突时不合并或覆盖，不记完成，重复启动仍保留两边", (t) => {
	const fx = fixture(t);
	fs.mkdirSync(fx.newSessionDir);
	const existing = '{"type":"session","cwd":"/another-project"}\n{"text":"另一份历史"}\n';
	fs.writeFileSync(fx.file, existing);
	const oldFile = join(fx.oldSessionDir, "chat.jsonl");
	const original = fs.readFileSync(oldFile, "utf8");
	for (let run = 0; run < 2; run++) {
		assert.equal(runUserDataNameMigration(fx.input).kind, "failed");
		assert.equal(fs.existsSync(fx.state), false);
		assert.equal(fs.readFileSync(oldFile, "utf8"), original);
		assert.equal(fs.readFileSync(fx.file, "utf8"), existing);
	}
});

test("两代目录并存但只需补修时（beta 已改目录名、header 仍指向旧路径）仍修好会话且不记完成", (t) => {
	// 真实机器上的形态：旧根只剩 Chromium 壳，新根数据完整，但会话目录由 beta 改名后 header.cwd 未补。
	const fx = fixture(t, { alreadyMigrated: true });
	fs.mkdirSync(fx.oldRoot);
	fs.writeFileSync(join(fx.oldRoot, "Local State"), "{}");
	assert.equal(JSON.parse(fs.readFileSync(fx.file, "utf8").split("\n")[0]).cwd, fx.oldCwd, "前置：header 仍指向旧路径");
	const result = runUserDataNameMigration(fx.input);
	assert.equal(result.kind, "skipped");
	assert.equal(result.reason, "collision");
	assert.equal(fs.existsSync(fx.state), false, "并存时不写完成记录");
	assert.equal(JSON.parse(fs.readFileSync(fx.file, "utf8").split("\n")[0]).cwd, fx.newCwd, "header 应被修复到新根");
	assert.equal(fs.readFileSync(join(fx.oldRoot, "Local State"), "utf8"), "{}", "旧根内容不动");
	assert.equal(fs.readFileSync(fx.file, "utf8"), `${JSON.stringify({ type: "session", cwd: fx.newCwd })}\n{"text":"历史正文"}\n`, "正文逐字节保留");
	const again = runUserDataNameMigration(fx.input);
	assert.equal(again.reason, "collision");
	assert.equal(JSON.parse(fs.readFileSync(fx.file, "utf8").split("\n")[0]).cwd, fx.newCwd);
	assert.equal(fs.existsSync(fx.state), false);
});

test("并存且旧根仍在使用（旧路径仍存在）时不改名、不改 header、不记完成", (t) => {
	const fx = fixture(t);
	fs.mkdirSync(fx.newRoot, { recursive: true });
	const oldFile = join(fx.oldSessionDir, "chat.jsonl");
	const original = fs.readFileSync(oldFile, "utf8");
	const result = runUserDataNameMigration(fx.input);
	assert.equal(result.reason, "collision");
	assert.equal(fs.existsSync(fx.oldSessionDir), true, "旧根名下的会话目录保留原样");
	assert.equal(fs.existsSync(fx.newSessionDir), false, "并存时不把旧根目录改名到新名");
	assert.equal(fs.readFileSync(oldFile, "utf8"), original, "旧路径仍存在时保守保留 header");
	assert.equal(fs.existsSync(fx.state), false);
});

test("新旧数据根冲突或显式目录不写完成记录", (t) => {
	for (const explicit of [false, true]) {
		const fx = fixture(t);
		fs.mkdirSync(fx.newRoot);
		const result = runUserDataNameMigration({ ...fx.input, portableOrExplicit: explicit });
		assert.equal(result.reason, explicit ? "explicit-user-data-dir" : "collision");
		assert.equal(fs.existsSync(fx.state), false);
		assert.equal(fs.existsSync(fx.oldRoot), true);
	}
});

test("已有完成记录但旧根再次出现时仍走冲突保护，不受快速跳过绕过", (t) => {
	const fx = fixture(t);
	runUserDataNameMigration(fx.input);
	const state = fs.readFileSync(fx.state, "utf8");
	fs.mkdirSync(fx.oldRoot);
	fs.writeFileSync(join(fx.oldRoot, "settings.json"), "legacy data");
	assert.equal(runUserDataNameMigration(fx.input).reason, "collision");
	assert.equal(fs.readFileSync(join(fx.oldRoot, "settings.json"), "utf8"), "legacy data");
	assert.equal(fs.readFileSync(fx.state, "utf8"), state);
});

for (const invalid of ["broken", "old-version", "not-completed", "other-platform", "other-root", "other-session-root", "oversized"]) {
	test(`${invalid} 完成记录不可信时重新核验，不加载超大记录`, (t) => {
		const fx = fixture(t);
		runUserDataNameMigration(fx.input);
		const state = readState(fx);
		if (invalid === "old-version") state.migrationVersion = 0;
		if (invalid === "not-completed") state.status = "pending";
		if (invalid === "other-platform") state.platform = "other-platform";
		if (invalid === "other-root") state.newRoot = join(fx.root, "other");
		if (invalid === "other-session-root") state.sessionsRoot = join(fx.root, "other-sessions");
		fs.writeFileSync(fx.state, invalid === "broken" ? "{broken" : invalid === "oversized" ? "x".repeat(64 * 1024) : JSON.stringify(state));
		let scanned = false;
		const checked = loadTsCommonJs(MODULE, {
			stubs: {
				"node:fs": {
					...fs,
					readdirSync(path, ...args) {
						if (String(path) === fx.sessionsRoot) scanned = true;
						return fs.readdirSync(path, ...args);
					},
					readFileSync(path, ...args) {
						if (invalid === "oversized") assert.notEqual(String(path), fx.state, "超大状态不能整文件读取");
						return fs.readFileSync(path, ...args);
					},
				},
			},
		});
		assert.equal(checked.runUserDataNameMigration(fx.input).kind, "skipped");
		assert.equal(scanned, true);
		assert.equal(readState(fx).status, "completed");
		assert.equal(readState(fx).migrationVersion, 1);
		assert.equal(readState(fx).newRoot, fx.newRoot);
	});
}

test("并行追加导致 header 发布放弃时不记完成，保留新增消息后可重试", (t) => {
	const fx = fixture(t, { alreadyMigrated: true });
	const original = fs.readFileSync(fx.file, "utf8");
	const extra = '{"text":"并行消息"}\n';
	const concurrent = loadTsCommonJs(MODULE, {
		stubs: {
			"node:fs": {
				...fs,
				fsyncSync(fd) {
					fs.fsyncSync(fd);
					fs.appendFileSync(fx.file, extra);
				},
			},
		},
	});
	assert.equal(concurrent.runUserDataNameMigration(fx.input).kind, "failed");
	assert.equal(fs.existsSync(fx.state), false);
	assert.equal(fs.readFileSync(fx.file, "utf8"), original + extra);
	runUserDataNameMigration(fx.input);
	assert.equal(readState(fx).status, "completed");
	assert.equal(fs.readFileSync(fx.file, "utf8"), `${JSON.stringify({ type: "session", cwd: fx.newCwd })}\n{"text":"历史正文"}\n${extra}`);
});

test("旧根不可读不能当作新安装，保留旧数据并报告失败", (t) => {
	const fx = fixture(t);
	const blocked = loadTsCommonJs(MODULE, {
		stubs: {
			"node:fs": {
				...fs,
				statSync(path, ...args) {
					if (String(path) === fx.oldRoot) throw denied();
					return fs.statSync(path, ...args);
				},
			},
		},
	});
	const result = blocked.runUserDataNameMigration(fx.input);
	assert.equal(result.kind, "failed");
	assert.equal(result.userDataPath, fx.oldRoot);
	assert.equal(fs.existsSync(fx.newRoot), false);
	assert.equal(fs.existsSync(join(fx.oldRoot, "settings.json")), true);
});

test("完成记录在 stat 后变大时读取仍有硬上界，回到核验而不是误跳过", (t) => {
	const fx = fixture(t);
	runUserDataNameMigration(fx.input);
	const descriptors = new Set();
	let readBytes = 0;
	let scanned = false;
	const enlarged = loadTsCommonJs(MODULE, {
		stubs: {
			"node:fs": {
				...fs,
				lstatSync(path, ...args) {
					const stat = fs.lstatSync(path, ...args);
					if (String(path) === fx.state) fs.writeFileSync(fx.state, "x".repeat(64 * 1024));
					return stat;
				},
				openSync(path, ...args) {
					const fd = fs.openSync(path, ...args);
					if (String(path) === fx.state) descriptors.add(fd);
					return fd;
				},
				closeSync(fd) {
					descriptors.delete(fd);
					return fs.closeSync(fd);
				},
				readSync(fd, buffer, offset, length, position) {
					const bytes = fs.readSync(fd, buffer, offset, length, position);
					if (descriptors.has(fd)) readBytes += bytes;
					return bytes;
				},
				readdirSync(path, ...args) {
					if (String(path) === fx.sessionsRoot) scanned = true;
					return fs.readdirSync(path, ...args);
				},
			},
		},
	});
	assert.equal(enlarged.runUserDataNameMigration(fx.input).kind, "skipped");
	assert.equal(readBytes, 16 * 1024 + 1);
	assert.equal(scanned, true);
	assert.equal(readState(fx).status, "completed");
});

test("迁移范围内 header 损坏或目标目录缺失时不记完成，修正输入后能重试", (t) => {
	for (const brokenHeader of ["{broken-json", JSON.stringify({ type: "session", cwd: "/not-yet-set" })]) {
		const fx = fixture(t, { alreadyMigrated: true });
		const pendingCwd = join(fx.oldRoot, "missing-workspace");
		const header = brokenHeader === "{broken-json" ? brokenHeader : JSON.stringify({ type: "session", cwd: pendingCwd });
		fs.writeFileSync(fx.file, `${header}\n{"text":"历史正文"}\n`);
		assert.equal(runUserDataNameMigration(fx.input).kind, "failed");
		assert.equal(fs.existsSync(fx.state), false);
		assert.equal(fs.readFileSync(fx.file, "utf8"), `${header}\n{"text":"历史正文"}\n`);
		fs.writeFileSync(fx.file, `${JSON.stringify({ type: "session", cwd: fx.oldCwd })}\n{"text":"历史正文"}\n`);
		runUserDataNameMigration(fx.input);
		assert.equal(readState(fx).status, "completed");
	}
});

test("配置写入中途失败保留完整原文件，不以半截配置记录完成，重试后可用", (t) => {
	const fx = fixture(t, { alreadyMigrated: true });
	const settings = join(fx.newRoot, "settings.json");
	const original = fs.readFileSync(settings, "utf8");
	const blocked = loadTsCommonJs(MODULE, {
		stubs: {
			"node:fs": {
				...fs,
				writeFileSync(path, content, options) {
					if (String(path) === settings || String(path).startsWith(`${settings}.`)) {
						fs.writeFileSync(path, content.slice(0, 8), options);
						throw denied();
					}
					return fs.writeFileSync(path, content, options);
				},
			},
		},
	});
	assert.equal(blocked.runUserDataNameMigration(fx.input).kind, "failed");
	assert.equal(fs.existsSync(fx.state), false);
	assert.equal(fs.readFileSync(settings, "utf8"), original);
	assert.ok(!fs.readdirSync(fx.newRoot).some((name) => name.startsWith("settings.json.")), "中断写入的临时配置应清理");
	runUserDataNameMigration(fx.input);
	assert.equal(readState(fx).status, "completed");
	assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).runtime, join(fx.newRoot, "pi-runtime"));
});

test("配置是符号链接时保留链接与原文件，不替换用户数据或记完成", (t) => {
	if (process.platform === "win32") return t.skip("Windows 创建符号链接需要系统授权；普通文件路径由其他用例覆盖");
	const fx = fixture(t, { alreadyMigrated: true });
	const settings = join(fx.newRoot, "settings.json");
	const linked = join(fx.root, "linked-config.json");
	const original = fs.readFileSync(settings, "utf8");
	fs.renameSync(settings, linked);
	fs.symlinkSync(linked, settings);
	assert.equal(runUserDataNameMigration(fx.input).kind, "failed");
	assert.equal(fs.existsSync(fx.state), false);
	assert.equal(fs.lstatSync(settings).isSymbolicLink(), true);
	assert.equal(fs.readFileSync(linked, "utf8"), original);
});
