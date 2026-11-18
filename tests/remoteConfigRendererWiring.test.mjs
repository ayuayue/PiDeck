import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";
import { systemIpcSource } from "./helpers/systemIpcSources.mjs";
import { configModalSource } from "./helpers/configModalSources.mjs";
import { remoteHostConnectionSource } from "./helpers/remoteHostConnectionSources.mjs";

/**
 * 环境切换的渲染层契约（本次重构后）：
 * - Pi 分页是唯一的环境入口（分页 + 下拉），页内不再有第二个目标选择器；
 * - 每个配置页按环境取内容：ssh = 自加载的脱敏 patch 面板（models/settings/trust/mcp），
 *   wsl = 该发行版目录下的结构化编辑器 / 文件编辑器，本机 = 原有编辑器；
 * - 关闭/切换环境时，本机草稿与远端未应用 patch 都不能静默丢失。
 *
 * 源码扫描对空白容错；行为由 remoteConfigModel / configEnvironmentModel 的纯函数测试覆盖。
 */

const SWITCH = "src/renderer/src/config/ConfigEnvironmentSwitch.tsx";
const PANEL = "src/renderer/src/config/RemoteConfigPanel.tsx";
const HOOK = "src/renderer/src/config/useRemotePiConfigPanel.ts";
const MODEL = "src/renderer/src/config/remoteConfigModel.ts";

const modal = configModalSource;
const envSwitch = readFileSync(SWITCH, "utf8");
const panel = readFileSync(PANEL, "utf8");
const hook = readFileSync(HOOK, "utf8");
const model = readFileSync(MODEL, "utf8");
const preload = preloadSource;

test("只有一个环境入口：Pi 分页上的下拉，页内不再渲染目标选择器", () => {
	assert.match(modal, /import \{ ConfigBackendSwitch, ConfigEnvironmentStatus \} from "\.\/config\/ConfigEnvironmentSwitch"/);
	assert.match(modal, /<ConfigBackendSwitch[\s\S]{0,400}?onSelectTarget=\{handleConfigTargetChange\}/);
	// 旧的页内选择器与资源目标条都已删除（重复入口会重新引入「这页切了那页没切」）。
	assert.doesNotMatch(modal, /PiConfigTargetSelector|ResourceTargetBar/);
	assert.match(envSwitch, /data-testid="config-env-trigger"/);
	assert.match(envSwitch, /data-testid="config-env-local"/);
	assert.match(envSwitch, /data-testid=\{"config-env-ssh-" \+ host\.id\}/);
	assert.match(envSwitch, /data-testid="config-env-wsl"/);
	// 环境名必须显示在分页上：整页作用域不能只靠记忆。
	assert.match(envSwitch, /data-testid="config-backend-pi-environment"/);
	assert.match(envSwitch, /data-testid="config-environment-status"/);
});

