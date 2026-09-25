import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function transpile(path) {
	return ts.transpileModule(require("node:fs").readFileSync(path, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: path,
	}).outputText;
}

function loadSharedWhisperRuntime() {
	const module = { exports: {} };
	vm.runInNewContext(transpile("src/shared/types/whisperRuntime.ts"), { module, exports: module.exports }, { filename: "whisperRuntime.ts" });
	return module.exports;
}

function loadSharedConfig(whisperRuntime) {
	const module = { exports: {} };
	vm.runInNewContext(
		transpile("src/shared/voiceTranscriptionConfig.ts"),
		{
			module,
			exports: module.exports,
			URL,
			require: (id) => {
				if (id === "./types/whisperRuntime") return whisperRuntime;
				throw new Error(`unexpected require: ${id}`);
			},
		},
		{ filename: "voiceTranscriptionConfig.ts" },
	);
	return module.exports;
}

function loadStoreClass(sharedConfig) {
	const module = { exports: {} };
	vm.runInNewContext(
		transpile("src/main/voice/VoiceTranscriptionConfigStore.ts"),
		{
			module,
			exports: module.exports,
			Buffer,
			require: (id) => {
				if (id === "node:fs/promises") return require("node:fs/promises");
				if (id === "node:path") return require("node:path");
				if (id === "../../shared/voiceTranscriptionConfig") return sharedConfig;
				throw new Error(`unexpected require: ${id}`);
			},
		},
		{ filename: "VoiceTranscriptionConfigStore.ts" },
	);
	return module.exports.VoiceTranscriptionConfigStore;
}

const whisperRuntime = loadSharedWhisperRuntime();
const sharedConfig = loadSharedConfig(whisperRuntime);
const VoiceTranscriptionConfigStore = loadStoreClass(sharedConfig);

test("normalizes base URLs and rejects unsafe URL forms", () => {
	assert.equal(sharedConfig.normalizeVoiceTranscriptionUrl("https://api.example.com/v1/"), "https://api.example.com/v1/audio/transcriptions");
	assert.equal(sharedConfig.normalizeVoiceTranscriptionUrl("https://api.example.com/v1/audio/transcriptions"), "https://api.example.com/v1/audio/transcriptions");
	assert.equal(sharedConfig.normalizeVoiceTranscriptionUrl("file:///tmp/api"), null);
	assert.equal(sharedConfig.normalizeVoiceTranscriptionUrl("https://user:pass@example.com/v1"), null);
	assert.equal(sharedConfig.normalizeVoiceTranscriptionUrl("https://example.com/v1?key=secret"), null);
});

test("per-engine sanitize: cloud needs baseUrl+model, local only needs a catalog model id", () => {
	// cloud 保持旧契约：缺 baseUrl/model 直接判非法。
	assert.equal(sharedConfig.sanitizeVoiceTranscriptionConfig({ engine: "cloud", baseUrl: "", model: "", language: "" }), null);
	const cloud = sharedConfig.sanitizeVoiceTranscriptionConfig({ engine: "cloud", baseUrl: "https://api.openai.com/v1", model: "whisper-1", language: "zh" });
	assert.equal(cloud.engine, "cloud");
	assert.equal(cloud.enabled, false);
	// local 不强制 baseUrl/model，但 localModelId 必须落在目录内（未知 → 默认）。
	const local = sharedConfig.sanitizeVoiceTranscriptionConfig({ engine: "local", enabled: true, localModelId: "small-q5_1", baseUrl: "", model: "" });
	assert.equal(local.engine, "local");
	assert.equal(local.enabled, true);
	assert.equal(local.localModelId, "small-q5_1");
	const badModel = sharedConfig.sanitizeVoiceTranscriptionConfig({ engine: "local", localModelId: "not-a-real-model" });
	assert.equal(badModel.localModelId, sharedConfig.DEFAULT_VOICE_TRANSCRIPTION_CONFIG.localModelId);
	// 自定义 cliPath 必须是类绝对路径且无控制字符。
	assert.equal(sharedConfig.sanitizeVoiceTranscriptionConfig({ engine: "local", cliPath: "relative/path" }), null);
	assert.equal(sharedConfig.sanitizeVoiceTranscriptionConfig({ engine: "local", cliPath: "C:\\tools\\whisper-cli.exe\u0000" }), null);
	assert.equal(sharedConfig.sanitizeVoiceTranscriptionConfig({ engine: "local", cliPath: "/usr/local/bin/whisper-cli" }).cliPath, "/usr/local/bin/whisper-cli");
});

