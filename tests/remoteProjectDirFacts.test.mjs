import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * W3 接线的验收点（计划 §3「事实层」）：**同一个目录在一次内容变化里只装载一次**。
 *
 * 用法与 remoteHostIpc.test.mjs 同一套：真的加载 `remoteProjectIpc`，只把 reader 换成会记账的假端口。
 * 断言的是行为（reader 被调用几次），不是实现细节——所以搬文件、改内部结构都不会让这组用例失真。
 *
 * 池化 B3 之后，假 service 必须提供**按项目 root 查询**的事实与能力入口
 * （`projectConnectionFacts(hostId, root)` / `projectHelperCapabilities(hostId, root)`）以及目录 watcher
 * 的保活计数（`retain/releaseProjectSessionWatch`）。旧的主机级 `connectionFacts(hostId)` 已不能证明
 * 这份缓存属于哪个 root：同主机可能同时挂着另一个 root 的会话，拿它当代数就是串根。这里把
 * 「root 不匹配返回 undefined」做成隔离守卫，并覆盖能力可用/不可用两条路径。
 */
const HOST_ID = "6f1b7c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PROJECT = "project-remote-1";
const PROJECT_ROOT = "/srv/app";

function harness(options = {}) {
	const calls = { list: [], watches: [], keepAlive: [], factLookups: [], capabilityLookups: [], searchContent: 0 };
	const handlers = new Map();
	const state = { connectionId: "conn-1", rootUnavailable: false, watchFails: false };
	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": {
				async resolveRemoteBrowseRoot() {
					return { canonicalPath: PROJECT_ROOT };
				},
			},
			"../remote/RemoteSearchReader": {
				REMOTE_SEARCH_READER_CODES: { queryInvalid: "QUERY_INVALID", requestFailed: "REMOTE_WORKSPACE_REQUEST_FAILED", optionsInvalid: "REMOTE_WORKSPACE_READER_OPTIONS_INVALID" },
				createRemoteSearchReader: () => ({
					async search() {
						return { entries: [], scanned: 0, truncated: false };
					},
					async searchContent() {
						calls.searchContent += 1;
						return { matches: [{ name: "a.ts", path: "src/a.ts", line: 1, column: 0, snippet: "const a = 1;" }], matchedFiles: 1, scannedFiles: 1, scannedBytes: 16, truncated: false };
					},
				}),
			},
			"../remote/RemoteWorkspaceReader": {
				createRemoteWorkspaceReader: () => ({
					async readFile() {
						return { content: Buffer.from("x"), bytes: 1, mtimeMs: 1 };
					},
				}),
			},
		},
	});
	let issuedWatchId = "w-unset";
	const facts = registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		directoryReader: {
			async read({ relative }) {
				calls.list.push(relative === "" ? "." : relative);
				if (options.listFails) return { ok: false, code: options.listError ?? "REMOTE_PROJECT_READ_FAILED" };
				const entries = options.entries ?? [{ name: "src", kind: "directory" }];
				return { ok: true, value: { entries, scanned: entries.length, truncated: options.truncated ?? false } };
			},
		},
		service: async () => ({
			withProjectSession: async (_hostId, _root, task) => {
				// 真实服务在拿到会话时 root 就有活的了；测试里用这个状态区分「root 已退休」与「读会建立会话」。
				state.rootUnavailable = false;
				return {
					ok: true,
					value: await task({
						connectionId: state.connectionId,
						// fs.watch 走同一条 request 通道：这里回答一个稳定的 watchId，其余方法不该被调用。
						request: async (method, params) => {
							if (method === "fs.watch") {
								calls.watches.push(JSON.parse(JSON.stringify(params)));
								if (state.watchFails) throw new Error("REMOTE_WORKSPACE_UNSUPPORTED");
								return { watchId: issuedWatchId };
							}
							if (method === "fs.unwatch") return { ok: true };
							throw new Error("UNEXPECTED_METHOD");
						},
						cancel: async () => undefined,
					}),
				};
			},
			// 项目事实只回答「服务这个 root 的会话」：同主机的兄弟 root 或主机级状态都不能替它担保。
			projectConnectionFacts: (hostId, root) => {
				calls.factLookups.push([hostId, root]);
				if (state.rootUnavailable || hostId !== HOST_ID || root !== PROJECT_ROOT) return undefined;
				return { connectionId: state.connectionId, state: "ready" };
			},
			// 能力属于声明它的那条 helper 会话；root 不匹配同样是 undefined（未知 ≠ 可用）。
			projectHelperCapabilities: (hostId, root) => {
				calls.capabilityLookups.push([hostId, root]);
				if (hostId !== HOST_ID) return undefined;
				if (options.capabilitiesByRoot !== undefined) return options.capabilitiesByRoot[root];
				return root === PROJECT_ROOT ? options.capabilities : undefined;
			},
			// 目录订阅保活：0→1 记 retain、退订清空记 release（池的 watchers 计数只是加减法）。
			retainProjectSessionWatch: (hostId, root) => calls.keepAlive.push({ kind: "retain", hostId, root }),
			releaseProjectSessionWatch: (hostId, root) => calls.keepAlive.push({ kind: "release", hostId, root }),
		}),
		projects: {
			enroll: async () => ({ projectId: PROJECT }),
			locator: (projectId) => (projectId === PROJECT ? { kind: "ssh", hostId: HOST_ID, remotePath: PROJECT_ROOT } : undefined),
		},
	});
	const list = (path) => handlers.get("remote:project-list")({}, PROJECT, path);
	const plain = (value) => JSON.parse(JSON.stringify(value));
	return {
		calls,
		state,
		list,
		facts,
		plain,
		watchId: (value) => {
			issuedWatchId = value;
		},
	};
}

