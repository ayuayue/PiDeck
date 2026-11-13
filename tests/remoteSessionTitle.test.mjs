import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { readSessionScannerSources } from "./helpers/sessionScannerSources.mjs";

const nodeRequire = createRequire(import.meta.url);
const HOST = "b145de8c-6330-45be-8752-f20e8e270150";

const { createRemoteSessionScanner, REMOTE_SESSION_CODES } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { cleanSessionTitleCandidate, inferSessionTitleFromHeadText, inferSessionTitleFromLines } = loadTsCommonJs("src/main/sessions/sessionNameLine.ts");
const { formatPromptTemplateBlock } = loadTsCommonJs("src/shared/expandedRefBlocks.ts");
const { REMOTE_WORKSPACE_MAX_HEAD_BYTES } = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const { createRemoteSessionTitleController, readTitleResponse, isProvisionalTitleOrigin, isTitleTailDegraded } = loadTsCommonJs("src/renderer/src/components/session/remoteSessionTitleState.ts");

/** 跨 VM realm 的比较前先归一化（deepStrictEqual 会比较原型）。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/**
 * 远端替身：只认识 fs.stat / fs.read（title 路径只需要这两个）。
 * frames 是仪器：readHead 的帧数、请求字节数、有没有额外 stat 都靠它断言。
 */
