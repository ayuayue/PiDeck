import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话 JSONL 的**受控改写**（P4.5c：编辑消息 / 删除消息 / 准备重发）。
 *
 * 传输只剩一条 host 级 helper 请求（`session.maintain`）：main 发操作、新正文、候选 id 与它读到的
 * revision，远端在**自己的**文件上流式改写。所以这里不连真机、也不在测试里重写文件：假 host 记录
 * 线上形状（`params` 的每个键、候选顺序、allowedRoots、expected 透传、limits、timeout）并按剧本回答，
 * 本模块要钉的就是「发了什么」与「失败怎么说」——改写规则本身由远端 artifact 自己的测试覆盖。
 *
 * 仍然保留的命令级证据：发请求前那条 pinned SSH 守卫快照（命令形状、失败即停、无自动重试）。
 *
 * 覆盖：三条操作的线上形状与返回值映射；候选 id 的最具体优先顺序与去重；delete 的 no-op 条件；
 * 回执的严格复核；helper 码 → 写入侧既有词汇的完整映射；「确定没改」与「可能已改」的分界；
 * 路径/身份非法时零远端交互；协调器接线（真实 catalog + 真实协调器 + 假 host）。
 */

const HOST = "11111111-1111-4111-8111-111111111111";
const HOME = "/home/dev";
const SESSION_ROOT = HOME + "/.pi/agent/sessions";
const REMOTE_ID = "ws/target.jsonl";
const TARGET_PATH = SESSION_ROOT + "/" + REMOTE_ID;
const SESSION_DIRECTORY = SESSION_ROOT + "/ws";
const BANNER = "Now using node v20.19.0 (npm v10.8.2)\n";
/** 稳定码不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

const { createRemoteSessionHistoryWriter, remoteSessionHistoryWriteFailure, REMOTE_SESSION_HISTORY_WRITER_CODES, REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID, REMOTE_SESSION_HISTORY_WRITE_MAX_BYTES } = loadTsCommonJs("src/main/remote/RemoteSessionHistoryWriter.ts");
const { buildRemoteSessionMaintainCandidates, REMOTE_SESSION_MAINTENANCE_CODES } = loadTsCommonJs("src/main/remote/RemoteSessionMaintenance.ts");
const { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH, REMOTE_HELPER_METHOD_SESSION_MAINTAIN, REMOTE_SESSION_MAINTAIN_MAX_DRAFT_BYTES, REMOTE_SESSION_MAINTAIN_MAX_ENTRIES, REMOTE_SESSION_MAINTAIN_MAX_FILE_BYTES, REMOTE_SESSION_MAINTAIN_MAX_LINE_BYTES, REMOTE_SESSION_MAINTAIN_REQUEST_TIMEOUT_MS } =
	loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");

/** 守卫命令形状：唯一解析点（生产模板一变，这里先红）。 */
const GUARD_SHAPE = /^'([^']+)' '-e' '[^']*' '(snapshot|commit)' '([^']+)' '([^']+)' '([^']*)' '([^']*)' '(\d+)'$/;
const CODES = REMOTE_SESSION_HISTORY_WRITER_CODES;
/** 冻结的线上一级键：多一个少一个都算契约变了。 */
const PARAM_KEYS = ["allowedRoots", "candidateIds", "expected", "limits", "newText", "operation", "path"];
const LIMITS = {
	maxFileBytes: REMOTE_SESSION_MAINTAIN_MAX_FILE_BYTES,
	maxLineBytes: REMOTE_SESSION_MAINTAIN_MAX_LINE_BYTES,
	maxEntries: REMOTE_SESSION_MAINTAIN_MAX_ENTRIES,
	maxDraftBytes: REMOTE_SESSION_MAINTAIN_MAX_DRAFT_BYTES,
};

/** 跨 realm（测试 VM 里跑生产代码）的普通对象不能 deepStrictEqual，一律先归一到本 realm 的 JSON 值。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * 假 host：内存文件表 + 生产守卫命令的 `snapshot` 语义 + 记录（并按剧本回答）`session.maintain`。
 *
 * 它**不**执行改写：改写规则已经不在这条链路上了。`options.maintain` 返回一个值就是本次回答，
 * 抛错就是请求层以该稳定码失败（与真实 transport 的行为一致）。
 */
function fakeHost(initialFiles, options = {}) {
	const files = new Map(Object.entries(initialFiles).map(([path, content]) => [path, Buffer.from(content, "utf8")]));
	const commands = [];
	const requests = [];
	const revision = () => {
		const content = files.get(TARGET_PATH);
		return { mode: 0o600, size: content.length, dev: "1", ino: "1", uid: "1", gid: "1", mtimeNs: "1", ctimeNs: "1", digest: createHash("sha256").update(content).digest("hex") };
	};
	const transport = {
		async runRemoteCommand({ hostId, remoteCommand }) {
			assert.equal(hostId, HOST);
			const index = commands.length;
			commands.push(remoteCommand);
			if (options.failCommand?.(remoteCommand, index)) return { exitCode: 1, stdout: "" };
			const match = GUARD_SHAPE.exec(remoteCommand);
			if (!match) throw new Error(`UNEXPECTED_REMOTE_COMMAND: ${remoteCommand}`);
			const [, , operation, marker, path, , , limit] = match;
			if (operation !== "snapshot") throw new Error(`GUARD_COMMIT_MUST_NOT_BE_SENT: ${remoteCommand}`);
			const content = files.get(path);
			const answer = (value) => ({ exitCode: 0, stdout: `${options.banner ? BANNER : ""}${marker}${JSON.stringify(value)}` });
			if (content === undefined) return answer({ ok: false, code: "commandFailed" });
			if (content.length > Number(limit)) return answer({ ok: false, code: "fileTooLarge", details: { size: content.length, limit: Number(limit) } });
			return answer({ ok: true, revision: revision() });
		},
	};
	const maintenance = {
		async request(hostId, method, params, requestOptions) {
			const call = { hostId, method, params: plain(params), options: plain(requestOptions ?? null), index: requests.length };
			requests.push(call);
			if (options.request) return await options.request(call);
			return { revision: revision(), draft: call.params.operation === "resend" ? DEFAULT_DRAFT : null };
		},
	};
	return { files, commands, requests, transport, maintenance, revision, text: (path = TARGET_PATH) => files.get(path)?.toString("utf8") };
}

const DEFAULT_DRAFT = { text: "again", images: [{ mime: "image/png", dataBase64: "AAAA" }] };

function createWriter(host, options = {}) {
	return createRemoteSessionHistoryWriter({
		transport: host.transport,
		maintenance: host.maintenance,
		resolveNodePath: async () => "/usr/bin/node",
		resolveSessionRoot: async () => ({ ok: true, root: SESSION_ROOT }),
		...options,
	});
}

function locatorWith(remotePath) {
	return { kind: "ssh", hostId: HOST, remoteSessionId: REMOTE_ID, remotePath };
}

const ABSOLUTE_LOCATOR = locatorWith(TARGET_PATH);

/** 一条真实形状的 pi 会话（内容不再由 main 解析，只需要是「远端那份文件」）。 */
function fixtureDocument() {
	const stamp = "2026-01-01T00:00:00.000Z";
	return `${[
		{ type: "session", id: "sess-1", timestamp: stamp },
		{ type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "hello world" }] } },
		{ type: "message", id: "a1", parentId: "u1", timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } },
		{
			type: "message",
			id: "u2",
			parentId: "a1",
			timestamp: stamp,
			message: {
				role: "user",
				content: [
					{ type: "text", text: "again" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
				],
			},
		},
		{ type: "message", id: "sys1", parentId: "u2", timestamp: stamp, message: { role: "system", content: [{ type: "text", text: "system prompt" }] } },
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n")}\n`;
}

/** 一次改写：默认走绝对 locator + 渲染层合成 id（与真实 UI 的 id 形状一致）。 */
async function maintain(host, operation, input = {}, options = {}) {
	const writer = createWriter(host, options);
	return await writer.mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation, messageId: `_viewer-history-${input.entryId ?? "u1"}`, ...input });
}