test("同一个目录读两次：只装载一次，两次拿到同一个 revision", async () => {
	const h = harness();
	const first = await h.list("");
	const second = await h.list("");
	assert.equal(h.calls.list.length, 1, "第二次读必须命中事实，不再打一次远端");
	assert.equal(first.value.revision, second.value.revision);
	assert.deepEqual(h.plain(first.value.entries), h.plain(second.value.entries));
	assert.equal(h.facts.dirLoads(), 1);
	assert.deepEqual(h.plain([...new Set(h.calls.factLookups.map(([hostId, root]) => hostId + "|" + root))]), [HOST_ID + "|" + PROJECT_ROOT], "缓存围栏按本项目自己的 root 查询");
});

test("remoteProjectList 与公共目录页共享同一份目录事实，只读一次", async () => {
	const h = harness();
	const listed = await h.list("");
	const page = await h.facts.directoryPage(PROJECT, "", false);
	assert.equal(listed.ok, true);
	assert.equal(page.ok, true);
	assert.equal(h.calls.list.length, 1, "the two public readers must not issue a second SFTP list");
	assert.equal(page.value.revision, listed.value.revision);
	assert.deepEqual(h.plain(page.value.entries.map((entry) => entry.relativePath)), ["src"]);
});

test("不同目录各装载一次：事实按 (项目, 路径) 分开", async () => {
	const h = harness();
	await h.list("");
	await h.list("src");
	assert.deepEqual(h.calls.list, [".", "src"]);
	assert.equal(h.facts.dirLoads(), 2);
});

test("写后标脏：下一次读重新装载，revision 前进；标脏本身不产生往返", async () => {
	const h = harness();
	const before = await h.list("src");
	assert.equal(h.calls.list.length, 1);

	// 写 "src/a.ts"：只标脏 src 与它的父目录（根层），此时一条远端请求都不该发出。
	h.facts.afterWrite(PROJECT, ["src/a.ts"]);
	assert.equal(h.calls.list.length, 1, "失效只标脏，不装载");

	const after = await h.list("src");
	assert.equal(h.calls.list.length, 2, "下一次读才付那次往返");
	assert.ok(after.value.revision > before.value.revision, "值被替换后 revision 必须变");
	assert.equal(h.facts.dirLoads(), 2);
});

test("写后未受影响的目录仍是命中（失效矩阵不漏也不多）", async () => {
	const h = harness();
	await h.list("assets");
	await h.list("src");
	assert.equal(h.calls.list.length, 2);
	h.facts.afterWrite(PROJECT, ["src/a.ts"]);
	await h.list("assets");
	assert.equal(h.calls.list.length, 2, "assets 不在失效范围内，不该重新装载");
});