function fakeTitleRemote(options = {}) {
	const frames = [];
	const content = options.content ?? Buffer.alloc(0);
	const size = options.size ?? content.length;
	const session = {
		async request(method, params) {
			frames.push({ method, params: plain(params ?? {}) });
			if (method === "fs.stat") {
				if (options.statError) throw Object.assign(new Error(options.statError), { code: options.statError });
				return { kind: options.kind ?? "file", bytes: size, mtimeMs: options.mtimeMs ?? 7 };
			}
			if (method === "fs.read") {
				const slice = content.subarray(params.offset, params.offset + params.bytes);
				return { chunk: Buffer.from(slice).toString("base64"), bytes: slice.length, eof: params.offset + slice.length >= size };
			}
			throw new Error("unexpected method " + method);
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const roots = [];
	const probeRoots = [];
	// 配置探测阶段（root=<home>/.pi/agent）的替身：这份远端没有 settings.json，任何请求都「读不到」。
	const probeSession = {
		async request() {
			throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const port = {
		remoteHome: async () => (Object.hasOwn(options, "home") ? options.home : "/home/dev"),
		async withProjectSession(hostId, root, task) {
			// J2 的配置探测不产生 frames/roots 记录：既有断言锁的是「会话阶段」的帧预算。
			if (root === "/home/dev/.pi/agent") {
				probeRoots.push(root);
				return { ok: true, value: await task(probeSession) };
			}
			roots.push(root);
			if (options.sessionFailure) return { ok: false, code: options.sessionFailure };
			if (options.throwInTask) return { ok: true, value: await options.throwInTask() };
			return { ok: true, value: await task(session) };
		},
	};
	return { port, frames, roots, probeRoots };
}

const stemId = "ws/2026-02-03T10-00-00-000Z_abc.jsonl";
const stemTitle = "2026-02-03T10-00-00-000Z_abc";

test("标题管线：session_info 名、旧版私有 sessionName、首条 user 文本都能作为标题（真实行样本）", () => {
	const authoritative = inferSessionTitleFromHeadText('{"type":"session_info","name":"Refactor the parser"}');
	assert.deepEqual(plain(authoritative), { name: "Refactor the parser", fromSessionInfo: true });
	// 旧版 PiDeck 私有行（无 type）：走「名字字段」候选，因此 fromSessionInfo 同样是 true——
	// 这个标志的含义是「标题来自名字字段而非首条消息」，不是「来自 session_info 记录」。
	const legacy = inferSessionTitleFromHeadText('{"sessionName":"Old rename","ts":1750000000000}');
	assert.equal(legacy.name, "Old rename");
	assert.equal(legacy.fromSessionInfo, true);
	// 弱兜底：没有名字行时，本地管线给出的标题就是首条 user 文本（侧栏显示的就是它）。
	const weak = inferSessionTitleFromHeadText('{"type":"message","message":{"role":"user","content":"Fix the failing test"}}');
	assert.equal(weak.name, "Fix the failing test");
	assert.equal(weak.fromSessionInfo, false);
	// 权威名赢，但弱兜底候选要带出去（#266 指纹比对基准）。
	const both = inferSessionTitleFromHeadText('{"type":"message","message":{"role":"user","content":"first ask"}}\n{"type":"session_info","name":"Later name"}');
	assert.equal(both.name, "Later name");
	assert.equal(both.fromSessionInfo, true);
	assert.equal(both.fallbackName, "first ask");
});

test("标题管线：时间戳/Untitled 名被清洗，整段抽不出标题时 name=undefined（绝不编造）", () => {
	assert.equal(inferSessionTitleFromHeadText('{"type":"session_info","name":"2026-02-03T10-00-00-000Z_abc"}').name, undefined);
	assert.equal(inferSessionTitleFromHeadText('{"type":"session_info","name":"Untitled"}').name, undefined);
	assert.equal(cleanSessionTitleCandidate("  "), undefined);
	assert.equal(inferSessionTitleFromHeadText("").name, undefined);
	assert.equal(inferSessionTitleFromHeadText('{"type":"session","id":"s-1"}').name, undefined);
	assert.equal(inferSessionTitleFromHeadText('{"type":"model_change","modelId":"gpt"}').name, undefined);
	assert.equal(inferSessionTitleFromHeadText('not json\n{"broken').name, undefined);
	// 首条 user 是展开后的 /模板 块时必须先剥块正文，只留用户自己写的字（与本地同一套清洗）。
	const template = formatPromptTemplateBlock("翻译官", "规则正文");
	const expanded = inferSessionTitleFromHeadText(JSON.stringify({ type: "message", message: { role: "user", content: template + "\n\nhow are you" } }));
	assert.equal(expanded.name, "how are you");
	const onlyTemplate = inferSessionTitleFromHeadText(JSON.stringify({ type: "message", message: { role: "user", content: template } }));
	assert.equal(onlyTemplate.name, "/翻译官");
	// 头被截断的半行被跳过，不影响前面已解析出的标题。
	const truncated = inferSessionTitleFromLines(['{"type":"session_info","name":"Named"}', '{"type":"mess']);
	assert.equal(truncated.name, "Named");
	assert.equal(truncated.fromSessionInfo, true);
});

test("title：有名字行→authoritative；只有首条消息→inferred；空头/畸形→fallback=文件名 stem", async () => {
	const named = fakeTitleRemote({ content: Buffer.from('{"type":"session_info","name":"Refactor the parser"}\n') });
	const parsed = await createRemoteSessionScanner({ port: named.port }).title({ hostId: HOST, remoteSessionId: stemId });
	assert.deepEqual(plain(parsed), { ok: true, title: "Refactor the parser", titleOrigin: "authoritative" });

	// 弱兜底是独立一档（inferred）：它是首条消息派生的，不是会话的真实名字。
	const weak = fakeTitleRemote({ content: Buffer.from('{"type":"message","message":{"role":"user","content":"Fix the failing test"}}\n') });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: weak.port }).title({ hostId: HOST, remoteSessionId: "ws/weak.jsonl" })), { ok: true, title: "Fix the failing test", titleOrigin: "inferred" });
	// 会话根来自握手 home，整次读取都在受控 root 内。
	assert.deepEqual(named.roots, ["/home/dev/.pi/agent/sessions"]);

	const empty = fakeTitleRemote({ content: Buffer.from("") });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: empty.port }).title({ hostId: HOST, remoteSessionId: stemId })), { ok: true, title: stemTitle, titleOrigin: "fallback" });
	// 空文件连 fs.read 都不发（readHead 的既有语义）。
	assert.deepEqual(
		empty.frames.filter((frame) => frame.method === "fs.read"),
		[],
	);

	const garbage = fakeTitleRemote({ content: Buffer.from('{"type":"session","id":"s-1"}\nnot json\n{"broken') });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: garbage.port }).title({ hostId: HOST, remoteSessionId: "ws/s.jsonl" })), { ok: true, title: "s", titleOrigin: "fallback" });
	// fallback 只能是文件名 stem：断言它就是 id 的末段去扩展名，而不是别的东西。
	assert.equal(stemTitle, stemId.slice(stemId.lastIndexOf("/") + 1).replace(/\.jsonl$/, ""));
});

