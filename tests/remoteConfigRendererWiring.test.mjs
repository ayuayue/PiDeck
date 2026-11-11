import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 环境切换的渲染层契约（本次重构后）：
 * - Pi 分页是唯一的环境入口（分页 + 下拉），页内不再有第二个目标选择器；
 * - 每个配置页按环境取内容：ssh = 自加载的脱敏 patch 面板（models/settings/trust/mcp），
 *   wsl = 该发行版目录下的结构化编辑器 / 文件编辑器，本机 = 原有编辑器；
 * - 关闭/切换环境时，本机草稿与远端未应用 patch 都不能静默丢失。
 *
 * 源码扫描对空白容错；行为由 remoteConfigModel / configEnvironmentModel 的纯函数测试覆盖。
 */

const CONFIG_MODAL = "src/renderer/src/ConfigModal.tsx";
const SWITCH = "src/renderer/src/config/ConfigEnvironmentSwitch.tsx";
const PANEL = "src/renderer/src/config/RemoteConfigPanel.tsx";
const HOOK = "src/renderer/src/config/useRemotePiConfigPanel.ts";
const MODEL = "src/renderer/src/config/remoteConfigModel.ts";
const PRELOAD = "src/preload/index.ts";

const modal = readFileSync(CONFIG_MODAL, "utf8");
const envSwitch = readFileSync(SWITCH, "utf8");
const panel = readFileSync(PANEL, "utf8");
const hook = readFileSync(HOOK, "utf8");
const model = readFileSync(MODEL, "utf8");
const preload = readFileSync(PRELOAD, "utf8");

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

test("导航按环境能力表过滤：ssh 只剩文件页（含只读认证），资源/安全页不给死入口", () => {
	assert.match(modal, /const supportedConfigTabs = configTabsForTarget\(configTarget\)/);
	assert.match(modal, /allConfigNavItems\.filter\(\(item\) => supportedConfigTabs\.includes\(item\.id\)\)/);
	assert.match(modal, /const showSecurityPage = securityPageSupported\(configTarget\)/);
	assert.match(modal, /const showResourcePages = resourcePagesSupported\(configTarget\)/);
	assert.match(modal, /!resourceOnly && showSecurityPage &&/);
	assert.match(modal, /\{showResourcePages && \(/);
	// 切环境后当前页若不存在，落到该环境第一页（不留在一个导航里已经没有的 tab 上）。
	assert.match(modal, /setTab\(\(current\) => resolveConfigTabForTarget\(next, current\)\)/);
});

test("每个配置页按环境取内容：ssh 面板 ×4，wsl 走该发行版目录，本机保持原编辑器", () => {
	// ssh：四个页都是自加载面板（导航已保证不会渲染本机编辑器）。
	for (const file of ["models", "settings", "trust", "mcp"]) {
		assert.match(modal, new RegExp('file="' + file + '" hostId=\\{remoteTargetHostId\\}'), file);
	}
	// ssh 没有源文件页：raw 分支不再有 remoteTargetHostId 的禁用副本。
	assert.doesNotMatch(modal, /remote-config-unsupported-raw|remote-config-unsupported-trust|remote-config-unsupported-mcp/);
	// ssh 的认证页存在但只读：派生视图面板，不是本机 AuthTab（否则会把本机凭据当成那台主机的）。
	assert.match(modal, /<RemoteAuthPanel key=\{"remote-auth-" \+ remoteTargetHostId\} hostId=\{remoteTargetHostId\} hostLabel=\{remoteHostLabel\} \/>/);
	// wsl：auth/trust 读该发行版原文，mcp 是文件编辑，raw 覆盖五个文件。
	assert.match(modal, /api\.config\.getRaw\("auth\.json", configTargetOption\)/);
	assert.match(modal, /api\.config\.getRaw\("trust\.json", configTargetOption\)/);
	assert.match(modal, /api\.config\.getRaw\("mcp\.json", configTargetOption\)/);
	assert.match(modal, /api\.config\.getRaw\(fileName, configTargetOption\)/);
	assert.match(modal, /showFileSelector=\{false\}/);
	// provider 探针只从本机网络出口发起：非本机环境即使读到 key 也不发发现请求。
	assert.match(modal, /configTarget\.kind === "local" && authRes/);
	// ssh 目标下 loadConfig 一次本地读盘都不走。
	assert.match(modal, /if \(configTarget\.kind === "ssh"\) return;/);
	// 环境切换必须驱动一次整页重读：local↔ssh 的 target 选项都是 undefined，只靠 loadConfig 身份变化不够。
	assert.match(modal, /const configTargetIdentity = configTargetKey\(configTarget\)/);
	assert.match(modal, /bumpResourceGeneration, resourceTarget, configTargetIdentity\]\)/);
});

test("ssh 认证面板：只读派生视图，没有任何写入/凭据值通道", () => {
	const authPanel = readFileSync("src/renderer/src/config/RemoteAuthPanel.tsx", "utf8");
	assert.match(authPanel, /data-testid="remote-auth-panel"/);
	assert.match(authPanel, /data-testid="remote-auth-readonly"/);
	assert.match(authPanel, /data-testid="remote-auth-provider"/);
	// 只走源文件级的按目标读取，不碰本机认证链路，也不发任何写入。
	assert.match(authPanel, /desktopApi\.config\.getRaw\("auth\.json", \{ target: \{ kind: "ssh" as const, hostId \} \}\)/);
	assert.doesNotMatch(authPanel, /saveRaw|saveAuth|saveModels|saveSettings|expectedVersion|markDirty/);
	// 凭据值没有任何展示位（只有 configured/missing 与类型）。
	assert.doesNotMatch(authPanel, /secret\.value|provider\.key|provider\.access/);
	// 主机连接与「先确保在线再读」与其它远端面板同一条路径。
	assert.match(authPanel, /const ready = await ensureConnected\(props\.hostId\)/);
	assert.match(authPanel, /request !== generation\.current/);
});

