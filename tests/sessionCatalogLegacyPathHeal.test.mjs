/**
 * 存量脏数据自愈（2026-10-08 fork/copy 现场）。
 *
 * 现场：旧版 `toAbsoluteSessionPath` 把 native 无条件当 Windows——Linux 上
 * `.pi/sessions/x.jsonl` 被拼成 `\home\zhadainian\PiDeck\.pi\sessions\x.jsonl`
 * 并落进 catalog。后果链：
 *   1. fork/copy 的 rename / 历史读取对该路径全部 ENOENT（标题后缀写不进、历史读不出）；
 *   2. mergeScanned 的外部删除清理把 mangled 路径当「磁盘可达而文件不在」误删
 *      （`\home\…` 在 POSIX 上 dirname 后逐级 `.` 一定存在）；
 *   3. 条目被扫描按绝对路径重新注册，标题所有权重置为弱兜底。
 *
 * 契约：
 *   a. load() 的 repairRelativeFilePaths 必须用修复后的解析器把 mangled POSIX 路径
 *      归一回真实绝对路径（自愈存量），并重算 originKey；
 *   b. 归一后同一文件与扫描绝对路径折叠为同一条目（不再双记录）；
 *   c. 共享解析器单测：mangled 形态自愈、Windows 形态保持字节契约。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

/** 加载生产 SessionCatalog（resolver 由用例注入）。 */
function loadCatalog() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": nodeRequire("node:fs/promises"),
			"node:fs": { existsSync: () => true },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

const identity = loadTsCommonJs("src/shared/sessionIdentity.ts");
const { toAbsoluteSessionPath, canonicalizeSessionPath } = identity;

test("shared resolver heals a legacy mangled POSIX session path", () => {
	const projectPath = "/home/dev/PiDeck";
	const mangled = "\\home\\dev\\PiDeck\\.pi\\sessions\\2026-10-07T23-35-20-802Z_abc.jsonl";
	const healed = toAbsoluteSessionPath(mangled, projectPath, "native");
	assert.equal(healed, "/home/dev/PiDeck/.pi/sessions/2026-10-07T23-35-20-802Z_abc.jsonl");
	// 自愈结果与扫描器发现的绝对路径同 identity（折叠为一条记录的前提）。
	assert.equal(canonicalizeSessionPath(healed, "native"), canonicalizeSessionPath("/home/dev/PiDeck/.pi/sessions/2026-10-07T23-35-20-802Z_abc.jsonl", "native"));
	// 正确解析的相对路径不再产生反斜杠产物。
	assert.equal(toAbsoluteSessionPath(".pi/sessions/x.jsonl", projectPath, "native"), `${projectPath}/.pi/sessions/x.jsonl`);
});

test("shared resolver keeps the Windows byte contract on drive-letter bases", () => {
	assert.equal(
		toAbsoluteSessionPath(".pi\\sessions\\x.jsonl", "D:\\Project\\PiDeck", "native"),
		"D:\\Project\\PiDeck\\.pi\\sessions\\x.jsonl",
	);
	// Windows 形态折叠大小写；POSIX 形态保留（大小写敏感身份）。
	assert.equal(canonicalizeSessionPath("D:\\Project\\X.jsonl", "native"), "d:/project/x.jsonl");
	assert.equal(canonicalizeSessionPath("/home/dev/Proj/x.jsonl", "native"), "/home/dev/Proj/x.jsonl");
});

test("catalog load heals a persisted mangled path and folds the scanned absolute entry in", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-heal-mangled-"));
	try {
		const projectPath = dir;
		const sessionsDir = join(dir, ".pi", "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const realFile = join(sessionsDir, "2026-10-07T23-35-20-802Z_abc.jsonl");
		await writeFile(realFile, '{"type":"session","id":"s"}\n{"type":"message","message":{"role":"user","content":"hello"}}\n', "utf8");

		// 旧版缺陷产物：mangled 路径已落库（现场形态）。
		const mangled = "\\home\\dev\\PiDeck\\.pi\\sessions\\2026-10-07T23-35-20-802Z_abc.jsonl".replace("home\\dev\\PiDeck", dir.replace(/^\//, "").replace(/\//g, "\\"));
		const catalogPath = join(dir, "sessions.json");
		await writeFile(
			catalogPath,
			JSON.stringify({
				version: 1,
				sessions: [
					{
						id: "legacy-mangled",
						projectId: "project-1",
						title: "旧标题",
						source: "pi",
						environment: "native",
						filePath: mangled,
						status: "active",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
			"utf8",
		);

		// resolver 与生产注入一致（index.ts：toAbsoluteSessionPath）。
		const resolver = (_projectId, filePath, environment) => toAbsoluteSessionPath(filePath, projectPath, environment);
		const catalog = new SessionCatalog(catalogPath, {}, resolver);
		await catalog.load();

		// 存量条目已归一回真实绝对路径并落盘。
		const healedEntry = catalog.listEntries().find((entry) => entry.id === "legacy-mangled");
		assert.ok(healedEntry, "legacy entry must survive the heal");
		assert.equal(healedEntry.filePath, realFile, "mangled path must heal to the real absolute path");

		// 重启等价：落盘的 filePath 已是绝对路径。
		const onDisk = JSON.parse(await readFile(catalogPath, "utf8")).sessions.find((entry) => entry.id === "legacy-mangled");
		assert.equal(onDisk.filePath, realFile);

		// 扫描按绝对路径发现同一文件 → 折叠到同一条目（不再双记录）。
		const records = await catalog.mergeScanned("project-1", [
			{ id: realFile, filePath: realFile, name: undefined, preview: "", messageCount: 1, updatedAt: 2000, source: "pi", environment: "native" },
		]);
		assert.equal(records.filter((record) => record.filePath === realFile).length, 1, "same file must fold into one record");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
