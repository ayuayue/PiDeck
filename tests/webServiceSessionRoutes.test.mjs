import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadWebServiceManager() {
	return loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		// VM 沙箱默认没有 fetch（Node 18+ 全局），dev 代理与回退测试需要它
		globals: {
			fetch: globalThis.fetch,
			Response: globalThis.Response,
			ReadableStream: globalThis.ReadableStream,
		},
	}).WebServiceManager;
}

function loadBrowserApi(fetchImpl) {
	const source = readFileSync("src/renderer/src/browserApi.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		fetch: fetchImpl,
		URLSearchParams,
		crypto: globalThis.crypto,
		window: {
			setInterval: () => 1,
			clearInterval: () => undefined,
			// browserApi 启动时从 window.location.search 读 ?token= 并写 localStorage，
			// 沙箱必须补齐这两个桩，否则真实代码在 vm 里取不到 location 直接抛错。
			location: { search: "" },
			localStorage: {
				getItem: () => null,
				setItem: () => undefined,
			},
		},
		require: (specifier) => {
			if (specifier === "./i18n") return { t: (key) => key };
			if (specifier === "./previewApi") {
				return {
					createPreviewApi: () => ({
						projects: { list: async () => [] },
						sessions: { list: async () => [] },
						settings: { get: async () => ({ webServiceEnabled: false }) },
					}),
				};
			}
			throw new Error(`Unexpected browser API dependency: ${specifier}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "browserApi.ts" });
	return sandbox.exports.createBrowserApi;
}

function fixture(overrides = {}) {
	const session = {
		id: "session-1",
		projectId: "project-1",
		title: "Session 1",
		source: "pi",
		environment: "native",
		preview: "",
		messageCount: 0,
		status: "draft",
		createdAt: 1,
		updatedAt: 1,
	};
	const runtime = {
		sessionId: session.id,
		agentId: "agent-1",
		runtimeGeneration: 3,
		projectId: session.projectId,
		cwd: "C:/project",
		status: "idle",
		createdAt: 2,
	};
	const agent = {
		id: runtime.agentId,
		projectId: session.projectId,
		cwd: runtime.cwd,
		title: session.title,
		status: "idle",
		createdAt: 2,
	};
	const calls = { createDraft: 0, createAnonymous: 0, createAgent: 0, createProject: [], deleteProject: [], send: [], stateTargets: [], modelTargets: [], rewindTargets: [], rewindParams: [], rewindRestores: [], fileChanges: [], subagents: [], todo: [] };
	const targeted = (target, value) => ({ ok: true, value: { target, value } });
	const deps = {
		// SSE 流式依赖：测试环境不订阅真实 pi 事件，但必须提供可调用实现满足契约。
		subscribePiEvents: () => () => undefined,
		getSessionIdForAgent: () => "session-1",
		listProjects: () => [{ id: "project-1", name: "Project", path: "C:/project" }],
		createProject: async (path) => {
			calls.createProject.push(path);
			return { id: "project-2", name: "New Project", path, lastOpenedAt: 2 };
		},
		deleteProject: async (projectId) => {
			calls.deleteProject.push(projectId);
			return true;
		},
		listModels: async () => [{ provider: "openai", id: "gpt-test", name: "GPT Test" }],
		listAgents: () => [agent],
		listSessions: async () => [],
		listCatalogSessions: async () => [session],
		createSessionDraft: async (input) => {
			calls.createDraft += 1;
			return { ...session, projectId: input.projectId, title: input.title || session.title };
		},
		createAnonymousSession: async (input) => {
			calls.createAnonymous += 1;
			const anonymousSession = {
				...session,
				id: "anonymous-1",
				projectId: input.projectId,
				title: input.title || "Anonymous Chat",
				noSession: true,
				status: "active",
			};
			return {
				session: anonymousSession,
				runtime: {
					...runtime,
					sessionId: anonymousSession.id,
					agentId: "anonymous-agent",
					noSession: true,
				},
			};
		},
		updateSessionRecord: async (_sessionId, patch) => ({ ...session, ...patch }),
		deleteSessionRecord: async () => true,
		copySessionRecord: async () => ({ cancelled: false, targetSessionId: "session-2" }),
		exportSessionRecordHtml: async () => ({ path: "session.html" }),
		readSessionReferenceMessages: async () => [{ role: "user", content: "reference", timestamp: 1 }],
		readSessionMessages: async () => ({
			messages: [{ id: "w1", role: "assistant", text: "window", timestamp: 1 }],
			total: 42,
			windowStart: 30,
			truncated: true,
		}),
		listSessionFileChanges: async (sessionId) => {
			calls.fileChanges.push(sessionId);
			return [{ path: "src/a.ts", changeType: "edit", additions: 1, deletions: 0, timestamp: 1 }];
		},
		listSessionSubagents: async (sessionId) => {
			calls.subagents.push(sessionId);
			return [{ id: "sub-1", name: "explore", status: "completed", startedAt: 1 }];
		},
		listSessionTodo: async (sessionId) => {
			calls.todo.push(sessionId);
			// 与真实实现对齐：会话无 todo 快照时返回 null（路由侧归一为 {todo:null}）
			return sessionId === "session-1" ? { todos: [{ content: "ship it", status: "completed" }], updatedAt: 2 } : null;
		},
		readSessionMessagePage: async () => ({ messages: [], total: 0, nextBefore: null }),
		sendSessionPrompt: async (input) => {
			calls.send.push(input);
			return {
				accepted: true,
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: runtime.agentId,
				runtimeGeneration: runtime.runtimeGeneration,
			};
		},
		listSessionRuntimes: () => [runtime],
		listSessionRuntimeModels: async (target) => {
			calls.modelTargets.push(target);
			return targeted(target, [{ provider: "openai", id: "gpt-test", name: "GPT Test" }]);
		},
		stopSessionRuntime: async (target) => ({ ok: true, value: target }),
		abortSessionRuntime: async (target) => targeted(target, undefined),
		restartSessionRuntime: async () => ({ ok: false, error: { code: "SESSION_RUNTIME_CHANGED" } }),
		compactSessionRuntime: async (target) => targeted(target, { isStreaming: false }),
		getSessionRuntimeState: async (target) => {
			calls.stateTargets.push(target);
			return targeted(target, { isStreaming: false });
		},
		listSessionRuntimeCommands: async (target) => targeted(target, []),
		exportSessionRuntimeHtml: async (target) => targeted(target, { path: "export.html" }),
		editSessionRuntimeMessage: async (target) => targeted(target, undefined),
		deleteSessionRuntimeMessage: async (target) => targeted(target, undefined),
		listRewindCheckpoints: async (target, params) => {
			calls.rewindTargets.push(target);
			calls.rewindParams.push(params ?? null);
			return targeted(target, {
				items: [
					{
						id: "turn-1-1-1234",
						sessionId: session.id,
						trigger: "turn",
						turnIndex: 1,
						branch: "main",
						timestamp: 1234,
					},
				],
				hasMore: false,
			});
		},
		getRewindCheckpointDiff: async (target) => targeted(target, "a.txt | 1 +"),
		restoreRewindCheckpoint: async (target, checkpointId, scope) => {
			calls.rewindRestores.push({ target, checkpointId, scope });
			return targeted(target, undefined);
		},
		prepareSessionRuntimeResend: async (target) => targeted(target, { text: "hello" }),
		setSessionRuntimeModel: async (target) => targeted(target, { isStreaming: false }),
		setSessionRuntimeThinking: async (target) => targeted(target, { isStreaming: false }),
		cloneSessionRuntime: async () => ({ ok: true, value: { targetSessionId: "session-2" } }),
		listPendingUiRequests: () => [],
		respondToUi: async () => undefined,
		createAgent: async () => {
			calls.createAgent += 1;
			return agent;
		},
		sendPrompt: async () => ({ accepted: true }),
		stopAgent: async () => undefined,
		runtimeState: async () => ({ isStreaming: false }),
		cycleModel: async () => ({ isStreaming: false }),
		availableModels: async () => [],
		setModel: async () => ({ isStreaming: false }),
		refreshModels: async () => ({ isStreaming: false }),
		cycleThinking: async () => ({ isStreaming: false }),
		setThinking: async () => ({ isStreaming: false }),
		...overrides,
	};
	return { session, runtime, calls, deps };
}

async function withServer(run, overrides = {}) {
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture(overrides);
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	const baseUrl = `http://127.0.0.1:${manager.current.port}`;
	try {
		await run({ ...harness, baseUrl });
	} finally {
		await manager.stop();
	}
}

test("Web service restart rebinds the configured listener", async () => {
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0);
	const port = manager.current.port;
	try {
		await manager.restart({ webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: port, webServiceRequiresAuth: false });
		const response = await fetch(`http://127.0.0.1:${port}/api/health`);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).ok, true);
	} finally {
		await manager.stop();
	}
});

