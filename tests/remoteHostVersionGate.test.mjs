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

test("the version probe is built from the contract helper, on the resolved absolute executable", () => {
	// 探针命令必须落在已验证的绝对路径上，且不得回退到 PATH 查询（引号规则也只有契约一处）。
	assert.equal(buildRemoteNodeVersionCommand("/usr/bin/node"), "'/usr/bin/node' '--version'");
	assert.equal(buildRemoteNodeVersionCommand("/home/u/.nvm/versions/node/v24.11.0/bin/node"), "'/home/u/.nvm/versions/node/v24.11.0/bin/node' '--version'");
	const { createSshClientRuntime } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
	assert.ok(createSshClientRuntime, "client runtime still loads (the script depends on it)");
});

test("the smoke script delegates node resolution and version gating to the resolver", () => {
	// 门禁不再由脚本自己实现：它已下沉到 `resolveRemoteNodeExecutable`（该函数自带 22.3 门禁，
	// 见 tests/remoteNodeResolution.test.mjs）。脚本必须调用它，而不是重新拼一份探测逻辑——
	// 两份阈值迟早漂移。
	const afterImports = smokeSource.indexOf("async function verifyRemoteHost");
	assert.ok(afterImports >= 0, "the smoke script's entry function must exist");
	const resolveCallIndex = smokeSource.indexOf("resolveRemoteNodeExecutable(", afterImports);
	assert.ok(resolveCallIndex >= 0, "the script must call the resolver inside verifyRemoteHost");

	// 解析必须发生在 bootstrap 调用点之前：旧 node 一旦先拿到上传/启动，失败形态又回到零帧退出。
	const bootstrapIndex = smokeSource.indexOf("bootstrapPinnedHost({", afterImports);
	assert.ok(bootstrapIndex >= 0, "bootstrap call missing from the smoke script");
	assert.ok(resolveCallIndex < bootstrapIndex, "resolution must precede the bootstrap call");

	// 脚本不得再自己调契约的版本门禁：留下一份就地实现就是第二个阈值来源。
	assert.doesNotMatch(smokeSource, /assertSupportedRemoteNodeVersion\s*\(/, "the gate belongs to the resolver, not to a second copy here");
	// 也不得回退到非交互 `command -v node`——那正是探到旧 node 的原始缺陷。
	// 断言的是「不再构造这个远端命令」，而不是关键词不存在（注释里提到它恰恰是应该的）。
	assert.doesNotMatch(smokeSource, /remoteCommand:\s*"command -v node"/, "the non-interactive probe must not come back as an actual command");
	assert.doesNotMatch(smokeSource, /remoteCommand:\s*["'`]command\s/, "no PATH-lookup remote command may be constructed");
});

test("the rejected-node error is actionable and does not surface as a bare crash", () => {
	// 验收判据：不合格的 node 必须得到一条可执行的先决条件错误，而不是
	// `BOOTSTRAP_NO_READY ... stderr-present` 这种需要大量背景才能读懂的症状。
	// 具体码由解析器产生（REMOTE_NODE_VERSION_UNSUPPORTED 等），这里锁定脚本不会把
	// 解析器的错误吞掉换成自己的笼统消息。
	assert.match(smokeSource, /resolveRemoteNodeExecutable/, "the resolver is the single source of the gate and its codes");
	// 脚本仍需把 bootstrap 阶段特有的失败形态（零帧退出）打印成可读三字段。
	assert.match(smokeSource, /BOOTSTRAP_NO_READY/, "the zero-frame exit must stay diagnosable");
	assert.match(smokeSource, /exitKind/);
	assert.match(smokeSource, /stderrSeen/);
});

test("the smoke script still probes the version contract, through the resolver's one implementation", () => {
	// 版本阈值只有一处：契约（remoteBootstrapContract.test.mjs 已有边界覆盖）。
	assert.throws(() => assertSupportedRemoteNodeVersion("v12.22.9\n"), /REMOTE_NODE_VERSION_UNSUPPORTED/);
	assert.doesNotThrow(() => assertSupportedRemoteNodeVersion("v22.3.0\n"));
	assert.throws(() => assertSupportedRemoteNodeVersion("v22.2.9\n"), /REMOTE_NODE_VERSION_UNSUPPORTED/);
	// Node 12 不认 `node:` 前缀的 require —— 门禁存在的原因，用文档化的机制固定下来。
	assert.match(readFileSync(join(repoRoot, "src/main/remote/RemoteBootstrapContract.ts"), "utf8"), /require\("node:fs"\)/);
	// 解析器必须真的调用契约门禁，而不是自带一份比较。
	const resolverSource = readFileSync(join(repoRoot, "src/main/remote/RemoteBootstrapSession.ts"), "utf8");
	assert.match(resolverSource, /assertSupportedRemoteNodeVersion\s*\(/);
});

test("the smoke script stays honest about what a passing probe proves", () => {
	// 脚本注释必须记录「路径探针 ≠ 版本可用」以及为什么非交互探测不够，
	// 否则后人会把登录 shell 解析当成冗余删掉。
	assert.match(smokeSource, /14\.18/, "comment must record when the node: prefix landed");
	assert.match(smokeSource, /outside\s+its\s+try|outside the try/i, "comment must record that the failing require sits outside the entry's try");
	assert.match(smokeSource, /login shell/i, "comment must record why the login shell is read");
	assert.match(smokeSource, /nvm/, "comment must name the concrete case (nvm is invisible to non-interactive SSH)");
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
