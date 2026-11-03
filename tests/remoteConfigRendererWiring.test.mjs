import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Batch B renderer wiring contract: the target selector, remote panel, disabled-page copy and ConfigModal
 * integration. Source scans are whitespace-tolerant; behavior that can be pure is covered by
 * remoteConfigModel.test.mjs instead.
 *
 * At this checkpoint the preload passthrough is deliberately absent (security addendum A1/A2 must land first),
 * so this suite also pins the fail-closed routing boundary.
 */

const CONFIG_MODAL = "src/renderer/src/ConfigModal.tsx";
const SELECTOR = "src/renderer/src/config/PiConfigTargetSelector.tsx";
const PANEL = "src/renderer/src/config/RemoteConfigPanel.tsx";
const HOOK = "src/renderer/src/config/useRemotePiConfigPanel.ts";
const NOTICE = "src/renderer/src/config/RemoteConfigUnsupportedNotice.tsx";
const MODEL = "src/renderer/src/config/remoteConfigModel.ts";
const PRELOAD = "src/preload/index.ts";

const modal = readFileSync(CONFIG_MODAL, "utf8");
const selector = readFileSync(SELECTOR, "utf8");
const panel = readFileSync(PANEL, "utf8");
const hook = readFileSync(HOOK, "utf8");
const notice = readFileSync(NOTICE, "utf8");
const model = readFileSync(MODEL, "utf8");
const preload = readFileSync(PRELOAD, "utf8");

test("the selector offers local plus verified, non-disabled hosts and stays a shadcn Select", () => {
	assert.match(selector, /from "\.\.\/components\/ui-shadcn\/select"/);
	assert.doesNotMatch(selector, /<select[\s>]/);
	assert.match(selector, /data-testid="config-target-bar"/);
	assert.match(selector, /data-testid="config-target-selector"/);
	assert.match(selector, /data-testid="config-target-local"/);
	assert.match(selector, /data-testid=\{"config-target-ssh-" \+ host\.id\}/);
	assert.match(selector, /if \(!configTargetBarVisible\(target, props\.hosts\)\) return null;/);
	assert.match(selector, /t\("config\.target\.local"\)/);
	// The selector only emits the target union; it never calls IPC itself.
	assert.doesNotMatch(selector, /desktopApi|ipcRenderer/);
});