async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

test("edit issues exactly one session.maintain request with the frozen params", async () => {
	const document = fixtureDocument();
	const host = fakeHost({ [TARGET_PATH]: document });
	const expected = host.revision();

	const result = await maintain(host, "edit", { entryId: "u1", newText: "edited text" });

	assert.equal(result, undefined);
	// 远端交互只有两条：发请求前那一次守卫快照 + 一条 helper 请求。没有第二条写通道，也没有回传整份文件。
	assert.equal(host.commands.length, 1);
	assert.equal(host.requests.length, 1);
	const guard = GUARD_SHAPE.exec(host.commands[0]);
	assert.equal(guard?.[2], "snapshot", `守卫命令形状不符: ${host.commands[0]}`);
	assert.equal(guard?.[4], TARGET_PATH);
	assert.equal(Number(guard?.[7]), REMOTE_SESSION_HISTORY_WRITE_MAX_BYTES, "快照上界就是守卫脚本自己的上界");

	const call = host.requests[0];
	assert.equal(call.hostId, HOST);
	assert.equal(call.method, REMOTE_HELPER_METHOD_SESSION_MAINTAIN);
	assert.equal(call.method, "session.maintain");
	assert.equal(call.options.timeoutMs, REMOTE_SESSION_MAINTAIN_REQUEST_TIMEOUT_MS);
	assert.deepEqual(Object.keys(call.params).sort(), PARAM_KEYS);
	assert.equal(call.params.path, TARGET_PATH);
	assert.equal(call.params.operation, "edit");
	assert.equal(call.params.newText, "edited text");
	// 合成 id 与其 entryId 是同一条消息的两种身份：最具体在前、去重、不重复发。
	assert.deepEqual(call.params.candidateIds, ["_viewer-history-u1", "u1"]);
	// allowedRoots 只有一个：目标文件自己的目录（不多给一条越权入口）。
	assert.deepEqual(call.params.allowedRoots, [SESSION_DIRECTORY]);
	// revision 原样回传：远端据此 compare-and-swap。
	assert.deepEqual(call.params.expected, plain(expected));
	assert.equal(call.params.expected.digest, createHash("sha256").update(document).digest("hex"));
	assert.deepEqual(call.params.limits, LIMITS);

	// 正文、路径、命令行都只出现在请求里：快照命令里一个字节的会话内容都没有。
	assert.equal(host.commands.join("\n").includes("edited text"), false);
	assert.equal(host.text(), document, "main 不再改写文件：远端负责落盘");
});

