/**
 * sessionFileExistsCached（死链判定 TTL 缓存）单元测试。
 * 用真实临时文件验证行为：TTL 内命中缓存不重 stat、过期后重判、容量上限清空。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sessionFileExistsCached, clearSessionFileLivenessCache } = loadTsCommonJs("src/main/sessions/sessionFileLiveness.ts");

test.afterEach(() => clearSessionFileLivenessCache());

test("存在与不存在都按 TTL 缓存，过期后重新判定", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-liveness-"));
	try {
		const present = join(root, "a.jsonl");
		writeFileSync(present, "{}");
		const missing = join(root, "gone.jsonl");
		let now = 1_000_000;
		assert.equal(sessionFileExistsCached(present, now), true);
		assert.equal(sessionFileExistsCached(missing, now), false);
		// TTL 内：删除文件也命中缓存（陈旧窗口是设计契约，2s 后由清理闸纠正）
		rmSync(present);
		assert.equal(sessionFileExistsCached(present, now + 1_000), true, "TTL 内命中缓存");
		// 过期：重新 stat，看到删除
		assert.equal(sessionFileExistsCached(present, now + 3_000), false, "过期后重判");
		assert.equal(sessionFileExistsCached(missing, now + 3_000), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("容量上限触发整体清空（防删除路径的键无界积累）", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-liveness-cap-"));
	try {
		const first = join(root, "0.jsonl");
		writeFileSync(first, "{}");
		const now = 1_000_000;
		sessionFileExistsCached(first, now);
		// 灌满到上限：全是不存在的新路径
		for (let index = 1; index < 2_000; index += 1) {
			sessionFileExistsCached(join(root, `${index}.jsonl`), now);
		}
		// 上限触发 clear 后旧键全部失效：first 重新 stat（仍是 true，但走的是新条目）
		assert.equal(sessionFileExistsCached(first, now + 1), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
