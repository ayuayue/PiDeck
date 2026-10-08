import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 通知历史持久化（NoticeHistoryStore）行为断言。
 * 覆盖：落盘编解码（常驻 Infinity ↔ -1 哨兵）、封顶丢最旧、坏载荷拒收、
 * 清空删文件、占用统计、损坏文件从宽处理。
 */
function createStore(filePath, logs) {
	const { NoticeHistoryStore } = loadTsCommonJs("src/main/notices/NoticeHistoryStore.ts");
	return new NoticeHistoryStore({
		getFilePath: () => filePath,
		log: (level, message, detail) => logs.push({ level, message, detail }),
	});
}

/** 快速产生第 n 条记录的标题。 */
const title = (n) => `notice-${n}`;

let tempDir;
let filePath;

before(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "notice-history-store-"));
	filePath = join(tempDir, "notice-history.json");
});

after(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

it("append 后 flush 落盘：结构含 version，常驻时长编码为 -1，load 解码回 Infinity", async () => {
	const logs = [];
	const store = createStore(filePath, logs);

	store.append({ title: "普通提示", kind: "info", duration: 6000 });
	store.append({ title: "常驻提示", kind: "error", duration: Number.POSITIVE_INFINITY });
	await store.flush();

	const raw = JSON.parse(await readFile(filePath, "utf8"));
	assert.equal(raw.version, 1);
	assert.equal(raw.entries.length, 2);
	assert.equal(raw.entries[0].duration, 6000, "有限时长按毫秒原样落盘");
	assert.equal(raw.entries[1].duration, -1, "常驻时长必须编码为 -1（JSON 无 Infinity）");
	assert.ok(raw.entries[0].timestamp > 0, "落盘带时间戳");
	assert.equal(raw.entries[0].id, undefined, "渲染层自增 id 不落盘");

	const loaded = await store.load();
	assert.equal(loaded[1].duration, Number.POSITIVE_INFINITY, "load 应把 -1 解码回常驻");
	assert.equal(loaded[0].duration, 6000);
});

it("超出上限丢最旧：文件与 load 结果都只保留最新 200 条", async () => {
	const logs = [];
	const store = createStore(filePath, logs);

	for (let i = 0; i < 205; i += 1) store.append({ title: title(i), kind: "info", duration: 1000 });
	await store.flush();

	const loaded = await store.load();
	assert.equal(loaded.length, 200);
	assert.equal(loaded[0].title, title(5), "最旧的 5 条应被丢弃");
	assert.equal(loaded[loaded.length - 1].title, title(204));
});

it("坏载荷拒收并记日志：缺主文案、空标题、NaN 时长、非对象", async () => {
	const logs = [];
	const store = createStore(filePath, logs);
	const before = (await store.load()).length;

	store.append(null);
	store.append({ title: "   ", kind: "info", duration: 1000 });
	store.append({ title: "无时长", kind: "info" });
	store.append({ title: "NaN 时长", kind: "info", duration: Number.NaN });
	store.append("not-an-object");

	const loaded = await store.load();
	assert.equal(loaded.length, before, "坏载荷一条都不落盘");
	assert.ok(
		logs.some((entry) => entry.level === "error" && entry.message === "notice history record rejected"),
		"拒收应留痕",
	);
});

it("非法 kind 归一为 neutral，超长文案截断而非拒收", async () => {
	const logs = [];
	const store = createStore(filePath, logs);

	store.append({ title: "怪档位", kind: "mystery", duration: 1000 });
	store.append({ title: "长".repeat(3000), description: "描".repeat(9000), kind: "info", duration: 1000 });
	await store.flush();

	const loaded = await store.load();
	const byTitle = (t) => loaded.find((entry) => entry.title.startsWith(t));
	assert.equal(byTitle("怪档位").kind, "neutral");
	assert.equal(byTitle("长").title.length, 2000);
	assert.equal(byTitle("长").description.length, 8000);
});

it("clear 删除文件：getSize 归零、load 返回空", async () => {
	const logs = [];
	const store = createStore(filePath, logs);

	store.append({ title: "会被清掉", kind: "info", duration: 1000 });
	await store.flush();
	assert.ok((await store.getSize()) > 0);

	await store.clear();
	assert.equal(await store.getSize(), 0, "清理后文件占用为 0");
	assert.equal((await store.load()).length, 0, "清理后 load 返回空历史");
});

it("防抖窗口内的连发合并为一次写盘", async () => {
	const logs = [];
	const store = createStore(filePath, logs);

	store.append({ title: "第一条", kind: "info", duration: 1000 });
	store.append({ title: "第二条", kind: "info", duration: 1000 });
	store.append({ title: "第三条", kind: "info", duration: 1000 });
	await store.flush();

	const loaded = await store.load();
	const names = (await readdir(tempDir)).filter((name) => name.startsWith("notice-history"));
	assert.equal(names.length, 1, "只应有一个数据文件（无残留 tmp）");
	assert.equal(loaded.length, 3, "三条合并进同一次写盘");
});

it("损坏文件从宽处理：load 返回空并记错误日志，下次写入自然覆盖", async () => {
	const logs = [];
	await writeFile(filePath, "{not-json", "utf8");
	const store = createStore(filePath, logs);

	assert.equal((await store.load()).length, 0, "损坏文件按空历史处理（跨 realm 数组不用 deepEqual）");
	assert.ok(
		logs.some((entry) => entry.level === "error" && entry.message === "notice history file unreadable, starting empty"),
		"损坏应留痕",
	);

	store.append({ title: "重建", kind: "info", duration: 1000 });
	await store.flush();
	const loaded = await store.load();
	assert.equal(loaded.length, 1);
	assert.equal(loaded[0].title, "重建");
});

it("文件缺失时 getSize 与 load 都按空处理", async () => {
	const logs = [];
	const missingPath = join(tempDir, "notice-history-missing.json");
	const store = createStore(missingPath, logs);

	assert.equal(await store.getSize(), 0);
	assert.equal((await store.load()).length, 0, "文件缺失时 load 返回空历史");
});