test("delete and resend send an empty newText; resend returns the draft the worker built", async () => {
	const document = fixtureDocument();
	const deleteHost = fakeHost({ [TARGET_PATH]: document });
	assert.equal(await maintain(deleteHost, "delete", { entryId: "a1", newText: "ignored for delete" }), undefined);
	assert.equal(deleteHost.requests[0].params.operation, "delete");
	assert.equal(deleteHost.requests[0].params.newText, "", "delete 不带正文（冻结契约）");

	const resendHost = fakeHost({ [TARGET_PATH]: document });
	const draft = await maintain(resendHost, "resend", { entryId: "u2", newText: "ignored for resend" });
	assert.equal(resendHost.requests[0].params.newText, "", "resend 不带正文（冻结契约）");
	// 草稿来自远端：`{ text, images: [{ mime, dataBase64 }] }` → 渲染层/pi 认的 ImageContent。
	assert.deepEqual(plain(draft), { text: "again", images: [{ type: "image", mimeType: "image/png", data: "AAAA" }] });

	const emptyDraftHost = fakeHost({ [TARGET_PATH]: document });
	emptyDraftHost.maintenance.request = async () => ({ revision: emptyDraftHost.revision(), draft: { text: "", images: [] } });
	const emptyDraft = await maintain(emptyDraftHost, "resend", { entryId: "u2" });
	assert.deepEqual(plain(emptyDraft), { text: "" }, "没有参考图时不返回空 images 键（与本机链路同形）");
});

test("candidate ids keep the lookup order: entryId projection, bare entryId, then the UI message id", async () => {
	const cases = [
		// 有 meta.entryId 提示：投影 id → 裸 entryId → UI id（UI id 与投影 id 相同 ⇒ 去重后两条）。
		{ messageId: "_viewer-history-u1", entryId: "u1", expected: ["_viewer-history-u1", "u1"] },
		// 提示来自停止前身份摘要：投影 id 用的是**同一个** agentId 前缀，裸 id 其次，UI id 最后。
		{ messageId: "_viewer-history-live", stoppedIdentity: { entryId: "a1", role: "assistant", timestamp: 1, fingerprint: "f" }, expected: ["_viewer-history-a1", "a1", "_viewer-history-live"] },
		// 没有任何提示：文件里只可能是 UI id 自己（旧会话没有 message.id 时它本身就是 entryId）。
		{ messageId: "live-random-id", expected: ["live-random-id"] },
		// 非合成 id：推不出 agentId，就只剩裸提示与 UI id。
		{ messageId: "live-random-id", entryId: "u2", expected: ["u2", "live-random-id"] },
		// 形状非法（控制字节 / 超长）的候选不可能是文件里的 id：丢掉，而不是发出去等对端拒。
		{ messageId: "bad\u0000id", expected: [] },
		{ messageId: "x".repeat(200), expected: [] },
	];
	for (const item of cases) {
		const host = fakeHost({ [TARGET_PATH]: fixtureDocument() });
		const writer = createWriter(host);
		const run = writer.mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: item.expected.length === 0 ? "edit" : "delete", messageId: item.messageId, ...(item.entryId === undefined ? {} : { entryId: item.entryId }), ...(item.stoppedIdentity === undefined ? {} : { stoppedIdentity: item.stoppedIdentity }) });
		if (item.expected.length === 0) assert.equal(await rejectionCode(() => run), CODES.messageNotFound, item.messageId);
		else await run;
		if (item.expected.length === 0) assert.deepEqual(host.requests, [], "没有候选 id 时一个请求都不发");
		else assert.deepEqual(host.requests[0].params.candidateIds, item.expected, item.messageId);
	}

	// 候选构造函数本身（纯函数）：最多 3 条、最具体在前、去重。
	assert.deepEqual(plain(buildRemoteSessionMaintainCandidates({ messageId: "agent-1-history-u1", entryIdHint: "u1" })), ["agent-1-history-u1", "u1"]);
	assert.deepEqual(plain(buildRemoteSessionMaintainCandidates({ messageId: "m", entryIdHint: "u1" })), ["u1", "m"]);
	assert.deepEqual(plain(buildRemoteSessionMaintainCandidates({ messageId: "" })), []);
});

