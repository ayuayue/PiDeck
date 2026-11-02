import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createSessionOnce } = loadTsCommonJs("src/renderer/src/utils/sessionCreation.ts");

const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

test("同一 key 的并发创建只跑一次，两个调用方拿到同一条会话", async () => {
	const registry = new Map();
	const gate = deferred();
	let calls = 0;
	const create = () => {
		calls += 1;
		return gate.promise;
	};
	const first = createSessionOnce(registry, "project-1", create);
	const second = createSessionOnce(registry, "project-1", create);
	assert.equal(first, second, "第二次调用必须复用在途 promise，不能再发一次 createDraft");
	gate.resolve({ id: "session-1" });
	assert.deepEqual(await first, { id: "session-1" });
	assert.deepEqual(await second, { id: "session-1" });
	assert.equal(calls, 1);
	assert.equal(registry.size, 0, "settle 后必须清空，下一次新建才是真的新建");
});

test("不同项目互不阻塞", async () => {
	const registry = new Map();
	const a = createSessionOnce(registry, "project-a", async () => ({ id: "a" }));
	const b = createSessionOnce(registry, "project-b", async () => ({ id: "b" }));
	assert.equal((await a).id, "a");
	assert.equal((await b).id, "b");
});

test("settle 之后的新调用重新创建", async () => {
	const registry = new Map();
	let calls = 0;
	const create = async () => {
		calls += 1;
		return { id: `session-${calls}` };
	};
	assert.equal((await createSessionOnce(registry, "p", create)).id, "session-1");
	assert.equal((await createSessionOnce(registry, "p", create)).id, "session-2");
	assert.equal(calls, 2);
});

test("创建失败：两个调用方都拿到 rejection，注册表清空后可以重试", async () => {
	const registry = new Map();
	let calls = 0;
	const create = async () => {
		calls += 1;
		if (calls === 1) throw new Error("ipc failed");
		return { id: "session-2" };
	};
	const first = createSessionOnce(registry, "p", create);
	const second = createSessionOnce(registry, "p", create);
	await assert.rejects(first, /ipc failed/);
	await assert.rejects(second, /ipc failed/);
	assert.equal(registry.size, 0);
	assert.equal((await createSessionOnce(registry, "p", create)).id, "session-2");
});

test("create 同步抛错收敛成 rejection，不污染注册表", async () => {
	const registry = new Map();
	const promise = createSessionOnce(registry, "p", () => {
		throw new Error("sync boom");
	});
	await assert.rejects(promise, /sync boom/);
	assert.equal(registry.size, 0);
	assert.equal((await createSessionOnce(registry, "p", async () => ({ id: "ok" }))).id, "ok");
});

const between = (source, startMarker, endMarker) => {
	const start = source.indexOf(startMarker);
	assert.ok(start >= 0, `找不到切片起点：${startMarker}`);
	const end = source.indexOf(endMarker, start);
	assert.ok(end > start, `找不到切片终点：${endMarker}`);
	return source.slice(start, end);
};

test("App 装配：新建会话与引导页首发共用同一份在途注册表", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const createWithTab = between(app, "const createSessionDraftWithTab = useCallback(", "const createAnonymousSessionWithTab = useCallback(");
	assert.match(createWithTab, /createSessionOnce\(pendingDraftCreationRef\.current, targetProjectId,/, "「+」/侧栏新建必须走单一在途闸门");

	const ensureForSend = between(app, "const ensureSessionForSend = useCallback(", "// 待绑定智能体只在「新会话页」有意义");
	assert.match(ensureForSend, /pendingDraftCreationRef\.current\.get\(project\.id\)/, "引导页首发必须先看同一项目有没有在途草稿");
	assert.match(ensureForSend, /createSessionOnce\(pendingDraftCreationRef\.current, project\.id,/, "自建时也必须登记到同一份注册表，供「+」复用");
	assert.doesNotMatch(ensureForSend, /^\s*const session = await api\.sessions\.createDraft\(/m, "不得再有绕过闸门的裸 createDraft（两条会话的根因）");
});

test("新建会话菜单：一次打开只派发一次选择（#481 双建根因）", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	const menu = between(source, "function NewSessionMenu(props:", "function RunControlContextItems(");
	assert.match(menu, /onOpenChange=\{\(next\) => \{[\s\S]*?if \(next\) pickedRef\.current = false;/, "每次打开菜单必须解锁（否则第二次新建被吞）");
	const selects = [...menu.matchAll(/onSelect=\{\(\) => ([^}]*)\}/g)].map((match) => match[1]);
	assert.ok(selects.length >= 3, `应覆盖聊天区/项目/ACP 三类目标，实际 ${selects.length}`);
	for (const body of selects) {
		assert.match(body, /^pick\(/, `onSelect 必须经过 pick() 单次闸门，实际：${body}`);
	}
});
