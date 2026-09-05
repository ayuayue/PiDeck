import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);

function loadConfigManager() {
	let content;
	const writes = [];
	const source = readFileSync("src/main/config/ConfigManager.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		AbortController,
		clearTimeout,
		exports: {},
		process: { ...process, platform: "win32" },
		setTimeout,
		require: (id) => {
			if (id === "node:fs/promises") {
				return {
					mkdir: async () => {},
					readFile: async () => {
						if (content == null) throw new Error("ENOENT");
						return content;
					},
					writeFile: async (filePath, nextContent) => {
						content = nextContent;
						writes.push({ filePath, content: nextContent });
					},
				};
			}
			if (id === "node:path") return path.win32;
			if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
			if (id === "electron") return { net: {} };
			if (id === "./baseUrlPath") {
				return {
					ensureOpenAiVersionPath: (value) => value,
					needsSessionBaseUrlVersionHint: () => false,
					suggestNormalizedBaseUrl: () => null,
				};
			}
			if (id === "../../shared/i18n/mainProcessCopy") return { mainProcessT: () => "" };
			if (id === "./parseProviderModels") return { parseProviderModelsResponse: () => [] };
			if (id === "./providerMigration") {
				return { isSafeProviderName: () => true };
			}
			if (id === "./tokendanceAttribution") {
				// saveModelsConfig 会调用归因兜底（仅依赖纯常量，无副作用），加载真实实现避免原生 require 找不到 .ts
				return loadTsCommonJs("src/main/config/tokendanceAttribution.ts");
			}
			// 用量探针传输层抽取（6d9e2294）后新增的依赖；trust 测试不调用用量探测，空实现即可
			if (id === "./usageProbeTransport") {
				return { usageProbeRequest: async () => { throw new Error("stub"); } };
			}
			if (id === "./userUsageProbes") {
				return {
					loadUserUsageProbes: async () => [],
					loadUsageProbeSettings: async () => ({ errors: [] }),
				};
			}
			if (id === "./providerUsageResolver") {
				return { resolveProviderUsageEndpoint: async () => ({ provider: "", matched: false }) };
			}
			if (id === "./usageProbeTemplates") {
				return {
					buildDeclarativeUsageProbeTemplate: () => ({ error: "stub" }),
					USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID: {},
				};
			}
			if (id === "../pi/piAiBuiltinCatalog") {
				return { getPiAiCatalogIndex: () => ({}) };
			}
			if (id === "./mcpConfig") {
				return {
					loadMcpConfigSnapshot: () => null,
					mcpDocsUrl: "",
					probeMcpServer: async () => ({ ok: false }),
					validateMcpConfigFile: () => undefined,
				};
			}
			if (id === "./providerUsageProbe") {
				return {
					candidateApplies: () => false,
					parseUsageResponseBody: () => null,
					USAGE_PROBE_CANDIDATES: [],
					usageProbeUrls: () => [],
				};
			}
			if (id === "../../shared/dshCredentialRef") {
				return { credentialRefFor: () => "STUB_API_KEY" };
			}
			if (id === "../dsh/pideckDshHome") {
				return { pideckUsageProbesDir: (value) => value };
			}
			// ConfigManager 依赖 ../../shared/dshProviderNames 的 normalizeDshDeepseekProvider；.ts 经 node 类型剥离可 require。
			if (id === "../../shared/dshProviderNames") {
				return require("../src/shared/dshProviderNames.ts");
			}
			// ConfigManager 依赖 ./dshUsageEndpoint；其依赖（dshCredentialRef/dshProviderNames/providerMigration）均已被上面 stub。
			if (id === "./dshUsageEndpoint") {
				const src = readFileSync("src/main/config/dshUsageEndpoint.ts", "utf8");
				const out = ts.transpileModule(src, {
					compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
				}).outputText;
				const m = { exports: {} };
				vm.runInNewContext(out, {
					...sandbox,
					module: m,
					exports: m.exports,
					require: sandbox.require,
				}, { filename: "dshUsageEndpoint.ts" });
				return m.exports;
			}
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "ConfigManager.ts" });
	return { ...sandbox.exports, getContent: () => content, writes };
}

test("preserves POSIX WSL trust keys under Windows path semantics", async () => {
	const { ConfigManager, getContent, writes } = loadConfigManager();
	const manager = new ConfigManager("C:\\PiDeck\\config");

	await manager.ensureTrustedDirectory("/root/ba_cli/");
	assert.deepEqual(JSON.parse(getContent()), { "/root/ba_cli": true });
	assert.equal(await manager.getProjectTrustDecision("/root/ba_cli/subdir"), true);

	await manager.setProjectTrustDecision("/root/ba_cli/subdir/../private", false);
	assert.deepEqual(JSON.parse(getContent()), {
		"/root/ba_cli": true,
		"/root/ba_cli/private": false,
	});
	assert.equal(await manager.getProjectTrustDecision("/root/ba_cli/private/nested"), false);
	assert.equal(writes.every((write) => write.filePath === "C:\\PiDeck\\config\\trust.json"), true);
});

test("retains case-insensitive matching for native Windows trust keys", async () => {
	const { ConfigManager } = loadConfigManager();
	const manager = new ConfigManager("C:\\PiDeck\\config");

	await manager.setProjectTrustDecision("C:\\Repo", true);
	assert.equal(await manager.getProjectTrustDecision("c:\\repo\\child"), true);
});
