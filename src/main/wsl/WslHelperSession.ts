/**
 * 发行版内 helper 的会话层（`docs/wsl-project-in-distro-io-plan.md` Wave 1a，决定 1/4）。
 *
 * 为什么需要这层、而不是每次文件操作起一次 `wsl.exe`：NDJSON helper 一次 spawn 就能服务 list/search/read
 * 的多次往返，冷启 `wsl.exe` 要 100–300ms，抽屉与搜索按一次一进程会直接卡死。协议、方法词汇表与
 * `RemoteControlClient`（`send`/`handleLine` 与 transport 无关）全部照用 SSH 侧对象——WSL 只是把同一个
 * helper 跑在 `wsl.exe -d <distro> -u <user>` 的 stdio 上，**没有第二种协议**。
 *
 * 与 SSH 侧的区别只在「谁在承担不受信」：发行版是本机受信 FS，所以没有连接状态机、没有退避重连、
 * 没有 bootstrap 仪式；这里的失败全部是稳定码 + 由调用方决定重试。会话池按 `distro+user+root` 复用，
 * 进程退出后下一次请求自动重建。
 *
 * 启动口径沿用 `wslPiProbe` 的结论：`-e /usr/bin/env PATH=<nodeBin>:<WSL_PI_BASE_PATH> node <helper> --root <root>`。
 * `-e` 是 exec（不重新过 shell），环境赋值是独立 argv，项目路径因此永远不会变成命令语法。
 */