test("delete is a no-op only when the message is missing AND no stopped identity exists", async () => {
	const document = fixtureDocument();
	// 远端回答「没有这条消息」。
	const missing = () => {
		throw new Error("SESSION_MAINTAIN_MESSAGE_NOT_FOUND");
	};

	const noStop = fakeHost({ [TARGET_PATH]: document }, { request: missing });
	assert.equal(await maintain(noStop, "delete", { entryId: "gone", messageId: "live-uuid" }), undefined, "文件里本来就没有这条：删除是 no-op");
	assert.equal(noStop.requests.length, 1, "no-op 不是「不发请求」：谁在文件里由远端判定");

	const withStop = fakeHost({ [TARGET_PATH]: document }, { request: missing });
	assert.equal(await rejectionCode(() => maintain(withStop, "delete", { entryId: "gone", messageId: "live-uuid", stoppedIdentity: { role: "user", timestamp: 1, fingerprint: "f" } })), CODES.messageNotFound, "留过停止前身份摘要却找不到 ⇒ 可能是定位缺陷，不能伪装成删除成功");

	// edit / resend 依赖正文：找不到必须报未找到（与在本机链路一致）。
	const editHost = fakeHost({ [TARGET_PATH]: document }, { request: missing });
	assert.equal(await rejectionCode(() => maintain(editHost, "edit", { entryId: "gone", newText: "y" })), CODES.messageNotFound);
	const resendHost = fakeHost({ [TARGET_PATH]: document }, { request: missing });
	assert.equal(await rejectionCode(() => maintain(resendHost, "resend", { entryId: "gone" })), CODES.messageNotFound);

	// 没有候选 id 时也一样（不发请求，语义与远端回 NOT_FOUND 相同）。
	const empty = fakeHost({ [TARGET_PATH]: document });
	assert.equal(await createWriter(empty).mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: "delete", messageId: "" }), undefined);
	assert.deepEqual(empty.commands, [], "没有候选 id ⇒ 连快照都不发");
	assert.equal(await rejectionCode(() => createWriter(empty).mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: "edit", messageId: "", newText: "y" })), CODES.messageNotFound);
});

