import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeZlib from "node:zlib";
import { zstdCompressSync } from "node:zlib";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseHeaderLine, isForeignRootSession, firstZstdFrameEnd, listForeignSessionsFromDisk, scanDshSessionHeaders } = loadTsCommonJs("src/main/dsh/dshForeignSessionScan.ts");
const { parseProjectionTitles, titleFromProjectionRecord } = loadTsCommonJs("src/main/dsh/dshProjectionCache.ts");
const { fallbackSessionTitle, foldLoggedSessionTitle } = loadTsCommonJs("src/main/dsh/dshSessionTitleFold.ts");
const { workspaceDirFor, findDshSessionLogFile, dshSessionFilePath } = loadTsCommonJs("src/main/dsh/dshSessionPath.ts");
const { DshHost } = loadTsCommonJs("src/main/dsh/DshHost.ts");

function headerJson(overrides = {}) {
	return JSON.stringify({
		type: "session",
		version: 0,
		id: "session-root-1",
		createdAt: 1,
		cwd: "D:\\project\\alpha",
		delegationDepth: 0,
		...overrides,
	});
}

test("parseHeaderLine accepts a session header and ignores later lines", () => {
	const parsed = parseHeaderLine(`${headerJson()}\n{"type":"user"}\n`, 99);
	assert.equal(parsed.id, "session-root-1");
	assert.equal(parsed.cwd, "D:\\project\\alpha");
	assert.equal(parsed.delegationDepth, 0);
	assert.equal(parsed.updatedAt, 99);
});

test("parseHeaderLine extracts the persisted agent preset (会话「模式」)", () => {
	const parsed = parseHeaderLine(headerJson({ agentPreset: "cordis" }), 1);
	assert.equal(parsed.agentPreset, "cordis");
	// 缺省 header（老版本 host 会话）不携带该字段，解析结果保持 undefined
	assert.equal(parseHeaderLine(headerJson(), 1).agentPreset, undefined);
});

test("parseHeaderLine rejects non-session first lines", () => {
	assert.equal(parseHeaderLine("not-json", 1), undefined);
	assert.equal(parseHeaderLine(JSON.stringify({ type: "user", id: "x" }), 1), undefined);
	assert.equal(parseHeaderLine(JSON.stringify({ type: "session" }), 1), undefined);
});

test("isForeignRootSession drops subagents and forked children", () => {
	assert.equal(isForeignRootSession({ id: "a", updatedAt: 1 }), true);
	assert.equal(isForeignRootSession({ id: "a", updatedAt: 1, origin: "subagent" }), false);
	assert.equal(isForeignRootSession({ id: "a", updatedAt: 1, parentSession: "session-parent" }), false);
	assert.equal(isForeignRootSession({ id: "a", updatedAt: 1, delegationDepth: 1 }), false);
});

test("firstZstdFrameEnd locates a real checksummed header frame", () => {
	const frame = zstdCompressSync(Buffer.from(`${headerJson()}\n`, "utf8"));
	const end = firstZstdFrameEnd(frame);
	assert.equal(end, frame.length);
	assert.equal(firstZstdFrameEnd(Buffer.from("not-zstd")), undefined);
	assert.equal(firstZstdFrameEnd(frame.subarray(0, 8)), undefined);
});

/** 在临时 DSH_HOME 写下 header（zstd 或明文 jsonl）；extraLines 可追加 session/title 等事件。 */
function writeSession(home, cwd, sessionId, headerOverrides, encoding = "zstd", extraLines = []) {
	const dir = join(home, "sessions", workspaceDirFor(cwd), sessionId);
	mkdirSync(dir, { recursive: true });
	const line = [`${headerJson({ id: sessionId, cwd, ...headerOverrides })}`, ...extraLines, ""].join("\n");
	if (encoding === "zstd") {
		writeFileSync(join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(line, "utf8")));
	} else {
		writeFileSync(join(dir, "session.jsonl"), line);
	}
}

test("parseProjectionTitles reads official session_projcache title.val rows", () => {
	const titles = parseProjectionTitles(
		JSON.stringify({
			unit: "session_projcache",
			tables: {
				sessions: {
					"session-root-a": {
						identity: { cwd: "D:/project/alpha" },
						rows: { title: { ver: 1, seq: 1, val: "你好" } },
					},
					"session-blank": {
						rows: { title: { ver: 1, seq: 1, val: "   " } },
					},
				},
			},
		}),
	);
	assert.equal(titles.get("session-root-a"), "你好");
	assert.equal(titles.has("session-blank"), false);
	assert.equal(titleFromProjectionRecord({ rows: { title: { val: 12 } } }), undefined);
});