test("装载失败如实返回稳定码与 outcome，不缓存成空目录", async () => {
	const h = harness({ listFails: true });
	const failed = await h.list("");
	assert.equal(failed.ok, false);
	assert.equal(failed.code, "REMOTE_PROJECT_READ_FAILED");
	assert.equal(failed.outcome, "rejected");
	// 失败不被当成事实：下一次读取会真的重试。
	await h.list("");
	assert.equal(h.calls.list.length, 2);
});

test("暖缓存必须由本项目 root 的会话作围栏：拿不到就拒绝，不退回旧缓存", async () => {
	const h = harness();
	const first = await h.list("");
	assert.equal(first.ok, true);
	const loads = h.calls.list.length;

	// 主机上可能还挂着另一个 root 的 helper，但本项目 root 目前没有就绪会话：这份暖缓存证明不了"现在"。
	h.state.rootUnavailable = true;
	const blocked = await h.list("");
	assert.equal(blocked.ok, false);
	assert.equal(blocked.code, "SSH_HOST_NOT_READY");
	assert.equal(h.calls.list.length, loads, "没有本项目 root 的会话时不付远端往返，也不返回旧缓存");

	h.state.rootUnavailable = false;
	const restored = await h.list("");
	assert.equal(restored.ok, true);
	assert.equal(restored.value.revision, first.value.revision, "会话恢复后仍复用同一份事实");
});

test("helper 变更事件只标脏对应目录（事件 → 失效接线，按会话身份路由）", async () => {
	const h = harness();
	// 根目录装载成功时订阅一次，helper 回一个 watchId；事件回来时按 (host, 会话, watchId) 找项目。
	h.watchId("w1-req-1");
	const before = await h.list("");
	assert.equal(h.calls.list.length, 1);
	assert.deepEqual(h.calls.watches, [{ paths: [""] }], "根目录第一次读到就订阅（非递归，覆盖根层与 .git 变化）");

	// 同主机另一条会话（另一个 root 的 helper）返回同一个 watchId：它的事件不得标脏本项目。
	h.facts.onHelperEvent({ hostId: HOST_ID, sessionKey: "conn-other", watchId: "w1-req-1", paths: [""] });
	const blocked = await h.list("");
	assert.equal(h.calls.list.length, 1, "别的 sessionKey 的同一 watchId 不标脏，也不装载");
	assert.equal(blocked.value.revision, before.value.revision);

	h.facts.onHelperEvent({ hostId: HOST_ID, sessionKey: "conn-1", watchId: "w1-req-1", paths: [""] });
	assert.equal(h.calls.list.length, 1, "事件不装载，只标脏");

	const after = await h.list("");
	assert.equal(h.calls.list.length, 2, "下一次读才付往返");
	assert.ok(after.value.revision > before.value.revision);
});

test("未注册的 watchId、别的 host、别的路径都不影响事实", async () => {
	const h = harness();
	h.watchId("w1-req-1");
	await h.list("src");
	assert.equal(h.calls.list.length, 1);
	assert.deepEqual(h.calls.watches, [], "非根目录不订阅");
	h.facts.onHelperEvent({ hostId: HOST_ID, sessionKey: "conn-1", watchId: "nope", paths: ["src"] });
	h.facts.onHelperEvent({ hostId: "ffffffff-ffff-4fff-8fff-ffffffffffff", sessionKey: "conn-1", watchId: "w1-req-1", paths: ["src"] });
	await h.list("src");
	assert.equal(h.calls.list.length, 1, "只认登记过的 (host, 会话, watchId, 路径)");
});

