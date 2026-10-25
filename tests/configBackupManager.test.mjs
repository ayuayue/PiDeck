/**
 * ConfigBackupManager 单测：备份创建/列表/保留策略/脱敏/恢复保护/删除/启动检测。
 * 手动模式：仅 first-run 自动；manual 与 first-run 永不自动删除；pre-restore 超量修剪。
 * 用真实临时目录驱动（依赖注入 getConfigDir/getUserDataDir/getAppVersion），不依赖 electron。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// 用统一 TS 沙箱加载：相对 import 按源文件目录解析（生产模块新增本地依赖不再炸沙箱）
const load = createTsSandbox();

function loadModule() {
	return load("src/main/config/ConfigBackupManager.ts");
}

const mod = loadModule();
const { ConfigBackupManager, redactSecrets, MAX_BACKUPS } = mod;

/** 构造一个指向真实临时目录的 manager，并铺好 pi 配置 + pideck 设置。 */
function setup(opts = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-backup-test-"));
	const userData = join(root, "userData");
	const configDir = join(root, "pi");
	mkdirSync(userData, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "models.json"), JSON.stringify({ providers: { alpha: { apiKey: "sk-test-123456789", model: "gpt-4" } } }, null, 2));
	writeFileSync(join(configDir, "auth.json"), JSON.stringify({ alpha: { type: "bearer", key: "sk-auth-abcdefgh" } }, null, 2));
	writeFileSync(join(configDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
	writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2));
	writeFileSync(join(userData, "settings.json"), JSON.stringify({ theme: "light" }, null, 2));
	const manager = new ConfigBackupManager({
		getConfigDir: () => configDir,
		getUserDataDir: () => userData,
		getAppVersion: () => "1.0.0",
		...opts,
	});
	return { manager, userData, configDir, root };
}

function cleanup(ctx) {
	rmSync(ctx.root, { recursive: true, force: true });
}

test("create 生成备份文件并记录元数据（files 含 pi/* 与 pideck/* 命名空间）", () => {
	const ctx = setup();
	try {
		const result = ctx.manager.create("manual");
		assert.equal(result.ok, true);
		assert.ok(result.id.endsWith(".json"));

		const listed = ctx.manager.list();
		assert.equal(listed.ok, true);
		assert.equal(listed.backups.length, 1);
		const meta = listed.backups[0];
		assert.equal(meta.appVersion, "1.0.0");
		assert.equal(meta.reason, "manual");
		assert.deepEqual([...meta.files].sort(), ["pi/auth.json", "pi/mcp.json", "pi/models.json", "pi/settings.json", "pideck/settings.json"]);
		assert.ok(meta.size > 0);
		assert.ok(meta.configDir.includes("pi"));
	} finally {
		cleanup(ctx);
	}
});

test("保留策略：自动备份（pre-restore/on-save/upgrade）超 MAX_BACKUPS 删最旧，first-run/manual 永不自动删除", () => {
	const ctx = setup();
	try {
		const firstRun = ctx.manager.create("first-run").id;
		const manual = ctx.manager.create("manual").id;
		const created = [];
		for (let i = 0; i < MAX_BACKUPS + 5; i++) {
			created.push(ctx.manager.create("pre-restore").id);
		}
		const listed = ctx.manager.list();
		// 自动备份只留最近 MAX_BACKUPS 份
		const auto = listed.backups.filter((b) => b.reason === "pre-restore");
		assert.equal(auto.length, MAX_BACKUPS);
		// 最旧的 5 份自动备份被删除（created 数组前 5 个）
		for (const id of created.slice(0, 5)) {
			assert.ok(!readdirSync(join(ctx.userData, "config-backups")).includes(id), `should prune ${id}`);
		}
		// first-run 与 manual 始终保留
		const reasons = listed.backups.map((b) => b.reason);
		assert.ok(reasons.includes("first-run"), `reasons=${reasons.join(",")}`);
		assert.ok(reasons.includes("manual"), `reasons=${reasons.join(",")}`);
		assert.ok(readdirSync(join(ctx.userData, "config-backups")).includes(firstRun));
		assert.ok(readdirSync(join(ctx.userData, "config-backups")).includes(manual));
	} finally {
		cleanup(ctx);
	}
});

/**
 * 回归：同一毫秒内创建的自动备份必须能正确定序，prune 不得删错。
 * 背景：createdAt 只有毫秒精度，列出时以它为唯一排序键且对相等元素返回 -1，
 * 破坏排序严格弱序（V8 TimSort 下结果不确定），慢机器（CI）上多份备份落进
 * 同一毫秒就会把较早的备份当成较新保留，导致断言失败 / 误删最旧备份
 * （main CI 2026-09-19 实际发生）。
 * 构造方式：直接按「同毫秒时间戳 + 递增序号」写盘（create 的同毫秒去重回退路径），
 * 不依赖真实时钟快慢，因此在快机器上也能稳定复现旧实现的缺陷。
 */
