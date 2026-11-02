/**
 * 同主机多项目 root 池化测量探针（ADR 证据；**不是默认单测**）。
 *
 * 背景：产品当前「每主机一个 held helper + root 固定」：两个远端项目交替读取时，establishProjectSession
 * 会先 discard 旧 manager/held，再重新 resolveNode → bootstrap（F3 复用已安装 bundle，通常不 scp）→
 * SSH + node helper --root → hello → root 复核 → 首次 list/目录 watch。本脚本在**真实主机**上按现有
 * helper 协议与现有远端命令，测量这条链路上可独立观测的成本：
 *
 *   - sshConnectMs          : 一次 ssh 短命令的建连+RTT（node 发现/root 复核/bundle verify 各自都要一次）
 *   - nodeDiscoveryMs       : 登录 shell PATH 探测（resolveNode 的远端部分，含一次 ssh）
 *   - rootProbeMs           : readlink -f <root>（establishProjectSession 的 canonical 复核，含一次 ssh）
 *   - bundleScanMs          : sha256sum 已部署 bundle 文件（F3 verify-existing 的远端扫描代理）
 *   - startToHelloMs        : spawn ssh+node helper --root 到 hello（helper 冷启动 + 握手）
 *   - helloToListMs         : hello 后首次 fs.list(".")（项目树第一次读）
 *   - watchSubscribeMs      : fs.watch(根 + 已加载目录) 的订阅往返（换代后必须重建）
 *   - switchTotalMs         : 一次完整 cycle（spawn→hello→list→watch→kill 结束）
 *   - switchHandshakeMs     : 同上但只到 hello（决定用户等待的首帧）
 *
 * 明确不能测到的（ADR 里写清，不冒充产品 API 测量）：
 *   - RemoteHostConnectionService 的 host operation lock 排队、pin/route 构造、bootstrap staging 帧、
 *     bundle 上传（F3 复用命中时本应 0 次，但脚本无法证明产品走到了 verify-existing）；
 *   - 渲染层 lazyDirTree 换代后对**全部已加载目录**的并发重读与 watcher rewatch（脚本只按固定 8 条路径
 *     代理一次 watch 帧；产品按 4 watcher × 32 路径分片）；
 *   - Electron/真实 UI 时序。
 * 因此输出里的 productProxy 只是**下界代理**，字段名与结论都必须带 proxy 标注。
 *
 * 用法（凭据只从环境读，不打印）：
 *   PowerShell:  $env:PIDECK_E2E_REMOTE_HOST=...; $env:PIDECK_E2E_REMOTE_USER=...;
 *                $env:PIDECK_E2E_REMOTE_FINGERPRINT=SHA256:...; $env:PIDECK_E2E_REMOTE_PORT=22;
 *                node tests/remoteRootSwitchProbe.mjs
 *   （本仓库的临时 wrapper 会在子进程内注入同一组变量；探针本身只读 env。）
 *
 * 退出码：0 = 已测量或凭据缺失（后者 verdict=not-measured，不伪造数字）；1 = 测量完成但 helper 出现失败码；
 *         2 = 建连/前置/夹具失败（输出含稳定原因，不含主机名/用户名）。
 */

import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const host = process.env.PIDECK_E2E_REMOTE_HOST ?? "";
const user = process.env.PIDECK_E2E_REMOTE_USER ?? "";
const port = process.env.PIDECK_E2E_REMOTE_PORT ?? "22";
const FINGERPRINT = process.env.PIDECK_E2E_REMOTE_FINGERPRINT ?? "";
const HOST_ID = "55555555-5555-4555-8555-555555555555";
const CYCLES = 5; // 冷启动 1 次 + 4 次切换（A→B→A→B→A）
const ROOT_NAMES = ["A", "B"];
const WATCH_DIRS = ["", "d00", "d01", "d02", "d03", "d04", "d05", "d06", "d07"];

const out = {
	probe: "remoteRootSwitchProbe",
	version: 1,
	measuredAt: new Date().toISOString(),
	host: "<host>",
	user: "<user>",
	fingerprint: FINGERPRINT === "" ? "<missing>" : "<set>",
	verdict: "unknown",
	cycles: CYCLES,
	setup: {},
	primitives: {},
	switches: {},
	counts: {},
	failures: [],
	proxy: {},
	notes: ["productProxy 是下界代理：不含 host operation lock 排队、pin/route 构造、bootstrap staging/上传、渲染层重读与分片 rewatch。", "watcher 重建按 helper 帧计数：每次换代后项目必须重新 fs.watch；产品还会对全部已加载目录重新分片。"],
};