test("native Session HTTP routes create drafts and send by stable Session identity", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const createResponse = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: "project-1", title: "From web" }),
		});
		const created = await createResponse.json();
		assert.equal(created.session.id, "session-1");
		assert.equal(created.session.title, "From web");
		assert.equal(calls.createDraft, 1);
		assert.equal(calls.createAgent, 0, "native Session creation must not use the legacy Agent facade");

		const promptResponse = await fetch(`${baseUrl}/api/sessions/session-1/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "request-1", message: " hello " }),
		});
		const prompted = await promptResponse.json();
		assert.equal(prompted.result.accepted, true);
		assert.equal(prompted.result.sessionId, "session-1");
		assert.equal(calls.send.length, 1);
		assert.equal(calls.send[0].message, "hello");
	});
});

test("web core routes create a project and expose the configured model list", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const projectResponse = await fetch(`${baseUrl}/api/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "C:/new-project" }),
		});
		const projectBody = await projectResponse.json();
		assert.equal(projectBody.project.id, "project-2");
		assert.deepEqual(calls.createProject, ["C:/new-project"]);

		const modelsResponse = await fetch(`${baseUrl}/api/models`);
		const modelsBody = await modelsResponse.json();
		assert.equal(modelsBody.models[0].id, "gpt-test");
	});
});

