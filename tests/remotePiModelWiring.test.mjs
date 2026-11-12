import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

import { preloadSource } from "./helpers/preloadSources.mjs";
import { previewApiSource } from "./helpers/previewApiSources.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
import { agentManagerSource } from "./helpers/agentManagerSources.mjs";
/**
 * Remote model catalog v1 wiring contract: one new IPC channel, one preload method, host-only input, main
 * assembly from ProjectStore -> narrow AgentManager finder -> getAvailableModels, and the renderer models-panel
 * action. Source scans are whitespace-tolerant; behavior is covered by the pure/probe suites.
 */

const IPC = "src/shared/ipc.ts";
const MAIN_INDEX = "src/main/index.ts";
const AGENT_MANAGER = "src/main/pi/AgentManager.ts";
const PROBE = "src/main/pi/RemotePiModelProbe.ts";
const IPC_MODULE = "src/main/ipc/remotePiModelIpc.ts";
const SECTION = "src/renderer/src/config/RemoteModelCatalogSection.tsx";
const PANEL = "src/renderer/src/config/RemoteConfigPanel.tsx";

const read = (path) => readFileSync(path, "utf8");

test("the new channel exists exactly once and stays in the remote: namespace", () => {
	const ipc = read(IPC);
	assert.match(ipc, /remotePiModels:\s*"remote:pi-models"/);
	assert.equal((ipc.match(/"remote:pi-models"/g) ?? []).length, 1);
});

test("preload exposes probeRemoteModels(hostId) forwarding only the host id", () => {
	const preload = preloadSource;
	assert.match(preload, /probeRemoteModels:\s*\(hostId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remotePiModels, hostId\)/);
	assert.match(preload, /RemoteModelProbeResult/);
	// No renderer-visible agentId/path parameter is added anywhere near the method.
	assert.doesNotMatch(preload, /probeRemoteModels:[\s\S]{0,200}?agentId/);
});

