/** #298：更名迁移必须补齐 session header.cwd，历史正文与非目标会话不可改写。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const modulePath = "src/main/projects/userDataNameMigration.ts";
const { runUserDataNameMigration, encodeSessionDirName } = loadTsCommonJs(modulePath);

/** 所有读写仅发生在临时目录；分别模拟首次升级和 beta 已迁移的磁盘状态。 */
function makeFixture(t, alreadyMigrated = false) {
	const root = fs.mkdtempSync(join(tmpdir(), "pideck-header-migration-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const appDataDir = join(root, "AppData");
	const homeDir = join(root, "home");
	const oldRoot = resolve(appDataDir, "pi-desktop");
	const newRoot = resolve(appDataDir, "PiDeck");
	const oldCwd = join(oldRoot, "chat-workspace");
	const newCwd = join(newRoot, "chat-workspace");
	fs.mkdirSync(alreadyMigrated ? newCwd : oldCwd, { recursive: true });
	const sessionsRoot = join(homeDir, ".pi", "agent", "sessions");
	const sourceDir = join(sessionsRoot, encodeSessionDirName(alreadyMigrated ? newCwd : oldCwd));
	const targetDir = join(sessionsRoot, encodeSessionDirName(newCwd));
	fs.mkdirSync(sourceDir, { recursive: true });
	return { root, oldRoot, newRoot, oldCwd, newCwd, sessionsRoot, sourceDir, targetDir, input: { appDataDir, homeDir } };
}

function sessionHeader(cwd) {
	return { type: "session", version: 3, id: "old-chat", timestamp: "2026-09-28T13:06:44.097Z", cwd };
}

for (const alreadyMigrated of [false, true]) {
	for (const eol of ["\n", "\r\n", ""]) {
		test(`${alreadyMigrated ? "已迁移 beta 补修" : "首次迁移"}：仅改 header.cwd，保留正文原始字节（${JSON.stringify(eol)}）`, (t) => {
			const fx = makeFixture(t, alreadyMigrated);
			const header = { ...sessionHeader(fx.oldCwd), parentSession: join(fx.sourceDir, "parent.jsonl"), metadata: { cwd: fx.oldCwd } };
			// 含旧路径、空行、超长消息、不完整 UTF-8 尾部：不能整文件 JSON.parse / split 后重写。
			const body = eol ? Buffer.concat([Buffer.from(`${eol}${JSON.stringify({ type: "message", text: `${fx.oldCwd} 历史正文 ${"x".repeat(300_000)}` })}${eol}${eol}`), Buffer.from([0xe4, 0xb8])]) : Buffer.alloc(0);
			fs.writeFileSync(join(fx.sourceDir, "chat.jsonl"), Buffer.concat([Buffer.from(JSON.stringify(header)), body]));

			const result = runUserDataNameMigration(fx.input);
			assert.equal(result.kind, alreadyMigrated ? "skipped" : "migrated");
			if (alreadyMigrated) assert.equal(result.reason, "already-migrated");
			const file = join(fx.targetDir, "chat.jsonl");
			const raw = fs.readFileSync(file);
			const expected = Buffer.concat([Buffer.from(JSON.stringify({ ...header, cwd: fx.newCwd })), body]);
			assert.deepEqual(raw, expected);
			assert.ok(fs.statSync(JSON.parse(raw.subarray(0, raw.length - body.length).toString()).cwd).isDirectory());

			const before = fs.statSync(file);
			runUserDataNameMigration(fx.input);
			assert.deepEqual(fs.readFileSync(file), raw, "重复执行不再修改会话");
			assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
			assert.deepEqual(fs.readdirSync(fx.targetDir), ["chat.jsonl"], "不遗留临时文件");
		});
	}
}

test("首次迁移中断后，已改名的 userData 仍能补完旧 encoded 目录和 header", (t) => {
	const fx = makeFixture(t, true);
	const legacyDir = join(fx.sessionsRoot, encodeSessionDirName(fx.oldCwd));
	fs.renameSync(fx.sourceDir, legacyDir);
	fs.writeFileSync(join(legacyDir, "chat.jsonl"), JSON.stringify(sessionHeader(fx.oldCwd)));
	fs.writeFileSync(join(fx.newRoot, "session-catalog.json"), JSON.stringify({ sessions: [{ filePath: join(legacyDir, "chat.jsonl") }] }));

	runUserDataNameMigration(fx.input);
	const target = join(fx.targetDir, "chat.jsonl");
	assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).cwd, fx.newCwd);
	assert.equal(JSON.parse(fs.readFileSync(join(fx.newRoot, "session-catalog.json"), "utf8")).sessions[0].filePath, target);
});