test("web state exposes pending UI requests and ui-response writes them back", async () => {
	const pending = [
		{
			sessionId: "session-1",
			agentId: "agent-1",
			runtimeGeneration: 3,
			requestId: "ask-1",
			method: "confirm",
			title: "Continue?",
		},
	];
	const responses = [];
	await withServer(
		async ({ baseUrl }) => {
			const stateResponse = await fetch(`${baseUrl}/api/state`);
			const state = await stateResponse.json();
			assert.equal(state.pendingUiRequests[0].requestId, "ask-1");

			const write = await fetch(`${baseUrl}/api/ui-response`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId: "session-1",
					agentId: "agent-1",
					runtimeGeneration: 3,
					requestId: "ask-1",
					response: { confirmed: true },
				}),
			});
			assert.equal(write.status, 200);
			assert.equal(responses[0].requestId, "ask-1");
			assert.equal(responses[0].response.confirmed, true);
		},
		{
			listPendingUiRequests: () => pending,
			respondToUi: async (input) => {
				responses.push(input);
			},
		},
	);
});

test("Web project route deletes a registered project but protects the built-in chat project", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const deleteResponse = await fetch(`${baseUrl}/api/projects/project-1/delete`, { method: "POST" });
		const deleted = await deleteResponse.json();
		assert.equal(deleted.deleted, true);
		assert.deepEqual(calls.deleteProject, ["project-1"]);
	});

	await withServer(async ({ baseUrl, deps }) => {
		deps.listProjects = () => [{ id: "builtin-chat", name: "Chat", path: "C:/chat", kind: "chat" }];
		const response = await fetch(`${baseUrl}/api/projects/builtin-chat/delete`, { method: "POST" });
		assert.equal(response.status, 400);
		const body = await response.json();
		assert.match(body.error, /built-in chat project cannot be deleted/i);
	});
});

test("runtime model listing preserves the generation-validated Session target", async () => {
	await withServer(async ({ baseUrl, runtime, calls }) => {
		const target = {
			sessionId: runtime.sessionId,
			agentId: runtime.agentId,
			runtimeGeneration: runtime.runtimeGeneration,
		};
		const response = await fetch(`${baseUrl}/api/sessions/session-1/runtime/models`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ target }),
		});
		const body = await response.json();
		assert.equal(body.result.ok, true);
		assert.equal(JSON.stringify(calls.modelTargets), JSON.stringify([target]));
	});
});

test("anonymous Session HTTP route creates a runtime-only Session record", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const response = await fetch(`${baseUrl}/api/sessions/anonymous`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: "project-1", title: "Private work" }),
		});
		const created = await response.json();
		assert.equal(created.session.id, "anonymous-1");
		assert.equal(created.session.noSession, true);
		assert.equal(created.runtime.noSession, true);
		assert.equal(calls.createAnonymous, 1);
		assert.equal(calls.createDraft, 0);
	});
});