test("环境菜单自己会跟：分区重新可见时重读主机清单，连接失败也会推送", () => {
	// 下拉不再「从挂载到关闭只读一次」：嵌入分区隐藏时不动，每次重新可见都重读（新增主机后不用关设置重开）。
	assert.match(modal, /if \(!open \|\| !paneVisible\) return;/);
	assert.match(modal, /\}, \[open, paneVisible\]\);/);
	const settings = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
	assert.match(settings, /active=\{pane === "config"\}/, "宿主必须告知分区可见性");
	// 连接失败的推送在池化路径也要发（不建 manager 的那条分支）：否则另一视图停在旧的成功态。
	const service = readFileSync("src/main/remote/RemoteHostConnectionService.ts", "utf8");
	assert.match(service, /publishPooledState\(\{ hostId, state: \{ hostId, generation: entry\.generation, state: "offline"/);
});

test("切环境有显式确认：保存并切换 / 放弃并切换 / 取消，远端 patch 不给假保存", () => {
	assert.match(modal, /const \[pendingEnvSwitch, setPendingEnvSwitch\] = useState/);
	assert.match(modal, /data-testid="config-env-switch-confirm"/);
	assert.match(modal, /data-testid="config-env-switch-save"/);
	assert.match(modal, /data-testid="config-env-switch-discard"/);
	assert.match(modal, /t\("config\.env\.switchDirtyMessage", \{ count: pendingEnvSwitch\.dirtyKeys\.length \}\)/);
	assert.match(modal, /t\("config\.env\.switchDirtyRemote"\)/);
	// 纯远端 patch 时只能丢弃（本机保存链路到不了远端）。
	assert.match(modal, /pendingEnvSwitch\.dirtyKeys\.every\(\(key\) => key\.startsWith\("remote:"\)\) \? null :/);
	// 关闭窗口：本机草稿优先走保存确认，其次才是远端 patch 的丢弃确认。
	assert.match(modal, /else if \(remoteConfigDirty\) \{[\s\S]{0,120}?setRemoteDiscardConfirmOpen\(true\);/);
	assert.match(modal, /if \(dirtyTabs\.size === 0 && remoteConfigDirty\) return false;/);
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
	const ipc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
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

test("authored e2e drives the environment dropdown and the trust/mcp panels", () => {
	const spec = readFileSync("e2e/remoteSessionAcceptance.spec.ts", "utf8");
	const helper = readFileSync("e2e/remote-config.ts", "utf8");
	assert.match(spec, /import \{ verifyRemoteConfig \} from "\.\/remote-config"/);
	assert.match(spec, /await test\.step\("远端配置：Pi 环境下拉选中主机 → 脱敏读取（version\/密钥徽标）→ 一次非密钥 patch → 信任\/MCP 同套面板"/);
	assert.match(spec, /verifyRemoteConfig\(\{ window: remoteWindow, credentials: creds, runId: paths\.runId, timeoutMs: timeouts\.helperMs \}\)/);
	assert.match(helper, /getByTestId\("config-env-trigger"\)/);
	assert.match(helper, /getByTestId\("config-environment-status"\)/);
	assert.match(helper, /getByTestId\("remote-config-version"\)/);
	assert.match(helper, /getByTestId\("remote-config-secret-badge"\)/);
	assert.match(helper, /getByTestId\("remote-config-patch"\)/);
	assert.match(helper, /getByTestId\("remote-config-save"\)/);
	assert.match(helper, /data-file", "trust"/);
	assert.match(helper, /data-file", "mcp"/);
	assert.match(helper, /pideckE2eMarker/);
	assert.match(helper, /base64 < "\$d\/models\.json"/);
	assert.match(helper, /const restoreCommand = wasPresent[\s\S]{0,300}?base64 -d < /);
	assert.match(helper, /finally \{[\s\S]{0,300}?runRemoteCommand\(credentials, restoreCommand/);
	assert.match(helper, /finally 必须把远端 models\.json 还原成测试前的字节/);
});

test("远端项目打开配置管理时默认落在它那台主机，但不经手一次静默写", () => {
	assert.match(modal, /preferredConfigTargetForProject\(activeProjectForTarget, remoteConfigHosts, configTarget\)/);
	assert.match(modal, /const activeProjectForTarget = useAtomValue\(projectByIdAtomFamily\(props\.projectId \?\? ""\)\)/);
	assert.match(modal, /if \(autoConfigTargetAppliedRef\.current\) return;/);
	assert.match(modal, /if \(!configSurfaceOpen\) \{\s*autoConfigTargetAppliedRef\.current = false;/);
	assert.match(modal, /if \(hasUnsavedConfigDrafts\(dirtyTabsRef\.current\) \|\| remoteConfigDirty\) return;/);
	assert.doesNotMatch(modal, /preferredConfigTargetForProject[\s\S]{0,200}saveModels/);
});