test("已迁移的自定义嵌套聊天目录从 chat-path.json 找回，不依赖一层子目录枚举", (t) => {
	const fx = makeFixture(t, true);
	const oldCwd = join(fx.oldRoot, "custom", "聊天 工作区");
	const newCwd = join(fx.newRoot, "custom", "聊天 工作区");
	fs.mkdirSync(newCwd, { recursive: true });
	fs.writeFileSync(join(fx.newRoot, "chat-path.json"), JSON.stringify({ path: newCwd }));
	const dir = join(fx.sessionsRoot, encodeSessionDirName(newCwd));
	fs.mkdirSync(dir);
	fs.writeFileSync(join(dir, "chat.jsonl"), JSON.stringify(sessionHeader(oldCwd)));

	runUserDataNameMigration(fx.input);
	assert.equal(JSON.parse(fs.readFileSync(join(dir, "chat.jsonl"), "utf8")).cwd, newCwd);
});

test("无关 cwd、缺失目标、损坏/超长 header 和非 JSONL 文件均原样保留", (t) => {
	const fx = makeFixture(t, true);
	const unchanged = new Map([
		["external.jsonl", JSON.stringify(sessionHeader(join(fx.root, "other")))],
		["dev.jsonl", JSON.stringify(sessionHeader(`${fx.oldRoot}-dev/chat-workspace`))],
		["traversal.jsonl", JSON.stringify(sessionHeader(`${fx.oldRoot}/../other`))],
		["missing-target.jsonl", JSON.stringify(sessionHeader(join(fx.oldRoot, "deleted-workspace")))],
		["malformed.jsonl", `{broken\n${JSON.stringify(sessionHeader(fx.oldCwd))}`],
		["not-session.jsonl", JSON.stringify({ type: "message", cwd: fx.oldCwd })],
		["invalid-cwd.jsonl", JSON.stringify({ type: "session", cwd: 123 })],
		["null.jsonl", "null\n"],
		["oversized.jsonl", `${JSON.stringify({ ...sessionHeader(fx.oldCwd), padding: "x".repeat(128 * 1024) })}\n`],
		["backup.jsonl.bak", JSON.stringify(sessionHeader(fx.oldCwd))],
	]);
	for (const [name, text] of unchanged) fs.writeFileSync(join(fx.sourceDir, name), text);
	const unrelatedDir = join(fx.sessionsRoot, "--unrelated-project--");
	fs.mkdirSync(unrelatedDir);
	const unrelated = JSON.stringify(sessionHeader(fx.oldCwd));
	fs.writeFileSync(join(unrelatedDir, "chat.jsonl"), unrelated);
	fs.writeFileSync(join(fx.sourceDir, "valid.jsonl"), JSON.stringify(sessionHeader(fx.oldCwd)));

	runUserDataNameMigration(fx.input);
	for (const [name, text] of unchanged) assert.equal(fs.readFileSync(join(fx.targetDir, name), "utf8"), text, name);
	assert.equal(fs.readFileSync(join(unrelatedDir, "chat.jsonl"), "utf8"), unrelated);
	assert.equal(JSON.parse(fs.readFileSync(join(fx.targetDir, "valid.jsonl"), "utf8")).cwd, fx.newCwd, "坏文件不阻断其他会话");
});

