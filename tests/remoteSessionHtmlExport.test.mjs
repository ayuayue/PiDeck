import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话（ssh locator）HTML 导出：**远端只读 + 本机写文件**。
 *
 * 不连真机、不连真 ssh：远端侧的假 exec 按命令形状（`tail -c N` / `tail -c +K | head -c C`）在一个内存
 * 字节串上执行真实语义（与 `remoteSessionHistoryRead.test.mjs` 同一套命令形状契约），而读端口用的是**真实**
 * `RemoteSessionHistoryReader`——分页、窗口边界、投影这些最易写错的东西因此被真正跑到，而不是被 mock 掩盖。
 * 渲染侧断言的是「与 DSH 投影式导出同一套模板」的可执行证据（同一份 markup/footer），而不是随便一段 HTML。
 */

const { createRemoteSessionHistoryReader } = loadTsCommonJs("src/main/remote/RemoteSessionHistoryReader.ts");
const { exportRemoteSessionHtml, collectRemoteSessionMessages, REMOTE_SESSION_EXPORT_LIMITS, REMOTE_SESSION_EXPORT_CODES } = loadTsCommonJs("src/main/remote/RemoteSessionHtmlExport.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const HOST_ID = "3f1d6a54-1b2c-4c6d-8f90-1a2b3c4d5e6f";
const REMOTE_PATH = "/home/dev/.pi/agent/sessions/--srv-app--/remote.jsonl";
const FOOTER = "Exported from PiDeck (SSH remote session)";
const NOTICE = "PARTIAL: got the {pages}/{messages} limit";

// 命令形状（唯一解析点，与 RemoteSessionHistoryReader 的两条命令形状一一对应）。
const TAIL_SHAPE =
	/^printf '([A-Za-z0-9_]+)'; \(stat -c '%i\|%s\|%y' '([^'\\]+)' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '([^'\\]+)'\); tail -c (\d+) -- '([^'\\]+)'; readStatus=\$\?; printf '([A-Za-z0-9_]+)_END'; \(stat -c '%i\|%s\|%y' '([^'\\]+)' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '([^'\\]+)'\); exit "\$readStatus"$/;
const RANGE_SHAPE =
	/^printf '([A-Za-z0-9_]+)'; \(stat -c '%i\|%s\|%y' '([^'\\]+)' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '([^'\\]+)'\); tail -c \+(\d+) -- '([^'\\]+)' \| head -c (\d+); readStatus=\$\?; printf '([A-Za-z0-9_]+)_END'; \(stat -c '%i\|%s\|%y' '([^'\\]+)' 2>\/dev\/null \|\| stat -f '%i\|%z\|%m' '([^'\\]+)'\); exit "\$readStatus"$/;

/** 跨 realm 归一：生产模块经 vm 加载，返回的数组/对象原型与测试 realm 不同。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 一条按真实 `tail`/`head` 语义执行的假远端文件。 */
function fakeRemote(content) {
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
	const commands = [];
	return {
		bytes,
		commands,
		transport: {
			readRemoteWindow: async ({ remoteCommand }) => {
				commands.push(remoteCommand);
				const tail = TAIL_SHAPE.exec(remoteCommand);
				if (tail) {
					const from = Math.max(0, bytes.length - Number(tail[4]));
					return { exitCode: 0, stdout: `${tail[1]}42|${bytes.length}|1700000000\n${bytes.subarray(from).toString("utf8")}${tail[6]}_END42|${bytes.length}|1700000000\n` };
				}
				const range = RANGE_SHAPE.exec(remoteCommand);
				if (!range) throw new Error(`UNEXPECTED_COMMAND: ${remoteCommand}`);
				const from = Number(range[4]) - 1;
				return { exitCode: 0, stdout: `${range[1]}42|${bytes.length}|1700000000\n${bytes.subarray(from, from + Number(range[6])).toString("utf8")}${range[7]}_END42|${bytes.length}|1700000000\n` };
			},
		},
	};
}

function line(id, parentId, role, content) {
	return `${JSON.stringify({ id, parentId, type: "message", message: { role, content, timestamp: 1_700_000_000_000 } })}\n`;
}

/** 会话 JSONL 夹具：turns 轮 user/assistant（与本地导出会渲染的同一种角色消息）。 */
function conversation(turns, padding = 0) {
	let jsonl = "";
	let parent = null;
	for (let index = 0; index < turns; index += 1) {
		const userId = `u${index}`;
		const assistantId = `a${index}`;
		jsonl += line(userId, parent, "user", `question-${index}${"x".repeat(padding)}`);
		jsonl += line(assistantId, userId, "assistant", `answer-${index}${"y".repeat(padding)}`);
		parent = assistantId;
	}
	return jsonl;
}

