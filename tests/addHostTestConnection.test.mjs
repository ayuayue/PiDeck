import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 「添加连接」失败可读性 + 「测试连接」入口（用户反馈）。
 *
 * 现场：本地 `ssh -i key ubuntu@host` 能连，PiDeck 添加却报 SSH_HOST_AUTHENTICATION_FAILED，
 * 而且对话框只有一个「添加并连接」，失败后不知道是哪一步错了。
 *
 * 契约：
 * 1. 失败码必须被翻译成人话（私钥被拒 / 私钥读不了 / 私钥带口令 / 网络不通 四类分别给下一步）；
 * 2. 表单里能先「测试连接」，不落库、不写 pin；
 * 3. 密码方式不做假测试（探针不接受交互式密码），按钮禁用并说明原因。
 */
const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const shared = readFileSync("src/shared/ipc.ts", "utf8");
const main = readFileSync("src/main/ipc/remoteHostIpc.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("失败码被翻译成可行动的说明，而不是只显示稳定码", () => {
	for (const code of ["SSH_AUTH_KEY_REJECTED", "SSH_AUTH_KEY_UNREADABLE", "SSH_AUTH_PASSPHRASE_REQUIRED", "SSH_HOST_UNREACHABLE", "SSH_HOST_COMMAND_TIMEOUT", "SSH_HOST_AUTHENTICATION_FAILED", "REMOTE_HOST_IDENTITY_FILE_INVALID", "INVALID_SSH_LOCAL_PATH"]) {
		assert.ok(dialog.includes(`case "${code}"`), `code ${code} must map to copy`);
	}
	// 防回退：submit 失败不能再只显示 `{code}` 占位。
	assert.doesNotMatch(dialog, /setError\(t\("settings\.connections\.add\.failed", \{ code: result\.code \}\)\)/);
	assert.match(dialog, /setError\(addFailureReason\(result\.code\)\)/);
	for (const key of ["keyRejected", "keyUnreadable", "passphraseRequired", "unreachable", "timeout", "authFailed", "keyPathInvalid"]) {
		assert.ok(zh.includes(`"settings.connections.add.reason.${key}":`), `zh-CN 缺 reason.${key}`);
		assert.ok(en.includes(`"settings.connections.add.reason.${key}":`), `en-US 缺 reason.${key}`);
	}
});

test("测试连接：三处通道齐备，且不写 host store", () => {
	assert.match(shared, /remoteHostTest:\s*"remote:test"/);
	assert.match(preload, /test:\s*\(input: import\("\.\.\/shared\/types\/remoteHost"\)\.RemoteHostAddInput\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostTest, input\)/);
	assert.match(main, /ipcMain\.handle\(ipcChannels\.remoteHostTest/);
	// 只调 probe（握手），绝不 createDraft/offerPin。
	const handler = main.slice(main.indexOf("ipcChannels.remoteHostTest"), main.indexOf("ipcChannels.remoteHostAdd, async"));
	assert.match(handler, /pinStore\.probe\(/);
	assert.doesNotMatch(handler, /createDraft|offerPin|confirmPin/);
});

test("测试连接按钮：密码方式禁用并说明，结果行区分成功与失败", () => {
	assert.match(dialog, /onClick=\{\(\) => void testConnection\(\)\}/);
	assert.match(dialog, /settings\.connections\.add\.test/);
	assert.match(dialog, /settings\.connections\.add\.testing/);
	assert.match(dialog, /form\.auth === "password"/, "password auth must not be testable through the probe");
	assert.match(dialog, /t\("settings\.connections\.add\.testPasswordUnsupported"\)/);
	assert.match(dialog, /settings\.connections\.add\.testOk/);
	assert.match(dialog, /settings\.connections\.add\.testFailed/);
	// 结果在参数变化后必须清空：否则旧的成功结论会跟着新配置一起显示。
	assert.match(dialog, /setTestResult\(null\);\n\t\}, \[form\.hostName, form\.port, form\.user, form\.identityFile, form\.auth, form\.passphrase\]\)/);
});
