import { mkdtempSync } from "./helpers/tempDir.mjs";
/**
 * SettingsStore 的远端项目 trust 段（P4.4b）。
 *
 * 这一段的语义要求全部在**真 SettingsStore**上验证（不是纯函数替身）：SettingsStore 依赖 electron /
 * 日志 / git 路径解析器，按仓库既有做法用 stub 顶掉（与 settingsStoreHiddenModules.test.mjs 同款）。
 *
 * 钉住：
 * - 旧 settings.json 缺这一段 ⇒ 空表（自然兼容，没有迁移脚本）；
 * - 读时清洗脏值（非数组 / 字段畸形 / key 与零件不自洽一律丢弃）；
 * - 写入只走 `replaceRemoteProjectTrust`，**重启后仍在**；
 * - 渲染层的通用 `settings:update` 通道**碰不到**这一段（否则等于绕过 trust 域用一条构造的记录替换整张表）。
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const DIGEST = "c".repeat(32);
const RECORD = {
	trustKey: `${HOST_ID}::${DIGEST}::/srv/app`,
	hostId: HOST_ID,
	canonicalRoot: "/srv/app",
	endpointDigest: DIGEST,
	decision: "approve",
	decidedAt: "2026-10-01T00:00:00.000Z",
};

function makeStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-remote-trust-user-"));
	const home = mkdtempSync(join(tmpdir(), "pideck-remote-trust-home-"));
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: {
				app: {
					getPath: (key) => (key === "userData" ? userData : key === "home" ? home : tmpdir()),
				},
				BrowserWindow: class {},
				Menu: { setApplicationMenu: () => undefined },
			},
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return { SettingsStore, userData };
}

/** 预置一份最小 settings.json（installationType / chatContentWidthPct 避免 load 尾部迁移钩子额外写盘）。 */
function seed(userData, extra) {
	writeFileSync(join(userData, "settings.json"), JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...extra }));
}

const persisted = (userData) => JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("旧 settings.json 缺这一段 ⇒ 空表（未决策任何远端项目，零迁移）", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	assert.deepEqual(plain(store.get().remoteProjectTrust), []);
});

test("读时清洗脏值：非数组 ⇒ 空表，数组里不自洽的条目逐条丢弃", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, { remoteProjectTrust: "approve" });
	let store = new SettingsStore();
	await store.load();
	assert.deepEqual(plain(store.get().remoteProjectTrust), []);

	seed(userData, {
		remoteProjectTrust: [RECORD, { ...RECORD, trustKey: `${HOST_ID}::${"d".repeat(32)}::/srv/app` }, { ...RECORD, decision: "allow" }, { ...RECORD, canonicalRoot: "/srv/app/" }, { ...RECORD, decidedAt: "yesterday" }],
	});
	store = new SettingsStore();
	await store.load();
	assert.deepEqual(plain(store.get().remoteProjectTrust), [RECORD], "只有自洽的那一条留下");
});

test("专用写入入口：落盘 + 重启后仍在 + 条目被归一化", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	await store.replaceRemoteProjectTrust([RECORD, { garbage: true }]);
	assert.deepEqual(persisted(userData).remoteProjectTrust, [RECORD], "写盘的是解码后的记录（脏值不进磁盘）");

	// 「重启」：新实例从磁盘读回同一段。
	const restarted = new SettingsStore();
	await restarted.load();
	assert.deepEqual(plain(restarted.get().remoteProjectTrust), [RECORD]);
	// 清空是合法操作（撤销最后一条决策）。
	await restarted.replaceRemoteProjectTrust([]);
	assert.deepEqual(persisted(userData).remoteProjectTrust, []);
});

test("通用 settings:update 碰不到这一段（trust 写入只能走远端 trust 域）", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, { remoteProjectTrust: [RECORD] });
	const store = new SettingsStore();
	await store.load();
	// 渲染层发来的通用补丁里带这一段：必须被剔除，不得改动决策（也不得靠它伪造一条信任）。
	await store.update({ remoteProjectTrust: [{ ...RECORD, decision: "deny", trustKey: `${HOST_ID}::${DIGEST}::/srv/other` }], language: "en-US" });
	assert.deepEqual(plain(store.get().remoteProjectTrust), [RECORD], "决策未被通用通道改写");
	assert.equal(store.get().language, "en-US", "同一次 patch 的其它字段照常生效");
	assert.deepEqual(persisted(userData).remoteProjectTrust, [RECORD]);
});