test("JSONL 使用有界块读取，不能通过 readFileSync 载入完整会话", (t) => {
	const fx = makeFixture(t, true);
	const body = `\n${"x".repeat(2 * 1024 * 1024)}`;
	fs.writeFileSync(join(fx.sourceDir, "chat.jsonl"), JSON.stringify(sessionHeader(fx.oldCwd)) + body);
	const bounded = loadTsCommonJs(modulePath, {
		stubs: {
			"node:fs": {
				...fs,
				readFileSync(path, ...args) {
					assert.ok(!String(path).endsWith(".jsonl"), "禁止整文件读取会话");
					return fs.readFileSync(path, ...args);
				},
				readSync(fd, buffer, offset, length, position) {
					assert.ok(length <= 256 * 1024, "每次读取必须有固定字节上界");
					// 主动制造短读，验证不能把一次 read 的返回长度当作整个文件大小。
					return fs.readSync(fd, buffer, offset, Math.min(length, 997), position);
				},
				writeSync(fd, buffer, offset, length) {
					return fs.writeSync(fd, buffer, offset, Math.min(length, 503));
				},
			},
		},
	});
	bounded.runUserDataNameMigration(fx.input);
	assert.equal(fs.readFileSync(join(fx.targetDir, "chat.jsonl"), "utf8"), JSON.stringify(sessionHeader(fx.newCwd)) + body);
});

test("原子替换失败时原文件不变且清理临时文件，下次启动可重试", (t) => {
	const fx = makeFixture(t, true);
	const raw = `${JSON.stringify(sessionHeader(fx.oldCwd))}\r\n历史正文\r\n`;
	fs.writeFileSync(join(fx.sourceDir, "chat.jsonl"), raw);
	const blocked = loadTsCommonJs(modulePath, {
		stubs: {
			"node:fs": {
				...fs,
				renameSync(from, to) {
					if (String(to).endsWith(".jsonl")) throw new Error("simulated rename failure");
					return fs.renameSync(from, to);
				},
			},
		},
	});
	assert.doesNotThrow(() => blocked.runUserDataNameMigration(fx.input));
	assert.equal(fs.readFileSync(join(fx.targetDir, "chat.jsonl"), "utf8"), raw);
	assert.deepEqual(fs.readdirSync(fx.targetDir), ["chat.jsonl"]);
	runUserDataNameMigration(fx.input);
	assert.equal(fs.readFileSync(join(fx.targetDir, "chat.jsonl"), "utf8"), `${JSON.stringify(sessionHeader(fx.newCwd))}\r\n历史正文\r\n`);
});

test("复制期间其他进程追加会话时放弃替换，不覆盖并行写入", (t) => {
	const fx = makeFixture(t, true);
	const file = join(fx.sourceDir, "chat.jsonl");
	const raw = `${JSON.stringify(sessionHeader(fx.oldCwd))}\n历史正文\n`;
	const appended = "并行新增消息\n";
	fs.writeFileSync(file, raw);
	const concurrent = loadTsCommonJs(modulePath, {
		stubs: {
			"node:fs": {
				...fs,
				fsyncSync(fd) {
					fs.fsyncSync(fd);
					fs.appendFileSync(file, appended);
				},
			},
		},
	});
	concurrent.runUserDataNameMigration(fx.input);
	assert.equal(fs.readFileSync(file, "utf8"), raw + appended);
	assert.deepEqual(fs.readdirSync(fx.targetDir), ["chat.jsonl"]);
	runUserDataNameMigration(fx.input);
	assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify(sessionHeader(fx.newCwd))}\n历史正文\n${appended}`);
});

for (const mode of ["collision", "explicit"]) {
	test(`${mode} 分支不修补其他数据环境的 header`, (t) => {
		const fx = makeFixture(t, true);
		if (mode === "collision") fs.mkdirSync(fx.oldCwd, { recursive: true });
		const raw = JSON.stringify(sessionHeader(fx.oldCwd));
		fs.writeFileSync(join(fx.sourceDir, "chat.jsonl"), raw);
		const result = runUserDataNameMigration({ ...fx.input, portableOrExplicit: mode === "explicit" });
		assert.equal(result.reason, mode === "collision" ? "collision" : "explicit-user-data-dir");
		assert.equal(fs.readFileSync(join(fx.sourceDir, "chat.jsonl"), "utf8"), raw);
	});
}