test("the IPC handler is a gate + single forward; disabled means unavailable, not a local fallback", () => {
	const ipc = read(IPC_MODULE);
	assert.match(ipc, /ipcMain\.handle\(ipcChannels\.remotePiModels/);
	assert.match(ipc, /if \(!input\.enabled \|\| input\.probe === undefined\) return \{ ok: false, code: REMOTE_MODEL_PROBE_CODES\.unavailable \};/);
	assert.match(ipc, /return await input\.probe\.probe\(hostId\);/);
	// Even an unexpected service throw must stay inside the closed-code contract.
	assert.match(ipc, /catch \{[\s\S]{0,160}?return \{ ok: false, code: REMOTE_MODEL_PROBE_CODES\.failed \};/);
	// The handler never constructs a project list/agent list itself: authority stays in the injected service.
	assert.doesNotMatch(ipc, /projectStore|agentManager|getAvailableModels/);
});

test("assembly resolves host -> ProjectStore remote projects -> narrow live-agent finder -> getAvailableModels", () => {
	const main = mainIpcSource;
	assert.match(main, /createRemotePiModelProbe\(\{/);
	assert.match(main, /projectIdsForHost:\s*\(hostId\)\s*=>[\s\S]{0,400}?isRemoteProject\(project\) && project\.locator\.hostId === hostId/);
	assert.match(main, /findLiveAgentId:\s*\(projectIds\)\s*=>[\s\S]{0,120}?findLiveRemoteAgentId\(projectIds\)/);
	assert.match(main, /getAvailableModels:\s*\(agentId\)\s*=>\s*agentManager\.getAvailableModels\(agentId\)/);
	assert.match(main, /registerRemotePiModelIpc\(\{ enabled: remoteFeatureEnabled, probe: remotePiModelProbe \}\)/);
});

test("the AgentManager finder is narrow: live remote runtime -> agentId only", () => {
	const manager = agentManagerSource;
	assert.match(manager, /findLiveRemoteAgentId\(projectIds: readonly string\[\]\): string \| undefined/);
	const method = manager.slice(manager.indexOf("findLiveRemoteAgentId("));
	const body = method.slice(0, method.indexOf("\n\t}\n"));
	assert.match(body, /runtime\.process\.isRunning\(\)/);
	assert.match(body, /isRemoteRuntime\(runtime\.tab\.projectId\)/);
	assert.match(body, /return agentId;/);
	// It must not hand out runtime/process/path handles or accept renderer input directly.
	assert.doesNotMatch(body, /runtime\.process\.client|runtime\.tab\.sessionPath|return runtime|hostId/);
});

test("the probe service is the only place that validates the host and does one bounded attempt", () => {
	const probe = read(PROBE);
	assert.match(probe, /PROJECT_HOST_ID_PATTERN\.test\(hostId\)/);
	assert.match(probe, /REMOTE_MODEL_PROBE_CODES\.targetInvalid/);
	assert.match(probe, /projectIdsForHost\(hostId\)/);
	assert.match(probe, /findLiveAgentId\(projectIds\)/);
	assert.match(probe, /getAvailableModels\(agentId\)/);
	assert.match(probe, /withTimeout\(/);
	assert.match(probe, /REMOTE_MODEL_PROBE_MAX_MODELS/);
	assert.match(probe, /maskEntry/);
	// No retry loop around the runtime call and no agentId in the result type.
	assert.doesNotMatch(probe, /for \(let attempt|retry\(/i);
	assert.doesNotMatch(probe, /agentId:\s*agentId/);
});

test("the renderer models panel exposes the real catalog action and keeps settings on the disabled note", () => {
	const panel = read(PANEL);
	assert.match(panel, /props\.file === "models" \? <RemoteModelCatalogSection hostId=\{props\.hostId\} \/>/);
	const section = read(SECTION);
	assert.match(section, /desktopApi\.probeRemoteModels\(props\.hostId\)/);
	assert.match(section, /data-testid="remote-model-probe"/);
	assert.match(section, /data-testid="remote-model-probe-loading"/);
	assert.match(section, /data-testid="remote-model-probe-error"/);
	assert.match(section, /data-testid="remote-model-probe-empty"/);
	assert.match(section, /data-testid="remote-model-providers"/);
	assert.match(section, /data-testid="remote-model-provider"/);
	assert.match(section, /data-testid="remote-model-entry"/);
	assert.match(section, /groupRemoteModelsByProvider/);
	assert.match(section, /remoteModelProbeErrorKey\(state\.code/);
	assert.match(read("src/renderer/src/config/remoteModelCatalogModel.ts"), /remoteModel\.errorNoRuntime/);
	// The renderer never fabricates model fields from local data/config.
	assert.doesNotMatch(section, /apiKey|baseUrl|agentId|configManager/);
	assert.match(section, /REMOTE_CONFIG_CODES\.providerOperationUnsupported/);
});

test("preview mode reports the closed unavailable code instead of a fake catalog", () => {
	const preview = previewApiSource;
	assert.match(preview, /probeRemoteModels:\s*async \(\) => \(\{ ok: false as const, code: "REMOTE_MODEL_PROBE_UNAVAILABLE" \}\)/);
});

test("i18n carries the catalog keys and the NO_RUNTIME copy tells the user to open a remote session", () => {
	const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const en = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	const keys = Object.keys(zh).filter((key) => key.startsWith("remoteModel."));
	assert.ok(keys.length >= 17, "unexpected remoteModel key count " + keys.length);
	for (const key of keys) {
		assert.ok(Object.prototype.hasOwnProperty.call(en, key), "en-US missing " + key);
		const zhPlaceholders = [...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		const enPlaceholders = [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		assert.deepEqual(zhPlaceholders, enPlaceholders, key);
	}
	assert.match(zh["remoteModel.errorNoRuntime"], /远端会话/);
	assert.match(en["remoteModel.errorNoRuntime"], /remote session/i);
	assert.match(zh["remoteModel.probeAction"], /模型目录/);
	assert.match(en["remoteModel.probeAction"], /model catalog/i);
	// The synthetic-probe/usage deferral is stated in the copy, not hidden.
	assert.match(zh["remoteModel.deferredNote"], /合成|用量/);
	assert.match(en["remoteModel.deferredNote"], /Synthetic|usage/i);
});

test("authored e2e adds the real catalog step to the product-road test without adding a test case", () => {
	const spec = read("e2e/remoteSessionAcceptance.spec.ts");
	const helper = read("e2e/remote-model-catalog.ts");
	assert.match(spec, /import \{ verifyRemoteModelCatalog \} from "\.\/remote-model-catalog"/);
	assert.match(spec, /远端模型目录：设置 → 模型 → ssh 目标 → 拉取实时目录/);
	assert.match(spec, /verifyRemoteModelCatalog\(\{ window, credentials: creds, timeoutMs: timeouts\.helperMs \}\)/);
	assert.match(helper, /getByTestId\("config-target-selector"\)/);
	assert.match(helper, /getByTestId\("remote-model-probe"\)/);
	assert.match(helper, /getByTestId\("remote-model-providers"\)/);
	assert.match(helper, /providerCount, "远端模型目录必须至少包含一个 provider"/);
	assert.match(helper, /await expect\(settings\)\.toHaveCount\(0\)/);
});