test("内容搜索能力只看本项目 root 的 helper 声明：可用 / 不可用 / 兄弟 root 不冒充", async () => {
	const available = harness({ capabilities: ["fs.searchContent"] });
	const hit = await available.facts.searchContent(PROJECT, "a");
	assert.equal(hit.ok, true);
	assert.equal(hit.value.hits.length, 1, "声明了能力就走真实内容搜索");
	assert.equal(hit.value.truncated, false);
	assert.deepEqual(available.plain(available.calls.capabilityLookups), [[HOST_ID, PROJECT_ROOT]], "能力按项目自己的 root 查询");
	assert.equal(available.calls.searchContent, 1);

	const unsupported = harness({ capabilities: ["fs.list"] });
	const none = await unsupported.facts.searchContent(PROJECT, "a");
	assert.equal(none.ok, true);
	assert.equal(none.value, null, "未声明能力 → ok:true/value:null（渲染层回退），不是失败");
	assert.equal(unsupported.calls.searchContent, 0, "能力缺失时不发无谓的内容搜索请求");

	const unknown = harness({});
	assert.equal((await unknown.facts.searchContent(PROJECT, "a")).value, null, "能力未知（undefined）同样回退");

	const sibling = harness({ capabilitiesByRoot: { "/srv/other": ["fs.searchContent"] } });
	assert.equal((await sibling.facts.searchContent(PROJECT, "a")).value, null, "兄弟 root 声明了能力也不能替本项目宣布可用");
	assert.deepEqual(sibling.plain(sibling.calls.capabilityLookups), [[HOST_ID, PROJECT_ROOT]], "仍然只查本项目自己的 root");
});

test("保活配对：目录第一次有 watch 时 retain 一次；关闭项目 release 恰好一次", async () => {
	const h = harness();
	await h.list("");
	assert.deepEqual(h.calls.keepAlive, [{ kind: "retain", hostId: HOST_ID, root: PROJECT_ROOT }], "0→1 retain 一次");
	await h.list("");
	await h.list("src");
	assert.equal(h.calls.keepAlive.length, 1, "watcher 仍挂着：后续读取/新目录不再 retain（池计数不漂）");

	await h.facts.closeProject(PROJECT);
	assert.deepEqual(
		h.calls.keepAlive.map((entry) => entry.kind),
		["retain", "release"],
		"关闭项目成对 release 一次",
	);
});

test("root 会话退休：只归还这一条会话的保活，旧代目录事实失效但不触发主机断开", async () => {
	const h = harness();
	h.watchId("w-retire");
	await h.list("");
	assert.deepEqual(h.calls.keepAlive, [{ kind: "retain", hostId: HOST_ID, root: PROJECT_ROOT }], "watcher 活着时该 root 保温");

	// 池把一条 root 会话退休（TTL/LRU/latched/显式）：只丢这条会话的登记与保活，邻居 root 与终端不受影响。
	h.facts.onRootRetired({ hostId: HOST_ID, root: PROJECT_ROOT, sessionKey: "conn-1" });
	assert.deepEqual(
		h.calls.keepAlive.map((entry) => entry.kind),
		["retain", "release"],
		"退休成对 release 恰好一次",
	);

	// 幂等：同一条会话再退休不得重复 release，也不得抛错。
	h.facts.onRootRetired({ hostId: HOST_ID, root: PROJECT_ROOT, sessionKey: "conn-1" });
	assert.equal(h.calls.keepAlive.length, 2, "重复退休不重复归还保活");

	// 退休会话的迟到事件不得再标脏。root 会话已经不在，旧目录事实也随之作废：下一次读会重新装载，
	// 但不会因为事件多付一次额外往返（事件本身仍然只标脏、不装载）。
	h.facts.onHelperEvent({ hostId: HOST_ID, sessionKey: "conn-1", watchId: "w-retire", paths: [""] });
	const reloaded = await h.list("");
	assert.equal(reloaded.ok, true, "root 正常退休后重新打开必须能读到");
	assert.equal(h.calls.list.length, 2, "旧代目录缓存随会话退休作废，下一次读重新装载");
});

test("retiring a root cancels its queued deep watcher without subscribing the old helper", async () => {
	const h = harness();
	await h.list("");
	await h.list("src");
	const before = h.calls.watches.length;
	h.facts.onRootRetired({ hostId: HOST_ID, root: PROJECT_ROOT, sessionKey: "conn-1" });
	await h.facts.flushDirWatch();
	assert.equal(h.calls.watches.length, before, "a retired session must not receive the delayed fs.watch");
	assert.deepEqual(h.plain(h.facts.dirWatchStatus(PROJECT)), { desired: [], covered: [] });
	await h.facts.dispose();
});

