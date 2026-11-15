/**
 * **手动工具，不在 CI 里跑**：要真的远程主机 + 真 pi 进程，本地跑不了。
 * 名字以 verify- 开头，但没有任何 workflow 调用它。
 *
 * 真机端到端验收（P4.4 扩展面）：远端内置扩展快照部署、`-e` 注入、runner env、安全策略写入。
 *
 * 为什么需要这个脚本：这套链路的三个关键事实只存在于真机上——（1）内容寻址快照确实按逐文件
 * sha256 激活到了 `<deployRoot>/extensions/<sha>/`；（2）runner 1.1.0 把 `PIDECK_*` env 真的合并进了
 * 子进程环境；（3）远端 pi 1.x 真的能加载这九个扩展并注册命令（`/todo` `/plan` `/goal`）。
 * 单测里的替身证明不了任何一条。
 *
 * 输出（每步一行、机器可读；失败打印稳定码并 exit 1）：
 *
 *   HOST_HANDSHAKE_OK   共享 pin 模块：只有与独立核验过的指纹逐字节相等才建 pin。
 *   NODE_OK             登录 shell PATH 里可用 node（≥22.3）。
 *   BOOTSTRAP_FINALIZED helper+runner 的内容寻址 bundle。
 *   SNAPSHOT_DEPLOYED   扩展快照激活：bundle sha + 文件数。
 *   SNAPSHOT_VERIFIED   远端 `sha256sum` 抽查与本地清单一致。
 *   SECURITY_ARTIFACT_OK 策略快照写入：路径、mode 0600、sha256 自校验。
 *   PROBE_ENV_OK        用内容寻址部署的探针 pi 验证：runner 把 PIDECK_* env 合并进子进程，
 *                       且 `-e` 路径真实存在（探针把 argv/env 写回，脚本读回核对）。
 *   REMOTE_COMMANDS_OK  远端真实 pi 1.x 加载九个扩展：`get_commands` 里出现 todo/plan/goal。
 *   PLAN_MARKER_STRIPPED （仅 `--with-prompt`，消耗一次模型调用）计划模式标记被扩展剥掉：
 *                       远端会话文件里看得到用户可见正文，但**看不到**隐藏标记。
 *   EXTENSIONS_E2E_OK   全部通过（exit 0）。
 *
 * 成本：默认**不调用模型**（探针是普通 Node 脚本；真实 pi 只回 get_commands）；`--with-prompt`
 * 额外发一条计划模式 prompt 验标记不泄漏（一次模型调用）。远端只留下内容寻址快照
 * （与其它运行共享，保留）；探针文件、探针输出与（本次）会话文件在 finally 里删除。
 *
 * 用法：node scripts/verify-remote-extensions.mjs <IPv4> <user> <independently-verified-ED25519-SHA256-fingerprint>
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";
import { pinVerifiedHost } from "./remoteVerifyPinnedHost.mjs";

const { resolveVerifiedSshClient } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
const { quotePosixArgument, REMOTE_BOOTSTRAP_DEPLOY_ROOT_SEGMENTS } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");
const { buildPinnedSshInvocation } = loadTsCommonJs("src/main/remote/SshVerifiedConnection.ts");
const { bootstrapPinnedHost, resolveRemoteNodeExecutable } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts");
const { createSshProcessLauncher } = loadTsCommonJs("src/main/remote/SshProcessLauncher.ts");
const { deployedRunnerPath } = loadTsCommonJs("src/main/remote/RemoteBootstrapDeployment.ts");
const { deployRemoteExtensionSnapshot, deployedExtensionSnapshotRoot } = loadTsCommonJs("src/main/remote/RemoteExtensionDeployment.ts");
const { readEffectiveExtensionSnapshot, remoteExtensionSnapshotFileNames, listRemoteInjectableExtensionNames } = loadTsCommonJs("src/main/extensions/remoteExtensionSnapshot.ts");
const { writeRemoteSecurityPolicySnapshot, remoteSecurityPolicyPath } = loadTsCommonJs("src/main/remote/RemoteSecurityPolicyArtifact.ts");
const { buildRemotePiRuntimePlan } = loadTsCommonJs("src/main/pi/piRemoteRuntimePlan.ts");
const { createSshPiRuntimeLauncher } = loadTsCommonJs("src/main/remote/SshPiRuntimeLauncher.ts");
const { PiRpcClient } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");
const { PI_DECK_PLAN_MODE_MARKER } = loadTsCommonJs("src/shared/composerModeMarkers.ts");

const USAGE = "Usage: node scripts/verify-remote-extensions.mjs <IPv4> <user> <independently-verified-ED25519-SHA256-fingerprint>";
const STABLE_CODE = /^[A-Z][A-Z0-9_]*$/;
const HOST_INPUT = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const USER_INPUT = /^[a-z_][a-z0-9_-]*$/;
const FINGERPRINT_INPUT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const REMOTE_CWD = "/tmp";
const TOTAL_BUDGET_MS = 5 * 60_000;
const RPC_TIMEOUT_MS = 30_000;

const PROBE_SOURCE = `import { existsSync, writeFileSync } from "node:fs";
const extensions = [];
for (let index = 0; index < process.argv.length; index += 1) {
	if (process.argv[index] === "--extension") extensions.push(process.argv[index + 1]);
}
const out = process.env.PIDECK_PROBE_OUT;
const security = process.env.PIDECK_SECURITY_CONFIG;
writeFileSync(out, JSON.stringify({
	extensionCount: extensions.length,
	extensionsExist: extensions.every((path) => existsSync(path)),
	securityPath: security,
	securityExists: typeof security === "string" && existsSync(security),
	sessionId: process.env.PIDECK_SESSION_ID,
}));
process.exit(0);
`;

function stableFailure(code, fields = []) {
	const error = new Error(code);
	error.fields = fields;
	return error;
}

function boundedField(value, limit = 200) {
	return String(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function reportFailure(error) {
	const code = typeof error?.message === "string" && STABLE_CODE.test(error.message) ? error.message : "";
	if (code === "") throw error;
	process.exitCode = 1;
	console.error(code, ...(Array.isArray(error?.fields) ? error.fields : []));
	if (code === "SMOKE_INPUT_INVALID") console.error(USAGE);
}

async function withDeadline(promise, timeoutMs, code) {
	void Promise.resolve(promise).catch(() => undefined);
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(stableFailure(code, [`timeoutMs=${timeoutMs}`])), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function runPinnedCommand(context, remoteCommand) {
	const invocation = await buildPinnedSshInvocation(context.directory, context.hostId, "ssh-batch", { client: context.client, remoteCommand });
	return context.client.run(invocation.executable, invocation.args);
}

function remoteHomeFromDeployRoot(deployRoot) {
	const suffix = `/${REMOTE_BOOTSTRAP_DEPLOY_ROOT_SEGMENTS.join("/")}`;
	if (typeof deployRoot !== "string" || !deployRoot.startsWith("/") || deployRoot.length <= suffix.length || !deployRoot.endsWith(suffix)) throw stableFailure("EXT_DEPLOY_ROOT_INVALID", [`deployRoot=${boundedField(deployRoot)}`]);
	return deployRoot.slice(0, -suffix.length);
}

async function requestOk(client, command, code) {
	let response;
	try {
		response = await client.request(command, RPC_TIMEOUT_MS);
	} catch (error) {
		throw stableFailure(code, [`rpc=${String(command.type)}`, `error=${boundedField(error?.message ?? error)}`]);
	}
	if (response?.success !== true) throw stableFailure(code, [`rpc=${String(command.type)}`, `piError=${boundedField(response?.error ?? "none")}`]);
	return response;
}

async function main(host, user, fingerprint) {
	const startedAt = Date.now();
	const deadlineAt = startedAt + TOTAL_BUDGET_MS;
	const budget = (cap) => {
		const left = deadlineAt - Date.now();
		if (left <= 0) throw stableFailure("EXT_E2E_TIMEOUT", [`budgetMs=${TOTAL_BUDGET_MS}`, `elapsedMs=${Date.now() - startedAt}`]);
		return Math.min(left, cap);
	};
	const sentinel = () => randomBytes(16).toString("hex");
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-extensions-e2e-"));
	const client = await resolveVerifiedSshClient();
	const context = { client, directory, hostId: "", home: "" };
	const cleanup = [];
	let runtime = null;
	try {
		const pinned = await pinVerifiedHost({ directory, client, host, user, fingerprint, label: "extensions-smoke" });
		context.hostId = pinned.hostId;
		console.log("HOST_HANDSHAKE_OK", host, `hostId=${pinned.hostId}`);

		const node = await resolveRemoteNodeExecutable({ userDataDir: directory, hostId: context.hostId, client, sentinel: sentinel() });
		console.log("NODE_OK", node.nodePath, node.version);

		const bundle = await bootstrapPinnedHost({ userDataDir: directory, hostId: context.hostId, generation: 1, nonce: sentinel(), nodePath: node.nodePath, client, launcher: createSshProcessLauncher() });
		console.log("BOOTSTRAP_FINALIZED", bundle.bundleSha256, deployedRunnerPath(bundle));
		context.home = remoteHomeFromDeployRoot(bundle.deployRoot);

		// ---- 1. 扩展快照部署（与生产同一份部署器/同一个 target）----
		const snapshot = readEffectiveExtensionSnapshot({ appPath: resolve("."), resourcesPath: resolve("."), isDev: true });
		if (snapshot === undefined) throw stableFailure("EXT_SNAPSHOT_UNAVAILABLE");
		const fileNames = remoteExtensionSnapshotFileNames(snapshot.manifest);
		const deployed = await deployRemoteExtensionSnapshot({
			userDataDir: directory,
			hostId: context.hostId,
			generation: 1,
			nonce: sentinel(),
			nodePath: node.nodePath,
			client,
			launcher: createSshProcessLauncher(),
			snapshot: { dir: snapshot.dir, names: fileNames },
		});
		const extensionsRoot = deployedExtensionSnapshotRoot(deployed);
		console.log("SNAPSHOT_DEPLOYED", deployed.bundleSha256, `files=${fileNames.length}`, extensionsRoot);

		// 抽查一个入口文件的远端 sha256 与本地清单一致（激活时 entry 已整份核对过，这里给出独立证据）。
		const sample = snapshot.manifest.files.find((file) => file.name === "pi-deck-todo.ts") ?? snapshot.manifest.files[0];
		const hashResult = await runPinnedCommand(context, `sha256sum ${quotePosixArgument(`${extensionsRoot}/${sample.name}`)}`);
		const remoteSha = String(hashResult.stdout ?? "")
			.trim()
			.split(/\s+/)[0];
		if (hashResult.exitCode !== 0 || remoteSha !== sample.sha256) throw stableFailure("SNAPSHOT_HASH_MISMATCH", [`file=${sample.name}`, `expected=${sample.sha256}`, `observed=${boundedField(remoteSha)}`]);
		const countResult = await runPinnedCommand(context, `ls ${quotePosixArgument(extensionsRoot)} | wc -l`);
		const remoteCount = Number(String(countResult.stdout ?? "").trim());
		if (countResult.exitCode !== 0 || remoteCount !== fileNames.length) throw stableFailure("SNAPSHOT_COUNT_MISMATCH", [`expected=${fileNames.length}`, `observed=${remoteCount}`]);
		console.log("SNAPSHOT_VERIFIED", sample.name, remoteSha, `count=${remoteCount}`);

		// ---- 2. 安全策略快照：写固定路径，校验 mode 与 sha ----
		const policyBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, enabled: true, defaultLevelId: "strict", levels: [], sessionLevels: {} }), "utf8");
		await writeRemoteSecurityPolicySnapshot({
			userDataDir: directory,
			hostId: context.hostId,
			generation: 1,
			nodePath: node.nodePath,
			deployRoot: bundle.deployRoot,
			bytes: policyBytes,
			client,
			launcher: createSshProcessLauncher(),
			nonce: sentinel(),
		});
		const policyPath = remoteSecurityPolicyPath(bundle.deployRoot);
		const policyResult = await runPinnedCommand(context, `stat -c %a ${quotePosixArgument(policyPath)}; sha256sum ${quotePosixArgument(policyPath)}`);
		const [modeLine, shaLine] = String(policyResult.stdout ?? "")
			.trim()
			.split("\n");
		const policySha = String(shaLine ?? "")
			.trim()
			.split(/\s+/)[0];
		const expectedPolicySha = createHash("sha256").update(policyBytes).digest("hex");
		if (policyResult.exitCode !== 0 || String(modeLine ?? "").trim() !== "600" || policySha !== expectedPolicySha) throw stableFailure("SECURITY_ARTIFACT_UNVERIFIED", [`mode=${boundedField(modeLine)}`, `sha=${boundedField(policySha)}`]);
		console.log("SECURITY_ARTIFACT_OK", policyPath, `mode=600`, `sha=${expectedPolicySha}`);

		// ---- 3. 探针 pi：runner env 合并与 -e 路径存在性（不碰模型）----
		const probeDir = await mkdtemp(join(tmpdir(), "pideck-remote-extensions-probe-"));
		cleanup.push(() => rm(probeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
		await writeFile(join(probeDir, "probe-pi.mjs"), PROBE_SOURCE);
		const probeDeploy = await deployRemoteExtensionSnapshot({
			userDataDir: directory,
			hostId: context.hostId,
			generation: 2,
			nonce: sentinel(),
			nodePath: node.nodePath,
			client,
			launcher: createSshProcessLauncher(),
			snapshot: { dir: probeDir, names: ["probe-pi.mjs"] },
		});
		const probeRoot = deployedExtensionSnapshotRoot(probeDeploy);
		// 探针快照只属于本次验收：内容寻址目录不是应用快照，跑完就删（主快照保留，供会话共用）。
		cleanup.push(async () => {
			await runPinnedCommand(context, `rm -rf ${quotePosixArgument(probeRoot)}`).catch(() => undefined);
		});
		const probeOut = `/tmp/pideck-ext-probe-${sentinel()}.json`;
		cleanup.push(async () => {
			await runPinnedCommand(context, `rm -f ${quotePosixArgument(probeOut)}`).catch(() => undefined);
		});
		const injectable = listRemoteInjectableExtensionNames({ available: new Set(fileNames), envAvailable: true });
		const extensionPaths = injectable.map((name) => `${extensionsRoot}/${name}`);
		const probePlan = buildRemotePiRuntimePlan({
			hostId: context.hostId,
			generation: 1,
			remoteCwd: REMOTE_CWD,
			nodePath: node.nodePath,
			piPath: `${probeRoot}/probe-pi.mjs`,
			runnerPath: deployedRunnerPath(bundle),
			nonce: sentinel(),
			extensions: extensionPaths,
			env: { PIDECK_SECURITY_CONFIG: policyPath, PIDECK_SESSION_ID: "e2e-session-1", PIDECK_PROBE_OUT: probeOut },
		});
		const probeRuntime = await createSshPiRuntimeLauncher({ userDataDir: directory, client, launcher: createSshProcessLauncher(), handshakeTimeoutMs: budget(60_000) }).launch(probePlan);
		let probeStderr = "";
		probeRuntime.stderr.on("data", (chunk) => {
			if (probeStderr.length < 4000) probeStderr += String(chunk);
		});
		const probeExit = await withDeadline(new Promise((resolveExit) => probeRuntime.onExit(resolveExit)), 60_000, "PROBE_EXIT_TIMEOUT");
		if (probeExit.code !== 0) throw stableFailure("PROBE_EXIT_NONZERO", [`code=${probeExit.code}`, `signal=${boundedField(probeExit.signal ?? "none")}`, `stderr=${boundedField(probeStderr)}`]);
		const probeRead = await runPinnedCommand(context, `cat ${quotePosixArgument(probeOut)}`);
		if (probeRead.exitCode !== 0) throw stableFailure("PROBE_OUTPUT_MISSING", [`exitCode=${probeRead.exitCode}`]);
		let probe;
		try {
			probe = JSON.parse(String(probeRead.stdout));
		} catch {
			throw stableFailure("PROBE_OUTPUT_UNREADABLE");
		}
		const expectedExtensions = injectable.length;
		if (probe.extensionCount !== expectedExtensions) throw stableFailure("PROBE_ARGV_MISMATCH", [`expected=${expectedExtensions}`, `observed=${probe.extensionCount}`]);
		if (probe.extensionsExist !== true) throw stableFailure("PROBE_EXTENSION_PATH_MISSING");
		if (probe.securityPath !== policyPath || probe.securityExists !== true) throw stableFailure("PROBE_SECURITY_ENV_MISMATCH", [`path=${boundedField(probe.securityPath ?? "none")}`, `exists=${probe.securityExists}`]);
		if (probe.sessionId !== "e2e-session-1") throw stableFailure("PROBE_SESSION_ENV_MISMATCH", [`observed=${boundedField(probe.sessionId ?? "none")}`]);
		console.log("PROBE_ENV_OK", `extensions=${probe.extensionCount}`, `security=${policyPath}`, `sessionId=${probe.sessionId}`);

		// ---- 4. 真实远端 pi 1.x 加载九个扩展并注册命令 ----
		const runtimePlan = buildRemotePiRuntimePlan({
			hostId: context.hostId,
			generation: 2,
			remoteCwd: REMOTE_CWD,
			nodePath: node.nodePath,
			piPath: (await loadPiPath(context, node)).piPath,
			runnerPath: deployedRunnerPath(bundle),
			nonce: sentinel(),
			extensions: extensionPaths,
			env: { PIDECK_SECURITY_CONFIG: policyPath, PIDECK_SESSION_ID: "e2e-session-1" },
		});
		runtime = await createSshPiRuntimeLauncher({ userDataDir: directory, client, launcher: createSshProcessLauncher(), handshakeTimeoutMs: budget(60_000) }).launch(runtimePlan);
		const rpc = new PiRpcClient(runtime.stdin, runtime.stdout);
		const commands = await requestOk(rpc, { type: "get_commands" }, "REMOTE_COMMANDS_RPC_FAILED");
		const names = new Set((Array.isArray(commands.data?.commands) ? commands.data.commands : []).map((command) => command?.name).filter((name) => typeof name === "string"));
		for (const required of ["todo", "plan", "goal"]) {
			if (!names.has(required)) throw stableFailure("REMOTE_COMMAND_MISSING", [`command=${required}`, `observed=${boundedField([...names].slice(0, 20).join(","))}`]);
		}
		console.log("REMOTE_COMMANDS_OK", `pi=${runtimePlan.piPath}`, `commands=${["todo", "plan", "goal"].join(",")}`);
		if (process.argv.includes("--with-prompt")) {
			const state = await requestOk(rpc, { type: "get_state" }, "PLAN_STATE_RPC_FAILED");
			const sessionFile = state.data?.sessionFile;
			if (typeof sessionFile !== "string" || !sessionFile.startsWith(`${context.home}/.pi/agent/sessions/`)) throw stableFailure("PLAN_SESSION_FILE_INVALID", [`observed=${boundedField(sessionFile ?? "none", 300)}`]);
			cleanup.push(async () => {
				await runPinnedCommand(context, `rm -f ${quotePosixArgument(sessionFile)}`).catch(() => undefined);
			});
			// 与渲染层发出的形状一致：隐藏标记在首行，用户可见正文紧随其后。
			const hidden = [PI_DECK_PLAN_MODE_MARKER, "只回复 ok", "", "请先只做只读分析，不要修改文件。最后必须输出以 `Plan:` 开头的编号计划，格式如下：", "Plan:", "1. 第一步"].join("\n");
			await requestOk(rpc, { type: "prompt", message: hidden }, "PLAN_PROMPT_RPC_FAILED");
			const planDeadline = Date.now() + budget(120_000);
			let sessionText = "";
			for (;;) {
				const read = await runPinnedCommand(context, `cat ${quotePosixArgument(sessionFile)}`);
				if (read.exitCode === 0) sessionText = String(read.stdout);
				if (sessionText.includes("只回复 ok") || Date.now() >= planDeadline) break;
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
			}
			if (!sessionText.includes("只回复 ok")) throw stableFailure("PLAN_SESSION_UNCONFIRMED", [`sessionFile=${sessionFile}`, `bytes=${sessionText.length}`]);
			if (sessionText.includes(PI_DECK_PLAN_MODE_MARKER)) throw stableFailure("PLAN_MARKER_LEAKED", [`sessionFile=${sessionFile}`]);
			console.log("PLAN_MARKER_STRIPPED", sessionFile);
		}
		console.log("EXTENSIONS_E2E_OK", `injected=${injectable.length}`, `snapshot=${deployed.bundleSha256}`);
	} finally {
		if (runtime) await runtime.stop("shutdown").catch(() => undefined);
		for (const step of cleanup.reverse()) await Promise.resolve(step()).catch(() => undefined);
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
	}
}

const piCache = new Map();
/** 解析远端 pi（脚本只跑一次，缓存只是为了在两步之间复用同一答案）。 */
async function loadPiPath(context, node) {
	const key = `${context.hostId}:${node.nodePath}`;
	if (!piCache.has(key)) {
		const { resolveRemotePiExecutable } = loadTsCommonJs("src/main/remote/RemotePiDiscovery.ts");
		piCache.set(key, await resolveRemotePiExecutable({ userDataDir: context.directory, hostId: context.hostId, client: context.client, sentinel: randomBytes(16).toString("hex"), nodePath: node.nodePath }));
	}
	return piCache.get(key);
}

const [host, user, fingerprint] = process.argv.slice(2);
if (!HOST_INPUT.test(host ?? "") || !USER_INPUT.test(user ?? "") || !FINGERPRINT_INPUT.test(fingerprint ?? "")) {
	process.exitCode = 1;
	console.error("SMOKE_INPUT_INVALID");
	console.error(USAGE);
} else {
	try {
		await main(host, user, fingerprint);
	} catch (error) {
		reportFailure(error);
	}
}