test("title：两段式各段都有界（≤64 KiB）——1 次 stat + 头读 + 尾读，绝不整文件读", async () => {
	const big = fakeTitleRemote({ content: Buffer.alloc(10 * 1024 * 1024, 0x20), size: 10 * 1024 * 1024 });
	const result = await createRemoteSessionScanner({ port: big.port }).title({ hostId: HOST, remoteSessionId: "ws/big.jsonl" });
	assert.deepEqual(plain(result), { ok: true, title: "big", titleOrigin: "fallback" });
	const reads = big.frames.filter((frame) => frame.method === "fs.read");
	const stats = big.frames.filter((frame) => frame.method === "fs.stat");
	// 10 MiB 文件头内没有权威名 ⇒ 按 I1 补一次有界尾读（每段都是一个契约分块的量级）。
	assert.equal(reads.length, 2, "头读 + 尾读");
	assert.equal(reads[0].params.offset, 0);
	assert.equal(reads[0].params.bytes, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(reads[1].params.offset, 10 * 1024 * 1024 - REMOTE_WORKSPACE_MAX_HEAD_BYTES, "尾窗口贴住文件尾");
	assert.ok(reads.every((frame) => frame.params.bytes <= REMOTE_WORKSPACE_MAX_HEAD_BYTES));
	assert.ok(reads.reduce((sum, frame) => sum + frame.params.bytes, 0) <= 2 * REMOTE_WORKSPACE_MAX_HEAD_BYTES, "请求字节总和必须 ≤ 两个窗口，而不是文件大小");
	assert.equal(stats.length, 1, "只有一次 sizing stat：尾读复用头读的 size");
});

test("title：只读——catalog 端口一次都不被调用，真实 catalog 在磁盘上不留写入", async (t) => {
	const counter = { calls: 0 };
	const catalogPort = {
		async ensureRemoteSession() {
			counter.calls += 1;
			throw new Error("title 不得触碰 catalog");
		},
	};
	const remote = fakeTitleRemote({ content: Buffer.from('{"type":"session_info","name":"Named"}\n') });
	const scanner = createRemoteSessionScanner({ port: remote.port, catalog: catalogPort, projectIdForHost: () => "p-1" });
	assert.deepEqual(plain(await scanner.title({ hostId: HOST, remoteSessionId: "ws/a.jsonl" })), { ok: true, title: "Named", titleOrigin: "authoritative" });
	assert.equal(counter.calls, 0, "title 路径根本不该有 catalog 端口调用");

	// 真实 SessionCatalog + open() 计数：只读通道不允许产生任何写盘（register 才写）。
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-title-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const openCalls = [];
	const fsPromises = {
		...nodeRequire("node:fs/promises"),
		open: async (...args) => {
			openCalls.push(args[0]);
			return nodeRequire("node:fs/promises").open(...args);
		},
	};
	const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: { "node:fs/promises": fsPromises, "../logging/sharedLogger": { getAppLogger: () => null } },
	});
	const realCatalog = new SessionCatalog(join(directory, "session-catalog.json"));
	await realCatalog.load();
	const readonlyScanner = createRemoteSessionScanner({ port: remote.port, catalog: realCatalog, projectIdForHost: () => "p-1" });
	await readonlyScanner.title({ hostId: HOST, remoteSessionId: "ws/a.jsonl" });
	await readonlyScanner.title({ hostId: HOST, remoteSessionId: "ws/a.jsonl" });
	assert.deepEqual(openCalls, [], "title 不得写盘");
	assert.equal(realCatalog.listEntries().length, 0);
});

test("title：非法入参在发帧前拒绝，稳定码与 G3 一致", async () => {
	const remote = fakeTitleRemote({ content: Buffer.from("") });
	const scanner = createRemoteSessionScanner({ port: remote.port });
	for (const hostId of ["", "a\u0000b", "x".repeat(65), undefined, 7]) {
		assert.deepEqual(plain(await scanner.title({ hostId, remoteSessionId: "ws/a.jsonl" })), { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid }, String(hostId));
	}
	const invalidIds = ["", "/abs/a.jsonl", "../a.jsonl", "ws/../a.jsonl", "a\\b.jsonl", "noext.txt", "ws//a.jsonl", "ws/.jsonl", "x".repeat(300) + ".jsonl", undefined, 7];
	for (const remoteSessionId of invalidIds) {
		assert.deepEqual(plain(await scanner.title({ hostId: HOST, remoteSessionId })), { ok: false, code: REMOTE_SESSION_CODES.idInvalid }, String(remoteSessionId).slice(0, 24));
	}
	assert.deepEqual(remote.frames, [], "非法调用一个帧都不发");
	assert.deepEqual(remote.roots, []);
});