test("runtime HTTP commands preserve the full generation-validated target", async () => {
	await withServer(async ({ baseUrl, runtime, calls }) => {
		const target = {
			sessionId: runtime.sessionId,
			agentId: runtime.agentId,
			runtimeGeneration: runtime.runtimeGeneration,
		};
		const response = await fetch(`${baseUrl}/api/sessions/session-1/runtime/state`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ target }),
		});
		const body = await response.json();
		assert.equal(body.result.ok, true);
		assert.equal(JSON.stringify(calls.stateTargets), JSON.stringify([target]));

		const mismatch = await fetch(`${baseUrl}/api/sessions/other/runtime/state`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ target }),
		});
		assert.equal(mismatch.status, 400);
	});
});

test("runtime restart streams heartbeat bytes while pending and still returns parseable JSON", async () => {
	let releaseRestart;
	const restartGate = new Promise((resolve) => {
		releaseRestart = resolve;
	});
	await withServer(
		async ({ baseUrl, runtime }) => {
			const target = {
				sessionId: runtime.sessionId,
				agentId: runtime.agentId,
				runtimeGeneration: runtime.runtimeGeneration,
			};
			const response = await fetch(`${baseUrl}/api/sessions/session-1/runtime/restart`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target }),
			});
			// 响应头先行到达：pending 期间浏览器能确认请求活着，而不是转圈黑盒。
			assert.equal(response.status, 200);
			const reader = response.body.getReader();
			// 第一个数据块应是心跳（JSON 前导空白），而不是最终结果——证明重启期间有持续字节。
			const first = await reader.read();
			assert.equal(first.done, false);
			const firstText = new TextDecoder().decode(first.value);
			assert.equal(firstText.trim(), "");
			releaseRestart();
			let rest = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				rest += new TextDecoder().decode(chunk.value);
			}
			// 前导心跳空白不影响 JSON 解析（客户端 fetch().json() 的口径）。
			const body = JSON.parse(firstText + rest);
			assert.equal(body.result.ok, true);
			assert.equal(body.result.value.restarted, true);
		},
		{
			restartSessionRuntime: async () => {
				await restartGate;
				return { ok: true, value: { restarted: true } };
			},
		},
	);
});

test("runtime rewind routes forward checkpointId/scope and keep the validated target", async () => {
	await withServer(async ({ baseUrl, runtime, calls }) => {
		const target = {
			sessionId: runtime.sessionId,
			agentId: runtime.agentId,
			runtimeGeneration: runtime.runtimeGeneration,
		};
		const listed = await (
			await fetch(`${baseUrl}/api/sessions/session-1/runtime/rewind-list`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target, limit: 20, beforeTimestamp: 500 }),
			})
		).json();
		assert.equal(listed.result.ok, true);
		assert.equal(JSON.stringify(calls.rewindTargets), JSON.stringify([target]));
		// 分页参数（limit/beforeTimestamp）应原样透传给后端。
		assert.equal(JSON.stringify(calls.rewindParams), JSON.stringify([{ limit: 20, beforeTimestamp: 500 }]));
		assert.equal(listed.result.value.value.items[0].trigger, "turn");

		const diffed = await (
			await fetch(`${baseUrl}/api/sessions/session-1/runtime/rewind-diff`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target, checkpointId: "turn-1-1-1234" }),
			})
		).json();
		assert.equal(diffed.result.value.value, "a.txt | 1 +");

		const restored = await (
			await fetch(`${baseUrl}/api/sessions/session-1/runtime/rewind-restore`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target, checkpointId: "turn-1-1-1234", scope: "files" }),
			})
		).json();
		assert.equal(restored.result.ok, true);
		assert.equal(JSON.stringify(calls.rewindRestores), JSON.stringify([{ target, checkpointId: "turn-1-1-1234", scope: "files" }]));

		const mismatch = await fetch(`${baseUrl}/api/sessions/other/runtime/rewind-list`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ target }),
		});
		assert.equal(mismatch.status, 400);
	});
});

test("catalog Session file operations are addressed only by stable Session ID", async () => {
	await withServer(async ({ baseUrl }) => {
		const copied = await (
			await fetch(`${baseUrl}/api/sessions/session-1/copy`, {
				method: "POST",
				body: "{}",
			})
		).json();
		assert.equal(copied.result.targetSessionId, "session-2");

		const exported = await (
			await fetch(`${baseUrl}/api/sessions/session-1/export-html`, {
				method: "POST",
				body: "{}",
			})
		).json();
		assert.equal(exported.result.path, "session.html");

		const references = await (await fetch(`${baseUrl}/api/sessions/session-1/reference-messages`)).json();
		assert.equal(references.messages[0].content, "reference");
	});
});

