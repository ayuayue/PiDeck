import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Real-host smoke 的 node 版本门禁。
 *
 * 背景（2026-09 实机发现）：`command -v node` 只证明「有一个绝对路径的 node」，不证明
 * 它够新。冻结入口 `REMOTE_BOOTSTRAP_INLINE_SOURCE` 的第一条语句是
 * `const fs=require("node:fs"),path=require("node:path");`，**位于 try 之外**，而
 * `require()` 的 `node:` 前缀从 Node 14.18 才支持。所以远端若是旧 node，入口在第一条
 * 语句就 MODULE_NOT_FOUND：stderr 有堆栈、stdout 零帧、exit 1 —— 与「入口自身坏掉」
 * 无法区分。`serve` 实测为 v12.22.9，正好落在这个坑里。
 *
 * 这些用例锁定「先验版本、再动 bootstrap」这个顺序，而不是复述契约内部的阈值比较
 * （那部分在 remoteBootstrapContract.test.mjs 已有边界覆盖）。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const smokeScriptPath = join(repoRoot, "scripts/verify-remote-host.mjs");
const smokeSource = readFileSync(smokeScriptPath, "utf8");

const { assertSupportedRemoteNodeVersion, buildRemoteNodeVersionCommand, REMOTE_BOOTSTRAP_INLINE_SOURCE, REMOTE_BOOTSTRAP_INLINE_ENTRY } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");

