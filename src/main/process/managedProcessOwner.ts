import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readProcIdentity } from "../instanceLockFile";

export const MANAGED_PROCESS_OWNER_ENV = "PIDECK_PROCESS_OWNER";
export type ManagedProcessOwner = { scope: string; pid: number; startTicks: number; bootId: string };
let owner: ManagedProcessOwner | undefined;

/** 实例身份只用于本地子进程生命周期；不传消息、不处理 pi 行为或远端进程。 */
export function configureManagedProcessOwner(userDataDir: string): void {
	if (process.platform !== "linux") return;
	try {
		const identity = readProcIdentity(process.pid);
		const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		if (!identity?.startTicks || !bootId) return;
		owner = { scope: createHash("sha256").update(userDataDir).digest("hex"), pid: process.pid, startTicks: identity.startTicks, bootId };
	} catch {
		/* /proc 不可用就不注入，不能假造归属 */
	}
}

export function currentManagedProcessOwner(): ManagedProcessOwner | undefined {
	return owner;
}

/** 不可让工具 env 或继承自外层 PiDeck 的旧标记覆盖当前实例身份。 */
export function managedProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next = { ...env };
	delete next[MANAGED_PROCESS_OWNER_ENV];
	if (owner) next[MANAGED_PROCESS_OWNER_ENV] = JSON.stringify(owner);
	return next;
}

export function parseManagedProcessOwner(raw: string): ManagedProcessOwner | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || !("scope" in value) || !("pid" in value) || !("startTicks" in value) || !("bootId" in value)) return undefined;
		if (
			typeof value.scope !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.scope) ||
			typeof value.pid !== "number" ||
			!Number.isSafeInteger(value.pid) ||
			value.pid <= 1 ||
			typeof value.startTicks !== "number" ||
			!Number.isSafeInteger(value.startTicks) ||
			value.startTicks <= 0 ||
			typeof value.bootId !== "string" ||
			!/^[a-f0-9-]{36}$/.test(value.bootId)
		)
			return undefined;
		return { scope: value.scope, pid: value.pid, startTicks: value.startTicks, bootId: value.bootId };
	} catch {
		return undefined;
	}
}