test("title：home 不可用、建立失败、readHead 失败、未知异常各自的稳定码", async () => {
	const ids = { hostId: HOST, remoteSessionId: "ws/a.jsonl" };
	for (const home of [undefined, "", "~", "relative/home", 42]) {
		const remote = fakeTitleRemote({ home, content: Buffer.from("") });
		assert.deepEqual(plain(await createRemoteSessionScanner({ port: remote.port }).title(ids)), { ok: false, code: REMOTE_SESSION_CODES.homeUnavailable }, String(home));
		assert.deepEqual(remote.roots, []);
	}
	const disconnected = fakeTitleRemote({ sessionFailure: "SSH_HOST_DISCONNECTED", content: Buffer.from("") });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: disconnected.port }).title(ids)), { ok: false, code: "SSH_HOST_DISCONNECTED" });
	const missing = fakeTitleRemote({ statError: "PATH_NOT_FOUND", content: Buffer.from("") });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: missing.port }).title(ids)), { ok: false, code: "PATH_NOT_FOUND" });
	const directory = fakeTitleRemote({ kind: "directory", content: Buffer.from("") });
	const notAFile = await createRemoteSessionScanner({ port: directory.port }).title(ids);
	assert.deepEqual(plain(notAFile), { ok: false, code: "NOT_A_FILE" });
	assert.deepEqual(
		directory.frames.filter((frame) => frame.method === "fs.read"),
		[],
		"非普通文件一个字节都不读",
	);
	// 未知异常（含路径的自由文本）折叠成稳定码，绝不外传。
	const boom = fakeTitleRemote({
		throwInTask: async () => {
			throw new Error("EACCES: /home/secret/session.jsonl");
		},
	});
	const failed = await createRemoteSessionScanner({ port: boom.port }).title(ids);
	assert.deepEqual(plain(failed), { ok: false, code: REMOTE_SESSION_CODES.titleFailed });
	assert.equal(JSON.stringify(failed).includes("secret"), false);
});

/** IPC 域：注入通道名 + electron 桩（每个用例单独装载一次，注册语义就是每次一份）。 */
function ipcFor(input) {
	const handlers = new Map();
	const { registerRemoteSessionIpc } = loadTsCommonJs("src/main/ipc/remoteSessionIpc.ts", {
		stubs: {
			electron: {
				ipcMain: {
					handle(channel, handler) {
						handlers.set(channel, handler);
					},
				},
			},
		},
	});
	registerRemoteSessionIpc(input);
	return handlers;
}

const CHANNELS = { scan: "remote:remote-session-scan", register: "remote:remote-session-register", title: "remote:remote-session-title" };

test("IPC title：注入 title 通道时注册并透传三档 origin；未注入时不注册（fail closed）", async () => {
	const named = fakeTitleRemote({ content: Buffer.from('{"type":"session_info","name":"Refactor the parser"}\n') });
	const handlers = ipcFor({ enabled: true, service: () => named.port, channels: CHANNELS });
	assert.equal(handlers.has(CHANNELS.title), true);
	assert.deepEqual(plain(await handlers.get(CHANNELS.title)({}, HOST, stemId)), { ok: true, value: { title: "Refactor the parser", titleOrigin: "authoritative" } });
	const weakRemote = fakeTitleRemote({ content: Buffer.from('{"type":"message","message":{"role":"user","content":"Fix the failing test"}}\n') });
	const weakHandlers = ipcFor({ enabled: true, service: () => weakRemote.port, channels: CHANNELS });
	assert.deepEqual(plain(await weakHandlers.get(CHANNELS.title)({}, HOST, stemId)), { ok: true, value: { title: "Fix the failing test", titleOrigin: "inferred" } });
	const fallbackRemote = fakeTitleRemote({ content: Buffer.from("") });
	const fallbackHandlers = ipcFor({ enabled: true, service: () => fallbackRemote.port, channels: CHANNELS });
	assert.deepEqual(plain(await fallbackHandlers.get(CHANNELS.title)({}, HOST, stemId)), { ok: true, value: { title: stemTitle, titleOrigin: "fallback" } });

	// 装配还没注入 title 通道：不注册，而不是注册到 undefined 或拿 scan 顶上。
	const withoutTitle = ipcFor({ enabled: true, service: () => named.port, channels: { scan: CHANNELS.scan, register: CHANNELS.register } });
	assert.equal(withoutTitle.has(CHANNELS.title), false);
	assert.equal(withoutTitle.has(CHANNELS.scan), true);
});