test("the smoke script probes the version the contract requires, on the same absolute executable", () => {
	// 复用契约里的探针构造器，而不是在脚本里另拼一次命令；否则阈值与引号规则会有两份。
	assert.match(smokeSource, /buildRemoteNodeVersionCommand\s*\(/, "script must build the probe with the contract helper");
	assert.match(smokeSource, /assertSupportedRemoteNodeVersion\s*\(/, "script must validate with the contract helper");
	const { createSshClientRuntime } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
	// 探针命令必须落在已验证的绝对路径上，且不得回退到 PATH 查询。
	assert.equal(buildRemoteNodeVersionCommand("/usr/bin/node"), "'/usr/bin/node' '--version'");
	assert.ok(createSshClientRuntime, "client runtime still loads (the script depends on it)");
});

test("the version gate runs before any bootstrap work is attempted", () => {
	// 顺序是关键：门禁若排在 bootstrap 之后，旧 node 仍会先拿到一份上传/启动，失败形态
	// 又回到「零帧退出」。断言「拒绝点」出现在 bootstrapPinnedHost 调用之前。
	const gateIndex = smokeSource.indexOf("assertSupportedRemoteNodeVersion(");
	const bootstrapIndex = smokeSource.indexOf("bootstrapPinnedHost({");
	assert.ok(gateIndex >= 0, "version gate missing from the smoke script");
	assert.ok(bootstrapIndex >= 0, "bootstrap call missing from the smoke script");
	assert.ok(gateIndex < bootstrapIndex, "version gate must precede the bootstrap call");

	// 门禁必须在真正发起 bootstrap 的调用点之前完成：SCP/启动都不该发生。
	// 注意取的是调用点（`bootstrapPinnedHost({`），不是 import 行里的名字——import 在文件
	// 顶部，拿它下比会让这条断言恒真。
	const versionProbeIndex = smokeSource.indexOf("buildRemoteNodeVersionCommand(");
	// 探针构造器自身也 import，所以从「import 之后」开始找调用点。
	const afterImports = smokeSource.indexOf("async function verifyRemoteHost");
	const probeCallIndex = smokeSource.indexOf("buildRemoteNodeVersionCommand(", afterImports);
	assert.ok(versionProbeIndex >= 0, "the version probe must be wired into the script");
	assert.ok(afterImports >= 0, "the smoke script's entry function must exist");
	assert.ok(probeCallIndex >= 0, "the probe must be called inside the verify function, not merely imported");
	assert.ok(bootstrapIndex > probeCallIndex, "the version probe must run before the bootstrap call site");
});

test("the rejected-node error names the path and version, and does not surface as a bare crash", () => {
	// 这条用例是这次实机发现的验收判据：旧 node 必须得到一条可执行的先决条件错误，
	// 而不是 `BOOTSTRAP_NO_READY ... stderr-present` 这种需要大量背景才能读懂的症状。
	assert.match(smokeSource, /REMOTE_NODE_VERSION_UNSUPPORTED/, "rejection must use the contract's stable code");
	assert.match(smokeSource, /REMOTE_NODE_VERSION_PROBE_FAILED/, "a failing probe needs its own distinguishable code");
});

test("the gate rejects the exact version that broke the real host, and admits the plan's threshold", () => {
	// 真实负样本：serve 上 /usr/bin/node --version 的输出。
	assert.throws(() => assertSupportedRemoteNodeVersion("v12.22.9\n"), /REMOTE_NODE_VERSION_UNSUPPORTED/);
	// 计划写死的门槛 22.3：等于通过，低一个 patch 必须拒绝。
	assert.doesNotThrow(() => assertSupportedRemoteNodeVersion("v22.3.0\n"));
	assert.throws(() => assertSupportedRemoteNodeVersion("v22.2.9\n"), /REMOTE_NODE_VERSION_UNSUPPORTED/);
	// Node 12 不认 `node:` 前缀的 require —— 门禁存在的原因，用文档化的机制固定下来。
	assert.match(readFileSync(join(repoRoot, "src/main/remote/RemoteBootstrapContract.ts"), "utf8"), /require\("node:fs"\)/);
});

test("the smoke script stays honest about what a passing probe proves", () => {
	// 脚本注释必须记录「路径探针 ≠ 版本可用」，否则后人会把门禁当成冗余删掉。
	assert.match(smokeSource, /14\.18/, "comment must record when the node: prefix landed");
	assert.match(smokeSource, /outside\s+its\s+try|outside the try/i, "comment must record that the failing require sits outside the entry's try");
});

test("the smoke script's usage guard and fingerprint input are unchanged by the gate", () => {
	// 门禁是纯增量：参数契约（IPv4/user/fingerprint/--bootstrap）不能被顺手改宽。
	assert.match(smokeSource, /Usage:\s*node scripts\/verify-remote-host\.mjs/);
	assert.match(smokeSource, /\[--bootstrap\]/);
	assert.match(smokeSource, /SHA256:/, "the independently verified fingerprint must still be a required input");
});

/**
 * 三类启动故障的区分判据（2026-09 实机定位时把三者混为一谈过）。
 *
 * 共同点都是「exit 1、stderr 有内容」，区别只在 stdout 有没有帧：
 *   A 有 WebCrypto、HOME 非法      → 1 帧 BOOTSTRAP_DEPLOY_ROOT_INVALID
 *   B 缺 WebCrypto                  → 1 帧 BOOTSTRAP_INTERNAL
 *   C try 之外的 require 失败        → 0 帧（真实故障长这样）
 *
 * B 证明 WebCrypto 缺失在 try **内部**，所以它不可能是「零帧」的原因；只有 C 这种
 * 在首条语句就炸的故障才没有机会写出任何帧。把 A/B/C 一起钉住，防止再有人用
 * 「缺 WebCrypto」去解释一个零帧退出。
 */
test("the frozen entry distinguishes a missing WebCrypto from a pre-try load failure by frame count", () => {
	const nonce = randomBytes(16).toString("hex");
	const argv = [REMOTE_BOOTSTRAP_INLINE_ENTRY, "1", "a".repeat(64), nonce];
	const runEntry = (source, env) => spawnSync(process.execPath, ["-e", source, "--", ...argv], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 20_000 });
	const frames = (result) => (result.stdout.trim() ? result.stdout.trim().split("\n") : []);

	// A: a working entry answers every failure with exactly one frame, so "no frame" is never
	// the normal shape of an entry-level error.
	const healthy = runEntry(REMOTE_BOOTSTRAP_INLINE_SOURCE, { HOME: "/" });
	assert.equal(healthy.status, 1, "an unusable HOME must exit non-zero");
	assert.equal(frames(healthy).length, 1, "an in-try failure must emit exactly one frame");
	assert.match(frames(healthy)[0], /BOOTSTRAP_DEPLOY_ROOT_INVALID/);

	// B: the WebCrypto gate sits inside the try, so removing the global still yields one frame.
	const noCrypto = runEntry(`delete globalThis.crypto;globalThis.crypto=undefined;${REMOTE_BOOTSTRAP_INLINE_SOURCE}`, { HOME: "/tmp" });
	assert.equal(noCrypto.status, 1);
	assert.equal(frames(noCrypto).length, 1, "a missing WebCrypto reports BOOTSTRAP_INTERNAL, it does not vanish");
	assert.match(frames(noCrypto)[0], /BOOTSTRAP_INTERNAL/);

	// C: the observed real-host shape. A node that cannot resolve `node:` in require() dies at the
	// entry's first statement, which is outside the try — zero frames, exit 1, stderr present.
	const shadow = "const __r=require;globalThis.require=(m)=>{if(String(m).startsWith('node:')){const e=new Error('Cannot find module '+m);e.code='MODULE_NOT_FOUND';throw e;}return __r(m);};";
	const preTry = runEntry(shadow + REMOTE_BOOTSTRAP_INLINE_SOURCE, { HOME: "/tmp" });
	assert.equal(preTry.status, 1);
	assert.equal(frames(preTry).length, 0, "a pre-try load failure is the only shape that emits no frame");
	assert.ok(preTry.stderr.trim().length > 0, "the pre-try failure is reported on stderr, which is what the smoke saw");

	// The reason this matters: the frozen source keeps its builtin loads outside the try, so a
	// future edit that moves them inside would silently turn case C into case B.
	assert.match(REMOTE_BOOTSTRAP_INLINE_SOURCE.slice(0, 120), /require\("node:fs"\)/);
	assert.ok(REMOTE_BOOTSTRAP_INLINE_SOURCE.indexOf("try{") > REMOTE_BOOTSTRAP_INLINE_SOURCE.indexOf('require("node:fs")'), "the builtin loads must stay outside the try, or the zero-frame diagnosis changes meaning");
});
