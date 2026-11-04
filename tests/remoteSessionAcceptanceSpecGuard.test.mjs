import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/*
 * 源码级守卫：Phase 4 P4.2 的真机 UI 验收（e2e/remoteSessionAcceptance.spec.ts）。
 *
 * 一份验收只有当它能红时才是证据。本文件把这件事钉在结构上，而不是靠人工 review：
 * 1. 环境门控必须在任何 test body / fixture setup 之前（缺凭据 ⇒ 整体 skip，不启动 Electron）；
 * 2. **凭据不落仓库**：用当前环境里的真实值扫 e2e/（不把真实主机/用户名/指纹抄进本文件——
 *    既有 `remoteAcceptanceSpecGuard.test.mjs` 把真实主机写在断言里，这里刻意不复制那个写法）；
 * 3. 操作链每一步都必须有具体断言：新建会话走**真实 UI 入口**（侧栏项目行「+」，不用 IPC 直调）、
 *    trust 提示必须被断言可见、停止后必须断言「可重启」、重开后必须断言历史正文；
 * 4. 真跑一次「无凭据」的 spec：必须全 skip、零 passed、零 failed、exit 0。
 *
 * 另外守住两件事，避免证据被悄悄削弱：
 * - 没有任何环境变量能把 spec 翻成「通过」（禁 EXPECT_FAIL / ALLOW_FAILURE / ACCEPT_ANY 一类开关）；
 * - 缺口探针（PIDECK_E2E_P42_GAP_PROBE）只能**追加**断言，不能替代链路本身的断言。
 */

const SPEC = "e2e/remoteSessionAcceptance.spec.ts";
const FIXTURES = "e2e/remote-fixtures.ts";
const TRUST_NOTICE_COMPONENT = "src/renderer/src/components/session/RemoteSessionTrustNotice.tsx";
const PLAYWRIGHT_CLI = "node_modules/@playwright/test/cli.js";
const CREDENTIAL_VARS = ["PIDECK_E2E_REMOTE_HOST", "PIDECK_E2E_REMOTE_USER", "PIDECK_E2E_REMOTE_FINGERPRINT"];
/** 缺口探针开关在 spec 里的**常量名**与**取值**（spec 必须由它门控那条更强的断言）。 */

function source(relativePath) {
	return readFileSync(relativePath, "utf8");
}

/** 摘出一段源码的函数体（从函数签名到下一个顶层 `}`）：用来断言「这段代码里没有 IPC/J 直调」。 */
function functionBody(text, signature) {
	const start = text.indexOf(signature);
	assert.ok(start >= 0, "找不到函数：" + signature);
	const end = text.indexOf("\n}", start);
	assert.ok(end > start, "函数体没有正常收尾：" + signature);
	return text.slice(start, end);
}