test("IPC title：开关关掉/非法 hostId/非字符串 id 都不过边界，且不构建服务", async () => {
	let called = false;
	const disabled = ipcFor({
		enabled: false,
		service: () => {
			called = true;
			return undefined;
		},
		channels: CHANNELS,
	});
	assert.deepEqual(plain(await disabled.get(CHANNELS.title)({}, HOST, "ws/a.jsonl")), { ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" });
	const bounded = ipcFor({
		enabled: true,
		service: () => {
			called = true;
			return undefined;
		},
		channels: CHANNELS,
	});
	for (const bad of ["", "not-a-uuid", undefined, 42]) {
		assert.deepEqual(plain(await bounded.get(CHANNELS.title)({}, bad, "ws/a.jsonl")), { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid, outcome: "rejected" });
	}
	assert.deepEqual(plain(await bounded.get(CHANNELS.title)({}, HOST, 7)), { ok: false, code: REMOTE_SESSION_CODES.idInvalid, outcome: "rejected" });
	assert.equal(called, false);
});

test("渲染层：tailDegraded 如实透传（缺省=false；非布尔=读不懂，不静默）", () => {
	// 尾读失败时主进程会带 tailDegraded:true；渲染层必须原样携带，否则「降级」在 UI 侧仍是静默。
	assert.deepEqual(plain(readTitleResponse({ ok: true, title: "T", titleOrigin: "authoritative", tailDegraded: true })), { kind: "ok", title: "T", origin: "authoritative", tailDegraded: true });
	assert.deepEqual(plain(readTitleResponse({ ok: true, title: "T", titleOrigin: "inferred" })), { kind: "ok", title: "T", origin: "inferred", tailDegraded: false });
	assert.deepEqual(plain(readTitleResponse({ ok: true, title: "T", titleOrigin: "fallback", tailDegraded: false })), { kind: "ok", title: "T", origin: "fallback", tailDegraded: false });
	// 契约只说 boolean | undefined：别的类型属于「读不懂」，回退扫描给的 stem 占位。
	for (const tailDegraded of ["yes", 1, {}, null]) {
		assert.equal(readTitleResponse({ ok: true, title: "T", titleOrigin: "authoritative", tailDegraded }).kind, "rejected", JSON.stringify(tailDegraded));
	}
	const controller = createRemoteSessionTitleController();
	const generation = controller.begin("host-a", "a.jsonl");
	assert.equal(controller.settle(generation, "host-a", "a.jsonl", { kind: "ok", title: "T", origin: "inferred", tailDegraded: true }), true);
	assert.equal(controller.statusOf("a.jsonl").tailDegraded, true, "状态条目必须携带降级标记");
	const clean = controller.begin("host-a", "b.jsonl");
	assert.equal(controller.settle(clean, "host-a", "b.jsonl", { kind: "ok", title: "B", origin: "authoritative" }), true);
	assert.equal(controller.statusOf("b.jsonl").tailDegraded, false);
});

test("两个判据独立：暂定（origin）与降级（tailDegraded）不得合并成一个词", () => {
	const entry = (origin, tailDegraded) => ({ status: "ready", title: "T", origin, code: null, tailDegraded });
	// [origin, tailDegraded, 期望 provisional, 期望 tailDegraded]
	const matrix = [
		["authoritative", true, false, true],
		["authoritative", false, false, false],
		["inferred", true, true, true],
		["fallback", false, true, false],
	];
	for (const [origin, degraded, provisional, tailDegraded] of matrix) {
		const item = entry(origin, degraded);
		assert.equal(isProvisionalTitleOrigin(item.origin), provisional, origin + "/" + degraded + " provisional");
		assert.equal(isTitleTailDegraded(item), tailDegraded, origin + "/" + degraded + " tailDegraded");
	}
	// 反例（合并就红）：把「降级」当成「暂定」会让 (authoritative,true) 期望的 provisional=false 变 true；
	// 反过来把「暂定」当成「降级」会让 (inferred,false) 期望的 tailDegraded=false 变 true。上面两格已经锁死。
	assert.equal(isProvisionalTitleOrigin("authoritative") && isTitleTailDegraded(entry("inferred", false)), false);
});

test("本地解析只有一份实现：SessionScanner 不再自带副本，远端不自己解析行", () => {
	const scannerSource = readSessionScannerSources();
	assert.doesNotMatch(scannerSource, /function inferScanNameFromLines/);
	assert.doesNotMatch(scannerSource, /function cleanScanTitle/);
	assert.match(scannerSource, /from "\.\/sessionNameLine"/);
	assert.match(scannerSource, /inferSessionTitleFromLines\(/);
	const remoteSource = readFileSync("src/main/sessions/RemoteSessionScanner.ts", "utf8");
	assert.match(remoteSource, /inferSessionTitleFromHeadText/);
	// 远端不得自己解析 JSONL **行**做标题推断（那是第二套解析器的入口）。J2 之后模块里确实有一处
	// JSON.parse，但它解析的是 settings.json（配置，用来决定会话根），不是逐行 JSONL；这里锁的是
	// 「没有手写的行解析器」：既不能对 line 调 JSON.parse，也不能自己切行。
	assert.doesNotMatch(remoteSource, /JSON\.parse\(line/);
	assert.doesNotMatch(remoteSource, /split\(\/\\r\?\\n\//);
});