test("ConfigModal integration keeps the local tab bodies and swaps only the remote target", () => {
	// Host list: existing channel, filtered before it can become a target option.
	assert.match(modal, /api\.remoteHosts\s*\.list\(\)/);
	assert.match(modal, /hosts\.filter\(\(host\) => host\.verified && !host\.disabled\)/);
	assert.match(modal, /setRemoteConfigHosts\(/);
	// Selector is inside the config content, shared by models and settings.
	const selectorRenders = modal.match(/<PiConfigTargetSelector target=\{configTarget\} hosts=\{remoteConfigHosts\} disabled=\{saving\} onChange=\{handleConfigTargetChange\} \/>/g) ?? [];
	assert.equal(selectorRenders.length, 2, "models and settings each render one selector");
	// Remote panel only for an ssh target; local ModelsTab/SettingsTab remain in the other branch.
	assert.match(modal, /remoteTargetHostId \? \([\s\S]{0,400}?<RemoteConfigPanel key=\{"remote-models-"/);
	assert.match(modal, /remoteTargetHostId \? \([\s\S]{0,400}?<RemoteConfigPanel key=\{"remote-settings-"/);
	assert.match(modal, /<ModelsTab[\s\S]{0,2000}?<\/RemoteConfigPanel>|\<ModelsTab/);
	assert.match(modal, /<SettingsTab/);
	// auth/trust/mcp/raw are replaced by stable-code copy for ssh targets.
	for (const tab of ["auth", "trust", "mcp", "raw"]) {
		assert.match(modal, new RegExp("REMOTE_CONFIG_UNSUPPORTED_TAB_COPY\\." + tab + "\\.bodyKey"), tab);
		assert.match(modal, new RegExp("REMOTE_CONFIG_UNSUPPORTED_TAB_COPY\\." + tab + "\\.code"), tab);
		assert.match(modal, new RegExp('testId="remote-config-unsupported-' + tab + '"'), tab);
	}
	// A remote target can never be written by the local unified save path.
	assert.match(modal, /if \(configTarget\.kind === "ssh"\) return;/);
	assert.match(modal, /disabled=\{saving \|\| configTarget\.kind === "ssh"\}/);
});

test("switching target or closing with an unapplied remote patch requires explicit confirmation", () => {
	assert.match(modal, /const \[pendingTargetSwitch, setPendingTargetSwitch\] = useState<PiConfigTarget \| null>\(null\)/);
	assert.match(modal, /if \(remoteConfigDirty\) \{[\s\S]{0,120}?setPendingTargetSwitch\(next\);/);
	assert.match(modal, /applyPendingTargetSwitch/);
	assert.match(modal, /t\("config\.target\.switchMessage"\)/);
	assert.match(modal, /const \[remoteDiscardConfirmOpen, setRemoteDiscardConfirmOpen\] = useState\(false\)/);
	assert.match(modal, /t\("config\.target\.discardMessage"\)/);
	// Closing route: local dirty first, then remote dirty, then plain close.
	assert.match(modal, /else if \(remoteConfigDirty\) \{[\s\S]{0,120}?setRemoteDiscardConfirmOpen\(true\);/);
	// Embedded shell saveAllDirty cannot silently drop a remote-only draft.
	assert.match(modal, /if \(dirtyTabs\.size === 0 && remoteConfigDirty\) return false;/);
});

test("the remote panel renders only sanitized snapshot metadata, never secret values", () => {
	assert.match(panel, /data-testid="remote-config-panel"/);
	assert.match(panel, /data-testid="remote-config-version"/);
	assert.match(panel, /data-testid="remote-config-sha256"/);
	assert.match(panel, /data-testid="remote-config-secret-badge" data-status=\{secret\.status\}/);
	assert.match(panel, /t\("remoteConfig\.secretConfigured"\)/);
	assert.match(panel, /t\("remoteConfig\.secretMissing"\)/);
	// The badge renders the status string only; there is no secret-value field in the DTO/panel.
	assert.doesNotMatch(panel, /secret\.value/);
	// Conflict keeps the draft (no reset) and offers an explicit reload; unconfirmed offers reload only.
	assert.match(panel, /data-testid="remote-config-conflict"/);
	assert.match(panel, /data-testid="remote-config-conflict-reload"/);
	assert.match(panel, /data-testid="remote-config-unconfirmed"/);
	assert.match(panel, /data-testid="remote-config-unconfirmed-reload"/);
	// Patch editor + explicit apply; version is supplied by the hook, not typed by the user.
	assert.match(panel, /data-testid="remote-config-patch"/);
	assert.match(panel, /data-testid="remote-config-save"/);
	assert.doesNotMatch(panel, /expectedVersion.*CodeMirror|CodeMirror.*expectedVersion/);
	// The models file gets the real live-runtime catalog action; settings keeps the usage-disabled note.
	assert.match(panel, /props\.file === "models" \? <RemoteModelCatalogSection hostId=\{props\.hostId\} \/> : <RemoteConfigDeferredOperations \/>/);
});

test("the hook is fail-closed until the security A-fix wires preload, and never guesses a version", () => {
	// Routing is wired only through the four existing methods with the shared target options (post A-fix).
	assert.match(hook, /from "\.\.\/desktopApi"/);
	assert.match(hook, /desktopApi\.config\.getModels\(\{ target \}\)/);
	assert.match(hook, /desktopApi\.config\.getSettings\(\{ target \}\)/);
	assert.match(hook, /desktopApi\.config\.saveModels\(\{ providers: \{\} \}, options\)/);
	assert.match(hook, /desktopApi\.config\.saveSettings\(\{\}, options\)/);
	assert.doesNotMatch(hook, /ipcRenderer|ipcChannels/);
	// The save call must use the displayed snapshot's version.
	assert.match(hook, /expectedVersion: state\.snapshot\.version/);
	// Generation guard prevents a late answer for an old host/file from overwriting state.
	assert.match(hook, /generation\.current/);
	assert.match(hook, /request !== generation\.current/);
	// Closed-code branching: conflict keeps draft; unconfirmed blocks retry.
	assert.match(hook, /code === REMOTE_CONFIG_CODES\.versionConflict[\s\S]{0,120}?type: "conflict"/);
	assert.match(hook, /code === REMOTE_CONFIG_CODES\.resultUnconfirmed[\s\S]{0,120}?type: "unconfirmed"/);
});

test("reserved keys are refused in the renderer before any IPC call (A1 early guard)", () => {
	assert.match(model, /RESERVED_PATCH_KEYS[\s\S]{0,120}?"__proto__", "constructor", "prototype"/);
	assert.match(model, /containsReservedPatchKey\(parsed\)/);
	assert.match(panel, /remoteConfig\.patchReservedKey/);
});

test("disabled provider operations and unsupported pages carry the shared closed codes", () => {
	const shared = loadTsCommonJs("src/shared/piConfig.ts");
	const noticeModule = loadTsCommonJs(NOTICE);
	// Provider test/model fetch are now the real live-runtime catalog action (models panel only); only the usage
	// query remains in the disabled list.
	assert.equal(noticeModule.REMOTE_CONFIG_DEFERRED_PROVIDER_ENTRIES.length, 1);
	assert.equal(noticeModule.REMOTE_CONFIG_DEFERRED_PROVIDER_ENTRIES[0].labelKey, "remoteConfig.disabled.usage");
	for (const entry of noticeModule.REMOTE_CONFIG_DEFERRED_PROVIDER_ENTRIES) assert.equal(entry.code, shared.REMOTE_CONFIG_CODES.providerOperationUnsupported);
	for (const tab of ["auth", "trust", "mcp", "raw"]) assert.equal(noticeModule.REMOTE_CONFIG_UNSUPPORTED_TAB_COPY[tab].code, shared.REMOTE_CONFIG_CODES.unsupported);
	// Stable code is rendered, not only in a title attribute.
	assert.match(notice, /remote-config-stable-code/);
	assert.match(notice, /\{props\.code\}/);
});

test("zh-CN and en-US carry the same Batch B keys with matching placeholders", () => {
	const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const en = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	const keys = Object.keys(zh).filter((key) => key.startsWith("remoteConfig.") || key.startsWith("config.target."));
	assert.ok(keys.length >= 45, "unexpected Batch B key count " + keys.length);
	for (const key of keys) {
		assert.ok(Object.prototype.hasOwnProperty.call(en, key), "en-US missing " + key);
		const zhPlaceholders = [...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		const enPlaceholders = [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		assert.deepEqual(zhPlaceholders, enPlaceholders, key);
	}
	// Both sides of the dictionary have exactly the same key universe (no orphan en keys).
	assert.equal(Object.keys(zh).length, Object.keys(en).length);
	assert.ok(zh["remoteConfig.title"].includes("{file}"));
	assert.ok(en["remoteConfig.title"].includes("{file}"));
	assert.ok(zh["remoteConfig.errorCode"].includes("{code}"));
	assert.ok(en["remoteConfig.errorCode"].includes("{code}"));
});

test("preload forwards optional target options on the four existing methods (no new channel)", () => {
	assert.match(preload, /getModels: \(options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configGetModels, options\)/);
	assert.match(preload, /getSettings: \(options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configGetSettings, options\)/);
	assert.match(preload, /saveModels: \(data: unknown, options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configSaveModels, data, options\)/);
	assert.match(preload, /saveSettings: \(settings: Record<string, unknown>, options\?: [\s\S]{0,160}?\) =>\s*ipcRenderer\.invoke\(ipcChannels\.configSaveSettings, settings, options\)/);
	// Local calls stay valid (options optional) and no fifth channel is introduced.
	assert.match(preload, /remote\?: import\("\.\.\/shared\/piConfig"\)\.RemotePiConfigSnapshot/);
	assert.match(preload, /remote\?: import\("\.\.\/shared\/piConfig"\)\.RemotePiConfigWriteReceipt/);
	assert.doesNotMatch(preload, /configGetModelsRemote|configSaveModelsRemote/);
});

test("A1 reserved-key refusal is aligned across renderer, main and the frozen helper", () => {
	const backend = readFileSync("src/main/config/RemotePiConfigBackend.ts", "utf8");
	const frozen = loadTsCommonJs("src/main/remote/RemoteConfigSource.ts").REMOTE_CONFIG_SOURCE;
	const helperEntry = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
	// The helper rejects reserved keys before merging; the main validator rejects them before any transport call.
	for (const key of ["__proto__", "constructor", "prototype"]) {
		assert.ok(frozen.includes(key), "frozen config.mjs must name reserved key " + key);
		assert.ok(helperEntry.REMOTE_HELPER_INLINE_SOURCE.length > 0);
	}
	assert.match(frozen, /RESERVED\s*=\s*\/\^\(\?:__proto__/);
	assert.match(backend, /key === "__proto__" \|\| key === "constructor" \|\| key === "prototype"/);
	assert.match(backend, /throw stable\(REMOTE_CONFIG_CODES\.fileInvalid\)/);
	// The renderer refuses the same names recursively before building any request (model test covers behavior).
	assert.match(model, /RESERVED_PATCH_KEYS[\s\S]{0,120}?"__proto__", "constructor", "prototype"/);
	// A2 alignment: the renderer never re-implements the secret matcher (it only renders helper statuses).
	assert.doesNotMatch(model, /maxTokens|tokenizer|REMOTE_CONFIG_SECRET_KEY_PATTERN/);
	assert.doesNotMatch(panel, /REMOTE_CONFIG_SECRET_KEY_PATTERN/);
});

test("authored e2e covers remote read + one non-secret patch without adding a test case", () => {
	const spec = readFileSync("e2e/remoteSessionAcceptance.spec.ts", "utf8");
	const helper = readFileSync("e2e/remote-config.ts", "utf8");
	assert.match(spec, /import \{ verifyRemoteConfig \} from "\.\/remote-config"/);
	assert.match(spec, /await test\.step\("远端配置：目标选择器 → 脱敏读取（version\/密钥徽标）→ 一次非密钥 patch → 认证页禁用副本"/);
	assert.match(spec, /verifyRemoteConfig\(\{ window: remoteWindow, credentials: creds, runId: paths\.runId, timeoutMs: timeouts\.helperMs \}\)/);
	// The authored helper drives the real UI contract ids and only adds an explicitly unique marker patch.
	assert.match(helper, /getByTestId\("config-target-selector"\)/);
	assert.match(helper, /getByTestId\("remote-config-version"\)/);
	assert.match(helper, /getByTestId\("remote-config-secret-badge"\)/);
	assert.match(helper, /getByTestId\("remote-config-patch"\)/);
	assert.match(helper, /getByTestId\("remote-config-save"\)/);
	assert.match(helper, /pideckE2eMarker/);
	// Real-host safety: backup before, byte-compare/restore in finally, and no existing user field touched.
	assert.match(helper, /base64 < "\$d\/models\.json"/);
	assert.match(helper, /const restoreCommand = wasPresent[\s\S]{0,300}?base64 -d < /);
	assert.match(helper, /finally \{[\s\S]{0,300}?runRemoteCommand\(credentials, restoreCommand/);
	assert.match(helper, /finally 必须把远端 models\.json 还原成测试前的字节/);
	assert.match(helper, /REMOTE_CONFIG_UNSUPPORTED/);
});
