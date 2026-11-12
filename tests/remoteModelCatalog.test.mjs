/**
 * 远端模型目录（P0 远端模型选择）：`pi --list-models` 在远端跑、结果传回、按主机缓存。
 *
 * 覆盖三块：命令形状（RemotePiDiscovery）、缓存/降级（RemotePiModelCatalog）、
 * 路由决策（remoteModelReportRouting）+ 装配处的源码契约。
 *
 * 为什么不是「问运行中的远端 pi 进程」：那样会话没激活就没有目录（用户必须先盲发一条消息），
 * 而且目录会随 runtime 重启/空闲回收一起消失。这组用例把「远端算好 → 传回 → 缓存」钉成行为：
 * 命令形状、缓存命中、快速档失败退回兼容档、以及任何失败都不伪造空列表。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { systemIpcSource } from "./helpers/systemIpcSources.mjs";

const { createRemoteModelCatalog, REMOTE_MODEL_CATALOG_CODES, REMOTE_MODEL_CATALOG_TTL_MS } = loadTsCommonJs("src/main/remote/RemotePiModelCatalog.ts");
const { buildRemotePiListModelsCommand, REMOTE_PI_MODEL_LIST_ARGS } = loadTsCommonJs("src/main/remote/RemotePiDiscovery.ts");

const PI_PATH = "/home/u/.nvm/versions/node/v24.11.0/bin/pi";
const NODE_PATH = "/home/u/.nvm/versions/node/v24.11.0/bin/node";

/** 与 `pi --list-models` 真实输出同形的一行（provider  model  context  max-out  thinking  images）。 */
const LIST_OUTPUT = ["provider      model                 context      max-out   thinking  images", "deepseek      deepseek-flash        1M           384K      yes       yes", ""].join("\n");

function createHarness(options = {}) {
	const calls = [];
	const pendingResolvers = [];
	let released = false;
	let clock = 1_000_000;
	const catalog = createRemoteModelCatalog({
		resolveFacts: async () => {
			if (options.factsThrow) throw new Error("SSH_HOST_NOT_READY");
			return { piPath: PI_PATH, nodePath: NODE_PATH };
		},
		run: async (input) => {
			calls.push({ hostId: input.hostId, remoteCommand: input.remoteCommand });
			const next = options.responses?.shift?.();
			const answer = next === undefined ? { exitCode: 0, stdout: LIST_OUTPUT } : next === "throw" ? "throw" : next;
			if (options.pending === true) {
				// releaseAll 可能先于 run 被调用（async 函数要过一轮微任务才走到 run），
				// 所以"已释放"必须记成状态，否则后到的 run 永远挂住。
				if (released) return answer === "throw" ? Promise.reject(new Error("ssh failed")) : answer;
				return await new Promise((resolve, reject) => {
					pendingResolvers.push(() => (answer === "throw" ? reject(new Error("ssh failed")) : resolve(answer)));
				});
			}
			if (answer === "throw") throw new Error("ssh failed");
			return answer;
		},
		now: () => clock,
	});
	return {
		catalog,
		calls,
		advance: (ms) => {
			clock += ms;
		},
		releaseAll: () => {
			released = true;
			for (const release of pendingResolvers.splice(0)) release();
		},
	};
}

test("远端目录命令与版本探测同构：解释器 + pi 路径 + 字面量参数，无用户输入", () => {
	const fast = buildRemotePiListModelsCommand(PI_PATH, NODE_PATH);
	assert.equal(fast, `'${NODE_PATH}' '${PI_PATH}' '--list-models' '--offline' '--no-extensions' '--no-skills' '--no-themes'`);
	// 老版本 pi 不认这些旗标：兼容档只留 --list-models。
	assert.equal(buildRemotePiListModelsCommand(PI_PATH, NODE_PATH, "compat"), `'${NODE_PATH}' '${PI_PATH}' '--list-models'`);
	// 参数与本机快速档同源（offline + 跳过发现），否则远端会为一次列表去加载全部扩展。
	assert.deepEqual([...REMOTE_PI_MODEL_LIST_ARGS.fast], ["--list-models", "--offline", "--no-extensions", "--no-skills", "--no-themes"]);
	// full = 本机「带扩展」档：手动刷新要能拿到扩展 registerProvider 贡献的模型（issue #181）。
	assert.equal(buildRemotePiListModelsCommand(PI_PATH, NODE_PATH, "full"), `'${NODE_PATH}' '${PI_PATH}' '--list-models' '--offline' '--no-skills' '--no-themes'`);
	assert.deepEqual([...REMOTE_PI_MODEL_LIST_ARGS.full], ["--list-models", "--offline", "--no-skills", "--no-themes"]);
});