function sshLocator() {
	return { kind: "ssh", hostId: HOST_ID, remotePath: REMOTE_PATH, remoteSessionId: "--srv-app--/remote.jsonl" };
}

/** 真实 reader + 假传输：远端读端口的生产形状（`readPage`）。 */
function remoteReader(remote, windowBytes = 512) {
	return createRemoteSessionHistoryReader({
		transport: remote.transport,
		project: (rawMessages) => rawMessages.map((message, index) => ({ id: `m${index}`, role: message.role, text: String(message.content ?? ""), timestamp: 1_700_000_000_000 })),
		windowBytes,
	});
}

async function exportDir(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-export-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

function exportInput(dir, reader, extra = {}) {
	return {
		sessionId: "session-remote-1",
		title: "远端会话导出",
		hostId: HOST_ID,
		locator: sshLocator(),
		readPage: (input) => reader.readPage(input),
		resolveExportDir: () => dir,
		copy: { footer: FOOTER, partialNotice: NOTICE },
		...extra,
	};
}

test("远端导出：分页直到取尽，HTML 里同时有 prompt 与回复正文（与 DSH 导出同一套渲染器）", async (t) => {
	const dir = await exportDir(t);
	const remote = fakeRemote(conversation(30));
	const result = await exportRemoteSessionHtml(exportInput(dir, remoteReader(remote, 512)));

	// 30 轮 × ~200 字节 > 512 字节窗口 ⇒ 必然多页；取尽后才允许 truncated=false。
	assert.ok(result.pagesRead > 1, `expected多页读取，实际 ${result.pagesRead}`);
	assert.equal(result.truncated, false);
	assert.equal(result.messageCount, 60);

	const html = await readFile(result.path, "utf8");
	// HTML 落在本机（远端只读）：路径在导出目录下，内容是同一份模板产物。
	assert.equal(result.path.startsWith(dir), true);
	// 正文证据：首轮与末轮的 prompt/回复都在。
	for (const marker of ["question-0", "answer-0", "question-29", "answer-29"]) assert.ok(html.includes(marker), `missing ${marker}`);
	// 顺序证据：时间正序（分页是从新往旧，拼接必须倒过来）。
	assert.ok(html.indexOf("question-0") < html.indexOf("question-29"));
	// 同一套渲染器（不是远端自造的简化 HTML）：DSH 导出模板的 markup/页脚都在。
	assert.ok(html.includes('<div class="msg user">'));
	assert.ok(html.includes('<div class="msg assistant">'));
	assert.ok(html.includes(`<footer class="footer">${FOOTER}</footer>`));
	// 没有截断时**不能**出现截断提示（否则用户会以为历史不完整）。
	assert.equal(html.includes("PARTIAL"), false);
});

test("上限命中：结果标记截断，HTML 里有可见说明，且保留最近的历史", async (t) => {
	const dir = await exportDir(t);
	const remote = fakeRemote(conversation(30));
	const result = await exportRemoteSessionHtml(exportInput(dir, remoteReader(remote, 512), { limits: { maxPages: 2 } }));

	assert.equal(result.truncated, true);
	assert.equal(result.pagesRead, 2);
	const html = await readFile(result.path, "utf8");
	// 截断说明用的是装配注入的那一份文案（本地化在 mainCopy 侧，模块内不硬编码）。
	assert.ok(html.includes(NOTICE), "截断必须有可见说明");
	assert.ok(html.includes("question-29"), "保留最近的：末尾一轮必须在");
	assert.equal(html.includes("question-0"), false, "被截掉的更早历史不能出现在 HTML 里");
});

test("消息条数上限在文件末尾命中时同样标记截断（裁掉的部分不算完整导出）", async (t) => {
	const dir = await exportDir(t);
	// 单页取尽（窗口远大于文件）⇒ 循环因 `nextBefore === null` 退出，随后才按条数上限裁剪。
	const remote = fakeRemote(conversation(3));
	const result = await exportRemoteSessionHtml(exportInput(dir, remoteReader(remote), { limits: { maxMessages: 3 } }));

	assert.equal(result.truncated, true);
	assert.equal(result.messageCount, 3);
	const html = await readFile(result.path, "utf8");
	assert.ok(html.includes("answer-2"));
	assert.equal(html.includes("question-0"), false);
	// 消息条数上限与页数上限都命中时，返回的条数仍受 maxMessages 约束（不做无界累积）。
	assert.ok(result.messageCount <= 3);
});

test("字节上限命中即停并在结果里标记（不静默截断成看起来完整的导出）", async (t) => {
	const dir = await exportDir(t);
	const remote = fakeRemote(conversation(30, 40));
	const result = await exportRemoteSessionHtml(exportInput(dir, remoteReader(remote, 512), { limits: { maxTextBytes: 200 } }));

	assert.equal(result.truncated, true);
	// 停在字节上限上，而不是页数上限上：页数远未到 maxPages（否则断言证明不了字节上限存在）。
	assert.ok(result.pagesRead < REMOTE_SESSION_EXPORT_LIMITS.maxPages, `expected 字节上限提前生效，实际页数 ${result.pagesRead}`);
	assert.ok(result.messageCount > 0);
	const html = await readFile(result.path, "utf8");
	assert.ok(html.includes("PARTIAL:"));
});

test("collect 只按端口取数：到顶即停，不越界请求（命令里只有窗口上界）", async () => {
	const remote = fakeRemote(conversation(2));
	const collection = await collectRemoteSessionMessages({ readPage: (input) => remoteReader(remote, 4096).readPage(input), hostId: HOST_ID, locator: sshLocator() });

	assert.equal(collection.truncated, false);
	assert.equal(collection.pagesRead, 1);
	assert.deepEqual(plain(collection.messages.map((message) => message.text)), ["question-0", "answer-0", "question-1", "answer-1"]);
	// 命令里唯一的数字是窗口上界（有界读），且只调用了 1 次（到顶即停）。
	assert.equal(remote.commands.length, 1);
	assert.equal(remote.commands[0].includes(String(remote.bytes.length)), false);
});

test("远端读失败 ⇒ 稳定码且不回退本机导出；裸异常/路径不外传", async (t) => {
	const dir = await exportDir(t);
	const thrown = (error) => ({
		readPage: async () => {
			throw error;
		},
	});
	// 连接层自己的稳定码原样转述。
	await assert.rejects(exportRemoteSessionHtml(exportInput(dir, thrown(new Error("SSH_HOST_NOT_READY")))), /^Error: SSH_HOST_NOT_READY$/);
	await assert.rejects(exportRemoteSessionHtml(exportInput(dir, thrown(new Error("REMOTE_SESSION_HISTORY_COMMAND_FAILED")))), /^Error: REMOTE_SESSION_HISTORY_COMMAND_FAILED$/);
	// 其余错误折叠成导出侧稳定码：远端路径/命令/stderr 不进返回结构。
	await assert.rejects(exportRemoteSessionHtml(exportInput(dir, thrown({ message: `spawn /usr/bin/ssh ENOENT ${REMOTE_PATH}` }))), new RegExp(`^Error: ${REMOTE_SESSION_EXPORT_CODES.readFailed}$`));
	// 写盘失败同样是稳定码，不外传 errno 与路径：① 目录解析不出来；② 目录的父级是文件（mkdir 必失败）。
	await assert.rejects(exportRemoteSessionHtml({ ...exportInput(dir, remoteReader(fakeRemote(conversation(1)))), resolveExportDir: () => "" }), new RegExp(`^Error: ${REMOTE_SESSION_EXPORT_CODES.writeFailed}$`));
	const blocked = join(dir, "blocked-file");
	await writeFile(blocked, "not a directory", "utf8");
	await assert.rejects(exportRemoteSessionHtml({ ...exportInput(dir, remoteReader(fakeRemote(conversation(1)))), resolveExportDir: () => join(blocked, "exports") }), new RegExp(`^Error: ${REMOTE_SESSION_EXPORT_CODES.writeFailed}$`));
});

test("未装配读端口 ⇒ 稳定码，绝不回退成本机导出", async (t) => {
	const dir = await exportDir(t);
	await assert.rejects(exportRemoteSessionHtml({ ...exportInput(dir, remoteReader(fakeRemote(conversation(1)))), readPage: undefined }), new RegExp(`^Error: ${REMOTE_SESSION_EXPORT_CODES.unavailable}$`));
});

// ── IPC 层：ssh 记录不许碰本机文件路径（`getLocalFilePath` 是本机文件路径的唯一入口）────────────

const REMOTE_PROJECT = { id: "project-remote", name: "Remote", locator: { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } };
const LOCAL_PROJECT = { id: "project-local", name: "Local", locator: { kind: "local", environment: "native", path: "/work/app" } };

async function setupIpc(t, { withRemoteExport = true } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-export-ipc-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalogPath = join(directory, "session-catalog.json");
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const localPathLookups = [];
	const localPath = join(directory, "local-session.jsonl");
	await writeFile(localPath, "", "utf8");
	const localFilePath = join(directory, "local-export.html");
	const remoteFilePath = join(directory, "remote-export.html");
	const localExports = [];
	const remoteExports = [];
	const handlers = new Map();
	catalog.getLocalFilePath = ((original) => (sessionId) => {
		localPathLookups.push(sessionId);
		return original(sessionId);
	})(catalog.getLocalFilePath.bind(catalog));
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", {
		stubs: { electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, app: { getPath: () => directory } } },
	});
	registerSessionIpc({
		projectStore: { get: (id) => [REMOTE_PROJECT, LOCAL_PROJECT].find((project) => project.id === id) },
		sessionCatalog: catalog,
		sessionScanner: {},
		settingsStore: { get: () => ({}) },
		sessionRuntimeCoordinator: { getTarget: () => undefined, isActivating: () => false },
		mainCopy: (key) => key,
		appLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
		getMainWindow: () => undefined,
		exportCatalogSessionHtml: async (sessionId) => {
			localExports.push(sessionId);
			return { path: localFilePath };
		},
		...(withRemoteExport
			? {
					exportRemoteCatalogSessionHtml: async (sessionId) => {
						remoteExports.push(sessionId);
						return { path: remoteFilePath, truncated: false };
					},
				}
			: {}),
	});
	const exportHtml = (sessionId) => handlers.get(ipcChannels.sessionsCatalogExportHtml)({}, sessionId);
	const registerRemote = async (remoteSessionId) =>
		catalog.ensureRemoteSession({
			projectId: REMOTE_PROJECT.id,
			hostId: HOST_ID,
			remoteSessionId,
			remotePath: `/home/dev/.pi/agent/sessions/${remoteSessionId}`,
			title: "远端会话",
			updatedAt: 1_700_000_000_000,
		});
	const createLocal = async () => {
		const draft = await catalog.createDraft({ projectId: LOCAL_PROJECT.id, title: "本地会话", environment: "native" });
		await catalog.update(draft.id, { filePath: localPath });
		return draft.id;
	};
	return { catalog, catalogPath, exportHtml, registerRemote, createLocal, localPathLookups, localExports, remoteExports, remoteFilePath };
}

