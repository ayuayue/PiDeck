import { clearTimeout, setTimeout } from "node:timers";
import type { LocalServiceStatus } from "../../shared/localServices";
import type { LocalServiceAdapter } from "./LocalServiceRegistry";
import type { LocalServiceCli } from "./localServiceCli";

const BILI_SERVICE_ID = "billion-context";
/** `bili` 没有 stop 子命令，也没有查询子命令；`doctor --json` 是官方只读体检，进程表就是状态源。 */
const DOCTOR_ARGS = ["doctor", "--json"];
const START_ARGS = ["start"];
const DOCTOR_TIMEOUT_MS = 20_000;
const START_SETTLE_MS = 20_000;
const STOP_SETTLE_MS = 10_000;
const POLL_INTERVAL_MS = 500;
/** UI 路径是双下划线；`/bili/` 会被当未知协议透传给 Anthropic 回 403。 */
const BILI_UI_PATH = "/__bili/";

export type BillionContextServiceDeps = {
	cli: LocalServiceCli;
	kill: (pid: number) => Promise<boolean>;
	/** 轮询节奏与预算。测试用来把「等进程起来/落下」压到毫秒级；生产一律用默认值。 */
	timing?: { pollMs?: number; startSettleMs?: number; stopSettleMs?: number };
};