test("远端算好的目录按主机缓存，过期后重新跑", async () => {
	const h = createHarness();
	const first = await h.catalog.load({ hostId: "h1" });
	assert.equal(first.ok, true);
	assert.equal(first.cached, false);
	assert.equal(first.models[0].provider, "deepseek");
	assert.equal(h.calls.length, 1);

	const second = await h.catalog.load({ hostId: "h1" });
	assert.equal(second.cached, true);
	assert.equal(h.calls.length, 1, "缓存命中不应再起远端进程");

	h.advance(REMOTE_MODEL_CATALOG_TTL_MS + 1);
	const third = await h.catalog.load({ hostId: "h1" });
	assert.equal(third.cached, false);
	assert.equal(h.calls.length, 2, "过期后要重新拉取");
});

test("force 绕过缓存（手动刷新按钮），并刷新缓存内容", async () => {
	const h = createHarness();
	await h.catalog.load({ hostId: "h1" });
	await h.catalog.load({ hostId: "h1", force: true });
	assert.equal(h.calls.length, 2);
	// 刷新后的结果仍然进缓存。
	h.advance(1);
	assert.equal((await h.catalog.load({ hostId: "h1" })).cached, true);
});

test("不同主机的缓存互不影响", async () => {
	const h = createHarness();
	await h.catalog.load({ hostId: "h1" });
	await h.catalog.load({ hostId: "h2" });
	assert.equal(h.calls.length, 2);
	assert.notEqual(h.calls[0].remoteCommand, undefined);
	assert.equal((await h.catalog.load({ hostId: "h2" })).cached, true);
});

test("快速档失败（老 pi 不认旗标）退回兼容档，成功后不再重试", async () => {
	const h = createHarness({ responses: [{ exitCode: 1, stdout: "unknown option --offline" }] });
	const result = await h.catalog.load({ hostId: "h1" });
	assert.equal(result.ok, true);
	assert.equal(h.calls.length, 2);
	assert.match(h.calls[1].remoteCommand, /'--list-models'$/);
});

test("两种形态都失败返回稳定码，且不缓存、不伪造空列表", async () => {
	// 真错误（不是「不认旗标」）不重试：多跑一次只会让选择器多转一圈。
	const h = createHarness({
		responses: [
			{ exitCode: 1, stdout: "", stderr: "permission denied" },
			{ exitCode: 1, stdout: "", stderr: "permission denied" },
		],
	});
	const failed = await h.catalog.load({ hostId: "h1" });
	assert.equal(failed.ok, false);
	assert.equal(failed.code, REMOTE_MODEL_CATALOG_CODES.failed);
	// 失败不进缓存：下一次必须重新尝试（用户可能刚修好远端 pi），并且仍然按两种形态各试一次。
	const retry = await h.catalog.load({ hostId: "h1" });
	assert.equal(retry.ok, false);
	assert.equal(h.calls.length, 2, "失败不能被缓存挡住重试（每次重新尝试一次）");
});

test("命令跑不起来（ssh 异常）与「解析出空目录」是两种不同结果", async () => {
	const thrown = createHarness({ responses: ["throw"] });
	assert.equal((await thrown.catalog.load({ hostId: "h1" })).code, REMOTE_MODEL_CATALOG_CODES.failed);

	const empty = createHarness({
		responses: [
			{ exitCode: 0, stdout: "provider model\n" },
			{ exitCode: 0, stdout: "provider model\n" },
		],
	});
	assert.equal((await empty.catalog.load({ hostId: "h1" })).code, REMOTE_MODEL_CATALOG_CODES.empty);
});

test("拿不到远端 pi 事实（未连接/探测失败）折叠成稳定码", async () => {
	const h = createHarness({ factsThrow: true });
	const result = await h.catalog.load({ hostId: "h1" });
	assert.equal(result.ok, false);
	assert.equal(result.code, REMOTE_MODEL_CATALOG_CODES.failed);
	assert.equal(h.calls.length, 0, "解析不到事实时不应该发出任何远端命令");
});