test("ssh 记录的导出走远端端口，且 getLocalFilePath 一次都没被调用", async (t) => {
	const h = await setupIpc(t);
	const { record } = await h.registerRemote("--srv-app--/remote.jsonl");

	const result = await h.exportHtml(record.id);

	assert.deepEqual(plain(result), { path: h.remoteFilePath, truncated: false });
	assert.deepEqual(plain(h.remoteExports), [record.id]);
	// 「没走本机文件」的硬证据：本机文件路径解析零调用，本机导出零调用，本机文件写入零调用。
	assert.deepEqual(plain(h.localPathLookups), []);
	assert.deepEqual(plain(h.localExports), []);
});

test("本机会话导出行为不变（回归守卫：仍走本机路径守卫 + 本机导出）", async (t) => {
	const h = await setupIpc(t);
	const sessionId = await h.createLocal();

	const result = await h.exportHtml(sessionId);

	assert.equal(result.path.includes("local-export.html"), true);
	assert.deepEqual(plain(h.localExports), [sessionId]);
	assert.deepEqual(plain(h.remoteExports), []);
	// 本机分支逐字未动：仍先过本机路径守卫。
	assert.deepEqual(plain(h.localPathLookups), [sessionId]);
});

test("远端导出端口未装配 ⇒ 稳定码（不是本机路径码，也不回退本机导出）", async (t) => {
	const h = await setupIpc(t, { withRemoteExport: false });
	const { record } = await h.registerRemote("--srv-app--/no-port.jsonl");

	await assert.rejects(h.exportHtml(record.id), new RegExp(REMOTE_SESSION_EXPORT_CODES.unavailable));
	assert.deepEqual(plain(h.localExports), []);
	assert.deepEqual(plain(h.localPathLookups), []);
});