test("historical message pages stay Session-addressed and bounded", async () => {
	await withServer(
		async ({ baseUrl }) => {
			const page = await (await fetch(`${baseUrl}/api/sessions/session-1/messages/page?before=3&pageSize=2`)).json();
			assert.equal(page.total, 3);
			assert.equal(page.nextBefore, 1);
		},
		{
			readSessionMessagePage: async (sessionId, before, pageSize) => ({
				messages: [{ id: sessionId, role: "assistant", text: String(pageSize), timestamp: 1 }],
				total: 3,
				nextBefore: before === 3 ? 1 : null,
			}),
		},
	);
});

test("whole-history read endpoint returns a bounded window with truncation metadata", async () => {
	// 大会话整量读会同时顶爆主进程与渲染层（#213）：/messages 必须是「加载窗口」，
	// 并显式告诉客户端被截断、窗口起点在哪，翻更早历史走 /messages/page。
	await withServer(async ({ baseUrl }) => {
		const body = await (await fetch(`${baseUrl}/api/sessions/session-1/messages`)).json();
		assert.equal(body.messages[0].text, "window");
		assert.equal(body.total, 42);
		assert.equal(body.windowStart, 30);
		assert.equal(body.truncated, true);
	});
});

test("web polling state carries sessions/runtimes but no per-session message payloads (P0 slim)", async () => {
	await withServer(async ({ baseUrl }) => {
		const response = await fetch(`${baseUrl}/api/state`);
		const state = await response.json();
		assert.equal(state.sessions[0].id, "session-1");
		assert.equal(state.runtimes[0].runtimeGeneration, 3);
		// P0 瘦身：/api/state 不再携带任何会话消息（历史走 /messages 与 /messages/page，运行中走 SSE）
		assert.equal("messagesBySession" in state, false);
	});
});

test("the browser client accepts the real Session-first web-state contract", async () => {
	await withServer(async ({ baseUrl }) => {
		const createBrowserApi = loadBrowserApi((path, init) => fetch(new URL(path, baseUrl), init));
		const api = createBrowserApi();
		const events = [];
		const unsubscribe = api.sessions.onRuntimeEvent((event) => events.push(event));
		try {
			const projects = await api.projects.list();
			assert.equal(projects[0].id, "project-1");
			await new Promise((resolve) => setImmediate(resolve));

			const runtimeEvent = events.find((event) => event.sourceChannel === "sessions:runtime");
			assert.equal(runtimeEvent?.sessionId, "session-1");
			assert.equal(runtimeEvent?.payload.status, "idle");
			const messageEvent = events.find((event) => event.sourceChannel === "sessions:messages");
			assert.equal(messageEvent?.payload.messages[0].text, "window");
		} finally {
			unsubscribe();
		}
	});
});

test("web polling no longer pulls per-runtime message snapshots", () => {
	const source = readFileSync("src/main/web/WebServiceManager.ts", "utf8");
	// P0：deps 已删除 getSessionRuntimeMessages，/api/state 与 Agent 内存消息解耦
	assert.doesNotMatch(source, /getSessionRuntimeMessages/);
	assert.doesNotMatch(source, /getMessages\(runtime\.agentId\)/);
});

test("embedded web client and HTTP surface are Session-first", async () => {
	await withServer(async ({ baseUrl }) => {
		const page = await (await fetch(baseUrl)).text();
		assert.match(page, /navigator\.languages/);
		assert.match(page, /localizeDescriptor/);
		assert.match(page, /activeSessionId/);
		assert.match(page, /runtimeGeneration/);
		assert.match(page, /\/api\/sessions\//);
		assert.doesNotMatch(page, /\/api\/agents/);
		assert.doesNotMatch(page, /activeAgentId|messagesByAgent|data-agent/);

		const legacy = await fetch(`${baseUrl}/api/agents`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: "project-1" }),
		});
		assert.equal(legacy.status, 404);
		assert.equal((await legacy.json()).code, "webError.apiNotFound");
	});
});

