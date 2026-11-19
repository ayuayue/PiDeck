import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOST = "11111111-1111-4111-8111-111111111111";
const VERSION = "a".repeat(64);
const NEXT_VERSION = "b".repeat(64);
const modulePath = "src/renderer/src/config/remoteConfigEditorApi.ts";
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness({ probeRemoteModels } = {}) {
	const calls = [];
	let data = { providers: { p: { apiKey: "configured", baseUrl: "https://remote.test", models: [{ id: "m", contextWindow: 1000 }] } }, custom: { preserved: true } };
	let version = VERSION;
	let writeError;
	const local = () => {
		throw new Error("local config must never be touched");
	};
	const api = {
		config: {
			getRaw: async (fileName, options) => {
				calls.push({ operation: "read", fileName, options });
				return { raw: "", remote: { kind: "remote", hostId: HOST, file: fileName.replace(".json", ""), version, sha256: version, data: structuredClone(data), secrets: [{ path: "providers.p.apiKey", status: "configured" }] } };
			},
			saveRaw: async (fileName, raw, options) => {
				calls.push({ operation: "write", fileName, raw, options });
				if (writeError) throw new Error(writeError);
				return { valid: true, remote: { kind: "remote", hostId: HOST, file: fileName.replace(".json", ""), version: NEXT_VERSION, sha256: NEXT_VERSION } };
			},
			getModels: local,
			getAuth: local,
			getSettings: local,
			getTrust: local,
			saveModels: local,
			saveAuth: local,
			saveSettings: local,
		},
		projects: { getModelSpec: local },
		probeRemoteModels: probeRemoteModels ?? (async () => ({ ok: true, hostId: HOST, models: [{ provider: "p", id: "m", contextWindow: 9000 }], providers: ["p"], count: 1, at: 1 })),
	};
	const { createRemoteConfigEditorApi } = loadTsCommonJs(modulePath);
	return {
		calls,
		editor: createRemoteConfigEditorApi(api, HOST, async () => ({ ok: true })),
		setWriteError: (error) => {
			writeError = error;
		},
		setRemote: (next, nextVersion = VERSION) => {
			data = next;
			version = nextVersion;
		},
	};
}

test("SSH 表单按已读版本保存完整文档，凭据保留交给远端处理", async () => {
	const h = harness();
	const read = await h.editor.config.getModels();
	const edited = plain(read.parsed);
	edited.providers.p.models[0].contextWindow = 2000;
	delete edited.custom;
	const saved = await h.editor.config.saveModels(edited);
	assert.equal(saved.valid, true);
	const write = h.calls.find((call) => call.operation === "write");
	assert.deepEqual(plain(write.options), { target: { kind: "ssh", hostId: HOST }, expectedVersion: VERSION, document: { data: edited, secretSources: [] } });
	assert.equal(write.raw, "", "源文件正文不能意外走本机覆盖路径");
});

test("结构化和源文件草稿分别保留版本，另一视图保存后不得把旧草稿当成新版本", async () => {
	const h = harness();
	const form = await h.editor.config.getModels();
	const raw = await h.editor.rawApi.config.getRaw("models.json");
	const edited = plain(form.parsed);
	edited.providers.p.baseUrl = "https://next.test";
	await h.editor.config.saveModels(edited);
	h.setRemote(edited, NEXT_VERSION);
	await h.editor.config.getModels();
	const oldDraft = JSON.parse(raw.raw);
	oldDraft.providers.p.models.push({ id: "new-model" });
	await h.editor.rawApi.config.saveRaw("models.json", JSON.stringify(oldDraft));
	const writes = h.calls.filter((call) => call.operation === "write");
	assert.equal(writes[1].options.expectedVersion, VERSION, "stale raw draft must retain its original guard");
});

test("供应商复制和改名记录同一文件内的凭据来源，已删除的草稿目标不会提交", async () => {
	const h = harness();
	const { parsed } = await h.editor.config.getModels();
	h.editor.copyProviderSecrets("p", "renamed");
	h.editor.copyProviderSecrets("renamed", "copy");
	await h.editor.config.saveModels({ providers: { copy: parsed.providers.p } });
	assert.deepEqual(plain(h.calls.find((call) => call.operation === "write").options.document.secretSources), [{ from: ["providers", "p"], to: ["providers", "copy"] }]);
});

test("失去可信远端回执阻止再次保存，无效凭据或保留键在 IPC 前拒绝", async () => {
	const h = harness();
	await h.editor.config.getModels();
	for (const document of [[], null, JSON.parse('{"providers":{},"__proto__":{"injected":true}}')]) await assert.rejects(() => h.editor.config.saveModels(document), /FILE_INVALID/);
	assert.equal(h.calls.filter((call) => call.operation === "write").length, 0);
});

test("SSH 失败保留版本并拒绝盲重试；重新读取后才允许再次保存", async () => {
	const h = harness();
	await h.editor.config.getModels();
	h.setWriteError("REMOTE_CONFIG_RESULT_UNCONFIRMED");
	const next = { providers: {} };
	await assert.rejects(() => h.editor.config.saveModels(next), /RESULT_UNCONFIRMED/);
	h.setWriteError(undefined);
	await assert.rejects(() => h.editor.config.saveModels(next), /RESULT_UNCONFIRMED/);
	assert.equal(h.calls.filter((call) => call.operation === "write").length, 1);
	h.editor.reloadRemoteConfig();
	await h.editor.config.getModels();
	assert.equal((await h.editor.config.saveModels(next)).valid, true);
});

test("未读取的文件或认证、非法 JSON 不得写任何本机或远端配置", async () => {
	const h = harness();
	await assert.rejects(() => h.editor.config.saveModels({ providers: {} }), /VERSION_CONFLICT/);
	await assert.rejects(() => h.editor.config.saveAuth({}), /VERSION_CONFLICT/);
	await h.editor.config.getModels();
	assert.equal((await h.editor.config.saveRaw("models.json", "{ broken")).valid, false);
	assert.equal(h.calls.filter((call) => call.operation === "write").length, 0);
});

test("SSH 模型规格与拉取列表来自远程目录，不能查询本机模型或发送远程密钥", async () => {
	const h = harness();
	await h.editor.config.getModels();
	const fetched = await h.editor.config.fetchModels("https://remote.test", "configured");
	assert.equal(fetched.success, true);
	assert.equal(fetched.models[0].contextWindow, 9000);
	assert.equal((await h.editor.projects.getModelSpec("p", "m")).contextWindow, 9000);
});

test("保存后重建远端目录，旧请求不能回填缓存或交给调用方当成新目录", async () => {
	let releaseOld;
	let markStarted;
	const started = new Promise((resolve) => {
		markStarted = resolve;
	});
	const oldResult = new Promise((resolve) => {
		releaseOld = resolve;
	});
	const result = (id) => ({ ok: true, hostId: HOST, models: [{ provider: "p", id }], providers: ["p"], count: 1, at: 1 });
	let probes = 0;
	const h = harness({
		probeRemoteModels: async () => {
			probes++;
			if (probes === 1) {
				markStarted();
				return oldResult;
			}
			return result("new");
		},
	});
	await h.editor.config.getModels();
	const beforeSave = h.editor.loadRemoteModels();
	await started;
	await h.editor.config.saveModels({ providers: {} });
	const afterSave = h.editor.loadRemoteModels();
	const refused = assert.rejects(beforeSave, /VERSION_CONFLICT/);
	releaseOld(result("stale"));
	await refused;
	assert.equal((await afterSave)[0].id, "new");
	assert.equal((await h.editor.loadRemoteModels())[0].id, "new");
	assert.equal(probes, 2);
});
