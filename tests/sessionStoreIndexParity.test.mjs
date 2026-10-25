import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// Wave 2 parity 门禁：session-store sidecar（Go）产出的条目表必须与 TS 的 parseIndexLine
// 语义一致。基准 tests/fixtures/sessionStoreIndexParity.golden.json 是**真实 Go 二进制**的输出
// （scripts/genSessionStoreIndexGolden.mjs 生成），因此这里用「同一份文件、两个读者」的行为对照：
//   native reader  = 今天上线的 TS 逐行解析路径（权威语义）
//   sidecar reader = 注入 sidecar 表的路径（走 validator + 新分支）
// 两侧对同一批公开 API 的输出必须逐字段相等；golden 与 TS 语义脱节时本测试会红
// （改语义就要重跑生成脚本，Go 侧 native/session-store/parity_test.go 用同一个基准守着自己）。
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

const FIXTURE = join(process.cwd(), "tests", "fixtures", "sessionStoreIndexParity.jsonl");
const GOLDEN_PATH = join(process.cwd(), "tests", "fixtures", "sessionStoreIndexParity.golden.json");
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
const SESSION_PATH = "/root/.pi/agent/sessions/parity/session.jsonl";

function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item) => item?.type === "text")
		.map((item) => item.text ?? "")
		.join("");
}

function createReader(readIndexTable) {
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => (sessionPath === SESSION_PATH ? FIXTURE : join(dirname(FIXTURE), "missing-ancestor.jsonl")),
		convertMessages: (_agentId, rawMessages, entryIds = []) =>
			rawMessages.map((message, index) => ({
				id: entryIds[index] ?? `message-${index}`,
				role: message.role,
				text: textFromContent(message.content),
			})),
		trimMessages: (messages) => messages,
		translate: () => "Summary unavailable.",
		...(readIndexTable ? { readIndexTable } : {}),
	});
}

/** 两个读者对同一批读取 API 的输出必须逐字段相等（行为等价，而不是内部结构相等）。 */
async function assertReadersAgree(createSidecarReader) {
	const nativeReader = createReader();
	const sidecarReader = createSidecarReader();
	const snapshot = async (reader) => ({
		window: await reader.readLoadWindow(SESSION_PATH, "_viewer", 3),
		page: await reader.readSessionDisplayTurnPage(SESSION_PATH, "_viewer", undefined, 2),
		branch: await reader.readBranchTree(SESSION_PATH),
		metadata: await reader.readSessionMetadata(SESSION_PATH),
		recent: await reader.readRecentMessages(SESSION_PATH, 4),
		display: await reader.readSessionDisplayMessages(SESSION_PATH),
	});
	const expected = await snapshot(nativeReader);
	const actual = await snapshot(sidecarReader);
	// deepEqual（非 strict）：对象来自 vm realm，原型不同会误报。
	assert.deepEqual(actual, expected);
	return expected;
}

test("sidecar 条目表与 TS 解析输出逐字段一致（含窗口/翻页/分支树/元数据）", async () => {
	const calls = [];
	const expected = await assertReadersAgree(() =>
		createReader(async (hostPath, version) => {
			calls.push({ hostPath, version });
			return GOLDEN;
		}),
	);
	// sidecar 路径确实被走到，且拿到的是真实 stat 版本（缓存键的语义来源）
	assert.equal(calls.length > 0, true);
	assert.equal(calls[0].hostPath, FIXTURE);
	assert.equal(calls[0].version.size, statSync(FIXTURE).size);
	assert.equal(Number.isFinite(calls[0].version.mtimeMs), true);
	// 基准确实覆盖了关键条目类型（防止 fixture 被改瘦后测试变成空转）
	assert.equal(GOLDEN.entries.length >= 18, true);
	assert.equal(
		GOLDEN.entries.some((entry) => entry.type === "compaction"),
		true,
	);
	assert.equal(
		GOLDEN.entries.some((entry) => entry.oversized === true),
		false,
	);
	assert.equal(expected.window.messages.length > 0, true);
});

test("末尾无完整行时忽略 sidecar 表（残行口径与 TS 逐行流不同）", async () => {
	// 把基准里最后一条消息删掉再加个「无换行」标记：如果被采用，行为就会缺最后一条。
	const truncated = {
		...GOLDEN,
		endsWithNewline: false,
		entries: GOLDEN.entries.filter((entry) => entry.id !== "m17"),
		lastEntryId: "m16",
	};
	const expected = await assertReadersAgree(() => createReader(async () => truncated));
	const ids = expected.display.map((message) => message.id);
	assert.equal(ids.includes("m17"), true);
});

test("形状不符的 sidecar 行被整体弃用，回退 TS 解析", async () => {
	const corrupted = {
		...GOLDEN,
		entries: GOLDEN.entries.map((entry) => (entry.id === "m2" ? { ...entry, parentId: 42 } : entry)),
	};
	const expected = await assertReadersAgree(() => createReader(async () => corrupted));
	assert.equal(expected.window.messages.length > 0, true);
});

test("sidecar 抛错/返回 null 时不影响读取", async () => {
	const expected = await assertReadersAgree(() =>
		createReader(async () => {
			throw new Error("sidecar unavailable");
		}),
	);
	assert.equal(expected.metadata.model.modelId, "gpt-5.2");
	assert.equal(expected.metadata.thinkingLevel, "high");
});

test("用户消息 preview 与 Go 条目表逐条一致（导轨标题不靠回读）", async () => {
	const { indexPreviewOf } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
	const lines = readFileSync(FIXTURE, "utf8")
		.split("\n")
		.filter((line) => line.trim());
	const byId = new Map();
	for (const line of lines) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			// fixture 里故意保留了损坏行（坏行不产条目），与索引侧同语义跳过。
			continue;
		}
		if (!parsed || typeof parsed.id !== "string") continue;
		// 与两侧同序解析消息来源：parsed.message → data.message →（旧格式）整行自带 role。
		const nested = parsed.message && typeof parsed.message === "object" ? parsed.message : undefined;
		const dataMessage = parsed.data && typeof parsed.data === "object" && parsed.data.message && typeof parsed.data.message === "object" ? parsed.data.message : undefined;
		const message = nested ?? dataMessage ?? (typeof parsed.role === "string" ? parsed : undefined);
		byId.set(parsed.id, message?.role === "user" ? indexPreviewOf(message) : undefined);
	}
	let compared = 0;
	for (const entry of GOLDEN.entries) {
		assert.equal(entry.preview ?? undefined, byId.get(entry.id), `条目 ${entry.id} 的 preview 与 TS 解析不一致`);
		if (entry.preview) compared += 1;
	}
	// 防止 fixture 被改瘦后测试变空转：至少要有用户消息预览被比对。
	assert.equal(compared > 0, true);
});