test("远端路由：CLI 成功就不问 runtime（目录不依赖进程存活）", async () => {
	const { resolveRemoteModelReport } = loadTsCommonJs("src/main/pi/remoteModelReportRouting.ts");
	const asked = [];
	const report = await resolveRemoteModelReport(
		{ projectId: "p1", liveAgentId: "agent-1" },
		{
			loadCatalog: async () => ({ models: [{ provider: "deepseek", id: "flash" }], ok: true, reason: null, version: null, detail: "", source: "remote", at: 1 }),
			askRuntime: async (agentId) => {
				asked.push(agentId);
				return null;
			},
		},
	);
	assert.equal(report.ok, true);
	assert.equal(report.source, "remote");
	assert.deepEqual(asked, [], "CLI 已经给出目录时不该再去问进程");
});

test("远端路由：CLI 失败但恰好有活进程时用进程的答案", async () => {
	const { resolveRemoteModelReport } = loadTsCommonJs("src/main/pi/remoteModelReportRouting.ts");
	const report = await resolveRemoteModelReport(
		{ projectId: "p1", liveAgentId: "agent-1" },
		{
			loadCatalog: async () => ({ models: [], ok: false, reason: "cli-failed", version: null, detail: "REMOTE_MODEL_CATALOG_FAILED", source: "none", at: 1 }),
			askRuntime: async () => ({ models: [{ provider: "x", id: "y" }], ok: true, reason: null, version: null, detail: "", source: "remote", at: 2 }),
		},
	);
	assert.equal(report.ok, true);
	assert.equal(report.models[0].id, "y");
});

test("远端路由：两个来源都失败时返回 CLI 的失败原因，而不是笼统的 remote-inactive", async () => {
	const { resolveRemoteModelReport } = loadTsCommonJs("src/main/pi/remoteModelReportRouting.ts");
	const report = await resolveRemoteModelReport(
		{ projectId: "p1", liveAgentId: "agent-1" },
		{
			loadCatalog: async () => ({ models: [], ok: false, reason: "cli-failed", version: null, detail: "REMOTE_MODEL_CATALOG_EMPTY", source: "none", at: 1 }),
			askRuntime: async () => null,
		},
	);
	assert.equal(report.ok, false);
	assert.equal(report.reason, "cli-failed");
	assert.equal(report.detail, "REMOTE_MODEL_CATALOG_EMPTY");
});

test("远端路由：没有任何来源时给 remote-inactive，且任何分支都不返回本机目录", async () => {
	const { resolveRemoteModelReport } = loadTsCommonJs("src/main/pi/remoteModelReportRouting.ts");
	const noProject = await resolveRemoteModelReport({ projectId: "" }, { loadCatalog: async () => null, askRuntime: async () => null });
	assert.equal(noProject.ok, false);
	assert.equal(noProject.reason, "remote-inactive");
	assert.equal(noProject.models.length, 0);

	// 非远端项目（loadCatalog 返回 null）但恰好有 remote agent：问进程。
	const viaRuntime = await resolveRemoteModelReport(
		{ projectId: "local-project", liveAgentId: "agent-1" },
		{
			loadCatalog: async () => null,
			askRuntime: async () => ({ models: [{ provider: "x", id: "y" }], ok: true, reason: null, version: null, detail: "", source: "remote", at: 1 }),
		},
	);
	assert.equal(viaRuntime.ok, true);

	// 本机目录（source: "cache"）不可能从这里出来：所有返回值要么 remote、要么失败。
	for (const report of [noProject, await resolveRemoteModelReport({ projectId: "p1" }, { loadCatalog: async () => null, askRuntime: async () => null })]) {
		assert.notEqual(report.source, "cache");
		assert.notEqual(report.source, "config-fallback");
	}
});