test("同毫秒创建的自动备份按序号定序，prune 删的是最旧的（时序回归）", () => {
	const ctx = setup();
	try {
		const dir = join(ctx.userData, "config-backups");
		mkdirSync(dir, { recursive: true });
		const stamp = "20260919151449957";
		const createdAt = "2026-09-19T15:14:49.957Z";
		const makeId = (i) => (i === 0 ? `backup-${stamp}.json` : `backup-${stamp}-${i}.json`);
		// 写 MAX_BACKUPS+5 份 pre-restore（全部同毫秒，序号 0..MAX_BACKUPS+4）
		const ids = [];
		for (let i = 0; i < MAX_BACKUPS + 5; i++) {
			const id = makeId(i);
			ids.push(id);
			writeFileSync(join(dir, id), JSON.stringify({ version: 1, createdAt, appVersion: "1.0.0", reason: "pre-restore", configDir: ctx.configDir, files: { "pi/models.json": "{}" } }), "utf8");
		}
		// first-run / manual 用独立（更早的）时间戳，避免覆盖同批次文件而混淆断言。
		// 两者永不自动删除，是保留策略的对照组。
		const protectedIds = ["backup-20260101000000000.json", "backup-20260101000000001.json"];
		writeFileSync(join(dir, protectedIds[0]), JSON.stringify({ version: 1, createdAt: "2026-01-01T00:00:00.000Z", appVersion: "1.0.0", reason: "first-run", configDir: ctx.configDir, files: { "pi/models.json": "{}" } }), "utf8");
		writeFileSync(join(dir, protectedIds[1]), JSON.stringify({ version: 1, createdAt: "2026-01-01T00:00:00.001Z", appVersion: "1.0.0", reason: "manual", configDir: ctx.configDir, files: { "pi/models.json": "{}" } }), "utf8");
		// 触发 prune：新创建一份备份即可（create 内部会跑保留策略）
		const result = ctx.manager.create("pre-restore");
		assert.equal(result.ok, true);

		const listed = ctx.manager.list();
		assert.equal(listed.ok, true);
		// 定序确定：同时间戳按序号降序（列表是「新→旧」）。
		// 只看手工造的同一批次（新 create 的备份时间戳不同，会排在前面干扰断言）。
		const autoIds = listed.backups.filter((b) => b.reason === "pre-restore" && b.id.includes(stamp)).map((b) => b.id);
		assert.ok(autoIds.length > 1, `同批次备份应有多份（实际 ${autoIds.length}）`);
		const seqOf = (id) => {
			const m = /^backup-(\d+)(?:-(\d+))?\.json$/.exec(id);
			return m && m[2] !== undefined ? Number(m[2]) : 0;
		};
		for (let i = 1; i < autoIds.length; i++) {
			assert.ok(seqOf(autoIds[i - 1]) > seqOf(autoIds[i]), `自动备份必须按序号降序（新→旧）：${autoIds.join(", ")}`);
		}
		// prune 删掉的是序号最小的（最旧）那批：同批次 MAX_BACKUPS+5 份 + 刚 create 的 1 份，
		// 自动备份共 MAX_BACKUPS+6 份，保留最近 MAX_BACKUPS 份 → 从序号 MAX_BACKUPS+1 起保留。
		// 边界：序号 ≤ MAX_BACKUPS 的都被修剪（比保守预期多删一份，因为 create 又添了一份）。
		const remaining = readdirSync(dir);
		for (const id of ids.slice(0, MAX_BACKUPS + 1)) {
			assert.ok(!remaining.includes(id), `应删除最旧的 ${id}（实际保留：${remaining.sort().join(", ")}）`);
		}
		for (const id of ids.slice(MAX_BACKUPS + 1)) {
			assert.ok(remaining.includes(id), `应保留较新的 ${id}（实际保留：${remaining.sort().join(", ")}）`);
		}
		// first-run / manual 与保留策略无关，必须仍在
		for (const id of protectedIds) {
			assert.ok(remaining.includes(id), `first-run/manual 不得被自动删除：${id}`);
		}
	} finally {
		cleanup(ctx);
	}
});