test("web errors expose stable codes without leaking unknown server exceptions", async () => {
	await withServer(async ({ baseUrl, runtime }) => {
		const mismatch = await fetch(`${baseUrl}/api/sessions/other/runtime/state`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ target: runtime }),
		});
		const body = await mismatch.json();
		assert.equal(mismatch.status, 400);
		assert.equal(body.code, "webError.runtimeTargetRequired");
		assert.equal("debugDetails" in body, false);
	});

	await withServer(
		async ({ baseUrl }) => {
			const response = await fetch(`${baseUrl}/api/state`);
			const body = await response.json();
			assert.equal(response.status, 500);
			assert.equal(body.code, "webError.internal");
			assert.equal(body.error, "The web service encountered an internal error");
			assert.equal("debugDetails" in body, false);
			assert.doesNotMatch(JSON.stringify(body), /SECRET_STACK_DETAIL/);
		},
		{
			listProjects: () => {
				throw new Error("SECRET_STACK_DETAIL");
			},
		},
	);
});

test("web responses strip desktop diagnostics and raw prompt errors recursively", async () => {
	await withServer(
		async ({ baseUrl, runtime }) => {
			// P0 瘦身后诊断剥离从有界消息端点断言（/api/state 已无消息负载）
			const messagesBody = await (await fetch(`${baseUrl}/api/sessions/session-1/messages`)).json();
			assert.doesNotMatch(JSON.stringify(messagesBody), /SECRET_MESSAGE_DIAGNOSTIC/);
			assert.equal("debugDetails" in messagesBody.messages[0].meta, false);

			const prompt = await (
				await fetch(`${baseUrl}/api/sessions/session-1/prompt`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId: "request-raw-error", message: "hello" }),
				})
			).json();
			assert.equal(prompt.result.error, "Failed to send the message.");
			assert.equal("debugDetails" in prompt.result, false);
			assert.doesNotMatch(JSON.stringify(prompt), /SECRET_PROMPT_ERROR/);

			const command = await (
				await fetch(`${baseUrl}/api/sessions/session-1/runtime/state`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ target: runtime }),
				})
			).json();
			assert.equal(command.result.error.code, "SESSION_COMMAND_FAILED");
			assert.equal("debugDetails" in command.result.error, false);
			assert.doesNotMatch(JSON.stringify(command), /SECRET_COMMAND_STACK/);
		},
		{
			readSessionMessages: async () => ({
				messages: [
					{
						id: "m-secret",
						agentId: "agent-1",
						role: "error",
						text: "Request failed.",
						timestamp: 1,
						meta: {
							i18nKey: "diagnostic.requestFailedUnknown",
							debugDetails: "SECRET_MESSAGE_DIAGNOSTIC",
						},
					},
				],
				total: 1,
				windowStart: 0,
				truncated: false,
			}),
			sendSessionPrompt: async (input) => ({
				accepted: false,
				sessionId: input.sessionId,
				requestId: input.requestId,
				error: "SECRET_PROMPT_ERROR",
				i18nKey: "diagnostic.promptRejected",
				debugDetails: "SECRET_PROMPT_STACK",
			}),
			getSessionRuntimeState: async () => ({
				ok: false,
				error: {
					code: "SESSION_COMMAND_FAILED",
					debugDetails: "SECRET_COMMAND_STACK",
				},
			}),
		},
	);
});

test("SSE /stream endpoint forwards pi agent events as AI SDK UI message frames", async () => {
	// 捕获 subscribe 的 handler，模拟主进程 pi 事件派发
	let emitPiEvent = null;
	await withServer(
		async ({ baseUrl }) => {
			const controller = new AbortController();
			const response = await fetch(`${baseUrl}/api/sessions/session-1/stream`, {
				signal: controller.signal,
				headers: { accept: "text/event-stream" },
			});
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");
			assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			const readUntil = async (marker) => {
				for (;;) {
					const at = buffer.indexOf(marker);
					if (at !== -1) return buffer.slice(0, at + marker.length);
					const { done, value } = await reader.read();
					if (done) return buffer;
					buffer += decoder.decode(value, { stream: true });
				}
			};

			// 派发：消息开始 → 文本增量 → agent_settled（中间 agent_end 不再关流）
			emitPiEvent("agent-1", { type: "message_start", message: { role: "assistant", id: "m1" } });
			emitPiEvent("agent-1", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Hello" },
			});
			emitPiEvent("agent-1", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: " world" },
			});
			emitPiEvent("agent-1", { type: "agent_end", stopReason: "done" });
			emitPiEvent("agent-1", { type: "agent_settled" });

			const wire = await readUntil("data: [DONE]");
			const afterDone = await reader.read();
			assert.equal(afterDone.done, true, "the SSE response must close after [DONE]");
			const frames = wire
				.split("\n\n")
				.filter((line) => line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]")
				.map((line) => JSON.parse(line.slice(6)));
			assert.equal(frames[0].type, "start");
			assert.equal(frames[0].messageId, "m1");
			assert.equal(frames[1].type, "text-start");
			assert.equal(frames[2].type, "text-delta");
			assert.equal(frames[2].delta, "Hello");
			assert.equal(frames[3].type, "text-delta");
			assert.equal(frames[3].delta, " world");
			// 同一文本块：text-delta 复用 text-start 的 id
			assert.equal(frames[2].id, frames[1].id);
			assert.equal(frames[3].id, frames[1].id);
			assert.equal(frames[4].type, "text-end");
			assert.equal(frames[5].type, "finish");
			controller.abort();
		},
		{
			// 用可捕获的 subscribe 覆盖默认的 no-op
			subscribePiEvents: (handler) => {
				emitPiEvent = handler;
				return () => {
					emitPiEvent = null;
				};
			},
		},
	);
});