test("fs.watch 失败：读取仍成功，但目录页必须带 watch-failed 与真实失败码；恢复后清除", async () => {
	const h = harness();
	h.state.watchFails = true;
	const listed = await h.list("");
	assert.equal(listed.ok, true, "订阅失败不是读失败");
	const degraded = await h.facts.directoryPage(PROJECT, "", false);
	assert.equal(degraded.ok, true);
	assert.equal(degraded.value.dirWatch?.degraded, true);
	assert.equal(degraded.value.dirWatch?.reason, "watch-failed");
	assert.equal(degraded.value.dirWatch?.code, "REMOTE_WORKSPACE_UNSUPPORTED");
	assert.equal(degraded.value.dirWatch?.covered, 0);
	assert.equal(degraded.value.dirWatch?.dropped, 1);

	// 下一次读之前让 helper 恢复：重新登记成功后，降级状态清除（不是永久贴标签）。
	h.state.watchFails = false;
	h.facts.afterWrite(PROJECT, ["src/a.ts"]);
	await h.list("");
	const recovered = await h.facts.directoryPage(PROJECT, "", false);
	assert.equal(recovered.ok, true);
	assert.equal(Object.hasOwn(recovered.value, "dirWatch"), false, "恢复覆盖后不得残留旧降级");
});

test("关闭/释放项目后 root 经 TTL/LRU 退休：重新打开能重新建立会话并成功读取", async () => {
	const h = harness();
	const first = await h.list("");
	assert.equal(first.ok, true);
	assert.equal(h.calls.list.length, 1);
	// 目录事实已经形成暖缓存，并带有这条会话的连接代。
	const warm = await h.facts.directoryPage(PROJECT, "", false);
	assert.equal(warm.value.generation, "conn-1");
	assert.equal(h.calls.watches.length, 1, "根目录已经订阅");

	await h.facts.closeProject(PROJECT);
	// 池按 TTL/LRU 回收这条 root：从这一刻起它不再有活会话，下一次读必须允许新建会话。
	h.state.rootUnavailable = true;
	h.state.connectionId = "conn-2";

	const reopened = await h.list("");
	assert.equal(reopened.ok, true, "关闭后重新打开不能因为旧暖缓存而卡在 SSH_HOST_NOT_READY");
	assert.equal(h.calls.list.length, 2, "旧缓存已清理，重新打开重新装载");
	assert.equal(h.calls.watches.length, 2, "新会话重新登记目录订阅");
	const page = await h.facts.directoryPage(PROJECT, "", false);
	assert.equal(page.value.generation, "conn-2", "generation 属于重新建立的会话，而不是被清掉的旧代");
});

test("深层 watch 降级时目录页带 dirWatch；正常覆盖时字段缺席", async () => {
	const h = harness();
	h.watchId("w1-cover");
	// 根层首次读取：订阅还没超预算，目录页不得凭空带降级字段。
	const healthy = await h.facts.directoryPage(PROJECT, "", false);
	assert.equal(healthy.ok, true);
	assert.equal(Object.hasOwn(healthy.value, "dirWatch"), false);

	// 129 个目录 > helper 预算（4 watcher × 32 路径 = 128）：深层订阅必须如实降级，
	// 目录页把缺口带给渲染层（否则文件树会把"没监听"显示成"没变化"）。
	for (let index = 0; index < 129; index += 1) {
		const page = await h.facts.directoryPage(PROJECT, "dir-" + index, false);
		assert.equal(page.ok, true);
	}
	await h.facts.flushDirWatch();
	const degraded = await h.facts.directoryPage(PROJECT, "dir-0", false);
	assert.equal(degraded.ok, true);
	assert.equal(degraded.value.dirWatch?.degraded, true);
	assert.equal(degraded.value.dirWatch?.reason, "paths-over-limit");
	assert.ok(degraded.value.dirWatch.desired > 128, "期望监听数必须超过预算");
	assert.ok(degraded.value.dirWatch.dropped > 0, "缺口必须 > 0，不能假装全覆盖");
	assert.equal(typeof degraded.value.dirWatch.covered, "number");
});