test("the spec gates on credentials before any Electron session can start", () => {
	const text = source(SPEC);
	assert.match(text, /test\.skip\(\s*[A-Za-z0-9_.]*credentials\s*===\s*undefined/, "the spec must skip when the credential set is absent");
	assert.ok(!text.includes("test.fixme"), "a fixme would hide the spec instead of gating it");
	assert.ok(!/test\.describe\.skip/.test(text), "a static describe.skip would not be a conditional gate");
	const gateIndex = text.indexOf("test.skip(");
	const firstBodyIndex = text.search(/test\(\s*"/);
	assert.ok(gateIndex >= 0, "the gate must exist");
	assert.ok(firstBodyIndex < 0 || gateIndex < firstBodyIndex, "the gate must be evaluated before the first test body runs");
	assert.ok(!/EXPECT_FAIL|ALLOW_FAILURE|PIDECK_E2E_ACCEPT_ANY/i.test(text), "no environment value may flip the spec to passing");
	// 远端能力已经是正式产品能力，真机 spec 不再依赖历史实验环境变量。
	assert.ok(!text.includes("PIDECK_REMOTE_EXPERIMENTAL"), "the spec must not depend on the retired experimental gate");
	assert.match(text, /from\s+"\.\/remote-fixtures"/, "the spec must reuse the shared real-host fixture");
	const fixture = source(FIXTURES);
	assert.ok(!fixture.includes("PIDECK_REMOTE_EXPERIMENTAL"), "the fixture must not depend on the retired experimental gate");
	assert.match(fixture, /PIDECK_E2E_USER_DATA_DIR:\s*profileDir/, "the fixture must isolate userData");
	// 隔离只针对 userData：HOME/USERPROFILE 必须保持真实，产品要用真实 ~/.ssh 私钥。
	assert.ok(!/USERPROFILE\s*:/.test(fixture) && !/\bHOME\s*:/.test(fixture), "the fixture must not redirect HOME/USERPROFILE (the product needs the real ~/.ssh)");
});

test("no credential value or shape is committed under e2e/", () => {
	// 通用判据（不抄真实值）：真实凭据的**当前值**不得出现在任何 e2e 源码里；此外禁掉 IPv4 与
	// ED25519 指纹字面量（环回地址是 e2e 自建本地服务用的，明确放行）。
	const secrets = CREDENTIAL_VARS.map((name) => process.env[name]?.trim()).filter((value) => typeof value === "string" && value.length > 0);
	const files = readdirSync("e2e").filter((name) => name.endsWith(".ts"));
	for (const name of files) {
		const text = source("e2e/" + name);
		for (const secret of secrets) assert.ok(!text.includes(secret), "e2e/" + name + " must not contain the live credential value of a PIDECK_E2E_REMOTE_* variable");
		const ipv4 = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? [];
		const nonLoopback = ipv4.filter((address) => !address.startsWith("127.") && address !== "0.0.0.0");
		assert.deepEqual(nonLoopback, [], "e2e/" + name + " must not contain a real host address: " + nonLoopback.join(", "));
		assert.ok(!/SHA256:[A-Za-z0-9+/]{43}/.test(text), "e2e/" + name + " must not contain a literal host-key fingerprint");
	}
	// 值扫描只在环境里有真凭据时才有效；形状扫描（IPv4 / 指纹）与文件名遍历任何时候都跑。
	// 真机跑本 spec 时环境里一定有那三个变量，值扫描因此必然生效。
});

test("the trust notice is asserted against the real component, not a lookalike", () => {
	const text = source(SPEC);
	// 组件侧锚点：data-testid 必须真的存在于渲染层，否则 spec 是在断言一个不存在的选择器。
	const component = source(TRUST_NOTICE_COMPONENT);
	assert.match(component, /data-testid="remote-session-trust-notice"/, "the notice component must expose the data-testid the spec asserts on");
	assert.match(text, /getByTestId\("remote-session-trust-notice"\)/, "the spec must locate the trust notice by its data-testid");
	assert.match(text, /remote-session-trust-notice[\s\S]{0,200}?toBeVisible\(/, "the trust notice must be asserted **visible** (存在但不可见不算)");
	assert.match(text, /远端项目资源未加载/, "the spec must also pin the user-visible copy of the notice");
});

test("every flow step asserts something concrete, through the real UI", () => {
	const text = source(SPEC);
	const steps = text.match(/test\.step\(/g) ?? [];
	const expects = text.match(/expect[(.]/g) ?? [];
	assert.ok(steps.length >= 6, "the flow should be split into explicit steps, found " + steps.length);
	assert.ok(expects.length >= steps.length, "every step needs at least one assertion: " + expects.length + " expects for " + steps.length + " steps");
	// 产品路与 trust 提示必須分节：一条提示缺失不能把「产品路通不通」的结论一起掩盖。
	assert.match(text, /test\("远端会话产品路/, "the product chain must be its own test");
	assert.match(text, /test\("远端会话的 trust 提示/, "the trust notice must be its own test (it cannot be moved after the stop: the notice goes away with the runtime)");
	const required = [
		["the credential environment variables", /readRemoteAcceptanceCredentials\(process\.env\)/],
		["the pin fingerprint check", /matchesRemoteFingerprint\(/],
		["the ready state", /"已连接"/],
		["the remote project enrollment", /chooseRemoteDirectory\(/],
		["the remote session creation entry", /createRemoteSessionInProject\(/],
		["the assistant body (not just a card)", /\.assistant-text/],
		["the user prompt in the timeline", /\.user-turn-text/],
		["the stop entry", /关闭 Agent/],
		["the restartable state after the stop", /启动 Agent/],
		["the re-open after the stop", /tab-close/],
		["the history survives the re-open", /重开后必须还能看到刚才的 prompt/],
		["the remote session file corroboration", /encodePiSessionDirectory\(/],
		["the cleanup of this run's remote paths", /rm -rf/],
	];
	for (const pair of required) assert.match(text, pair[1], "the spec must assert " + pair[0]);
	// 「新建会话」不能绕过 UI：这条链路的每一步都必须是真实界面动作，spec 里不该出现任何 IPC 直调。
	assert.ok(!/piDesktop|ipcRenderer/.test(text), "the spec must drive the UI, not the IPC surface");
	assert.match(text, /finally\s*\{/, "the remote fixture must be cleaned up in a finally block");
	assert.ok(!/rm -rf\s*["']?\$?HOME/.test(text), "the cleanup must never target the remote HOME");
	// 清理落点必须由本项目路径编码折出来（归属确认），不是通配或会话根目录。
	assert.match(text, /rm -rf\s*"\s*\+\s*paths\.e2eRoot/, "the cleanup must remove the runId-scoped e2e root");
	assert.match(text, /sessionEvidenceDir/, "the cleanup must target the encoded session directory derived from this project path");
});

test("the new session entry is a real UI click (hover then click), and not forced past hit-testing", () => {
	const fixture = source(FIXTURES);
	const body = functionBody(fixture, "export async function createRemoteSessionInProject(");
	assert.match(body, /\.hover\(\)/, "the helper must hover the project row so the dimmed action layer becomes interactive");
	assert.match(body, /普通会话/, "the helper must click the project row's real new-session button");
	assert.ok(!/force:\s*true/.test(body), "force:true would skip hit-testing and click whatever is underneath");
	assert.ok(!/piDesktop|ipcRenderer/.test(body), "the helper must not create the session through IPC");
});

test("the reload-history step is part of the default chain and still asserts the remote body", () => {
	const text = source(SPEC);
	// 曾经的「缺口探针」在远端正文读取交付后已提升为**默认门禁**：开关必须不存在——留着开关就等于
	// 允许把这条覆盖关掉，而它正是「远端读页分支被本机路径守卫挡死」那个 bug 溜过验收的缺口。
	assert.ok(!text.includes("PIDECK_E2E_P42_GAP_PROBE"), "the promoted step must not keep a probe env switch");
	assert.ok(!text.includes("GAP_PROBE_ENV"), "no probe env constant should remain in the spec");
	const stepIndex = text.indexOf('await test.step("⋯ →「重新加载会话」后历史仍在（无存活 runtime 的远端正文读取）"');
	assert.ok(stepIndex > 0, "the reload-history step must exist and be labelled");
	const step = text.slice(stepIndex, text.indexOf("} finally {"));
	// 它必须是"真断言"而不是静默观察：断言 prompt 与回复正文都可见。
	assert.match(step, /getByRole\("menuitem", \{ name: "从磁盘重新加载消息", exact: true \}\)/, "the step must drive the real reload menu item");
	assert.match(step, /重载后必须仍能看到 prompt/, "the step must assert the prompt is still visible");
	assert.match(step, /重载后必须仍能看到回复正文/, "the step must assert the assistant body is still visible");
	// 顺序仍在"重开标签页后历史仍在"之后：先交付链、再这条与 runtime 无关的路径。
	const reopenIndex = text.indexOf("重开后必须还能看到刚才的 prompt");
	assert.ok(reopenIndex > 0 && reopenIndex < stepIndex, "the reload-history step must come after the delivered chain's assertions");
});

test("without credentials the spec is skipped, never passed", { timeout: 300_000 }, () => {
	const env = Object.assign({}, process.env);
	for (const name of CREDENTIAL_VARS) delete env[name];
	const result = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "test", SPEC, "--reporter=json"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
	const text = (result.stdout ?? "") + (result.stderr ?? "");
	const start = text.indexOf("{");
	let report;
	if (start >= 0) {
		try {
			report = JSON.parse(text.slice(start));
		} catch {
			report = undefined;
		}
	}
	assert.ok(report !== undefined, "the JSON reporter must produce a report:\n" + text.slice(-2000));
	const stats = report.stats;
	assert.ok(stats.expected + stats.skipped + stats.unexpected >= 1, "the spec collected no tests at all (syntax error or empty spec), so it is not evidence yet:\n" + text.slice(-2000));
	assert.ok(stats.skipped >= 1, "the spec must report at least one skipped case, got " + JSON.stringify(stats));
	assert.equal(stats.expected, 0, "nothing may report as passed without credentials");
	assert.equal(stats.unexpected, 0, "nothing may fail without credentials either");
	assert.equal(result.status, 0, "a fully skipped run exits zero");
});
