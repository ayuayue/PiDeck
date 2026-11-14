import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { remoteHostConnectionSource } from "./helpers/remoteHostConnectionSources.mjs";

/**
 * 远端会话扫描必须在「缓存状态读不到 home」时按需建立会话（真机 e2e 定位到的缺陷）。
 *
 * 现象：连接 state=ready，但界面永远显示「远端 home 解析失败」；而失败之后再单独调一次扫描却完全
 * 成功（28 条真实会话 + 两条夹具会话）。根因：remoteHome 只读缓存里的 manager 状态，而其它远端路径
 * （withProjectSession / 项目读取 / 登记）都会按需建立会话 —— 登记/读取跑完会收掉临时会话，于是
 * 「刚登记完项目就展开去扫」正好命中空窗期。
 */
const { createRemoteSessionScanner, REMOTE_SESSION_CODES } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");

test("the scan uses an ensuring home resolver, not the cached read", async () => {
	let ensuredCalled = 0;
	const port = {
		// 模拟那一刻的缓存状态：读不到 home
		remoteHome: async () => undefined,
		// 生产端口提供的确保式解析：按需建立会话后能拿到 home
		remoteHomeEnsuring: async () => {
			ensuredCalled += 1;
			return "/home/dev";
		},
		// 走到会话建立这一步就停下：报一个不可能与 home 不可用混淆的错，证明**已经越过 home 解析**。
		withProjectSession: async () => {
			throw new Error("PROBE_REACHED_PAST_HOME");
		},
	};
	const scanner = createRemoteSessionScanner({ port });
	const result = await scanner.scan("11111111-1111-4111-8111-111111111111");
	assert.equal(ensuredCalled, 1, "扫描必须调用确保式解析一次");
	assert.equal(result.ok, false);
	assert.notEqual(result.code, REMOTE_SESSION_CODES.homeUnavailable, "不得再报 home 不可用：那一刻会话其实可以建立");
});

test("the read-only remoteHome keeps its contract (no connect on a plain read)", () => {
	const source = remoteHostConnectionSource;
	// remoteHome 仍然是纯读：只委托 readCachedHome，自己绝不去 connect。
	assert.match(source, /async remoteHome\(hostId: string\): Promise<string \| undefined> \{\s*return readCachedHome\(hostId\);/);
	// 只有「确保式」版本才允许走 connectLocked（UI 每次渲染都可能问只读版，不能因此拉起 ssh）。
	const ensuring = source.match(/const readHomeEnsuring = async[\s\S]*?\n\t\};/);
	assert.ok(ensuring, "readHomeEnsuring must exist");
	assert.match(ensuring[0], /connectLocked\(hostId\)/);
});