import { execFile, spawn as spawnProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { STABLE_CODE_PATTERN } from "../../shared/op";
import { WSL_HELPER_SESSION_CODES } from "../../shared/types/wslHelper";
import { createRemoteControlClient, type RemoteControlClient } from "../remote/RemoteControlClient";
import { REMOTE_HELPER_MAX_FRAME_BYTES, REMOTE_HELPER_MAX_METHOD_LENGTH, REMOTE_HELPER_METHOD_HELLO, REMOTE_HELPER_PROTOCOL_VERSION, type RemoteHelperCancelResult } from "../remote/RemoteHelperContract";
import { resolveHelperEntryPath } from "../remote/RemoteHelperCommand";
import { REMOTE_HELPER_ENTRY_FILE_NAME } from "../remote/RemoteHelperEntry";
import { isRemoteRunnerAbsolutePath } from "../remote/RemoteRunnerContract";
import { deployWslHelperBundle, type WslHelperDeployment } from "./WslHelperDeploy";
import { buildWslPiProbeScript, parseWslPiProbeOutput, WSL_PI_BASE_PATH, WSL_PI_PROBE_TIMEOUT_MS } from "./wslPiProbe";
import { decodeWslOutput, getWslExe } from "./wslExe";

/** hello 的本地截止：helper 已在发行版里跑起来，它要么立刻答要么就是坏的，不能无限挂。 */
export const WSL_HELPER_HANDSHAKE_TIMEOUT_MS = 20_000;

/** 文件域必备能力，与 SSH 侧同一份清单：缺一个就不是可用的文件会话。 */
const REQUIRED_HELPER_CAPABILITIES = ["fs.stat", "fs.list", "fs.read"] as const;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 一个项目在发行版内的会话身份。`root` 是**发行版内** Linux 绝对路径（不是 UNC）：
 * 这条链路只认 Linux 路径，转换发生在取项目身份的那一层。
 */
export type WslHelperSessionTarget = { distro: string; user: string; root: string };

export type WslHelperRequestOptions = {
	timeoutMs?: number;
	repo?: string;
	/** 帧写出后回报请求 id；与 SSH 侧同一语义，是 `cancel` 唯一认的名字。 */
	onRequestId?: (requestId: string) => void;
};

export type WslHelperSession = {
	readonly target: WslHelperSessionTarget;
	readonly deployment: WslHelperDeployment;
	/** helper 在 hello 里报告的发行版 HOME。 */
	readonly home: string;
	readonly capabilities: readonly string[];
	readonly helperVersion: string | undefined;
	readonly nodeVersion: string | undefined;
	readonly alive: boolean;
	request(method: string, params?: unknown, options?: WslHelperRequestOptions): Promise<unknown>;
	cancel(requestId: string, options?: { timeoutMs?: number }): Promise<RemoteHelperCancelResult>;
	close(reason?: string): void;
};

/** 子进程最小面：单测用假实现驱动 stdout 帧与退出，生产用 `spawn`。 */
export type WslHelperChild = {
	stdin: Writable | null;
	stdout: Readable | null;
	stderr: Readable | null;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
};

export type WslHelperSpawnInput = { command: string; args: string[] };
export type WslHelperSpawn = (input: WslHelperSpawnInput) => WslHelperChild;

/** 在发行版内找 node bin 目录：复用的是 `wslPiProbe` 的脚本与解析，不另立一套探测。 */
export type WslHelperNodeLookup = (input: { distro: string; user: string }) => Promise<string | undefined>;

export type WslHelperSessionPoolDeps = {
	platform?: NodeJS.Platform;
	/** 部署口：单测注入假部署，生产用发行版内写入。 */
	deploy?: (input: { distro: string; user: string; nodeBinDir: string }) => Promise<{ ok: true; value: WslHelperDeployment } | { ok: false; code: string }>;
	lookupNodeBinDir?: WslHelperNodeLookup;
	spawn?: WslHelperSpawn;
	handshakeTimeoutMs?: number;
};

export type WslHelperSessionPool = {
	request(target: WslHelperSessionTarget, method: string, params?: unknown, options?: WslHelperRequestOptions): Promise<unknown>;
	cancel(target: WslHelperSessionTarget, requestId: string, options?: { timeoutMs?: number }): Promise<RemoteHelperCancelResult>;
	/** 项目关闭/移除时释放；不存在的项目是 no-op。 */
	close(target: WslHelperSessionTarget): void;
	closeAll(): void;
	/** 只读诊断：当前活着的会话数。 */
	activeCount(): number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** distro/user 是设置数据：只做「可用作 argv token」的检查，不解释内容。 */
function isUsableToken(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !CONTROL_CHARS.test(value);
}

function isValidTarget(value: unknown): value is WslHelperSessionTarget {
	if (!isRecord(value)) return false;
	return isUsableToken(value.distro) && isUsableToken(value.user) && isRemoteRunnerAbsolutePath(value.root);
}

function targetKey(target: WslHelperSessionTarget): string {
	return JSON.stringify([target.distro, target.user, target.root]);
}

function fail(code: string): Error {
	return new Error(code);
}

/** PATH 注入与 `buildWslPiExecArgs` 同一口径：`/` 表示不前置（node 已在系统 bin 里）。 */
function helperPathValue(nodeBinDir: string): string {
	return nodeBinDir === "/" ? WSL_PI_BASE_PATH : `${nodeBinDir}:${WSL_PI_BASE_PATH}`;
}

/**
 * helper 的启动 argv。`-e /usr/bin/env PATH=... node <entry> --root <root>`：
 * 环境赋值与路径都是独立 argv，不经任何 shell 重新解析（`&`、引号、`$( )` 都不成为语法）。
 */
export function buildWslHelperLaunchArgs(input: { distro: string; user: string; nodeBinDir: string; deployRoot: string; bundleSha256: string; root: string }): string[] {
	if (!isValidTarget({ distro: input?.distro, user: input?.user, root: input?.root })) throw fail(WSL_HELPER_SESSION_CODES.inputInvalid);
	if (!isRemoteRunnerAbsolutePath(input.nodeBinDir) && input.nodeBinDir !== "/") throw fail(WSL_HELPER_SESSION_CODES.inputInvalid);
	const entry = resolveHelperEntryPath({ deployRoot: input.deployRoot, bundleSha256: input.bundleSha256, entryName: REMOTE_HELPER_ENTRY_FILE_NAME });
	return ["-d", input.distro, "-u", input.user, "-e", "/usr/bin/env", `PATH=${helperPathValue(input.nodeBinDir)}`, "node", entry, "--root", input.root];
}

/** 生产 spawn：`wsl.exe` 自带 stdio，shell 回退会把 argv 变成命令语法，必须显式关闭。 */
const defaultSpawn: WslHelperSpawn = ({ command, args }) => spawnProcess(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false }) as unknown as WslHelperChild;

/** 默认 node 定位：与 `PiLocator.runWslPiProbe` 同一脚本/解析，只保留这里需要的两种 shell。 */
const defaultLookupNodeBinDir: WslHelperNodeLookup = async ({ distro, user }) => {
	const script = buildWslPiProbeScript();
	for (const [shell, flags] of [
		["/bin/bash", ["-lic"]],
		["/bin/sh", ["-c"]],
	] as const) {
		const output = await runProbe(distro, user, shell, [...flags], script);
		if (output === null) continue;
		return parseWslPiProbeOutput(output)?.nodeBinDir || undefined;
	}
	return undefined;
};

function runProbe(distro: string, user: string, shell: string, flags: string[], script: string): Promise<string | null> {
	const exe = getWslExe();
	if (exe.shell) return Promise.resolve(null);
	return new Promise((resolve) => {
		const child = execFile(exe.command, ["-d", distro, "-u", user, "-e", shell, ...flags, script], { encoding: "buffer", timeout: WSL_PI_PROBE_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			if (error) {
				resolve(null);
				return;
			}
			resolve(decodeWslOutput(stdout));
		});
		// 交互 shell 的 rc 里一句 `read` 就能把探测挂到超时。
		child.stdin?.end();
	});
}

/**
 * NDJSON 分帧：与 helper 的 `\n` 终止符一一对应。超过帧上限时整条会话作废（`onOverflow`），
 * 不做「截断后继续」——那样会把半帧当协议数据交给客户端。
 */
function attachFrameReader(stream: Readable, onLine: (line: string) => void, onOverflow: () => void): void {
	let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	stream.on("data", (chunk: Buffer | string) => {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
		pending = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
		let newline = pending.indexOf(10);
		while (newline !== -1) {
			const line = pending.subarray(0, newline).toString("utf8");
			pending = pending.subarray(newline + 1);
			onLine(line);
			newline = pending.indexOf(10);
		}
		if (pending.length > REMOTE_HELPER_MAX_FRAME_BYTES) {
			pending = Buffer.alloc(0);
			onOverflow();
		}
	});
}

const REQUEST_ID_PATTERN = /^req-\d{1,18}$/;

/**
 * 从客户端刚编码的帧里读出请求 id。客户端只按 id 暴露取消，帧是 id 唯一以文本出现的地方；
 * 只接受它自己 mint 的形状，别的帧一律不填——调用方拿不到 id 就只是不能取消，不会被骗。
 */
function acceptFrameId(capture: { method: string; id?: string }, line: string): void {
	if (capture.id !== undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	if (!isRecord(parsed) || parsed.method !== capture.method) return;
	const id = parsed.id;
	if (typeof id === "string" && REQUEST_ID_PATTERN.test(id)) capture.id = id;
}

type HelloFacts = { home: string; capabilities: readonly string[]; helperVersion: string | undefined; nodeVersion: string | undefined };

function readHelloResult(value: unknown, requestedRoot: string): HelloFacts {
	if (!isRecord(value)) throw fail(WSL_HELPER_SESSION_CODES.handshakeInvalid);
	if (value.protocolVersion !== REMOTE_HELPER_PROTOCOL_VERSION) throw fail(WSL_HELPER_SESSION_CODES.protocolMismatch);
	if (typeof value.platform !== "string" || typeof value.arch !== "string" || typeof value.home !== "string" || !Array.isArray(value.capabilities)) throw fail(WSL_HELPER_SESSION_CODES.handshakeInvalid);
	// helper 在启动时解析一次 root 并报告 canonical 结果：相等才证明 confinement 边界就是用户确认的目录。
	if (value.root !== requestedRoot) throw fail(WSL_HELPER_SESSION_CODES.rootMismatch);
	const capabilities = value.capabilities.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= REMOTE_HELPER_MAX_METHOD_LENGTH);
	if (REQUIRED_HELPER_CAPABILITIES.some((required) => capabilities.includes(required) === false)) throw fail(WSL_HELPER_SESSION_CODES.capabilityMissing);
	return {
		home: value.home,
		capabilities,
		helperVersion: typeof value.helperVersion === "string" ? value.helperVersion : undefined,
		nodeVersion: typeof value.nodeVersion === "string" ? value.nodeVersion : undefined,
	};
}

/** 请求 id 的捕获槽：所有请求共用同一条 transport，但同一时刻只有一个请求在写自己的帧。 */
type IdCaptureSlot = { current?: { method: string; id?: string } };

function createWslHelperSession(input: { target: WslHelperSessionTarget; deployment: WslHelperDeployment; child: WslHelperChild; control: RemoteControlClient; facts: HelloFacts; capture: IdCaptureSlot; onGone: () => void }): WslHelperSession {
	let alive = true;
	const release = (reason: string): void => {
		if (!alive) return;
		alive = false;
		try {
			input.control.closeConnection(reason);
		} catch {
			// 释放路径从退出回调里跑，不能把异常抛回事件循环。
		}
		try {
			input.child.kill();
		} catch {
			// 进程可能已经结束。
		}
		input.onGone();
	};

	return {
		target: input.target,
		deployment: input.deployment,
		home: input.facts.home,
		capabilities: input.facts.capabilities,
		helperVersion: input.facts.helperVersion,
		nodeVersion: input.facts.nodeVersion,
		get alive() {
			return alive;
		},
		async request(method, params, options) {
			if (!alive) throw fail(WSL_HELPER_SESSION_CODES.exited);
			if (typeof method !== "string" || method.length === 0 || method.length > REMOTE_HELPER_MAX_METHOD_LENGTH) throw fail(WSL_HELPER_SESSION_CODES.inputInvalid);
			const capture: { method: string; id?: string } = { method };
			// `control.request` 在返回 Promise 之前同步编码并写出帧，所以这个槽只覆盖它自己的写窗口。
			input.capture.current = capture;
			try {
				const result = await input.control.request(method, params, {
					...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
					...(options?.repo === undefined ? {} : { repo: options.repo }),
				});
				const requestId = capture.id;
				// id 只在这条请求自己的帧被写出后才存在；回报失败的观察者不得影响请求本身。
				if (requestId !== undefined && options?.onRequestId !== undefined) {
					try {
						options.onRequestId(requestId);
					} catch {
						// Observer side channel.
					}
				}
				return result;
			} finally {
				if (input.capture.current === capture) input.capture.current = undefined;
			}
		},
		async cancel(requestId, options) {
			if (!alive) throw fail(WSL_HELPER_SESSION_CODES.exited);
			return await input.control.cancel(requestId, options);
		},
		close(reason) {
			release(reason ?? "WSL_HELPER_SESSION_CLOSED");
		},
	};
}

export function createWslHelperSessionPool(deps: WslHelperSessionPoolDeps = {}): WslHelperSessionPool {
	const platform = deps.platform ?? process.platform;
	const deploy = deps.deploy ?? ((input) => deployWslHelperBundle(input));
	const lookupNodeBinDir = deps.lookupNodeBinDir ?? defaultLookupNodeBinDir;
	const spawn = deps.spawn ?? defaultSpawn;
	const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? WSL_HELPER_HANDSHAKE_TIMEOUT_MS;

	const sessions = new Map<string, WslHelperSession>();
	const connecting = new Map<string, Promise<WslHelperSession>>();
	const nodeBinDirs = new Map<string, Promise<string | undefined>>();
	const deployments = new Map<string, Promise<WslHelperDeployment>>();

	function deployOnce(distro: string, user: string, nodeBinDir: string): Promise<WslHelperDeployment> {
		const key = JSON.stringify([distro, user]);
		const existing = deployments.get(key);
		if (existing !== undefined) return existing;
		const task = (async () => {
			const deployed = await deploy({ distro, user, nodeBinDir });
			if (deployed.ok === false) {
				deployments.delete(key);
				throw fail(deployed.code);
			}
			return deployed.value;
		})();
		deployments.set(key, task);
		task.catch(() => {
			if (deployments.get(key) === task) deployments.delete(key);
		});
		return task;
	}

	function nodeBinDirFor(target: WslHelperSessionTarget): Promise<string | undefined> {
		const key = JSON.stringify([target.distro, target.user]);
		const existing = nodeBinDirs.get(key);
		if (existing !== undefined) return existing;
		// 只缓存成功结果：「这次没找到」可能是发行版刚启动/刚装 nvm，下一次请求应当重新探测。
		const task = lookupNodeBinDir({ distro: target.distro, user: target.user }).then((value) => {
			if (value === undefined && nodeBinDirs.get(key) === task) nodeBinDirs.delete(key);
			return value;
		});
		nodeBinDirs.set(key, task);
		return task;
	}

	async function connect(target: WslHelperSessionTarget): Promise<WslHelperSession> {
		if (platform !== "win32") throw fail(WSL_HELPER_SESSION_CODES.unavailable);
		const exe = getWslExe();
		if (exe.shell) throw fail(WSL_HELPER_SESSION_CODES.unavailable);
		const nodeBinDir = await nodeBinDirFor(target);
		if (nodeBinDir === undefined) throw fail(WSL_HELPER_SESSION_CODES.nodeMissing);
		const deployment = await deployOnce(target.distro, target.user, nodeBinDir);
		const args = buildWslHelperLaunchArgs({ distro: target.distro, user: target.user, nodeBinDir, deployRoot: deployment.deployRoot, bundleSha256: deployment.bundleSha256, root: target.root });
		let child: WslHelperChild;
		try {
			child = spawn({ command: exe.command, args });
		} catch {
			throw fail(WSL_HELPER_SESSION_CODES.unavailable);
		}
		if (child.stdin === null || child.stdout === null || child.stderr === null) {
			child.kill();
			throw fail(WSL_HELPER_SESSION_CODES.unavailable);
		}
		const key = targetKey(target);
		let session: WslHelperSession | undefined;
		const drop = (): void => {
			if (session !== undefined && sessions.get(key) === session) sessions.delete(key);
		};
		const capture: IdCaptureSlot = {};
		const control = createRemoteControlClient({
			hostId: `wsl-${target.distro}-${target.user}`,
			send: (line) => {
				child.stdin?.write(`${line}\n`);
				// 帧刚离开 transport，id 现在才是一个可以拿来取消的名字。
				const armed = capture.current;
				if (armed !== undefined) acceptFrameId(armed, line);
			},
		});
		control.openConnection();
		attachFrameReader(
			child.stdout,
			(line) => control.handleLine(line),
			() => {
				control.closeConnection("REMOTE_FRAME_TOO_LARGE");
				child.kill();
			},
		);
		// stderr 只用于排空管道：helper 的报错文本不进入任何稳定码。
		child.stderr.on("data", () => undefined);

		const cleanup = (): void => {
			try {
				control.closeConnection("WSL_HELPER_SESSION_EXITED");
			} catch {
				// ignore
			}
			try {
				child.kill();
			} catch {
				// ignore
			}
		};

		let facts: HelloFacts;
		try {
			// 退出发生在握手前：请求以 REMOTE_CONNECTION_LOST 被拒，走 catch 的清理即可。
			// 退出发生在会话建立后：由会话自己的 close 统一收口（标记死亡 + 池里摘除）。
			child.on("exit", () => {
				if (session !== undefined) session.close("WSL_HELPER_SESSION_EXITED");
				else control.closeConnection("REMOTE_CONNECTION_LOST");
			});
			const hello = await control.request(REMOTE_HELPER_METHOD_HELLO, undefined, { timeoutMs: handshakeTimeoutMs });
			facts = readHelloResult(hello, target.root);
		} catch (error) {
			cleanup();
			throw error instanceof Error && STABLE_CODE_PATTERN.test(error.message) ? error : fail(WSL_HELPER_SESSION_CODES.handshakeInvalid);
		}

		session = createWslHelperSession({ target, deployment, child, control, facts, capture, onGone: drop });
		return session;
	}

	async function sessionFor(target: WslHelperSessionTarget): Promise<WslHelperSession> {
		if (!isValidTarget(target)) throw fail(WSL_HELPER_SESSION_CODES.inputInvalid);
		const key = targetKey(target);
		const existing = sessions.get(key);
		if (existing !== undefined && existing.alive) return existing;
		const pending = connecting.get(key);
		if (pending !== undefined) return pending;
		const task = connect(target).then(
			(session) => {
				connecting.delete(key);
				sessions.set(key, session);
				return session;
			},
			(error: unknown) => {
				connecting.delete(key);
				throw error;
			},
		);
		connecting.set(key, task);
		return task;
	}

	return {
		async request(target, method, params, options) {
			const session = await sessionFor(target);
			return await session.request(method, params, options);
		},
		async cancel(target, requestId, options) {
			const session = await sessionFor(target);
			return await session.cancel(requestId, options);
		},
		close(target) {
			if (!isValidTarget(target)) return;
			const key = targetKey(target);
			const session = sessions.get(key);
			sessions.delete(key);
			session?.close("WSL_HELPER_SESSION_CLOSED");
		},
		closeAll() {
			for (const session of [...sessions.values()]) session.close("WSL_HELPER_SESSION_CLOSED");
			sessions.clear();
		},
		activeCount() {
			return sessions.size;
		},
	};
}
