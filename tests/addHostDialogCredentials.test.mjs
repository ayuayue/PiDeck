import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 远程配置面板：类型切换 + 实时预览 + 表单 + SSH config 导入。
// 关键契约不变：只提供底层真能执行的选项。密码在 OpenSSH 下有 askpass 通道，因此现在可选，
// 但密钥/口令之外的东西一律不落盘：表单只把 authMethod 交给主进程，密码随本次连接进入内存。

const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");

test("form carries username, auth mode and private key", () => {
	assert.match(dialog, /const EMPTY_FORM = \{[\s\S]*?port: "22",[\s\S]*?auth: "agent" as AuthMode,[\s\S]*?identityFile: "",[\s\S]*?password: "",[\s\S]*?passphrase: ""\s*\};/);
	// 新建走 EMPTY_FORM；编辑模式（props.edit）从已存档案与口令派生初值，两者共用同一份 FormState。
	assert.match(dialog, /if \(editing === undefined\) return EMPTY_FORM;/);
	assert.match(dialog, /password: editing\.authMethod === "password" \? secret : ""/);
	assert.match(dialog, /id="remote-host-user"/);
	assert.match(dialog, /id="remote-host-identity"/);
	// 私钥路径不做渲染层展开：~ 由主进程规范化。
	assert.match(dialog, /\.\.\.\(user\.length > 0 \? \{ user \} : \{\}\)/);
	assert.match(dialog, /\.\.\.\(identityFile\.length > 0 \? \{ identityFile \} : \{\}\)/);
	assert.match(dialog, /form\.auth === "key" && identityFile\.length === 0/);
});

test("SSH config import fills the form instead of submitting silently", () => {
	assert.match(dialog, /const applyCandidate = useCallback\(\(candidate: RemoteHostConfigCandidate\) => \{/);
	assert.match(dialog, /auth: candidate\.identityFile === null \? "agent" : "key"/);
	assert.match(dialog, /setImporting\(false\)/);
	// 候选被过滤后仍要说明「被跳过」的原因。
	assert.match(dialog, /settings\.connections\.add\.skipped/);
});

test("新建连接只提供 SSH：WSL 的档案表单已随档案层退役一起移除", () => {
	// WSL 不是连接：它的发行版/用户在开发设置里，项目在「添加项目」时选。
	assert.doesNotMatch(dialog, /onClick=\{\(\) => setKind\("wsl"\)\}/);
	assert.doesNotMatch(dialog, /addWslHost\(/);
	assert.doesNotMatch(dialog, /wsl-host-distro|wsl-host-user/);
	assert.doesNotMatch(dialog, /initialKind/);
	// Docker 仍然后端未接入（工具栏里只剩导入 SSH config 一个操作）。
	assert.doesNotMatch(dialog, /add\.kind\.docker/);
});

test("password mode is offered, and the secret is never part of the persisted input", () => {
	// 输入框只在「密码」模式出现，默认仍是 agent。
	assert.match(dialog, /form\.auth === "password" \? \(/);
	assert.match(dialog, /id="remote-host-password"/);
	// 密码字段现在带明文切换（用户要求）：默认仍遮罩，且可见态与密钥口令分离。
	assert.match(dialog, /const \[showPassword, setShowPassword\] = useState\(false\)/);
	assert.match(dialog, /type=\{showPassword \? "text" : "password"\}/);
	assert.match(dialog, /form\.auth === "password" && password\.length === 0/);
	// 提交给主进程的只有 authMethod；密码只作为 connect 的第二个参数（本次连接内存），不进 add/update 输入。
	assert.match(dialog, /form\.auth === "password" \? \{ authMethod: "password" as const \} : \{\}/);
	// 密钥口令与登录密码走同一条「只进内存」的通道，但只有非空时才传。
	assert.match(dialog, /const currentSecret = useCallback\(\(\) => \(form\.auth === "password" \? form\.password : form\.auth === "key" \? form\.passphrase : ""\), \[form\]\)/);
	assert.match(dialog, /desktopApi\.remoteHosts\.connect\(hostId, secret\.length > 0 \? secret : undefined\)/);
	assert.match(dialog, /secret\.length > 0 \? \{ secret \} : \{\}/);
	// 对话框不再把口令回传给宿主（宿主也不自己发起连接）。
	assert.doesNotMatch(dialog, /props\.onSubmitted/);
	assert.doesNotMatch(dialog, /authMethod: "password", password/);
	// 旧的不支持提示已随能力一起移除。
	assert.doesNotMatch(dialog, /auth\.passwordUnsupported/);
});

test("the header preview reflects the current target", () => {
	assert.match(dialog, /settings\.connections\.add\.previewPlaceholder/);
	assert.match(dialog, /previewHost\.length === 0[\s\S]{0,40}previewPlaceholder/);
});