test("helper codes map onto the writer vocabulary the coordinator already speaks", async () => {
	const mapped = [
		["SESSION_MAINTAIN_MESSAGE_NOT_FOUND", CODES.messageNotFound],
		["SESSION_MAINTAIN_FILE_CHANGED", CODES.fileChanged],
		["SESSION_MAINTAIN_FILE_TOO_LARGE", CODES.fileTooLarge],
		["SESSION_MAINTAIN_FILE_INVALID", CODES.fileInvalid],
		["SESSION_MAINTAIN_ROLE_INVALID", CODES.roleInvalid],
		["SESSION_MAINTAIN_DRAFT_TOO_LARGE", CODES.draftTooLarge],
		["SESSION_MAINTAIN_COMMIT_UNCONFIRMED", CODES.resultUnconfirmed],
		["SESSION_MAINTAIN_INPUT_INVALID", CODES.commandFailed],
		["SESSION_MAINTAIN_PATH_INVALID", CODES.pathInvalid],
		// 对端亲自回答的「没改」：目标文件一个字节都没动，可以安全重读后重试。
		["PERMISSION_DENIED", CODES.commandFailed],
		["IO_ERROR", CODES.commandFailed],
		["PROTOCOL_INVALID", CODES.commandFailed],
		// 版本过旧：这个方法根本不存在。
		["METHOD_NOT_FOUND", CODES.unavailable],
		// 帧可能已写出：只能「重新加载核对」，不能「重试」。
		["REQUEST_TIMEOUT", CODES.resultUnconfirmed],
		["REMOTE_CONNECTION_LOST", CODES.resultUnconfirmed],
		["HELPER_INTERNAL", CODES.resultUnconfirmed],
		[REMOTE_SESSION_MAINTENANCE_CODES.resultUnconfirmed, CODES.resultUnconfirmed],
		[REMOTE_SESSION_MAINTENANCE_CODES.responseInvalid, CODES.resultUnconfirmed],
	];
	for (const [helperCode, writerCode] of mapped) {
		const host = fakeHost(
			{ [TARGET_PATH]: fixtureDocument() },
			{
				request: () => {
					throw new Error(helperCode);
				},
			},
		);
		assert.equal(await rejectionCode(() => maintain(host, "edit", { entryId: "u1", newText: "x" })), writerCode, helperCode);
		assert.equal(host.requests.length, 1, `${helperCode}: 破坏性动作绝不自动重试`);
	}

	// 体积参数跟着错误走（渲染层的 {sizeMb}/{limitMb} 需要真实上界，不能拿本机 32MB 兜底骗人）。
	const tooLarge = fakeHost(
		{ [TARGET_PATH]: fixtureDocument() },
		{
			request: () => {
				throw Object.assign(new Error("SESSION_MAINTAIN_FILE_TOO_LARGE"), { details: { size: 600, limit: 512 } });
			},
		},
	);
	await assert.rejects(
		() => maintain(tooLarge, "edit", { entryId: "u1", newText: "x" }),
		(error) => {
			const failure = remoteSessionHistoryWriteFailure(error);
			return failure.code === CODES.fileTooLarge && failure.details.size === 600 && failure.details.limit === 512;
		},
	);

	// 连接层的稳定码（帧还没写出）原样透出：与改动前的连接诊断口径一致，不折叠成「结果未确认」。
	for (const connectionCode of ["SSH_CONNECTION_NOT_READY", "SSH_CONNECTION_MANAGER_DISPOSED"]) {
		const host = fakeHost(
			{ [TARGET_PATH]: fixtureDocument() },
			{
				request: () => {
					throw new Error(connectionCode);
				},
			},
		);
		assert.equal(await rejectionCode(() => maintain(host, "edit", { entryId: "u1", newText: "x" })), connectionCode);
	}
	// 没有稳定码的抛出：无法证明「没发生」⇒ 未确认（绝不谎报「目标未改动」）。
	const opaque = fakeHost(
		{ [TARGET_PATH]: fixtureDocument() },
		{
			request: () => {
				throw new Error("socket hang up");
			},
		},
	);
	assert.equal(await rejectionCode(() => maintain(opaque, "edit", { entryId: "u1", newText: "x" })), CODES.resultUnconfirmed);

	// 「结果未确认」与「确定没改」必须是两个码（渲染层据此显示两种不同文案）。
	assert.notEqual(CODES.resultUnconfirmed, CODES.commandFailed);
	for (const code of Object.values(CODES)) assert.match(code, STABLE_CODE, code);
	assert.equal(new Set(Object.values(CODES)).size, Object.keys(CODES).length, "稳定码不许重名");
});

test("an unconfirmed rewrite is reported once, never replayed, and never as 'nothing changed'", async () => {
	const document = fixtureDocument();
	for (const reply of [
		() => {
			throw new Error("REQUEST_TIMEOUT");
		},
		() => {
			throw new Error("REMOTE_CONNECTION_LOST");
		},
	]) {
		const host = fakeHost({ [TARGET_PATH]: document }, { request: reply });
		const writer = createWriter(host);
		assert.equal(await rejectionCode(() => writer.mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: "delete", messageId: "_viewer-history-a1", entryId: "a1" })), CODES.resultUnconfirmed);
		assert.equal(host.requests.length, 1, "未确认不等于自动重试：请求只发一次");
		assert.equal(host.commands.length, 1, "快照也只发一次");
	}
});

test("the reply shape is re-checked strictly: unknown, missing or mistyped fields are never trusted", async () => {
	const document = fixtureDocument();
	const revision = fakeHost({ [TARGET_PATH]: document }).revision();
	const cases = {
		// 缺 revision：无法证明改写落在哪一版上。
		missingRevision: [{ draft: null }, "edit"],
		// 多一个键：对端不是这份契约。
		extraKey: [{ revision, draft: null, path: TARGET_PATH }, "edit"],
		// edit/delete 不该带回草稿。
		unexpectedDraft: [{ revision, draft: { text: "x", images: [] } }, "edit"],
		// resend 必须带回草稿（否则重发的是空文本）。
		missingDraft: [{ revision, draft: null }, "resend"],
		// 草稿里出现契约之外的键/坏 base64/坏 mime。
		draftExtraKey: [{ revision, draft: { text: "x", images: [{ mime: "image/png", dataBase64: "AAAA", data: "AAAA" }] } }, "resend"],
		draftBadBase64: [{ revision, draft: { text: "x", images: [{ mime: "image/png", dataBase64: "not base64!" }] } }, "resend"],
		draftBadMime: [{ revision, draft: { text: "x", images: [{ mime: "png", dataBase64: "AAAA" }] } }, "resend"],
		// revision 字段类型错/摘要不是 sha256。
		badRevision: [{ revision: { ...revision, digest: "nope" }, draft: null }, "edit"],
		// 不是对象。
		notAnObject: ["ok", "edit"],
	};
	for (const [name, [answer, operation]] of Object.entries(cases)) {
		const host = fakeHost({ [TARGET_PATH]: document }, { request: () => answer });
		const code = await rejectionCode(() => maintain(host, operation, { entryId: "u1", newText: "x" }));
		// 请求已经发出：形状不可信只能落「结果未确认」，不能落「目标未改动，请重试」。
		assert.equal(code, CODES.resultUnconfirmed, name);
		assert.equal(host.requests.length, 1, name);
	}

	// 草案超出契约上界：对端违反自己的界 ⇒ 同样不可信（绝不偷偷交给重发一条半份草稿）。
	const huge = fakeHost({ [TARGET_PATH]: document }, { request: () => ({ revision, draft: { text: "x".repeat(REMOTE_SESSION_MAINTAIN_MAX_DRAFT_BYTES + 1), images: [] } }) });
	assert.equal(await rejectionCode(() => maintain(huge, "resend", { entryId: "u1" })), CODES.resultUnconfirmed);
});