test("local engine runtimeReady comes from isLocalReady; legacy cloud config migrates enabled=true", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-voice-config-"));
	const configPath = join(directory, "voice-transcription.json");
	let localReady = false;
	const store = new VoiceTranscriptionConfigStore({
		getConfigPath: () => configPath,
		isEncryptionAvailable: () => true,
		protect: (value) => Buffer.from(`protected:${value}`, "utf8"),
		unprotect: (value) =>
			Buffer.from(value)
				.toString("utf8")
				.replace(/^protected:/, ""),
		log: () => {},
		isLocalReady: () => localReady,
	});
	try {
		const local = await store.saveConfig({ enabled: true, engine: "local", localModelId: "base-q5_1", baseUrl: "https://api.openai.com/v1", model: "whisper-1", language: "" });
		assert.equal(local.ok, true);
		// 本地引擎的 runtimeReady 只看 isLocalReady，与是否配了云密钥无关。
		assert.equal(local.config.engine, "local");
		assert.equal(local.config.runtimeReady, false);
		localReady = true;
		assert.equal((await store.getPublicConfig()).runtimeReady, true);

		// 迁移：旧云配置无 enabled 字段但已存密钥 → 读取时视为已开启。
		await writeFile(configPath, JSON.stringify({ version: 1, baseUrl: "https://api.openai.com/v1", model: "whisper-1", language: "", protectedApiKey: "someblob" }), "utf8");
		const migrated = await store.getPublicConfig();
		assert.equal(migrated.enabled, true);
		assert.equal(migrated.engine, "cloud");
		assert.equal(migrated.runtimeReady, true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("encrypted key is redacted publicly, retained on blank save, and cleared with clear precedence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-voice-config-"));
	const configPath = join(directory, "voice-transcription.json");
	const store = new VoiceTranscriptionConfigStore({
		getConfigPath: () => configPath,
		isEncryptionAvailable: () => true,
		protect: (value) => Buffer.from(`protected:${value}`, "utf8"),
		unprotect: (value) =>
			Buffer.from(value)
				.toString("utf8")
				.replace(/^protected:/, ""),
		log: () => {},
	});
	try {
		const saved = await store.saveConfig({
			baseUrl: "https://api.example.com/v1",
			model: "whisper-1",
			language: "zh",
			apiKey: "sk-secret",
		});
		assert.equal(saved.ok, true);
		assert.equal(saved.config.hasApiKey, true);
		assert.equal("apiKey" in saved.config, false);
		assert.equal((await readFile(configPath, "utf8")).includes("sk-secret"), false);

		const retained = await store.saveConfig({
			baseUrl: "https://api.example.com/v1",
			model: "whisper-2",
			language: "",
		});
		assert.equal(retained.config.hasApiKey, true);
		assert.equal((await store.getCredentials()).apiKey, "sk-secret");

		const cleared = await store.saveConfig({
			baseUrl: "https://api.example.com/v1",
			model: "whisper-2",
			language: "",
			clearApiKey: true,
			apiKey: "must-not-win",
		});
		assert.equal(cleared.config.hasApiKey, false);
		assert.equal(await store.getCredentials(), null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects new keys without secure storage and ignores oversized encrypted fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-voice-config-"));
	const configPath = join(directory, "voice-transcription.json");
	const store = new VoiceTranscriptionConfigStore({
		getConfigPath: () => configPath,
		isEncryptionAvailable: () => false,
		protect: () => Buffer.from("unused"),
		unprotect: () => "unused",
		log: () => {},
	});
	try {
		const result = await store.saveConfig({
			baseUrl: "https://api.example.com/v1",
			model: "whisper-1",
			language: "",
			apiKey: "secret",
		});
		assert.equal(result.ok, false);
		assert.equal(result.error, "secureStorageUnavailable");
		await writeFile(
			configPath,
			JSON.stringify({
				version: 1,
				baseUrl: "https://api.example.com/v1",
				model: "whisper-1",
				language: "",
				protectedApiKey: "x".repeat(8193),
			}),
			"utf8",
		);
		assert.equal((await store.getPublicConfig()).hasApiKey, false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