test("read 详情脱敏：auth key / models apiKey 替换为 ***，结构保留", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		const detail = ctx.manager.read(id);
		assert.ok(detail);
		const authFile = detail.files.find((f) => f.name === "pi/auth.json");
		const modelsFile = detail.files.find((f) => f.name === "pi/models.json");
		assert.equal(authFile.redacted, true);
		assert.equal(modelsFile.redacted, true);
		assert.ok(!authFile.raw.includes("sk-auth-abcdefgh"));
		assert.ok(authFile.raw.includes('"key": "***"'));
		assert.ok(!modelsFile.raw.includes("sk-test-123456789"));
		assert.ok(modelsFile.raw.includes('"apiKey": "***"'));
		// 非敏感文件不脱敏
		const settingsFile = detail.files.find((f) => f.name === "pi/settings.json");
		assert.equal(settingsFile.redacted, false);
	} finally {
		cleanup(ctx);
	}
});

test("restore：恢复前自动建 pre-restore 保护备份，并把内容写回对应位置", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		// 改坏当前配置，验证恢复能写回
		writeFileSync(join(ctx.configDir, "models.json"), "{}");
		const result = ctx.manager.restore(id);
		assert.equal(result.ok, true);

		// 保护备份已生成
		const listed = ctx.manager.list();
		const reasons = listed.backups.map((b) => b.reason);
		assert.ok(reasons.includes("pre-restore"), `reasons=${reasons.join(",")}`);
		// 恢复后 models.json 回到备份内容
		const restored = JSON.parse(readFileSync(join(ctx.configDir, "models.json"), "utf8"));
		assert.equal(restored.providers.alpha.apiKey, "sk-test-123456789");
		// pideck 设置写回 userData
		const pideck = JSON.parse(readFileSync(join(ctx.userData, "settings.json"), "utf8"));
		assert.equal(pideck.theme, "light");
	} finally {
		cleanup(ctx);
	}
});

test("restore 保护备份失败时拒绝恢复（不留无退路状态）", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		// 让 collectFiles 收集不到任何文件（pi 目录 + pideck 设置都移除）→
		// pre-restore 保护备份必然失败，恢复必须被拒绝。
		rmSync(ctx.configDir, { recursive: true, force: true });
		rmSync(join(ctx.userData, "settings.json"), { force: true });
		const result = ctx.manager.restore(id);
		assert.equal(result.ok, false);
		assert.match(result.error, /pre-restore backup failed/);
	} finally {
		cleanup(ctx);
	}
});

test("restore 单文件：只恢复指定的 key，其它文件保持当前值", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		// 改坏两个文件，然后只恢复 models.json。
		writeFileSync(join(ctx.configDir, "models.json"), "{}");
		writeFileSync(join(ctx.configDir, "auth.json"), '{ "alpha": { "type": "bearer", "key": "changed-123456" } }');

		const result = ctx.manager.restore(id, ["pi/models.json"]);
		assert.equal(result.ok, true);
		// models.json 已恢复；auth.json 保持改后的值（未被恢复）。
		const models = JSON.parse(readFileSync(join(ctx.configDir, "models.json"), "utf8"));
		assert.equal(models.providers.alpha.apiKey, "sk-test-123456789");
		const auth = JSON.parse(readFileSync(join(ctx.configDir, "auth.json"), "utf8"));
		assert.equal(auth.alpha.key, "changed-123456");
	} finally {
		cleanup(ctx);
	}
});

test("restore 非法 files 白名单：全非法 → 拒绝恢复", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		const result = ctx.manager.restore(id, ["pi/../evil.json", "unknown.txt"]);
		assert.equal(result.ok, false);
		assert.equal(result.error, "no valid files to restore");
	} finally {
		cleanup(ctx);
	}
});

test("restore 只写回白名单 key：未知/路径穿越 key 一律跳过", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		// 篡改备份包：注入路径穿越与未知 key，模拟恶意/损坏备份。
		const filePath = join(ctx.userData, "config-backups", id);
		const pkg = JSON.parse(readFileSync(filePath, "utf8"));
		pkg.files["pi/../evil.json"] = '{"hacked":true}';
		pkg.files["unknown/file.txt"] = "x";
		writeFileSync(filePath, JSON.stringify(pkg));

		const result = ctx.manager.restore(id);
		assert.equal(result.ok, true);
		// 恶意 key 未写盘（userData 与 pi 目录外都不应出现 evil.json）。
		assert.equal(existsSync(join(ctx.userData, "evil.json")), false);
		assert.equal(existsSync(join(ctx.root, "evil.json")), false);
	} finally {
		cleanup(ctx);
	}
});