test("the pinned snapshot decides the revision: a file over the bound or an untrustworthy reply never reaches the worker", async () => {
	const document = fixtureDocument();

	// ① 文件超出快照上界：fail-closed，重试也不会变（守卫脚本自己的界）。
	const oversized = fakeHost({ [TARGET_PATH]: "x".repeat(2048) });
	assert.equal(await rejectionCode(() => maintain(oversized, "edit", { entryId: "u1", newText: "x" }, { maxFileBytes: 1024 })), CODES.fileTooLarge);
	assert.deepEqual(oversized.requests, [], "上界不通过时一个请求都不发");

	// ② 守卫命令非 0 退出：远端没给出结论，什么都不改。
	const failed = fakeHost({ [TARGET_PATH]: document }, { failCommand: (_command, index) => index === 0 });
	assert.equal(await rejectionCode(() => maintain(failed, "edit", { entryId: "u1", newText: "x" })), CODES.commandFailed);
	assert.equal(failed.commands.length, 1, "失败即停：不得自动重试");
	assert.deepEqual(failed.requests, []);

	// ③ 输出里没有标记（回执撕裂）：拿不到可信 revision，绝不发请求。
	const torn = fakeHost({ [TARGET_PATH]: document });
	torn.transport.runRemoteCommand = async () => ({ exitCode: 0, stdout: "" });
	assert.equal(await rejectionCode(() => createWriter(torn).mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: "delete", messageId: "_viewer-history-a1", entryId: "a1" })), CODES.transferInvalid);
	assert.deepEqual(torn.requests, []);

	// ④ 登录横幅不影响解析：标记之后的 JSON 才是结果。
	const banner = fakeHost({ [TARGET_PATH]: document }, { banner: true });
	assert.equal(await maintain(banner, "edit", { entryId: "u1", newText: "after banner" }), undefined);
	assert.equal(banner.requests.length, 1);

	// ⑤ 快照命令本身仍在 pinned 通道的单命令预算内，且只有单引号字面量。
	for (const command of banner.commands) {
		assert.equal(/["`$\\\n]/.test(command.replace(/'[^']*'/g, "''")), false, `用户参数不得逃出单引号 argv: ${command}`);
		assert.equal(/[\r\n]/.test(command), false, "单命令禁止换行");
		assert.equal(command.length <= REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH, true, `命令超过 pinned 通道的单命令上界: ${command.length}`);
	}
});

