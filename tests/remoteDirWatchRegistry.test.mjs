import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createDirWatchRegistry, dirKeysAfterWrite } = loadTsCommonJs("src/main/remote/RemoteDirWatchRegistry.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const OTHER_HOST = "ffffffff-ffff-4fff-8fff-ffffffffffff";
/** 会话身份 = `RemoteProjectSession.connectionId`：`hostId#managerToken#generation`。 */
const connOf = (hostId, managerToken, generation) => hostId + "#" + managerToken + "#" + generation;
/** 沙箱里造的对象的原型与测试文件不同：比较前复制成本地值。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * 目录订阅登记表（W6 接线）要挡的是「事件猜错项目」：事件帧只带 watchId，项目归属只能来自登记。
 *
 * root 池之后同主机可以同时存在多条 helper 会话，所以登记键是 `hostId → sessionKey → 一代`：
 * watchId 只在**发起它的会话**里有效，查事件必须带会话身份。这组用例钉三件事：未登记就忽略
 * （含别的会话/旧会话/别的 host）、同一会话重复读不重复订阅、写后失效范围。
 *
 * 跨会话隔离、每会话 4×32 预算与保活配对见 remoteDirWatchSessionIsolation.test.mjs。
 */
test("登记后才认事件；必须带会话身份，未知 watchId / 别的会话 / 别的 host 一律忽略", async () => {
	const registry = createDirWatchRegistry();
	const session = connOf(HOST, "m1", 1);
	await registry.ensure(HOST, session, "p1", async () => "w1");
	assert.deepEqual(plain(registry.scopesForEvent(HOST, session, "w1")), [{ projectId: "p1", paths: [""] }]);
	assert.equal(registry.scopesForEvent(HOST, session, "w-unknown"), undefined, "没发起过的 watchId 不得猜项目");
	assert.equal(registry.scopesForEvent(HOST, connOf(HOST, "m1", 2), "w1"), undefined, "同主机别的会话（换代/兄弟 root）不得命中");
	assert.equal(registry.scopesForEvent(HOST, connOf(HOST, "m2", 1), "w1"), undefined, "同主机的兄弟 root 会话不得命中");
	assert.equal(registry.scopesForEvent(OTHER_HOST, session, "w1"), undefined, "别的 host 不得命中");
});

test("同一会话只订阅一次；helper 不给 id 时静默降级（不登记）", async () => {
	const registry = createDirWatchRegistry();
	const session = connOf(HOST, "m1", 1);
	let subscriptions = 0;
	const subscribe = async () => {
		subscriptions += 1;
		return "w1";
	};
	// 同一 helper 会话的每次读都会新建 session 包装对象，但 connectionId 相同：身份只看 connectionId。
	await registry.ensure(HOST, session, "p1", subscribe);
	await registry.ensure(HOST, session, "p1", subscribe);
	assert.equal(subscriptions, 1, "同项目重复读根目录不该重复订阅");
	assert.equal(registry.sizeOfSession(HOST, session), 1);

	const unsupported = createDirWatchRegistry();
	await unsupported.ensure(HOST, session, "p1", async () => undefined);
	assert.equal(unsupported.sizeOfSession(HOST, session), 0, "helper 不支持（没有 id）就不登记");
});

test("写后失效范围：所在目录 + 父目录（根层只算自己）", () => {
	// 用 join 比较：键里含 NUL，跨 realm 的数组/字符串比较容易被原型差异干扰。
	const key = (path) => "p1" + String.fromCharCode(0) + path;
	assert.deepEqual(plain(dirKeysAfterWrite("p1", ["src/a.ts"])).sort(), [key(""), key("src")].sort());
	assert.deepEqual(plain(dirKeysAfterWrite("p1", ["a.ts"])), [key("")]);
	// 两个文件同一目录只算一次。
	assert.deepEqual(plain(dirKeysAfterWrite("p1", ["src/a.ts", "src/b.ts"])).sort(), [key(""), key("src")].sort());
});