test("delete / deleteAll 删除备份文件", () => {
	const ctx = setup();
	try {
		const { id } = ctx.manager.create("manual");
		assert.equal(ctx.manager.delete(id).ok, true);
		assert.equal(ctx.manager.list().backups.length, 0);

		ctx.manager.create("manual");
		ctx.manager.create("manual");
		assert.equal(ctx.manager.deleteAll().ok, true);
		assert.equal(ctx.manager.list().backups.length, 0);
	} finally {
		cleanup(ctx);
	}
});

test("deleteMany 批量删除：逐项删除，非法 id 跳过且不阻断其余", () => {
	const ctx = setup();
	try {
		const a = ctx.manager.create("manual");
		const b = ctx.manager.create("manual");
		const c = ctx.manager.create("manual");

		// 混合合法 + 非法 + 不存在的 id：合法的删掉，非法/不存在跳过，仍返回 ok。
		const result = ctx.manager.deleteMany([a.id, b.id, "../evil.json", "backup-9999999999999.json"]);
		assert.equal(result.ok, true);
		assert.equal(result.deleted, 2);
		const { backups } = ctx.manager.list();
		assert.equal(backups.length, 1);
		assert.equal(backups[0].id, c.id);
	} finally {
		cleanup(ctx);
	}
});

test("deleteMany 全部非法：一个都没删 → 返回失败", () => {
	const ctx = setup();
	try {
		ctx.manager.create("manual");
		// 全传非法 id → 一个都没删 → 失败。
		const result = ctx.manager.deleteMany(["../evil.json", "foo.txt"]);
		assert.equal(result.ok, false);
		assert.equal(ctx.manager.list().backups.length, 1);
	} finally {
		cleanup(ctx);
	}
});

test("ensureInitialBackups：无备份 → first-run；已有备份 → 不新增（手动模式）", () => {
	const ctx = setup();
	try {
		// 无备份：首次使用
		const first = ctx.manager.ensureInitialBackups();
		assert.equal(first.ok, true);
		const listed = ctx.manager.list();
		assert.equal(listed.backups.length, 1);
		assert.equal(listed.backups[0].reason, "first-run");

		// 已有备份：不再自动创建（同版本不新增；版本差异场景见下一条测试）
		const same = ctx.manager.ensureInitialBackups();
		assert.equal(same.ok, true);
		assert.equal(ctx.manager.list().backups.length, 1);
	} finally {
		cleanup(ctx);
	}
});

test("路径安全：非法 id（路径穿越/非备份命名）一律拒绝", () => {
	const ctx = setup();
	try {
		for (const bad of ["../evil.json", "backup-1.json/../x", "other.json", "backup-x.json", ""]) {
			assert.equal(ctx.manager.delete(bad).ok, false, `delete(${bad})`);
			assert.equal(ctx.manager.restore(bad).ok, false, `restore(${bad})`);
			assert.equal(ctx.manager.read(bad), null, `read(${bad})`);
		}
	} finally {
		cleanup(ctx);
	}
});

test("ensureInitialBackups 手动模式补充：升级版本后已有备份目录不再补 backup", () => {
	// 与主测试互补：这里独立验证“版本变化也不新增”的场景（setup 版本固定为 1.0.0）。
	// 通过伪造第二个 manager 指向同一临时目录 + 不同版本号驱动。
	const ctx = setup();
	try {
		assert.equal(ctx.manager.ensureInitialBackups().ok, true);
		assert.equal(ctx.manager.list().backups.length, 1);

		const upgraded = new ConfigBackupManager({
			getConfigDir: () => ctx.configDir,
			getUserDataDir: () => ctx.userData,
			getAppVersion: () => "2.0.0",
		});
		assert.equal(upgraded.ensureInitialBackups().ok, true);
		assert.equal(upgraded.list().backups.length, 1);
	} finally {
		cleanup(ctx);
	}
});

test("redactSecrets：非 JSON 原样返回；短值不误伤", () => {
	// 非 JSON 文本原样
	const nonJson = redactSecrets("not-json", "pi/models.json");
	assert.equal(nonJson.text, "not-json");
	assert.equal(nonJson.redacted, false);
	// 短 key 值不替换（避免误伤 "key": "models" 类标识符）
	const shortKey = redactSecrets(JSON.stringify({ key: "abc" }), "pi/auth.json");
	assert.equal(shortKey.redacted, false);
	// 嵌套数组里的 secret 也脱敏
	const nested = redactSecrets(JSON.stringify({ providers: { a: { list: [{ apiKey: "sk-long-enough-123" }] } } }), "pi/models.json");
	assert.equal(nested.redacted, true);
	assert.ok(!nested.text.includes("sk-long-enough-123"));
});