test("invalid paths and identities are refused before any remote interaction", async () => {
	// 相对身份 + 没有会话根解析端口 = fail-closed（绝不猜 <home>/.pi/agent/sessions）。
	const relativeHost = fakeHost({});
	const relative = createRemoteSessionHistoryWriter({ transport: relativeHost.transport, maintenance: relativeHost.maintenance, resolveNodePath: async () => "/usr/bin/node" });
	assert.equal(await rejectionCode(() => relative.mutate({ hostId: HOST, locator: locatorWith(REMOTE_ID), operation: "delete", messageId: "m" })), CODES.pathUnresolved);

	// 含单引号的远端路径：绝不进命令行（拒绝而不是实现一套转义）。
	const quoted = fakeHost({ [TARGET_PATH]: fixtureDocument() });
	assert.equal(await rejectionCode(() => createWriter(quoted).mutate({ hostId: HOST, locator: locatorWith(`${SESSION_ROOT}/ws/it's.jsonl`), operation: "delete", messageId: "m", entryId: "u1" })), CODES.pathInvalid);

	// 非规范绝对路径：与读取侧同一判据，写面同样在发请求前拒绝。
	const nonCanonical = fakeHost({ [TARGET_PATH]: fixtureDocument() });
	for (const badPath of [`${SESSION_ROOT}//ws/x.jsonl`, `${SESSION_ROOT}/../escape.jsonl`, `${SESSION_ROOT}/./ws/x.jsonl`]) {
		assert.equal(await rejectionCode(() => createWriter(nonCanonical).mutate({ hostId: HOST, locator: locatorWith(badPath), operation: "delete", messageId: "m", entryId: "u1" })), CODES.pathInvalid, badPath);
	}

	// hostId / locator / operation 判据。
	const identity = fakeHost({ [TARGET_PATH]: fixtureDocument() });
	const writer = createWriter(identity);
	assert.equal(await rejectionCode(() => writer.mutate({ hostId: "nope", locator: ABSOLUTE_LOCATOR, operation: "delete", messageId: "m" })), CODES.hostIdInvalid);
	assert.equal(await rejectionCode(() => writer.mutate({ hostId: HOST, locator: { ...ABSOLUTE_LOCATOR, hostId: "22222222-2222-4222-8222-222222222222" }, operation: "delete", messageId: "m" })), CODES.locatorInvalid);
	assert.equal(await rejectionCode(() => writer.mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: "truncate", messageId: "m" })), CODES.operationInvalid);
	for (const host of [relativeHost, quoted, nonCanonical, identity]) {
		assert.deepEqual(host.commands, [], "身份/路径/操作非法时一个远端命令都不发");
		assert.deepEqual(host.requests, [], "身份/路径/操作非法时一个 helper 请求都不发");
	}

	// 折叠：非稳定码的异常不外传（路径、stderr、正文都不进诊断）。
	assert.equal(remoteSessionHistoryWriteFailure(Object.assign(new Error(CODES.fileTooLarge), { details: { size: 1, limit: 2 } })).details.limit, 2);
	assert.equal(remoteSessionHistoryWriteFailure(new Error("boom")).code, CODES.transportFailed);
});

test("constructor rejects an invalid assembly instead of failing on first use", () => {
	const host = fakeHost({ [TARGET_PATH]: fixtureDocument() });
	const codeOf = (run) => {
		try {
			run();
		} catch (error) {
			return typeof error?.message === "string" ? error.message : String(error);
		}
		throw new Error("EXPECTED_THROW");
	};
	assert.equal(
		codeOf(() => createRemoteSessionHistoryWriter({})),
		REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID,
	);
	// 缺请求端口（旧装配）：构造即拒，绝不落回「下载整份文件再上传」的第二条写路径。
	assert.equal(
		codeOf(() => createRemoteSessionHistoryWriter({ transport: host.transport, resolveNodePath: async () => "/usr/bin/node" })),
		REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID,
	);
	// 上界与会话维护的文件上限同源：超过它就不再是「这台机器能安全维护的会话」，构造即拒。
	assert.equal(
		codeOf(() => createWriter(host, { maxFileBytes: REMOTE_SESSION_MAINTAIN_MAX_FILE_BYTES + 1 })),
		REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID,
	);
});

/**
 * 接线级证据：真实 `SessionCatalog` + 真实 `SessionRuntimeCoordinator` + 真实写面 + 假 host。
 * 三条链路在 ssh 记录上走的是 catalog 分支（本机路径入口一次都不参与），且错误映射能被渲染层分类。
 */