type ServiceSnapshot = { running: boolean; pid?: number; origin?: string; version?: string; instances: { pid: number; origin: string }[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 只认回环地址：UI 地址从 CLI 报告里读，但必须落在 127.0.0.1/localhost 上。
 * 面板只监听回环且无鉴权，这一层收口同时挡住了「报告被改写成公网地址」把内置浏览器带走。
 */
function loopbackOrigin(entry: Record<string, unknown>): string | undefined {
	const port = typeof entry.port === "number" && Number.isInteger(entry.port) && entry.port > 0 && entry.port < 65_536 ? entry.port : undefined;
	const candidate = typeof entry.origin === "string" && entry.origin ? entry.origin : port ? `http://127.0.0.1:${port}` : undefined;
	if (!candidate) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:") return undefined;
	if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return undefined;
	if (!parsed.port) return undefined;
	return `http://${parsed.hostname}:${parsed.port}`;
}

function readVersion(report: Record<string, unknown>): string | undefined {
	const install = isRecord(report.global) ? report.global : undefined;
	const value = install?.runningVersion ?? install?.diskVersion;
	return typeof value === "string" && value.length > 0 && value.length <= 40 ? value : undefined;
}

/** 解析 `bili doctor --json`：返回 null 表示报告本身不可用（区别于「装了但没在跑」）。 */
export function parseBillionContextReport(stdout: string): ServiceSnapshot | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const version = readVersion(parsed);
	const processes = Array.isArray(parsed.processes) ? parsed.processes : [];
	// 全部活实例都收（bili 支持 lane daemon，进程表可能同时有多行）；第一个仍是主实例。
	const instances: { pid: number; origin: string }[] = [];
	for (const entry of processes) {
		if (!isRecord(entry) || entry.alive !== true) continue;
		const pid = typeof entry.pid === "number" && Number.isInteger(entry.pid) && entry.pid > 0 ? entry.pid : undefined;
		const origin = loopbackOrigin(entry);
		if (!pid || !origin) continue;
		instances.push({ pid, origin });
	}
	if (instances.length > 0) return { running: true, pid: instances[0].pid, origin: instances[0].origin, instances, ...(version ? { version } : {}) };
	return { running: false, instances: [], ...(version ? { version } : {}) };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * billion-context（`bili`）服务适配器。
 *
 * 命令固定为 `bili doctor --json` / `bili start`，停止按 doctor 报告的 pid 终止——
 * 插件能提供的只有服务 ID，命令、参数、端口解析全在这里，因此「服务控制」不构成
 * 「执行任意命令」的能力面。
 */
export class BillionContextService implements LocalServiceAdapter {
	readonly id = BILI_SERVICE_ID;
	private readonly timing: { pollMs: number; startSettleMs: number; stopSettleMs: number };

	constructor(private readonly deps: BillionContextServiceDeps) {
		this.timing = {
			pollMs: deps.timing?.pollMs ?? POLL_INTERVAL_MS,
			startSettleMs: deps.timing?.startSettleMs ?? START_SETTLE_MS,
			stopSettleMs: deps.timing?.stopSettleMs ?? STOP_SETTLE_MS,
		};
	}

	async status(signal?: AbortSignal): Promise<LocalServiceStatus> {
		const report = await this.deps.cli.run(DOCTOR_ARGS, DOCTOR_TIMEOUT_MS);
		if (!report.ok) return { id: this.id, available: false, running: false, reason: report.reason };
		const snapshot = parseBillionContextReport(report.stdout);
		if (!snapshot) return { id: this.id, available: false, running: false, reason: "invalid-report" };
		if (!snapshot.running) return { id: this.id, available: true, running: false, ...(snapshot.version ? { version: snapshot.version } : {}) };
		const withVersion = (url: string) => ({ uiUrl: url, ...(snapshot.version ? { version: snapshot.version } : {}) });
		return {
			id: this.id,
			available: true,
			running: true,
			pid: snapshot.pid,
			...withVersion(`${snapshot.origin}${BILI_UI_PATH}`),
			// lane daemon（如 pi 自己拉起的实例）也会出现在进程表里：全部带给面板，
			// openUi(pid) 从这份白名单里点名，插件依旧拿不到「注 own 地址」的能力面。
			instances: snapshot.instances.map((inst) => ({ pid: inst.pid, uiUrl: `${inst.origin}${BILI_UI_PATH}` })),
		};
	}

	async start(signal?: AbortSignal): Promise<LocalServiceStatus> {
		const current = await this.status(signal);
		if (!current.available || current.running) return current;
		const spawned = this.deps.cli.spawnDetached(START_ARGS);
		if (!spawned.ok) return { id: this.id, available: true, running: false, reason: spawned.reason };
		return (await this.waitFor(signal, this.timing.startSettleMs, (next) => next.running)) ?? { id: this.id, available: true, running: false, reason: "start-timeout" };
	}

	async stop(signal?: AbortSignal): Promise<LocalServiceStatus> {
		const current = await this.status(signal);
		if (!current.available || !current.running || !current.pid) return { id: this.id, available: current.available, running: false };
		const killed = await this.deps.kill(current.pid);
		if (!killed) return { ...current, reason: "stop-failed" };
		const settled = await this.waitFor(signal, this.timing.stopSettleMs, (next) => !next.running);
		if (settled) return settled;
		// 终止动作本身成功了，但服务又回来了：这个代理可能被别的持有方管着（例如 pi 的 bili 扩展
		// 发现自己的代理掉了就重新拉起）。「停不掉」和「停了又被拉起来」是两件事，
		// 用 pid 变化分开报，面板才能给出能读得懂的解释而不是一个笼统的失败。
		const latest = await this.status(signal);
		if (!latest.running) return latest;
		return { ...latest, reason: latest.pid !== undefined && latest.pid !== current.pid ? "stop-restarted" : "stop-failed" };
	}

	/** 轮询到期望状态为止；信号中断（插件被撤销授权）或超出预算返回 null，由调用方给稳定原因码。 */
	private async waitFor(signal: AbortSignal | undefined, budgetMs: number, done: (status: LocalServiceStatus) => boolean): Promise<LocalServiceStatus | null> {
		const deadline = Date.now() + budgetMs;
		for (;;) {
			const status = await this.status(signal);
			if (done(status)) return status;
			if (signal?.aborted || Date.now() >= deadline) return null;
			await delay(this.timing.pollMs, signal);
			if (signal?.aborted) return null;
		}
	}
}