/**
 * 回归：/api/chat 必须为每一轮提交生成独立的幂等键。
 *
 * AI SDK 的 DefaultChatTransport 把 useChat 的 chatId 放在 body.id，而 Web 端把
 * chatId 直接设成了 sessionId（每轮都不变）。若服务端直接拿 body.id 当 requestId，
 * SessionRuntimeCoordinator.deliveryByRequest（TTL 10 分钟）会把第二轮起的提交
 * 当成「同一请求的重试」，直接返回上一轮缓存的 accepted 结果 —— pi 永远收不到新
 * prompt，Web 端没有任何响应，桌面端也不落盘（用户现场：一个会话只能发第一条）。
 */
test("chat endpoint mints a per-turn request idempotency key instead of reusing the chat id", async () => {
	const submit = (baseUrl, messageId, text) =>
		fetch(`${baseUrl}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({
				// DefaultChatTransport 的真实报文：id = chatId = sessionId
				id: "session-1",
				messages: [{ id: messageId, role: "user", parts: [{ type: "text", text }] }],
				trigger: "submit-message",
				messageId,
			}),
		});
	// SSE 响应不会自行结束（测试里没有 pi 事件源），只断言请求侧行为后立即断开。
	const waitFor = async (predicate) => {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("condition was not met before the timeout");
	};

	await withServer(async ({ baseUrl, calls }) => {
		const first = await submit(baseUrl, "turn-1", "first");
		assert.equal(first.status, 200);
		void first.body?.cancel().catch(() => undefined);
		await waitFor(() => calls.send.length === 1);

		const second = await submit(baseUrl, "turn-2", "second");
		assert.equal(second.status, 200);
		void second.body?.cancel().catch(() => undefined);
		await waitFor(() => calls.send.length === 2);

		const [firstTurn, secondTurn] = calls.send;
		assert.equal(firstTurn.message, "first");
		assert.equal(secondTurn.message, "second");
		// 幂等键不能复用上一轮的值，也不能退化成每轮相同的 chatId。
		assert.notEqual(firstTurn.requestId, secondTurn.requestId);
		assert.notEqual(firstTurn.requestId, "session-1");
	});
});

/**
 * 计划模式：/api/chat 必须把 body.agentMessage 原样透传给 sendSessionPrompt
 * （隐藏指令通道，由内置扩展 pi-deck-plan-mode 识别）；未携带时不得注入空字段。
 */
test("chat endpoint forwards agentMessage hidden instruction when present", async () => {
	const submit = (baseUrl, messageId, extra) =>
		fetch(`${baseUrl}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({
				id: "session-1",
				messages: [{ id: messageId, role: "user", parts: [{ type: "text", text: "帮我重构" }] }],
				trigger: "submit-message",
				messageId,
				...extra,
			}),
		});
	const waitFor = async (predicate) => {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("condition was not met before the timeout");
	};

	await withServer(async ({ baseUrl, calls }) => {
		// 隐居指令透传：内容原样到达 sendSessionPrompt
		const planned = await submit(baseUrl, "plan-1", { agentMessage: "__PI_DECK_PLAN_MODE__\n帮我重构" });
		assert.equal(planned.status, 200);
		void planned.body?.cancel().catch(() => undefined);
		await waitFor(() => calls.send.length === 1);
		assert.equal(calls.send[0].agentMessage, "__PI_DECK_PLAN_MODE__\n帮我重构");

		// 普通消息：不携带 agentMessage 字段（不注入空串，保持现有 payload 形态）
		const plain = await submit(baseUrl, "plain-1", {});
		assert.equal(plain.status, 200);
		void plain.body?.cancel().catch(() => undefined);
		await waitFor(() => calls.send.length === 2);
		assert.equal("agentMessage" in calls.send[1], false);
	});
});