function sanitize(text) {
	return String(text).split(host).join("<host>").split(user).join("<user>");
}

function sshBase(extra = []) {
	return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8", "-p", port, ...extra, user + "@" + host];
}

function sshRun(command, timeout = 30_000) {
	const started = performance.now();
	const result = spawnSync("ssh", [...sshBase(), command], { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: sanitize((result.stderr ?? "").trim()).slice(0, 200),
		ms: performance.now() - started,
	};
}

function stats(values) {
	if (values.length === 0) return { count: 0 };
	const sorted = [...values].sort((left, right) => left - right);
	const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[(sorted.length - 1) / 2];
	const round = (value) => Math.round(value * 100) / 100;
	return { count: values.length, minMs: round(sorted[0]), medianMs: round(median), maxMs: round(sorted[sorted.length - 1]), samples: values.map(round) };
}

function safeDirName(root, fallback) {
	const name = root.split("/").filter(Boolean).pop() ?? "";
	return /^[A-Za-z]+$/.test(name) ? name : fallback;
}

/** One helper child per cycle: production starts a new ssh + node helper on every root switch. */
function startHelper(nodePath, helperPath, root) {
	// One remote-command string, fully quoted: ssh hands it to the remote shell, and the absolute node path is
	// required because a non-interactive session does not load the user's login-shell PATH (nvm etc.).
	const child = spawn("ssh", [...sshBase(["-T"]), nodePath + " '" + helperPath + "' --root '" + root + "'"], { stdio: ["pipe", "pipe", "pipe"] });
	child.stdin.setDefaultEncoding("utf8");
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let buffered = "";
	let stderr = "";
	const waiters = new Set();
	const frames = [];
	child.stderr.on("data", (chunk) => {
		stderr += sanitize(chunk).slice(0, 400);
	});
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		let index;
		while ((index = buffered.indexOf("\n")) >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			if (line.trim() === "") continue;
			try {
				frames.push(JSON.parse(line));
			} catch {
				out.failures.push({ method: "stdout", code: "NON_JSON_LINE" });
			}
			for (const waiter of [...waiters]) waiter();
		}
	});
	child.on("exit", () => {
		for (const waiter of [...waiters]) waiter();
	});
	return {
		child,
		frames,
		stderr: () => stderr,
		/** Wait for the next frame matching predicate (timeout bounded). */
		waitFor(predicate, label, timeoutMs = 25_000) {
			const found = frames.find(predicate);
			if (found !== undefined) return Promise.resolve(found);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(waiter);
					reject(new Error("FRAME_TIMEOUT:" + label));
				}, timeoutMs);
				const waiter = () => {
					const frame = frames.find(predicate);
					if (frame === undefined) return;
					clearTimeout(timer);
					waiters.delete(waiter);
					resolve(frame);
				};
				waiters.add(waiter);
			});
		},
		send(frame) {
			child.stdin.write(JSON.stringify(frame) + "\n");
		},
		async stop() {
			const started = performance.now();
			try {
				child.stdin.end();
			} catch {}
			await new Promise((resolve) => {
				if (child.exitCode !== null) return resolve();
				const timer = setTimeout(() => {
					try {
						child.kill();
					} catch {}
					resolve();
				}, 10_000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			return performance.now() - started;
		},
	};
}

/** One measured cycle: spawn helper, hello, list, watch, unwatch, kill. */
async function runCycle(index, nodePath, helperPath, root, watchPaths) {
	const cycle = { index, rootName: safeDirName(root, "R" + index), ok: true, codes: [] };
	const helper = startHelper(nodePath, helperPath, root);
	const t0 = performance.now();
	let phase = "start";
	try {
		helper.send({ v: 1, hostId: HOST_ID, generation: 100 + index, id: "hello-" + index, method: "hello", timeoutMs: 20_000 });
		const hello = await helper.waitFor((frame) => frame.id === "hello-" + index, "hello");
		cycle.startToHelloMs = performance.now() - t0;
		if (hello.ok !== true) throw new Error("HELLO_" + (hello.error?.code ?? "FAILED"));
		cycle.helperVersion = hello.result?.helperVersion ?? null;
		cycle.helperPid = Number.isSafeInteger(hello.result?.pid) ? hello.result.pid : null;

		phase = "list";
		const tList = performance.now();
		helper.send({ v: 1, hostId: HOST_ID, generation: 100 + index, id: "list-" + index, method: "fs.list", timeoutMs: 20_000, params: { path: "." } });
		const list = await helper.waitFor((frame) => frame.id === "list-" + index, "fs.list");
		cycle.helloToListMs = performance.now() - tList;
		if (list.ok !== true) throw new Error("LIST_" + (list.error?.code ?? "FAILED"));
		cycle.entries = Array.isArray(list.result?.entries) ? list.result.entries.length : null;

		phase = "watch";
		const tWatch = performance.now();
		helper.send({ v: 1, hostId: HOST_ID, generation: 100 + index, id: "watch-" + index, method: "fs.watch", timeoutMs: 20_000, params: { paths: watchPaths } });
		const watch = await helper.waitFor((frame) => frame.id === "watch-" + index, "fs.watch");
		cycle.watchSubscribeMs = performance.now() - tWatch;
		if (watch.ok !== true) throw new Error("WATCH_" + (watch.error?.code ?? "FAILED"));
		cycle.watchId = typeof watch.result?.watchId === "string" ? watch.result.watchId : null;
		cycle.watchPaths = watchPaths.length;

		// Unwatch before kill so a clean session does not rely on process death for cleanup.
		helper.send({ v: 1, hostId: HOST_ID, generation: 100 + index, id: "unwatch-" + index, method: "fs.unwatch", timeoutMs: 10_000, params: { watchId: cycle.watchId } });
		await helper.waitFor((frame) => frame.id === "unwatch-" + index, "fs.unwatch");

		// Capacity evidence: RSS/threads of the live helper (outside the latency measurements above).
		if (cycle.helperPid !== null) {
			const ps = sshRun("ps -p " + cycle.helperPid + " -o rss=,nlwp=");
			const parts = ps.stdout.trim().split(/s+/).filter(Boolean).map(Number);
			if (ps.status === 0 && parts.length >= 2 && Number.isFinite(parts[0])) {
				cycle.helperRssKb = parts[0];
				cycle.helperThreads = parts[1];
			}
		}
	} catch (error) {
		cycle.ok = false;
		cycle.codes.push(sanitize(error instanceof Error ? error.message : String(error)).slice(0, 120));
	} finally {
		cycle.killMs = await helper.stop();
		cycle.totalMs = performance.now() - t0;
		cycle.exitCode = helper.child.exitCode;
		// stderr is diagnostics only (never a protocol frame): keep the tail so a failed start is explainable.
		if (helper.stderr() !== "") cycle.stderr = helper.stderr().slice(-300);
	}
	return cycle;
}

async function main() {
	if (host === "" || user === "") {
		out.verdict = "not-measured";
		out.reason = "MISSING_CREDENTIALS";
		out.steps = [
			"在 PowerShell 进程内注入 PIDECK_E2E_REMOTE_HOST / USER / FINGERPRINT（可选 PORT），不要写入仓库或日志。",
			"从仓库根运行：node tests/remoteRootSwitchProbe.mjs",
			"把输出的 primitives/switches/counts/failures 原样填入 docs/remote-host-root-pooling-adr.md 的「测量」表；不要手工改数字。",
			"若验机环境由临时 wrapper 派生 env（如 %TEMP%\\pideck-v-probe.ps1 的形式），把其中的目标脚本替换为本探针并在子进程内运行，凭据不要外泄。",
		];
		console.log(JSON.stringify(out, null, 2));
		return 0;
	}

	// 1) Locate the already deployed bundle and the remote node through the same login-shell path production uses.
	const bundles = sshRun("ls -1dt $HOME/.pideck/remote-host/bundles/*/ 2>/dev/null | head -3");
	if (bundles.status !== 0 || bundles.stdout.trim() === "") throw new Error("NO_DEPLOYED_BUNDLE");
	const bundlePath = bundles.stdout.split(/\r?\n/).filter(Boolean)[0].replace(/\/$/, "");
	out.setup.bundle = { pathHashOnly: true, candidates: bundles.stdout.split(/\r?\n/).filter(Boolean).length };
	const nodeProbe = sshRun("/bin/sh -lc 'command -v node' 2>/dev/null || command -v node");
	const nodePath = nodeProbe.stdout.split(/\r?\n/).filter(Boolean).pop() ?? "";
	if (nodePath === "") throw new Error("NO_REMOTE_NODE");
	out.setup.nodeVersion = sshRun(nodePath + " -v").stdout.trim();
	const bundleFiles = ["helper.mjs", "git-read.mjs", "git-write.mjs", "git-sync.mjs", "config.mjs", "search-content.mjs", "upload-commit.mjs", "terminal-runner.mjs"];
	const present = sshRun("for f in " + bundleFiles.join(" ") + "; do [ -f '" + bundlePath + "/'$f ] && echo $f; done")
		.stdout.split(/\r?\n/)
		.filter(Boolean);
	out.setup.bundleFiles = present.length;
	out.setup.missingBundleFiles = bundleFiles.filter((name) => present.includes(name) === false);

	// 2) Two project roots with a small but non-trivial tree (deep dirs are what makes rewatch expensive).
	const roots = {};
	for (const name of ROOT_NAMES) {
		const created = sshRun("mktemp -d $HOME/.pideck-rootprobe-" + name + ".XXXXXX");
		const root = created.stdout.trim();
		if (created.status !== 0 || root === "" || !root.startsWith("/")) throw new Error("MKTEMP_FAILED_" + name);
		roots[name] = root;
		const fixture = [
			"printf 'root probe " + name + "\\n' > '" + root + "/note.txt'",
			"mkdir -p '" + root + "/d00' '" + root + "/d01' '" + root + "/d02' '" + root + "/d03' '" + root + "/d04' '" + root + "/d05' '" + root + "/d06' '" + root + "/d07'",
			...Array.from({ length: 8 }, (_value, index) => "printf 'x\\n' > '" + root + "/d0" + index + "/f.txt'"),
		].join(" && ");
		const setup = sshRun(fixture);
		if (setup.status !== 0) throw new Error("FIXTURE_SETUP_FAILED_" + name);
	}
	out.setup.roots = { a: "A:<temp>", b: "B:<temp>", treeFiles: 9, treeDirs: 8 };

	// 3) Primitive costs, each exactly one ssh command (3 samples, median reported).
	const sshSamples = [];
	const nodeSamples = [];
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const ping = sshRun("true");
		if (ping.status !== 0) throw new Error("SSH_CONNECT_FAILED");
		sshSamples.push(ping.ms);
		nodeSamples.push(sshRun("/bin/sh -lc 'command -v node' 2>/dev/null || command -v node").ms);
	}
	out.primitives.sshConnectMs = stats(sshSamples);
	out.primitives.nodeDiscoveryMs = stats(nodeSamples);
	const rootSamples = { A: [], B: [] };
	for (const name of ROOT_NAMES) for (let attempt = 0; attempt < 3; attempt += 1) rootSamples[name].push(sshRun("readlink -f '" + roots[name] + "'").ms);
	out.primitives.rootProbeMs = { a: stats(rootSamples.A), b: stats(rootSamples.B) };
	const bundleScanSamples = [];
	for (let attempt = 0; attempt < 3; attempt += 1) bundleScanSamples.push(sshRun("sha256sum " + present.map((name) => "'" + bundlePath + "/" + name + "'").join(" ") + " >/dev/null").ms);
	out.primitives.bundleScanMs = stats(bundleScanSamples);

	// 4) Alternating A→B→A→B→A cycles over the real deployed helper.
	const helperPath = bundlePath + "/helper.mjs";
	const cycles = [];
	for (let index = 0; index < CYCLES; index += 1) {
		const name = ROOT_NAMES[index % 2];
		const watchPaths = WATCH_DIRS;
		cycles.push(await runCycle(index, nodePath, helperPath, roots[name], watchPaths));
	}
	const okCycles = cycles.filter((cycle) => cycle.ok === true);
	const switchCycles = okCycles.slice(1); // exclude cold start from switch latency; cold start is reported separately
	out.switches = {
		coldStart: cycles[0]?.ok === true ? { startToHelloMs: cycles[0].startToHelloMs, helloToListMs: cycles[0].helloToListMs, totalMs: cycles[0].totalMs } : { failed: true, codes: cycles[0]?.codes ?? [] },
		startToHelloMs: stats(switchCycles.map((cycle) => cycle.startToHelloMs)),
		helloToListMs: stats(switchCycles.map((cycle) => cycle.helloToListMs)),
		watchSubscribeMs: stats(switchCycles.map((cycle) => cycle.watchSubscribeMs)),
		totalMs: stats(switchCycles.map((cycle) => cycle.totalMs)),
		killMs: stats(okCycles.map((cycle) => cycle.killMs)),
		perCycle: cycles.map((cycle) => ({
			index: cycle.index,
			root: cycle.rootName,
			ok: cycle.ok,
			startToHelloMs: cycle.startToHelloMs ?? null,
			helloToListMs: cycle.helloToListMs ?? null,
			watchSubscribeMs: cycle.watchSubscribeMs ?? null,
			totalMs: cycle.totalMs ?? null,
			watchId: cycle.watchId ?? null,
			entries: cycle.entries ?? null,
			codes: cycle.codes,
			stderr: cycle.stderr ?? null,
		})),
	};
	out.counts = {
		helperStarts: cycles.length,
		helperFailures: cycles.filter((cycle) => cycle.ok !== true).length,
		sshCommandsApprox: sshSamples.length + nodeSamples.length + Object.values(rootSamples).flat().length + bundleScanSamples.length + 4 + okCycles.length + 3,
		watcherSubscriptions: okCycles.length,
		uniqueWatchIds: new Set(okCycles.map((cycle) => cycle.watchId).filter((value) => typeof value === "string")).size,
		watchPathsPerSwitch: WATCH_DIRS.length,
	};
	const failures = cycles.flatMap((cycle) => cycle.codes.map((code) => ({ cycle: cycle.index, code })));
	out.failures = failures;

	// 5) Capacity: per-helper memory/threads from the live cycles, plus a co-residency check (two roots at once).
	const rss = okCycles.map((cycle) => cycle.helperRssKb).filter((value) => Number.isFinite(value));
	const threads = okCycles.map((cycle) => cycle.helperThreads).filter((value) => Number.isFinite(value));
	out.capacity = {
		helperRssKb: stats(rss),
		helperThreads: stats(threads),
		note: "单 helper 的 RSS/线程数来自真实主机 ps；池化 N 个 root 时进程/内存按 N 线性增长（N 个独立 ssh + node），另加每连接 SSH 客户端与缓冲区。",
	};
	try {
		const a = startHelper(nodePath, helperPath, roots.A);
		const b = startHelper(nodePath, helperPath, roots.B);
		const helloA = a.waitFor((frame) => frame.id === "co-hello-a", "co-hello-a", 20_000);
		const helloB = b.waitFor((frame) => frame.id === "co-hello-b", "co-hello-b", 20_000);
		a.send({ v: 1, hostId: HOST_ID, generation: 900, id: "co-hello-a", method: "hello", timeoutMs: 20_000 });
		b.send({ v: 1, hostId: HOST_ID, generation: 901, id: "co-hello-b", method: "hello", timeoutMs: 20_000 });
		const [first, second] = await Promise.all([helloA, helloB]);
		const pids = [first.result?.pid, second.result?.pid].filter((value) => Number.isSafeInteger(value));
		const ps = pids.length === 2 ? sshRun("ps -o rss= -o nlwp= -p " + pids.join(",")) : { status: 1, stdout: "" };
		const rows = ps.stdout
			.split(/\r?\n/)
			.map((line) => line.trim().split(/\s+/).filter(Boolean).map(Number))
			.filter((parts) => parts.length >= 2 && Number.isFinite(parts[0]));
		out.capacity.coResident = {
			ok: first.ok === true && second.ok === true,
			helperProcesses: pids.length,
			sshConnections: 2,
			rssKbEach: rows.map((parts) => parts[0]),
			threadsEach: rows.map((parts) => parts[1]),
			sumRssKb: rows.reduce((total, parts) => total + parts[0], 0),
			note: "两个 root 的 helper 可同时存活（各自 ssh 连接、各自 --root）；这是池化可行性的进程级证据，不代表产品服务已支持。",
		};
		// If the per-cycle ps variant returned no rows on this host, the co-resident sample still measures the
		// same process property; label the source instead of leaving an empty stat.
		if (out.capacity.helperRssKb.count === 0 && rows.length > 0) {
			out.capacity.helperRssKb = stats(rows.map((parts) => parts[0]));
			out.capacity.helperThreads = stats(rows.map((parts) => parts[1]));
			out.capacity.rssSource = "co-resident two-helper sample";
		}
		await Promise.all([a.stop(), b.stop()]);
	} catch (error) {
		out.capacity.coResident = { ok: false, error: sanitize(error instanceof Error ? error.message : String(error)).slice(0, 120) };
	}

	// 6) Fail-closed failure codes, measured instead of quoted from source only.
	const bad = startHelper(nodePath, helperPath, "/nonexistent-pideck-rootprobe-root");
	try {
		const startup = bad.waitFor((frame) => frame.ok === false && typeof frame.error?.code === "string", "startup-failure", 15_000);
		bad.send({ v: 1, hostId: HOST_ID, generation: 999, id: "bad-hello", method: "hello", timeoutMs: 10_000 });
		const failure = await startup;
		out.failureCodes = { invalidRoot: failure.error.code, helperExitCode: null };
	} catch (error) {
		out.failureCodes = { invalidRoot: "NO_FRAME", helperExitCode: null };
	} finally {
		await bad.stop();
		out.failureCodes.helperExitCode = bad.child.exitCode;
	}
	const vanishRoot = sshRun('d=$(mktemp -d $HOME/.pideck-rootprobe-gone.XXXXXX) && rmdir "$d" && target=$(readlink -f -- "$d"); code=0; [ -n "$target" ] || code=4; [ -d "$target" ] || code=5; echo ROOT_PROBE_EXIT=$code; exit $code');
	const vanishExit = /ROOT_PROBE_EXIT=(\d+)/.exec(vanishRoot.stdout)?.[1];
	const controlRoot = sshRun("target=$(readlink -f -- " + JSON.stringify(roots.A) + '); code=0; [ -n "$target" ] || code=4; [ -d "$target" ] || code=5; echo ROOT_PROBE_EXIT=$code; exit $code');
	const controlExit = /ROOT_PROBE_EXIT=(\d+)/.exec(controlRoot.stdout)?.[1];
	out.failureCodes.vanishedRoot = {
		probeExitCode: vanishExit === undefined ? null : Number(vanishExit),
		probeExitCodeExistingRoot: controlExit === undefined ? null : Number(controlExit),
		productCode: "establishProjectSession 把该失败记为 SSH_PROJECT_ROOT_UNRESOLVED（源码事实：verifyProjectRoot 的 catch 分支）",
	};
	// 5) Proxy lower bound for a product switch: discovery + root probe + bundle scan proxy + helper handshake/first read/watch.
	const median = (entry) => (typeof entry?.count === "number" && entry.count > 0 ? entry.medianMs : null);
	const startToHello = median(out.switches.startToHelloMs);
	const helloToList = median(out.switches.helloToListMs);
	const watchSubscribe = median(out.switches.watchSubscribeMs);
	if (startToHello !== null && helloToList !== null && watchSubscribe !== null) {
		out.proxy.productSwitchLowerBoundMs = {
			nodeDiscovery: median(out.primitives.nodeDiscoveryMs),
			rootProbe: median(out.primitives.rootProbeMs.a),
			bundleScan: median(out.primitives.bundleScanMs),
			helperStartToHello: startToHello,
			firstRead: helloToList,
			watchSubscribe: watchSubscribe,
			sumMs: Math.round((median(out.primitives.nodeDiscoveryMs) + median(out.primitives.rootProbeMs.a) + median(out.primitives.bundleScanMs) + startToHello + helloToList + watchSubscribe) * 100) / 100,
			note: "下界：不含 operation lock 排队、pin/route 构造、bootstrap staging 帧、bundle 上传、渲染层全部已加载目录的重读与 4×32 分片 rewatch。",
		};
	}
	out.verdict = failures.length === 0 ? "measured" : "measured-with-failures";
	out.cleanup = { roots: "removed" };
	// Cleanup only after all measurements: a failed cleanup is reported but never hides numbers.
	for (const name of ROOT_NAMES) {
		const cleanup = sshRun("rm -rf '" + roots[name] + "'");
		if (cleanup.status !== 0) out.cleanup.roots = "cleanup-failed";
	}
	return failures.length === 0 ? 0 : 1;
}

let exitCode = 0;
try {
	exitCode = await main();
} catch (error) {
	out.verdict = "error";
	out.error = sanitize(error instanceof Error ? error.message : String(error)).slice(0, 200);
	exitCode = 2;
}
console.log(JSON.stringify(out, null, 2));
process.exit(exitCode);
