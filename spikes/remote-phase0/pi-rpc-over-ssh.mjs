/**
 * Phase 0 spike：system ssh 启动远端 `pi --mode rpc`，完成 get_state → prompt → abort 完整 RPC turn。
 *
 * 对应 docs/remote-development-plan.md §12 Phase 0 门禁：
 *   1. 无 orphan Pi —— 断开本地 ssh 后，远端 pi 在有限时间内退出（--check-orphan 用第二条连接验证）；
 *   2. stdout 无额外 banner —— 逐行 JSON.parse，任何非 JSON 行都判 FAIL；
 *   3. 网络断开能在有限时间内触发 exit —— kill 本地 ssh 进程，测量流关闭耗时；
 *   4. 不需修改 Pi —— 只消费 pi 官方 stdio JSON-RPC（与 PiDeck 本地 PiRpcClient 同协议）。
 *
 * 用法：
 *   node spikes/remote-phase0/pi-rpc-over-ssh.mjs --self-test
 *   node spikes/remote-phase0/pi-rpc-over-ssh.mjs --host <alias> --fingerprint-only
 *        # 只观察候选 key；须从主机控制台/管理员的独立渠道核对 fingerprint
 *   node spikes/remote-phase0/pi-rpc-over-ssh.mjs --self-test --probe-model jiyuan/deepseek-flash --verify-model-output
 *   node spikes/remote-phase0/pi-rpc-over-ssh.mjs --host <alias> --expected-fingerprint SHA256:<fingerprint> \
 *        --pi /absolute/path/to/pi --probe-model jiyuan/deepseek-flash --verify-model-output
 *        # 会产生一次真实模型调用；仅在明确授权后运行
 *   node spikes/remote-phase0/pi-rpc-over-ssh.mjs --host <alias> \
 *        --expected-fingerprint SHA256:<fingerprint> --pi /absolute/path/to/pi --cwd /tmp --check-orphan
 *        # 发送并取消一条最小 prompt，验证 SSH/RPC/断线回收
 *
 * 设计约束（与计划 §8.3 对齐）：
 *   - ssh 进程用 argv 数组 spawn（shell:false）；远端命令仅有固定程序/flags 与经过 POSIX 单引号转义的 cwd；
 *   - 本 spike 为验证 cwd 使用 `cd && exec` wrapper；产品版由 runner stdin 握手传入 cwd；
 *   - 真机 prompt 可能触发模型调用；需经用户同意，使用专用测试账号与现有目录。
 *   - 脚本不直接写项目文件或杀掉其他会话的进程；Pi 仍可能写入其会话目录/日志。
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

// ---------- 参数 ----------

function parseArgs(argv) {
	const args = {
		host: undefined,
		cwd: "/tmp",
		pi: "pi",
		expectedFingerprint: undefined,
		checkOrphan: false,
		locatePi: false,
		inspectModelSettings: false,
		modelProbe: undefined,
		verifyModelOutput: false,
		selfTest: false,
		fingerprintOnly: false,
	};
	for (let i = 2; i < argv.length; i += 1) {
		const token = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`missing value for ${token}`);
			i += 1;
			return argv[i];
		};
		switch (token) {
			case "--host":
				args.host = next();
				break;
			case "--cwd":
				args.cwd = next();
				break;
			case "--pi":
				args.pi = next();
				break;
			case "--expected-fingerprint":
				args.expectedFingerprint = next();
				break;
			case "--check-orphan":
				args.checkOrphan = true;
				break;
			case "--locate-pi":
				args.locatePi = true;
				break;
			case "--inspect-model-settings":
				args.inspectModelSettings = true;
				break;
			case "--probe-model":
				args.modelProbe = next();
				break;
			case "--verify-model-output":
				args.verifyModelOutput = true;
				break;
			case "--self-test":
				args.selfTest = true;
				break;
			case "--fingerprint-only":
				args.fingerprintOnly = true;
				break;
			default:
				throw new Error(`unknown argument: ${token}`);
		}
	}
	if (args.modelProbe && !/^[\w.-]+\/[\w.+:-]+$/.test(args.modelProbe)) throw new Error("--probe-model must be provider/modelId");
	if (args.verifyModelOutput && !args.modelProbe) throw new Error("--verify-model-output requires --probe-model provider/modelId");
	if (args.verifyModelOutput && (args.fingerprintOnly || args.locatePi || args.inspectModelSettings)) throw new Error("--verify-model-output cannot be combined with diagnostic-only modes");
	if (!args.selfTest && !args.host) throw new Error("--host is required (or use --self-test)");
	if (!args.selfTest && !args.fingerprintOnly && !args.expectedFingerprint) throw new Error("--expected-fingerprint is required before running remote Pi; run --fingerprint-only and verify it out of band first");
	if (args.expectedFingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(args.expectedFingerprint)) throw new Error("--expected-fingerprint must be an OpenSSH SHA256 fingerprint");
	if (args.host !== undefined && (args.host.length > 255 || args.host.startsWith("-") || /[\s\0-\x1f]/.test(args.host))) {
		throw new Error("--host must be one SSH config alias or user@host token; whitespace/control characters and leading '-' are rejected");
	}
	if (!args.selfTest && (!args.cwd.startsWith("/") || /[\0\r\n]/.test(args.cwd))) throw new Error("--cwd must be an absolute POSIX path without NUL/newlines");
	if (!/^[\w./-]+$/.test(args.pi) || args.pi.startsWith("-")) throw new Error("--pi must be a single executable token without shell syntax");
	return args;
}

function quotePosix(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function runtimePathPrefix(args) {
	// A Pi installed under nvm usually needs the adjacent Node instead of /usr/bin/node.
	return args.pi.startsWith("/") ? `export PATH=${quotePosix(posix.dirname(args.pi))}:"$PATH" && ` : "";
}

// ---------- 结果清单 ----------

const results = [];
let checkScope = "传输/生命周期检查";
function record(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------- 精简 JSONL RPC 客户端（协议对齐 src/main/pi/PiRpcClient.ts） ----------

class JsonlRpcClient {
	constructor(stdin, stdout) {
		this.stdin = stdin;
		this.pending = new Map();
		this.events = [];
		this.waiters = [];
		this.nonJsonLines = [];
		this.buffer = "";
		this.nextId = 1;
		this.closed = false;
		stdout.setEncoding("utf8");
		stdout.on("data", (chunk) => this.consume(chunk));
		stdout.on("end", () => {
			if (this.buffer.trim()) this.nonJsonLines.push(`unterminated stdout frame: ${this.buffer.slice(0, 200)}`);
			this.fail(new Error("RPC stdout ended"));
		});
		stdin.on("error", (error) => this.fail(error));
	}

	fail(error) {
		if (this.closed) return;
		this.closed = true;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`${error.message} (pending ${id})`));
		}
		this.pending.clear();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters = [];
	}

	waitForEvent(predicate, timeoutMs) {
		if (this.closed) return Promise.reject(new Error("RPC stream is closed"));
		const index = this.events.findIndex(predicate);
		if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve: (event) => {
					clearTimeout(waiter.timer);
					this.waiters = this.waiters.filter((item) => item !== waiter);
					resolve(event);
				},
				reject: (error) => {
					clearTimeout(waiter.timer);
					this.waiters = this.waiters.filter((item) => item !== waiter);
					reject(error);
				},
				timer: undefined,
			};
			waiter.timer = setTimeout(() => waiter.reject(new Error(`event timeout after ${timeoutMs}ms`)), timeoutMs);
			this.waiters.push(waiter);
		});
	}

	consume(chunk) {
		this.buffer += chunk;
		if (this.buffer.length > 8 * 1024 * 1024) {
			this.nonJsonLines.push("stdout line exceeded 8 MiB without LF");
			this.buffer = "";
			return;
		}
		while (true) {
			const index = this.buffer.indexOf("\n");
			if (index === -1) return;
			let line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				// Phase 0 门禁 2：stdout 无额外 banner。非 JSON 行记录原文（截断）。
				this.nonJsonLines.push(line.slice(0, 200));
				continue;
			}
			if (!message || typeof message !== "object" || Array.isArray(message)) {
				this.nonJsonLines.push(`non-object JSON frame: ${line.slice(0, 200)}`);
				continue;
			}
			if (message.type === "response" && message.id && this.pending.has(message.id)) {
				const { resolve, timer } = this.pending.get(message.id);
				this.pending.delete(message.id);
				clearTimeout(timer);
				resolve(message);
			} else {
				const waiter = this.waiters.find((item) => item.predicate(message));
				if (waiter) waiter.resolve(message);
				else this.events.push(message);
			}
		}
	}

	request(payload, timeoutMs) {
		if (this.closed) return Promise.reject(new Error(`RPC client is closed: ${String(payload.type)}`));
		const id = `spike-${this.nextId}`;
		this.nextId += 1;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout after ${timeoutMs}ms: ${String(payload.type)}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	end() {
		this.stdin.end();
	}
}

// ---------- 通用：带超时的进程退出等待 ----------

function waitForExit(child, label, timeoutMs) {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
		const timer = setTimeout(() => {
			record(`${label} 在 ${timeoutMs}ms 内退出`, false, "超时，强制回收");
			child.kill("SIGKILL");
			resolve({ code: null, signal: null, timedOut: true });
		}, timeoutMs);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, timedOut: false });
		});
	});
}

function sshOptions(args) {
	return [
		"-o", `UserKnownHostsFile=${args.knownHosts}`,
		"-o", `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
		"-o", "StrictHostKeyChecking=yes",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=15",
	];
}

/** 启动远端 pi：selfTest 时 spawn 本地 node fake-pi，否则 spawn system ssh。 */
function launchRuntime(args) {
	if (args.selfTest) {
		return spawn(process.execPath, [join(import.meta.dirname, "fake-pi.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
	}
	// This diagnostic spike quotes a test cwd for its cwd check. Product runtime
	// launch will send cwd in the runner init frame, never in the remote command.
	const remoteCommand = `${runtimePathPrefix(args)}cd ${quotePosix(args.cwd)} && printf 'PIDECK_SPIKE_PID=%s\\n' "$$" >&2 && exec ${quotePosix(args.pi)} --mode rpc --no-themes --offline`;
	return spawn("ssh", [...sshOptions(args), "--", args.host, remoteCommand], { stdio: ["pipe", "pipe", "pipe"], shell: false });
}

// ---------- 场景 1：完整 RPC turn ----------

async function runFullTurn(args) {
	console.log(`\n=== 场景 1：RPC turn（${args.selfTest ? "self-test / 本地假 pi" : `ssh ${args.host}`}） ===`);
	const child = launchRuntime(args);
	let stderrTail = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderrTail = (stderrTail + chunk).slice(-2000);
	});
	const client = new JsonlRpcClient(child.stdin, child.stdout);
	child.on("error", (error) => client.fail(error));
	try {
		const state = await client.request({ type: "get_state" }, 30_000);
		const stateOk = state.success === true;
		record("get_state 返回 success", stateOk, state.error ? `error=${state.error}` : "");
		if (stateOk) {
			let promptSettled = false;
			const promptResult = client.request({ type: "prompt", message: "Reply with exactly: PIDECK-SPIKE-OK" }, 45_000)
				.then((response) => ({ response }), (error) => ({ error }))
				.finally(() => { promptSettled = true; });
			let started = false;
			try {
				await client.waitForEvent((event) => event.type === "agent_start", 30_000);
				started = true;
			} catch (error) {
				record("收到 agent_start", false, error.message);
			}
			if (started) record("收到 agent_start", true);
			const wasActive = started && !promptSettled;
			try {
				const abort = await client.request({ type: "abort" }, 10_000);
				record("运行中 abort RPC 返回 success", wasActive && abort.success === true, `active=${wasActive} success=${abort.success}`);
			} catch (error) {
				record("运行中 abort RPC 返回 success", false, error.message);
			}
			const prompt = await promptResult;
			record("prompt RPC 已结算", Boolean(prompt.response), prompt.response ? `success=${prompt.response.success}` : prompt.error.message);
			const end = client.events.find((event) => event.type === "agent_end");
			const assistant = Array.isArray(end?.messages) ? end.messages.filter((message) => message?.role === "assistant").at(-1) : undefined;
			console.log(`  agent_end: stopReason=${end?.stopReason ?? "unknown"}, assistantStopReason=${assistant?.stopReason ?? "unknown"}（已取消回合，不判定模型输出）`);
		}
	} catch (error) {
		record("get_state 返回 success", false, error.message);
	} finally {
		record("stdout 无非 JSON 行", client.nonJsonLines.length === 0, client.nonJsonLines[0] ?? "");
		record("收到事件帧", client.events.length > 0, client.events.map((event) => event.type).join(", "));
		client.end();
		const exit = await waitForExit(child, "pi/ssh 正常关闭", 15_000);
		record("stdin EOF 后进程退出", !exit.timedOut && exit.code === 0, `exit=${exit.code} signal=${exit.signal}`);
		if (stderrTail.trim()) console.log(`  (stderr 诊断尾部): ${stderrTail.trim().slice(0, 300)}`);
	}
}

// ---------- 场景 2：断线回收 ----------

async function runDisconnect(args) {
	console.log(`\n=== 场景 2：本地 ssh 断开 → 有限时间内退出（${args.selfTest ? "self-test 跳过" : `ssh ${args.host}`}） ===`);
	if (args.selfTest) {
		console.log("SKIP  self-test 模式无 ssh 进程，跳过");
		return;
	}
	const child = launchRuntime(args);
	const client = new JsonlRpcClient(child.stdin, child.stdout);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
	child.on("error", (error) => client.fail(error));
	try {
		const state = await client.request({ type: "get_state" }, 30_000);
		if (!state.success) throw new Error(state.error ?? "get_state 未成功");
	} catch (error) {
		record("断线场景 get_state 预热", false, error.message);
		client.end();
		await waitForExit(child, "预热失败后的 ssh", 5_000);
		return;
	}
	const remotePid = stderr.match(/PIDECK_SPIKE_PID=(\d+)/)?.[1];
	record("取得本次远端 pi PID", Boolean(remotePid), remotePid ? `pid=${remotePid}` : "未收到启动标记");

	const killed = Date.now();
	child.kill("SIGKILL");
	const exit = await waitForExit(child, "ssh 断线路径", 15_000);
	record("本地 ssh 强制结束", !exit.timedOut && (exit.code !== null || exit.signal !== null), `耗时=${Date.now() - killed}ms`);
	if (!args.checkOrphan) {
		console.log("SKIP  远端 PID 回收检查：真机运行请加 --check-orphan");
		return;
	}
	if (!remotePid) return;
	await new Promise((resolve) => setTimeout(resolve, 5_000));
	const check = await new Promise((resolve) => {
		const probe = spawn("ssh", [...sshOptions(args), "--", args.host, `ps -p ${remotePid} -o args=`], { stdio: ["ignore", "pipe", "pipe"], shell: false });
		let out = "";
		probe.stdout.setEncoding("utf8");
		probe.stdout.on("data", (chunk) => { out = (out + chunk).slice(-500); });
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => { probe.kill("SIGKILL"); finish({ error: "探测超时" }); }, 30_000);
		probe.once("error", (error) => finish({ error: error.message }));
		probe.once("close", (code) => finish({ code, out: out.trim() }));
	});
	record("远端本次 pi 已回收", check.code === 1, check.error ?? `ps exit=${check.code}${check.out ? ` process=${check.out}` : ""}`);
}

