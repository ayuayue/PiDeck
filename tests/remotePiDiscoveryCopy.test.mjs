import { agentManagerSource } from "./helpers/agentManagerSources.mjs";
/**
 * 远端 pi 探测稳定码的 i18n 契约（P4.1 接线，2026-10）。
 *
 * 契约：REMOTE_PI_DISCOVERY_CODES 里的**每一个**码都要有用户可读、中英双语齐全的文案键，
 * 并且在远端准备失败的 catch 处真的被使用（否则用户只会看到一个裸码）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { remotePiDiscoveryCopyKey } = loadTsCommonJs("src/main/remote/remotePiDiscoveryCopy.ts");
// 码表本身在探测模块里导出（helper 只是消费它）。
const { REMOTE_PI_DISCOVERY_CODES } = loadTsCommonJs("src/main/remote/RemotePiDiscovery.ts");
const { mainProcessZhCN, mainProcessEnUS } = loadTsCommonJs("src/shared/i18n/mainProcessCopy.ts");

test("每个探测码都有可读文案键，且中英双语文案齐全非空", () => {
	assert.ok(REMOTE_PI_DISCOVERY_CODES.length >= 3, "码表至少包含 P4.1 的三个环境类码");
	for (const code of REMOTE_PI_DISCOVERY_CODES) {
		const message = `PiDeck remote pi discovery failed: ${code}`;
		const key = remotePiDiscoveryCopyKey(message);
		assert.equal(typeof key, "string", `${code} 必须有文案键`);
		const zh = mainProcessZhCN[key];
		const en = mainProcessEnUS[key];
		assert.equal(typeof zh, "string", `${key} 缺中文文案`);
		assert.equal(typeof en, "string", `${key} 缺英文文案`);
		assert.ok(zh.length >= 20 && en.length >= 20, `${key} 的文案要给出可执行的下一步，不能是占位短语`);
		// 不能退化成通用启动失败文案（那等于没接线）。
		assert.notEqual(zh, mainProcessZhCN["diagnostic.agentStartFailed"]);
		assert.notEqual(en, mainProcessEnUS["diagnostic.agentStartFailed"]);
	}
});

test("认不出码时返回 undefined（调用方回落通用文案，不误报）", () => {
	assert.equal(remotePiDiscoveryCopyKey("ssh: connect to host port 22: Connection refused"), undefined);
	assert.equal(remotePiDiscoveryCopyKey(""), undefined);
});

test("接线守卫：远端准备失败的 catch 真的用了这个映射", () => {
	const src = agentManagerSource;
	assert.match(src, /remotePiDiscoveryCopyKey\(rawMessage\)/);
	assert.match(src, /addLocalizedMessage\(\s*id,\s*"error",\s*discoveryKey \?\? "diagnostic\.agentStartFailed"/);
});
