/**
 * PiDeck 特有文件在 $DSH_HOME 下的统一落点（.pideck）：
 * - 路径纯函数（归档/用量配置/宿主锁都在 .pideck 子目录内）；
 * - 旧位置（.pideck-archive / usage-probes.json / .pideck-host.lock）一次性迁移，幂等。
 * DSH 官方约定文件（storages/、.credentials.yaml 等）不允许进 .pideck。
 *
 * 注：迁移是**一次性**逻辑（旧布局仅开发/试用环境存在）；确认无残留后随下一版
 * 删除「迁移」相关用例与 migrateLegacyPideckDshFiles（路径用例保留）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PIDECK_DSH_DIR, pideckDshHome, pideckHostLockPath, pideckArchivePath, pideckUsageProbesPath, pideckUsageProbesDir, migrateLegacyPideckDshFiles } = loadTsCommonJs("src/main/dsh/pideckDshHome.ts");

function withHome(fn) {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-home-"));
	try {
		fn(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("全部 PiDeck 特有路径都落在 $DSH_HOME/.pideck 内", () => {
	const home = "/home/user/.dsh";
	assert.equal(PIDECK_DSH_DIR, ".pideck");
	assert.ok(pideckDshHome(home).endsWith(join(".dsh", ".pideck")));
	assert.ok(pideckHostLockPath(home).endsWith(join(".pideck", "host.lock")));
	assert.ok(pideckArchivePath(home).endsWith(join(".pideck", "archive")));
	assert.ok(pideckUsageProbesPath(home).endsWith(join(".pideck", "usage-probes.json")));
	assert.equal(pideckUsageProbesDir(home), pideckDshHome(home));
});

test("迁移：旧位置文件搬进 .pideck（归档/用量配置/宿主锁），幂等", () => {
	withHome((home) => {
		// 旧布局
		mkdirSync(join(home, ".pideck-archive", "s1"), { recursive: true });
		writeFileSync(join(home, "usage-probes.json"), "{}", "utf8");
		writeFileSync(join(home, ".pideck-host.lock"), "12345", "utf8");

		migrateLegacyPideckDshFiles(home);
		assert.ok(existsSync(join(home, ".pideck", "archive", "s1")));
		assert.equal(readFileSync(join(home, ".pideck", "usage-probes.json"), "utf8"), "{}");
		assert.equal(readFileSync(join(home, ".pideck", "host.lock"), "utf8"), "12345");
		// 旧位置已清空
		assert.ok(!existsSync(join(home, ".pideck-archive")));
		assert.ok(!existsSync(join(home, "usage-probes.json")));
		assert.ok(!existsSync(join(home, ".pideck-host.lock")));

		// 再次执行：源不存在 → 无操作，不回滚也不报错（幂等）。
		writeFileSync(join(home, ".pideck", "usage-probes.json"), '{"v":2}', "utf8");
		migrateLegacyPideckDshFiles(home);
		assert.equal(readFileSync(join(home, ".pideck", "usage-probes.json"), "utf8"), '{"v":2}');
	});
});

test("迁移：目标已存在时不覆盖（保留新数据）", () => {
	withHome((home) => {
		mkdirSync(join(home, ".pideck", "archive"), { recursive: true });
		writeFileSync(join(home, ".pideck", "archive", "keep.txt"), "new", "utf8");
		mkdirSync(join(home, ".pideck-archive", "old.txt"), { recursive: true });
		migrateLegacyPideckDshFiles(home);
		assert.ok(existsSync(join(home, ".pideck", "archive", "keep.txt")));
		assert.ok(existsSync(join(home, ".pideck-archive", "old.txt")), "旧归档保留不覆盖");
	});
});

test("迁移：空 DSH_HOME 无操作（不创建 .pideck）", () => {
	withHome((home) => {
		migrateLegacyPideckDshFiles(home);
		assert.ok(!existsSync(join(home, ".pideck")));
	});
});