test("sessions:list-models 只在「既非远端会话也没有远端 runtime」时才走本机目录", () => {
	const source = systemIpcSource;
	const start = source.indexOf("ipcMain.handle(ipcChannels.sessionsListModels");
	assert.ok(start > 0, "未找到 sessions:list-models handler");
	const end = source.indexOf("\n\t});", start);
	const handler = source.slice(start, end);
	assert.match(handler, /resolveRemoteModelReport\(/);
	// 分流门必须同时看会话与项目：虚拟 sessionId（小窗新建/自动化编辑器）不在 catalog 里，
	// 只看会话判据会让它们在远端项目里拿到本机目录。
	assert.match(handler, /\(sessionId\.length > 0 && sessionRuntimeCoordinator\.isRemoteSession\(sessionId\)\) \|\| \(projectId\.length > 0 && agentManager\.isRemoteProject\(projectId\)\)/);
	// 远端分支直接 return，本机解析只出现在它之后（顺序即优先级）。
	const remoteReturn = handler.indexOf("resolveRemoteModelReport(");
	const localReturn = handler.indexOf("resolveLocalModelReport(forceArg)");
	assert.ok(remoteReturn > 0 && localReturn > remoteReturn, "本机目录必须排在远端分支之后");
});

test("手动刷新从「带扩展」全量档起步（扩展贡献的模型只在这条路上出现）", async () => {
	const h = createHarness();
	await h.catalog.load({ hostId: "h1", force: true });
	// 第一档是 full：**不带** --no-extensions（扩展可以 registerProvider 贡献模型）。
	assert.doesNotMatch(h.calls[0].remoteCommand, /--no-extensions/, "第一档必须是 full（不带 --no-extensions）");
});

test("force 与普通查询不共享在途请求：刷新不会被降级成快速档", async () => {
	const h = createHarness({ pending: true });
	const plain = h.catalog.load({ hostId: "h1" });
	const forced = h.catalog.load({ hostId: "h1", force: true });
	h.releaseAll();
	await Promise.all([plain, forced]);
	assert.equal(h.calls.length, 2, "普通查询与 force 必须各发一条（档位不同）");
	assert.match(h.calls[0].remoteCommand, /--no-extensions/);
	assert.doesNotMatch(h.calls[1].remoteCommand, /--no-extensions/);
});

test("同一档位的并发查询共用一条 SSH（分屏两栏同时打开选择器）", async () => {
	const h = createHarness({ pending: true });
	const a = h.catalog.load({ hostId: "h1" });
	const b = h.catalog.load({ hostId: "h1" });
	h.releaseAll();
	assert.equal((await a).ok, true);
	assert.equal((await b).ok, true);
	assert.equal(h.calls.length, 1);
});

test("invalidate 与在途查询赛跑时，旧结果不会写回缓存", async () => {
	const h = createHarness({ pending: true });
	const inFlight = h.catalog.load({ hostId: "h1" });
	h.catalog.invalidate("h1");
	h.releaseAll();
	await inFlight;
	// 缓存已被清空且代次已变：下一次必须重新拉。
	await h.catalog.load({ hostId: "h1" });
	assert.equal(h.calls.length, 2, "invalidate 之后不能被在途结果复活缓存");
});

test("退出 0 但输出里混着 unknown option 噪音时，能解析出模型就照常接受", async () => {
	const h = createHarness({ responses: [{ exitCode: 0, stdout: LIST_OUTPUT + "\n# note: unknown option --offline is ignored\n" }] });
	const result = await h.catalog.load({ hostId: "h1" });
	assert.equal(result.ok, true);
	assert.equal(result.models.length, 1);
	assert.equal(h.calls.length, 1, "有好结果就不该继续降档");
});

test("stderr 里的 unknown option 也会触发降档（不同版本 pi 抱怨位置不同）", async () => {
	const h = createHarness({ responses: [{ exitCode: 1, stdout: "", stderr: "error: unknown option '--offline'" }] });
	const result = await h.catalog.load({ hostId: "h1" });
	assert.equal(result.ok, true);
	assert.equal(h.calls.length, 2);
});

test("快速档解析为空时继续降档，全部档位都空才报 empty（假空 vs 真空）", async () => {
	const h = createHarness({
		responses: [
			{ exitCode: 0, stdout: "provider model\n" },
			{ exitCode: 0, stdout: "provider model\n" },
		],
	});
	const result = await h.catalog.load({ hostId: "h1" });
	assert.equal(result.ok, false);
	assert.equal(result.code, REMOTE_MODEL_CATALOG_CODES.empty);
	assert.equal(h.calls.length, 2, "空不是终态：要再试下一档");
});