// ── dev 模式静态资源代理：外部 Web 端必须加载重构后的 React 版（A2） ──

/** 起一个 mock vite dev server，记录请求路径并返回固定资源内容。 */
async function startMockDevServer() {
	const hits = [];
	const server = createHttpServer((request, response) => {
		hits.push(request.url ?? "");
		if (request.url === "/web.html") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end('<div id="dev-web">A2 React page</div>');
		} else if (request.url === "/assets/web.js") {
			response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
			response.end('console.log("dev asset");');
		} else if (request.url === "/@vite/client") {
			response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
			response.end('console.log("vite client");');
		} else if (request.url?.startsWith("/src/web-main.tsx")) {
			response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
			response.end(`console.log("entry with query: ${request.url}");`);
		} else {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("not found");
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	return {
		hits,
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/** dev 模式（devRendererUrl 已注入）下，静态请求全部代理到 vite dev server。 */
test("session activity strips routes expose file changes, subagents, and todo snapshots", async () => {
	await withServer(async ({ baseUrl }) => {
		// 与桌面 IPC 同源的三条监控路由：形状 + 按 sessionId 取数
		const files = await (await fetch(`${baseUrl}/api/sessions/session-1/file-changes`)).json();
		assert.equal(files.changes.length, 1);
		assert.equal(files.changes[0].path, "src/a.ts");

		const subs = await (await fetch(`${baseUrl}/api/sessions/session-1/subagents`)).json();
		assert.equal(subs.subagents[0].id, "sub-1");

		const todo = await (await fetch(`${baseUrl}/api/sessions/session-1/todo`)).json();
		assert.equal(todo.todo.todos[0].content, "ship it");

		const missing = await (await fetch(`${baseUrl}/api/sessions/missing-session/todo`)).json();
		assert.equal(missing.todo, null);
	});
});

test("web service dev mode proxies static assets to the renderer dev server", async () => {
	const devServer = await startMockDevServer();
	try {
		await withServer(
			async ({ baseUrl }) => {
				// 根路径 → 代理到 /web.html（外部端入口，而非桌面端 index.html）
				const page = await fetch(baseUrl + "/");
				assert.equal(page.status, 200);
				assert.match(page.headers.get("content-type") ?? "", /text\/html/);
				assert.match(await page.text(), /A2 React page/);
				// 带扩展名资源 → 原样转发
				const asset = await fetch(baseUrl + "/assets/web.js");
				assert.equal(asset.status, 200);
				assert.match(asset.headers.get("content-type") ?? "", /text\/javascript/);
				assert.equal(await asset.text(), 'console.log("dev asset");');
				// vite 内部模块（无扩展名）必须原样转发，不能被映射成 /web.html 的 HTML
				const viteClient = await fetch(baseUrl + "/@vite/client");
				assert.equal(viteClient.status, 200);
				assert.match(viteClient.headers.get("content-type") ?? "", /text\/javascript/);
				assert.equal(await viteClient.text(), 'console.log("vite client");');
				// query 参数必须保留（vite 依赖预构建/HMR 依赖 ?v= ?t= ?import）
				const withQuery = await fetch(baseUrl + "/src/web-main.tsx?v=abc&import");
				assert.equal(withQuery.status, 200);
				assert.match(await withQuery.text(), /entry with query: \/src\/web-main\.tsx\?v=abc&import/);
				assert.deepEqual(devServer.hits, ["/web.html", "/assets/web.js", "/@vite/client", "/src/web-main.tsx?v=abc&import"]);
			},
			{ devRendererUrl: devServer.baseUrl },
		);
	} finally {
		await devServer.close();
	}
});

/** dev server 不可用（如只启动了主进程）时，回退 A1 内嵌页保证服务不白屏。 */
test("web service dev mode falls back to the legacy page when dev server is down", async () => {
	// 端口 1 通常无服务监听；fetch 连接拒绝后应回退内嵌页而非 500。
	await withServer(
		async ({ baseUrl }) => {
			const page = await fetch(baseUrl + "/");
			assert.equal(page.status, 200);
			assert.match(await page.text(), /PiDeck Web Service/);
		},
		{ devRendererUrl: "http://127.0.0.1:1" },
	);
});