// ---------- 场景 3：endpoint 解析 + host key fingerprint ----------

async function runFingerprint(args) {
	console.log(`\n=== 端点解析 + host key fingerprint（ssh ${args.host}） ===`);
	const tmpDir = await mkdtemp(join(tmpdir(), "pideck-spike-kh-"));
	try {
		const knownHosts = join(tmpDir, "known_hosts");
		const config = await new Promise((resolve, reject) => {
			const probe = spawn("ssh", ["-G", "--", args.host], { stdio: ["ignore", "pipe", "pipe"], shell: false });
			let out = "";
			probe.stdout.setEncoding("utf8");
			probe.stdout.on("data", (chunk) => { out += chunk; });
			probe.once("error", reject);
			probe.once("close", (code) => code === 0 ? resolve(out) : reject(new Error(`ssh -G exit=${code}`)));
		});
		const pick = (key) => config.split("\n").find((line) => line.startsWith(`${key} `))?.slice(key.length + 1).trim();
		console.log(`  endpoint: ${pick("user")}@${pick("hostname")}:${pick("port")}`);

		// accept-new 仅把候选 key 存在临时目录；成功认证后才读取候选。
		const handshake = await new Promise((resolve) => {
			const probe = spawn("ssh", [
				"-o", `UserKnownHostsFile=${knownHosts}`,
				"-o", `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
				"-o", "StrictHostKeyChecking=accept-new",
				"-o", "BatchMode=yes",
				"-o", "ConnectTimeout=15",
				"--", args.host, "true",
			], { stdio: ["ignore", "ignore", "pipe"], shell: false });
			let stderr = "";
			probe.stderr.setEncoding("utf8");
			probe.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
			let settled = false;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			const timer = setTimeout(() => { probe.kill("SIGKILL"); finish({ ok: false, error: "握手超时" }); }, 30_000);
			probe.once("error", (error) => finish({ ok: false, error: error.message }));
			probe.once("close", (code) => finish({ ok: code === 0, error: stderr.trim() }));
		});
		if (!handshake.ok) throw new Error(`SSH 认证握手失败：${handshake.error}`);
		if (!(await readFile(knownHosts, "utf8")).trim()) throw new Error("已认证握手没有写入 host key");
		const fingerprintOutput = await new Promise((resolve, reject) => {
			const probe = spawn("ssh-keygen", ["-l", "-E", "sha256", "-f", knownHosts], { stdio: ["ignore", "pipe", "pipe"], shell: false });
			let out = "";
			probe.stdout.setEncoding("utf8");
			probe.stdout.on("data", (chunk) => { out += chunk; });
			probe.once("error", reject);
			probe.once("close", (code) => code === 0 ? resolve(out) : reject(new Error(`ssh-keygen exit=${code}`)));
		});
		const fingerprints = [...fingerprintOutput.matchAll(/SHA256:[A-Za-z0-9+/]{43}/g)].map((match) => match[0]);
		if (fingerprints.length === 0) throw new Error("ssh-keygen 未返回 SHA256 fingerprint");
		for (const fingerprint of fingerprints) console.log(`  observed host key: ${fingerprint}`);
		if (args.expectedFingerprint && !fingerprints.includes(args.expectedFingerprint)) throw new Error("候选 host key 与独立来源的 fingerprint 不一致；未连接 Pi");
		record(args.expectedFingerprint ? "fingerprint 与独立来源匹配" : "已取得候选 fingerprint（待独立核对）", true);
		args.knownHosts = knownHosts;
		return tmpDir;
	} catch (error) {
		await rm(tmpDir, { recursive: true, force: true });
		throw error;
	}
}

async function runRemotePreflight(args) {
	const command = `${runtimePathPrefix(args)}cd ${quotePosix(args.cwd)} && pwd && uname -s && uname -m && node --version && ${quotePosix(args.pi)} --version`;
	const result = await new Promise((resolve) => {
		const probe = spawn("ssh", [...sshOptions(args), "--", args.host, command], { stdio: ["ignore", "pipe", "pipe"], shell: false });
		let stdout = "";
		let stderr = "";
		probe.stdout.setEncoding("utf8");
		probe.stderr.setEncoding("utf8");
		probe.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-4000); });
		probe.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => { probe.kill("SIGKILL"); finish({ error: "远端预检超时" }); }, 30_000);
		probe.once("error", (error) => finish({ error: error.message }));
		probe.once("close", (code) => finish({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
	});
	if (result.error || result.code !== 0) throw new Error(`远端 cwd/Node/Pi 预检失败：${result.error ?? result.stderr ?? `exit=${result.code}`}`);
	console.log(`  remote cwd / OS / arch / Node / Pi:\n${result.stdout.split("\n").map((line) => `    ${line}`).join("\n")}`);
	record("远端 cwd、Node、Pi 可用", true);
}

async function runRemotePiLookup(args) {
	const command = `printf 'default node: '; command -v node || true; printf 'default pi: '; command -v pi || true; printf 'login pi: '; bash -lc 'command -v pi' || true; for candidate in "$HOME"/.nvm/versions/node/*/bin/pi "$HOME"/.local/bin/pi "$HOME"/.asdf/shims/pi "$HOME"/.volta/bin/pi /usr/local/bin/pi /opt/homebrew/bin/pi; do if [ -x "$candidate" ]; then printf 'candidate: %s\\n' "$candidate"; fi; done`;
	const result = await new Promise((resolve) => {
		const probe = spawn("ssh", [...sshOptions(args), "--", args.host, command], { stdio: ["ignore", "pipe", "pipe"], shell: false });
		let stdout = "";
		let stderr = "";
		probe.stdout.setEncoding("utf8");
		probe.stderr.setEncoding("utf8");
		probe.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-4000); });
		probe.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => { probe.kill("SIGKILL"); finish({ error: "Pi 路径诊断超时" }); }, 30_000);
		probe.once("error", (error) => finish({ error: error.message }));
		probe.once("close", (code) => finish({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
	});
	if (result.error || result.code !== 0) throw new Error(`Pi 路径诊断失败：${result.error ?? result.stderr ?? `exit=${result.code}`}`);
	console.log(`  ${result.stdout.split("\n").join("\n  ")}`);
	record("已完成只读 Pi 路径诊断", true);
}

async function inspectRemoteModelSettings(args) {
	const source = [
		"const fs=require('fs'); const os=require('os');",
		"for(const file of [os.homedir()+'/.pi/agent/settings.json','/tmp/.pi/settings.json']) {",
		"  if(!fs.existsSync(file)) { console.log(file+' absent'); continue; }",
		"  let settings; try { settings=JSON.parse(fs.readFileSync(file,'utf8')); } catch { console.log(file+' unreadable'); continue; }",
		"  for(const key of ['enabledModels','defaultModel','defaultProvider','model']) {",
		"    const value=settings[key]; const values=Array.isArray(value)?value.filter(x=>typeof x==='string'):(typeof value==='string'?[value]:[]);",
		"    for(const item of values) {",
		"      if(item.includes('deepseek-v4-flash-0731')) console.log(file+' '+key+' contains old pattern');",
		"      if(item.includes('deepseek-flash')) console.log(file+' '+key+' contains deepseek-flash');",
		"    }",
		"  }",
		"}",
	].join("\n");
	const result = await new Promise((resolve) => {
		const probe = spawn("ssh", [...sshOptions(args), "--", args.host, `node -e ${quotePosix(source)}`], { stdio: ["ignore", "pipe", "pipe"], shell: false });
		let stdout = "";
		let stderr = "";
		probe.stdout.setEncoding("utf8");
		probe.stderr.setEncoding("utf8");
		probe.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-4000); });
		probe.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => { probe.kill("SIGKILL"); finish({ error: "设置检查超时" }); }, 30_000);
		probe.once("error", (error) => finish({ error: error.message }));
		probe.once("close", (code) => finish({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
	});
	if (result.error || result.code !== 0) throw new Error(`模型选择字段检查失败：${result.error ?? result.stderr ?? `exit=${result.code}`}`);
	console.log(`  ${result.stdout.split("\n").join("\n  ")}`);
	record("已检查远端 Pi 模型选择字段（无凭据输出）", true);
}

async function runModelSelectionProbe(args) {
	const [provider, modelId] = args.modelProbe.split("/");
	console.log(`\n=== set_model/get_state 探针（${args.selfTest ? "本地假 pi" : `ssh ${args.host}`}） ===`);
	const child = launchRuntime(args);
	const client = new JsonlRpcClient(child.stdin, child.stdout);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
	child.on("error", (error) => client.fail(error));
	try {
		const initial = await client.request({ type: "get_state" }, 30_000);
		if (!initial.success) throw new Error(`initial get_state: ${initial.error ?? "unsuccessful"}`);
		const selected = await client.request({ type: "set_model", provider, modelId }, 30_000);
		record("set_model RPC 返回 success", selected.success === true, selected.error ?? `${provider}/${modelId}`);
		if (selected.success) {
			const state = await client.request({ type: "get_state" }, 30_000);
			const actual = state.data?.model;
			const matches = state.success === true && actual?.provider === provider && actual?.id === modelId;
			record("get_state 确认所选模型", matches, actual ? `${actual.provider}/${actual.id}` : "state 中没有 model");
		}
	} catch (error) {
		record("模型选择 RPC 探针", false, error.message);
	} finally {
		record("模型探针 stdout 无非 JSON 行", client.nonJsonLines.length === 0, client.nonJsonLines[0] ?? "");
		client.end();
		const exit = await waitForExit(child, "模型探针 Pi 进程", 15_000);
		record("模型探针 Pi 进程正常退出", !exit.timedOut && exit.code === 0, `exit=${exit.code} signal=${exit.signal}`);
		const warning = stderr.match(/No models match pattern "([^"]+)"/);
		if (warning) console.log(`  Pi settings warning: No models match pattern "${warning[1]}"`);
	}
}

async function runModelOutputProbe(args) {
	const [provider, modelId] = args.modelProbe.split("/");
	const expectedText = "PIDECK-PHASE0-OK";
	console.log(`\n=== 完整模型回答验证（${args.selfTest ? "本地假 pi" : `ssh ${args.host}`}；${provider}/${modelId}） ===`);
	const child = launchRuntime(args);
	const client = new JsonlRpcClient(child.stdin, child.stdout);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
	child.on("error", (error) => client.fail(error));
	try {
		const initial = await client.request({ type: "get_state" }, 30_000);
		if (!initial.success) throw new Error(`initial get_state: ${initial.error ?? "unsuccessful"}`);
		const selected = await client.request({ type: "set_model", provider, modelId }, 30_000);
		record("set_model RPC 返回 success", selected.success === true, selected.error ?? `${provider}/${modelId}`);
		if (!selected.success) return;
		const state = await client.request({ type: "get_state" }, 30_000);
		const actual = state.data?.model;
		const modelMatches = state.success === true && actual?.provider === provider && actual?.id === modelId;
		record("get_state 确认所选模型", modelMatches, actual ? `${actual.provider}/${actual.id}` : "state 中没有 model");
		if (!modelMatches) return;

		const prompt = await client.request({ type: "prompt", message: `Reply with exactly: ${expectedText}` }, 90_000);
		record("prompt RPC 返回 success", prompt.success === true, prompt.error ?? "");
		if (!prompt.success) return;
		let end;
		try {
			end = await client.waitForEvent((event) => event.type === "agent_end", 10_000);
		} catch (error) {
			record("收到 agent_end", false, error.message);
			return;
		}
		const assistants = Array.isArray(end.messages) ? end.messages.filter((message) => message?.role === "assistant") : [];
		const assistant = assistants.at(-1);
		const content = assistant?.content;
		const text = typeof content === "string"
			? content
			: Array.isArray(content)
				? content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("")
				: "";
		const modelCallSucceeded = end.stopReason !== "error" && assistant?.stopReason !== "error";
		record("收到 agent_end", true, `stopReason=${end.stopReason ?? "unknown"}`);
		record("真实回答符合预期文本", modelCallSucceeded && text.trim() === expectedText, `assistantStopReason=${assistant?.stopReason ?? "unknown"}`);
	} catch (error) {
		record("完整模型回答验证", false, error.message);
	} finally {
		record("完整模型探针 stdout 无非 JSON 行", client.nonJsonLines.length === 0, client.nonJsonLines[0] ?? "");
		client.end();
		const exit = await waitForExit(child, "完整模型探针 Pi 进程", 15_000);
		record("完整模型探针 Pi 进程正常退出", !exit.timedOut && exit.code === 0, `exit=${exit.code} signal=${exit.signal}`);
		const warning = stderr.match(/No models match pattern "([^"]+)"/);
		if (warning) console.log(`  Pi settings warning: No models match pattern "${warning[1]}"`);
	}
}

// ---------- main ----------

let pinDir;
try {
	const args = parseArgs(process.argv);
	if (args.verifyModelOutput) checkScope = "模型响应 + SSH/RPC 检查";
	else if (args.modelProbe) checkScope = "模型选择 + SSH/RPC 检查";
	else if (args.inspectModelSettings) checkScope = "远端设置只读检查";
	else if (args.locatePi) checkScope = "远端 Pi 路径只读检查";
	else if (args.fingerprintOnly) checkScope = "Host fingerprint 观察";
	if (!args.selfTest) pinDir = await runFingerprint(args);
	if (args.inspectModelSettings) await inspectRemoteModelSettings(args);
	else if (args.locatePi) await runRemotePiLookup(args);
	else if (args.verifyModelOutput) {
		if (!args.selfTest) await runRemotePreflight(args);
		await runModelOutputProbe(args);
	} else if (args.modelProbe) {
		if (!args.selfTest) await runRemotePreflight(args);
		await runModelSelectionProbe(args);
	} else if (!args.fingerprintOnly) {
		if (!args.selfTest) await runRemotePreflight(args);
		await runFullTurn(args);
		await runDisconnect(args);
	}
} catch (error) {
	record("spike 参数/启动", false, error.message);
} finally {
	if (pinDir) await rm(pinDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n=== ${checkScope}：${results.length - failed.length}/${results.length} PASS（跨平台 HostVerifier 矩阵未覆盖） ===`);
process.exit(failed.length > 0 ? 1 : 0);