test("导航按环境能力表过滤，不给当前环境不支持的页面入口", () => {
	assert.match(modal, /const supportedConfigTabs = configTabsForTarget\(configTarget\)/);
	assert.match(modal, /allConfigNavItems\.filter\(\(item\) => supportedConfigTabs\.includes\(item\.id\)\)/);
	assert.match(modal, /const showSecurityPage = securityPageSupported\(configTarget\)/);
	assert.match(modal, /const showResourcePages = resourcePagesSupported\(configTarget\)/);
	assert.match(modal, /!resourceOnly && showSecurityPage &&/);
	assert.match(modal, /\{showResourcePages && \(/);
	// 切环境后当前页若不存在，落到该环境第一页（不留在一个导航里已经没有的 tab 上）。
	assert.match(modal, /setTab\(\(current\) => resolveConfigTabForTarget\(next, current\)\)/);
});

test("环境菜单自己会跟：分区重新可见时重读主机清单，连接失败也会推送", () => {
	// 下拉不再「从挂载到关闭只读一次」：嵌入分区隐藏时不动，每次重新可见都重读（新增主机后不用关设置重开）。
	assert.match(modal, /if \(!open \|\| !paneVisible\) return;/);
	assert.match(modal, /\}, \[open, paneVisible\]\);/);
	const settings = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
	assert.match(settings, /active=\{pane === "config"\}/, "宿主必须告知分区可见性");
	// 连接失败的推送在池化路径也要发（不建 manager 的那条分支）：否则另一视图停在旧的成功态。
	const service = remoteHostConnectionSource;
	assert.match(service, /publishPooledState\(\{ hostId, state: \{ hostId, generation: entry\.generation, state: "offline"/);
});

test("远端面板：四个文件同一套脱敏快照 + patch 编辑器，模型/设置保留各自附加块", () => {
	assert.match(panel, /data-testid="remote-config-panel"/);
	assert.match(panel, /data-testid="remote-config-version"/);
	assert.match(panel, /data-testid="remote-config-sha256"/);
	assert.match(panel, /data-testid="remote-config-secret-badge" data-status=\{secret\.status\}/);
	assert.doesNotMatch(panel, /secret\.value/);
	assert.match(panel, /data-testid="remote-config-conflict"/);
	assert.match(panel, /data-testid="remote-config-conflict-reload"/);
	assert.match(panel, /data-testid="remote-config-unconfirmed"/);
	assert.match(panel, /data-testid="remote-config-unconfirmed-reload"/);
	assert.match(panel, /data-testid="remote-config-patch"/);
	assert.match(panel, /data-testid="remote-config-save"/);
	// 文件名来自共享表（新增 trust/mcp 时不需要再改这段分支）。
	assert.match(panel, /const fileLabel = PI_CONFIG_FILE_NAMES\[props\.file\]/);
	assert.match(panel, /props\.file === "models" \? <RemoteModelCatalogSection hostId=\{props\.hostId\} \/> : props\.file === "settings" \? <RemoteConfigDeferredOperations \/> : null/);
});

test("面板 hook：一个文件级通道对覆盖四个文件，保存只用展示中的 version", () => {
	assert.match(hook, /from "\.\.\/desktopApi"/);
	assert.match(hook, /desktopApi\.config\.getRaw\(PI_CONFIG_FILE_NAMES\[file\], \{ target: \{ kind: "ssh" as const, hostId \} \}\)/);
	assert.match(hook, /desktopApi\.config\.saveRaw\(PI_CONFIG_FILE_NAMES\[file\], "", options\)/);
	assert.doesNotMatch(hook, /desktopApi\.config\.getModels|desktopApi\.config\.getSettings|desktopApi\.config\.saveModels|desktopApi\.config\.saveSettings/);
	assert.doesNotMatch(hook, /ipcRenderer|ipcChannels/);
	assert.match(hook, /expectedVersion: state\.snapshot\.version/);
	assert.match(hook, /request !== generation\.current/);
	assert.match(hook, /code === REMOTE_CONFIG_CODES\.versionConflict[\s\S]{0,120}?type: "conflict"/);
	assert.match(hook, /code === REMOTE_CONFIG_CODES\.resultUnconfirmed[\s\S]{0,120}?type: "unconfirmed"/);
});

test("receipt 校验接受四个文件键，未知键一律 invalid", () => {
	const shared = loadTsCommonJs("src/shared/piConfig.ts");
	const modelModule = loadTsCommonJs(MODEL);
	for (const file of shared.PI_CONFIG_FILES) {
		const receipt = { kind: "remote", hostId: "h", file, version: "a".repeat(64), sha256: "a".repeat(64) };
		assert.equal(modelModule.readRemoteConfigWriteReceipt({ remote: receipt }).file, file);
	}
	assert.equal(modelModule.readRemoteConfigWriteReceipt({ remote: { kind: "remote", hostId: "h", file: "auth", version: "a".repeat(64), sha256: "a".repeat(64) } }), "invalid");
});

test("reserved keys are refused in the renderer before any IPC call (A1 early guard)", () => {
	assert.match(model, /RESERVED_PATCH_KEYS[\s\S]{0,120}?"__proto__", "constructor", "prototype"/);
	assert.match(model, /containsReservedPatchKey\(parsed\)/);
	assert.match(panel, /remoteConfig\.patchReservedKey/);
});

test("disabled provider operations carry the shared closed code", () => {
	const shared = loadTsCommonJs("src/shared/piConfig.ts");
	const noticeModule = loadTsCommonJs("src/renderer/src/config/RemoteConfigUnsupportedNotice.tsx");
	assert.equal(noticeModule.REMOTE_CONFIG_DEFERRED_PROVIDER_ENTRIES.length, 1);
	assert.equal(noticeModule.REMOTE_CONFIG_DEFERRED_PROVIDER_ENTRIES[0].labelKey, "remoteConfig.disabled.usage");
	for (const entry of noticeModule.REMOTE_CONFIG_DEFERRED_PROVIDER_ENTRIES) assert.equal(entry.code, shared.REMOTE_CONFIG_CODES.providerOperationUnsupported);
	const notice = readFileSync("src/renderer/src/config/RemoteConfigUnsupportedNotice.tsx", "utf8");
	assert.match(notice, /remote-config-stable-code/);
	assert.match(notice, /\{props\.code\}/);
});

test("zh-CN and en-US carry the same environment keys with matching placeholders", () => {
	const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const en = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	const keys = Object.keys(zh).filter((key) => key.startsWith("remoteConfig.") || key.startsWith("remoteAuth.") || key.startsWith("config.target.") || key.startsWith("config.env."));
	assert.ok(keys.length >= 50, "unexpected environment key count " + keys.length);
	for (const key of keys) {
		assert.ok(Object.prototype.hasOwnProperty.call(en, key), "en-US missing " + key);
		const zhPlaceholders = [...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		const enPlaceholders = [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		assert.deepEqual(zhPlaceholders, enPlaceholders, key);
	}
	assert.equal(Object.keys(zh).length, Object.keys(en).length);
	for (const key of ["config.env.scopeLocal", "config.env.scopeWsl", "config.env.scopeSsh", "config.env.switchDirtyMessage", "config.env.mcpFileHint"]) {
		assert.ok(zh[key].length > 0, key);
		assert.ok(en[key].length > 0, key);
	}
});

test("preload forwards the file-level channel with target options and keeps the old methods intact", () => {
	assert.match(preload, /getRaw: \(fileName: string, options\?: [\s\S]{0,200}?ipcRenderer\.invoke\(ipcChannels\.configGetRaw, fileName, options\)/);
	assert.match(preload, /saveRaw: \(fileName: string, rawJson: string, options\?: [\s\S]{0,200}?ipcRenderer\.invoke\(ipcChannels\.configSaveRaw, fileName, rawJson, options\)/);
	assert.match(preload, /getModels: \(options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configGetModels, options\)/);
	assert.match(preload, /getSettings: \(options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configGetSettings, options\)/);
	assert.match(preload, /saveModels: \(data: unknown, options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configSaveModels, data, options\)/);
	assert.match(preload, /saveSettings: \(settings: Record<string, unknown>, options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configSaveSettings, settings, options\)/);
});

test("ssh 认证读取在 IPC 边界只有派生视图（remoteAuth），从不把原文当成 raw", () => {
	const ipc = systemIpcSource;
	assert.match(ipc, /routed\.kind === "remote-auth"\) return \{ raw: "", remoteAuth: routed \}/);
	assert.match(preload, /remoteAuth\?: import\("\.\.\/shared\/piConfig"\)\.RemotePiAuthSnapshot/);
});

test("A1 reserved-key refusal is aligned across renderer, main and the frozen helper", () => {
	const backend = readFileSync("src/main/config/RemotePiConfigBackend.ts", "utf8");
	const frozen = loadTsCommonJs("src/main/remote/RemoteConfigSource.ts").REMOTE_CONFIG_SOURCE;
	const helperEntry = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
	for (const key of ["__proto__", "constructor", "prototype"]) {
		assert.ok(frozen.includes(key), "frozen config.mjs must name reserved key " + key);
		assert.ok(helperEntry.REMOTE_HELPER_INLINE_SOURCE.length > 0);
	}
	assert.match(frozen, /RESERVED\s*=\s*\/\^\(\?:__proto__/);
	assert.match(backend, /key === "__proto__" \|\| key === "constructor" \|\| key === "prototype"/);
	assert.match(backend, /throw stable\(REMOTE_CONFIG_CODES\.fileInvalid\)/);
	assert.match(model, /RESERVED_PATCH_KEYS[\s\S]{0,120}?"__proto__", "constructor", "prototype"/);
	assert.doesNotMatch(model, /maxTokens|tokenizer|REMOTE_CONFIG_SECRET_KEY_PATTERN/);
	assert.doesNotMatch(panel, /REMOTE_CONFIG_SECRET_KEY_PATTERN/);
});

test("远端项目打开配置管理时默认落在它那台主机，但不经手一次静默写", () => {
	assert.match(modal, /preferredConfigTargetForProject\(activeProjectForTarget, remoteConfigHosts, configTarget\)/);
	assert.match(modal, /const activeProjectForTarget = useAtomValue\(projectByIdAtomFamily\(props\.projectId \?\? ""\)\)/);
	assert.match(modal, /if \(autoConfigTargetAppliedRef\.current\) return;/);
	assert.match(modal, /if \(!configSurfaceOpen\) \{\s*autoConfigTargetAppliedRef\.current = false;/);
	assert.match(modal, /if \(hasUnsavedConfigDrafts\(dirtyTabsRef\.current\)\) return;/);
	assert.doesNotMatch(modal, /preferredConfigTargetForProject[\s\S]{0,200}saveModels/);
});