test("the three chains over an ssh record reach the worker; the local path entry is never used", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-write-chain-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalog = new SessionCatalog(join(directory, "session-catalog.json"));
	await catalog.load();
	const document = fixtureDocument();
	const host = fakeHost({ [TARGET_PATH]: document });
	const writer = createWriter(host);
	const coordinator = new SessionRuntimeCoordinator(
		catalog,
		{ backend: "pi", list: () => [] },
		async () => ({ accepted: false, delivery: "rejected", error: "unused", sessionId: "unused", requestId: "unused" }),
		undefined,
		undefined,
		() => writer,
	);
	const localPathLookups = [];
	const originalGetLocalFilePath = catalog.getLocalFilePath.bind(catalog);
	catalog.getLocalFilePath = (sessionId) => {
		localPathLookups.push(sessionId);
		return originalGetLocalFilePath(sessionId);
	};
	const registration = await catalog.ensureRemoteSession({ projectId: "project-remote", hostId: HOST, remoteSessionId: REMOTE_ID, remotePath: TARGET_PATH, title: "远端会话", updatedAt: 1 });
	const sessionId = registration.record.id;

	const edited = await coordinator.editCatalogMessage(sessionId, "_viewer-history-u1", "edited remotely", "u1");
	const deleted = await coordinator.deleteCatalogMessage(sessionId, "_viewer-history-a1", "a1");
	const resent = await coordinator.prepareCatalogResend(sessionId, "_viewer-history-u2", "u2");

	assert.equal(edited.ok, true);
	assert.equal(deleted.ok, true);
	assert.equal(resent.ok, true);
	assert.equal(resent.value.text, "again");
	assert.deepEqual(plain(resent.value.images), [{ type: "image", mimeType: "image/png", data: "AAAA" }]);
	// 三条链路各发一条请求，操作与候选都对得上（requestedSessionId → 同一条远端文件）。
	assert.deepEqual(
		host.requests.map((call) => call.params.operation),
		["edit", "delete", "resend"],
	);
	assert.deepEqual(
		host.requests.map((call) => call.params.candidateIds[0]),
		["_viewer-history-u1", "_viewer-history-a1", "_viewer-history-u2"],
	);
	assert.deepEqual(localPathLookups, [], "ssh 记录全程不碰本机路径入口");

	// 「历史没改，只是草稿太大」有自己的可读码：不能报成功，也不能报「写失败可重试」。
	const draftTooLarge = fakeHost(
		{ [TARGET_PATH]: document },
		{
			request: () => {
				throw new Error("SESSION_MAINTAIN_DRAFT_TOO_LARGE");
			},
		},
	);
	const strict = new SessionRuntimeCoordinator(
		catalog,
		{ backend: "pi", list: () => [] },
		async () => ({ accepted: false, delivery: "rejected", error: "unused", sessionId: "unused", requestId: "unused" }),
		undefined,
		undefined,
		() => createWriter(draftTooLarge),
	);
	const tooLarge = await strict.prepareCatalogResend(sessionId, "_viewer-history-u2", "u2");
	assert.equal(tooLarge.ok, false);
	assert.equal(tooLarge.error.code, "SESSION_DRAFT_TOO_LARGE");
	assert.equal(tooLarge.error.debugDetails, CODES.draftTooLarge);

	// 本机会话在同一条协调器上仍走本机分支（假 host 一条命令都不发）。
	const commandsBefore = host.commands.length;
	const requestsBefore = host.requests.length;
	const draft = await catalog.createDraft({ projectId: "project-local", title: "本机会话", environment: "native" });
	await catalog.update(draft.id, { filePath: join(directory, "local.jsonl") });
	const localResult = await coordinator.editCatalogMessage(draft.id, "live-4", "local edit", "entry-x");
	assert.equal(localResult.ok, false, "替身 agents 没有本机写面能力：失败恰好证明它走的是本机分支");
	assert.equal(host.commands.length, commandsBefore);
	assert.equal(host.requests.length, requestsBefore);
});

/**
 * 停止时留存的身份摘要只用于「同一条消息」的锚点：entryId 进候选，正文与指纹都不下发（冻结契约里
 * 没有这两个字段，main 也不在这里重算活动分支）。
 */
test("a stopped identity contributes its entryId as a candidate and nothing else", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-live-stop-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalog = new SessionCatalog(join(directory, "catalog.json"));
	await catalog.load();
	const registration = await catalog.ensureRemoteSession({ projectId: "remote", hostId: HOST, remoteSessionId: REMOTE_ID, remotePath: TARGET_PATH, title: "live", updatedAt: 1 });
	const sessionId = registration.record.id;
	const host = fakeHost({ [TARGET_PATH]: fixtureDocument() });
	const writer = createWriter(host);
	const messages = [{ id: "live-random-id", role: "user", text: "hello world", timestamp: 1_700_000_010_000, meta: { entryId: "u1", persistedTimestamp: 1_700_000_000_000 } }];
	const tabs = [{ id: "agent-live", projectId: "remote", status: "idle", sessionPath: TARGET_PATH, createdAt: 1 }];
	const retained = [];
	const gateway = {
		backend: "pi",
		list: () => tabs,
		getMessages: () => {
			assert.equal(tabs.length, 1, "identity must be captured before stop, not after runtime caches are destroyed");
			return messages;
		},
		stop: async () => {
			tabs.length = 0;
			messages.length = 0;
		},
	};
	const coordinator = new SessionRuntimeCoordinator(
		catalog,
		gateway,
		async () => undefined,
		undefined,
		undefined,
		() => ({
			mutate: async (input) => {
				retained.push(input.stoppedIdentity);
				return writer.mutate(input);
			},
		}),
	);
	coordinator.bindExistingAgent(sessionId, "agent-live");
	const stopped = await coordinator.stopRuntime(coordinator.getTarget(sessionId));
	assert.equal(stopped.ok, true);
	const deleted = await coordinator.deleteCatalogMessage(sessionId, "live-random-id");
	assert.equal(deleted.ok, true);
	assert.equal(retained[0].role, "user");
	assert.equal("text" in retained[0], false, "only the fingerprint may outlive the runtime, not the message body");
	// live id 在文件里不存在：留存的 entryId 是唯一能把「停止前那条消息」翻译成文件身份的东西。
	assert.deepEqual(host.requests[0].params.candidateIds, ["u1", "live-random-id"]);
	assert.equal(JSON.stringify(host.requests[0].params).includes("fingerprint"), false);
});