test("listForeignSessionsFromDisk returns root sessions and skips subagents", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-scan-"));
	try {
		writeSession(home, "D:/project/alpha", "session-root-a", {});
		writeSession(home, "D:/project/alpha", "session-child", {
			origin: "subagent",
			parentSession: "session-root-a",
			delegationDepth: 1,
		});
		writeSession(home, "D:/project/beta", "session-plain", {}, "jsonl");
		const items = listForeignSessionsFromDisk(home);
		const ids = items.map((item) => item.dshSessionId).sort();
		assert.equal(ids.join(","), "session-plain,session-root-a");
		const alpha = items.find((item) => item.dshSessionId === "session-root-a");
		assert.equal(alpha.cwd, "D:/project/alpha");
		assert.equal(typeof alpha.updatedAt, "number");
		assert.equal(alpha.title, undefined, "空日志没有 session/title 也没有首条提示时不得编造标题");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("listForeignSessionsFromDisk passes the persisted agent preset through", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-preset-"));
	try {
		writeSession(home, "D:/project/alpha", "session-preset-a", { agentPreset: "minimal" });
		writeSession(home, "D:/project/alpha", "session-legacy", {});
		const items = listForeignSessionsFromDisk(home);
		const preset = items.find((item) => item.dshSessionId === "session-preset-a");
		assert.equal(preset.agentPreset, "minimal");
		// 老版本 host 的会话 header 没有该字段：item 不携带（保持 undefined）
		const legacy = items.find((item) => item.dshSessionId === "session-legacy");
		assert.equal(legacy.agentPreset, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("foldLoggedSessionTitle prefers last session/title then first-prompt fallback", () => {
	assert.equal(fallbackSessionTitle("几个问题需要修复，1 现在模型 自动重试失败"), "几个问题需要修复，1 现在模");
	const folded = foldLoggedSessionTitle(
		[
			headerJson({ id: "session-root-a" }),
			JSON.stringify({
				type: "user/message",
				data: {
					source: { kind: "user" },
					content: [{ type: "text", text: "几个问题需要修复，1 现在模型 自动重试失败" }],
				},
			}),
			JSON.stringify({ type: "session/title", data: { title: "静态 Loader 条目" } }),
			JSON.stringify({ type: "session/title", data: { title: "你好" } }),
		].join("\n"),
	);
	assert.equal(folded, "你好");
});

test("listForeignSessionsFromDisk folds session/title from the log when cache is missing", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-log-title-"));
	try {
		writeSession(home, "D:/project/alpha", "session-root-a", {}, "jsonl", [
			JSON.stringify({
				type: "user/message",
				data: {
					source: { kind: "user" },
					content: [{ type: "text", text: "几个问题需要修复" }],
				},
			}),
			JSON.stringify({ type: "session/title", data: { title: "静态 Loader 条目" } }),
		]);
		const items = listForeignSessionsFromDisk(home);
		assert.equal(items[0].title, "静态 Loader 条目");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("listForeignSessionsFromDisk uses first-prompt fallback when the log has no session/title", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-fallback-"));
	try {
		writeSession(home, "D:/project/alpha", "session-root-a", {}, "zstd", [
			JSON.stringify({
				type: "user/message",
				data: {
					source: { kind: "user" },
					content: [{ type: "text", text: "几个问题需要修复，1 现在模型 自动重试失败" }],
				},
			}),
		]);
		const items = listForeignSessionsFromDisk(home);
		assert.equal(items[0].title, "几个问题需要修复，1 现在模");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("listForeignSessionsFromDisk attaches official projection-cache titles", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-title-"));
	try {
		writeSession(home, "D:/project/alpha", "session-root-a", {});
		mkdirSync(join(home, "storages"), { recursive: true });
		writeFileSync(
			join(home, "storages", "session_projcache.json"),
			JSON.stringify({
				unit: "session_projcache",
				tables: {
					sessions: {
						"session-root-a": {
							identity: { cwd: "D:/project/alpha" },
							rows: { title: { ver: 1, seq: 12, val: "你好" } },
						},
					},
				},
			}),
		);
		const items = listForeignSessionsFromDisk(home);
		assert.equal(items.length, 1);
		assert.equal(items[0].title, "你好");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("scan skips a missing sessions tree without throwing", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-empty-"));
	try {
		assert.equal(scanDshSessionHeaders(home).length, 0);
		assert.equal(listForeignSessionsFromDisk(join(home, "missing")).length, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.listForeignSessions / listSessionIds read disk without starting host", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-host-"));
	try {
		writeSession(home, "D:/project/alpha", "session-root-a", {});
		writeSession(home, "D:/project/alpha", "session-child", {
			origin: "subagent",
			parentSession: "session-root-a",
			delegationDepth: 1,
		});
		const host = new DshHost(
			() => join(home, "userData"),
			() => home,
			() => undefined,
			() => home,
		);
		assert.equal(host.isStarted(), false);
		const foreign = await host.listForeignSessions();
		const ids = await host.listSessionIds();
		assert.equal(host.isStarted(), false, "列清单不得 fork host，否则会抢 dsh-web 的 DSH_HOME");
		assert.equal(foreign.map((item) => item.dshSessionId).join(","), "session-root-a");
		assert.equal(ids.sort().join(","), "session-child,session-root-a");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ── 解压的 CPU / 内存边界 ─────────────────────────────────────────────────────
// 扫描是「刷一次侧栏就跑一遍全量会话」的路径，这里锁住两件事：
// 1) 内存：单帧解压必须有输出上限——zstd 帧自带可声明的 contentSize，实测 339 字节
//    的帧能解出 10MB，无上限解压就是主进程内存尖峰；
// 2) CPU：只要 id/归属的调用方不该为标题读满前缀并逐帧解压，已有投影缓存标题时
//    连第二帧都不碰。

/** 按 DSH「每次追加一个 zstd 帧」的真实布局写多帧会话文件（每项一帧）。 */
function writeFramedSession(home, cwd, sessionId, frames, logName = "session.jsonl.zstd") {
	const dir = join(home, "sessions", workspaceDirFor(cwd), sessionId);
	mkdirSync(dir, { recursive: true });
	const bytes = frames.map((frame) => (Buffer.isBuffer(frame) ? frame : zstdCompressSync(Buffer.from(frame, "utf8"))));
	writeFileSync(join(dir, logName), Buffer.concat(bytes));
	return dir;
}

/** 写官方投影缓存（session_projcache）标题行。 */
function writeProjcacheTitle(home, sessionId, title) {
	mkdirSync(join(home, "storages"), { recursive: true });
	writeFileSync(
		join(home, "storages", "session_projcache.json"),
		JSON.stringify({
			unit: "session_projcache",
			tables: { sessions: { [sessionId]: { identity: { cwd: "D:/project/alpha" }, rows: { title: { ver: 1, seq: 5, val: title } } } } },
		}),
	);
}

/** 带 zstd 解压计数的扫描模块（桩在依赖注入层，不碰生产代码）。 */
function countingScanModule() {
	const state = { count: 0, options: [] };
	const mod = loadTsCommonJs("src/main/dsh/dshForeignSessionScan.ts", {
		stubs: {
			"node:zlib": {
				...nodeZlib,
				zstdDecompressSync: (buffer, options) => {
					state.count += 1;
					state.options.push(options);
					return nodeZlib.zstdDecompressSync(buffer, options);
				},
			},
		},
	});
	return { scan: mod.scanDshSessionHeaders, list: mod.listForeignSessionsFromDisk, state };
}

const frameHeader = (sessionId) => `${headerJson({ id: sessionId, cwd: "D:/project/alpha" })}\n`;
const TITLE_FRAME = `${JSON.stringify({ type: "session/title", data: { title: "帧里的标题" } })}\n`;

/** 构造一个「压缩后几百字节、解压后超上限」的帧，模拟损坏/构造文件。 */
const bombFrame = () => zstdCompressSync(Buffer.alloc(16 * 1024 * 1024, 0));

test("zstd 解压带输出上限：超限帧被当作损坏跳过，不解出 GB 级缓冲区", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-frame-cap-"));
	const { scan, state } = countingScanModule();
	try {
		writeFramedSession(home, "D:/project/alpha", "session-bomb", [bombFrame()]);
		assert.equal(scan(home).length, 0, "首帧膨胀超限 ⇒ 会话跳过，而不是解出 16MiB");
		assert.ok(state.count > 0, "必须确实尝试过解压（不是因别的原因跳过）");
		for (const options of state.options) {
			assert.equal(typeof options?.maxOutputLength, "number", "每次解压都要带 maxOutputLength");
			assert.ok(options.maxOutputLength <= 8 * 1024 * 1024, `上限 ${options?.maxOutputLength} 不该超过 8MiB`);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("投影缓存命中时不进逐帧解压：只解 header 帧", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-fold-lazy-"));
	try {
		writeFramedSession(home, "D:/project/alpha", "session-root-a", [frameHeader("session-root-a"), TITLE_FRAME]);
		// 缓存未覆盖：标题只能来自第二帧，至少解两次
		const cold = countingScanModule();
		assert.equal(cold.scan(home, { foldTitle: true })[0].loggedTitle, "帧里的标题");
		assert.ok(cold.state.count >= 2, `冷路径要解标题帧，实际只解了 ${cold.state.count} 次`);
		// 缓存命中：标题由缓存提供，第二帧不再解（这是外部会话清单的常态）
		writeProjcacheTitle(home, "session-root-a", "缓存标题");
		const warm = countingScanModule();
		assert.equal(warm.list(home)[0].title, "缓存标题");
		assert.equal(warm.state.count, 1, `缓存命中只该解 header 帧，实际 ${warm.state.count} 次`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("中途坏帧只让标题折叠降级，会话本身不丢", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-fold-broken-"));
	try {
		// 帧序：header → 膨胀帧（折叠会在它这里 break）→ 标题帧（永远到不了）
		writeFramedSession(home, "D:/project/alpha", "session-root-a", [frameHeader("session-root-a"), bombFrame(), TITLE_FRAME]);
		const headers = scanDshSessionHeaders(home, { foldTitle: true });
		assert.equal(headers.length, 1, "坏帧不影响 header 与会话归属");
		assert.equal(headers[0].id, "session-root-a");
		assert.equal(headers[0].loggedTitle, undefined, "折叠降级为无标题，不抛错");
		// 降级后仍可用首条提示回退（标题缺失不该等于会话不可用）
		assert.ok(headers[0].updatedAt > 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("scanDshSessionHeaders 默认不折叠标题，显式开启才读前缀", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-fold-default-"));
	try {
		writeFramedSession(home, "D:/project/alpha", "session-root-a", [frameHeader("session-root-a"), TITLE_FRAME]);
		const cheap = scanDshSessionHeaders(home);
		assert.equal(cheap.length, 1);
		assert.equal(cheap[0].loggedTitle, undefined, "只要 id 的调用方不该为标题读前缀");
		assert.equal(scanDshSessionHeaders(home, { foldTitle: true })[0].loggedTitle, "帧里的标题");
		assert.equal(scanDshSessionHeaders(home, { foldTitle: (id) => id === "session-root-a" })[0].loggedTitle, "帧里的标题");
		assert.equal(scanDshSessionHeaders(home, { foldTitle: (id) => id === "session-other" })[0].loggedTitle, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("首帧超出小前缀时退到大前缀，不因读得少丢会话", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-header-fallback-"));
	try {
		// 小会话可能整体写在一帧里：用不可压缩填充把「压后首帧」顶到 64KiB~256KiB 之间
		const filler = randomBytes(200 * 1024).toString("base64");
		const singleFrame = zstdCompressSync(Buffer.from(`${frameHeader("session-root-a")}${filler}\n`, "utf8"));
		assert.ok(singleFrame.length > 64 * 1024 && singleFrame.length < 256 * 1024, `首帧 ${singleFrame.length} 字节需落在小前缀(64KiB)/大前缀(256KiB)之间才能验证退路`);
		writeFramedSession(home, "D:/project/alpha", "session-root-a", [singleFrame]);
		const headers = scanDshSessionHeaders(home);
		assert.equal(headers.length, 1, "小前缀装不下首帧必须补读，而不是丢会话");
		assert.equal(headers[0].id, "session-root-a");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ── 日志文件名的「格式代」（vN）发现 ───────────────────────────────────────
// 官方 generationLogFilename：版本 0 保留无版本名 `session.jsonl[.zstd]`，之后每一代带小写
// 数字 `vN`（如 `session.v3.jsonl.zstd`）。只认 v0 会让新版 DSH 写的会话在 PiDeck 侧
// 整个「不存在」——清单缺最新会话、目录定位不到（删不掉）、sessionPath 指向不存在的文件。

test("findDshSessionLogFile：v0 与 v1+ 都认，多代并存取最大版本，非官方拼法不认", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-dsh-logfile-"));
	// 跨 realm 对象不能 deepStrictEqual（vm 加载的生产模块原型不同），逐字段断言。
	const assertLogFile = (actual, expectedPath, expectedCompressed) => {
		assert.equal(actual?.path, expectedPath);
		assert.equal(actual?.compressed, expectedCompressed);
	};
	try {
		assert.equal(findDshSessionLogFile(join(root, "nope")), undefined, "目录不存在 → 不是会话目录");
		mkdirSync(join(root, "empty"));
		assert.equal(findDshSessionLogFile(join(root, "empty")), undefined, "空目录 → 不是会话目录");

		mkdirSync(join(root, "v0"));
		writeFileSync(join(root, "v0", "session.jsonl.zstd"), "x");
		assertLogFile(findDshSessionLogFile(join(root, "v0")), join(root, "v0", "session.jsonl.zstd"), true);

		mkdirSync(join(root, "v3"));
		writeFileSync(join(root, "v3", "session.v3.jsonl.zstd"), "x");
		assertLogFile(findDshSessionLogFile(join(root, "v3")), join(root, "v3", "session.v3.jsonl.zstd"), true);

		mkdirSync(join(root, "plain"));
		writeFileSync(join(root, "plain", "session.v2.jsonl"), "x");
		assertLogFile(findDshSessionLogFile(join(root, "plain")), join(root, "plain", "session.v2.jsonl"), false);

		// 多代并存（迁移/异常场景）：取版本号最大的
		mkdirSync(join(root, "both"));
		writeFileSync(join(root, "both", "session.jsonl.zstd"), "x");
		writeFileSync(join(root, "both", "session.v3.jsonl.zstd"), "x");
		assert.equal(findDshSessionLogFile(join(root, "both")).path, join(root, "both", "session.v3.jsonl.zstd"), "旧 v0 不能盖住新一代");

		// 非官方拼法（前导零/大写/临时名/非会话文件）不认，避免把半成品当成会话
		mkdirSync(join(root, "junk"));
		for (const name of ["session.v03.jsonl.zstd", "SESSION.JSONL.ZSTD", "session.v3.jsonl.zstd.tmp", "pideck-manifest.json"]) writeFileSync(join(root, "junk", name), "x");
		assert.equal(findDshSessionLogFile(join(root, "junk")), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("扫描：v1+ 格式代的会话必须进清单（header + 标题折叠都不受命名影响）", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-scan-v3-"));
	try {
		writeFramedSession(home, "D:/project/alpha", "session-root-v3", [frameHeader("session-root-v3"), TITLE_FRAME], "session.v3.jsonl.zstd");
		const items = listForeignSessionsFromDisk(home);
		assert.equal(items.length, 1, "v3 日志的会话不能被当成非会话目录跳过");
		assert.equal(items[0].dshSessionId, "session-root-v3");
		assert.equal(items[0].title, "帧里的标题");
		assert.equal(scanDshSessionHeaders(home).length, 1, "id 扫描同样要认 v1+");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("dshSessionFilePath：已存在的会话按实际格式代解析，未落盘时给 v0 规范名", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-pathgen-"));
	try {
		const cwd = "D:/project/alpha";
		const dir = join(home, "sessions", workspaceDirFor(cwd));
		// 未落盘（新建会话）：保持确定性路径，不因目录缺失就报错
		assert.equal(dshSessionFilePath(home, cwd, "session-new"), join(dir, "session-new", "session.jsonl.zstd"));
		writeFramedSession(home, cwd, "session-v3", [frameHeader("session-v3")], "session.v3.jsonl.zstd");
		assert.equal(dshSessionFilePath(home, cwd, "session-v3"), join(dir, "session-v3", "session.v3.jsonl.zstd"), "已存在的会话必须报真实文件");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
