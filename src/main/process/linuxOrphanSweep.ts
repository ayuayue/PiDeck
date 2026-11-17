import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readProcIdentity } from "../instanceLockFile";
import { currentManagedProcessOwner, MANAGED_PROCESS_OWNER_ENV, parseManagedProcessOwner, type ManagedProcessOwner } from "./managedProcessOwner";

const MAX_ENV_BYTES = 1024 * 1024;
const MAX_KILLS = 200;

async function ownerMarker(procDir: string): Promise<ManagedProcessOwner | undefined> {
	const file = await open(join(procDir, "environ"), "r");
	try {
		const bytes = Buffer.alloc(MAX_ENV_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = await file.read(bytes, length, bytes.length - length, null);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length > MAX_ENV_BYTES) return undefined;
		const prefix = `${MANAGED_PROCESS_OWNER_ENV}=`;
		const marker = bytes
			.toString("utf8", 0, length)
			.split("\0")
			.find((entry) => entry.startsWith(prefix));
		return marker ? parseManagedProcessOwner(marker.slice(prefix.length)) : undefined;
	} finally {
		await file.close();
	}
}

async function sameUser(procDir: string, uid: number): Promise<boolean> {
	const info = await stat(procDir);
	if (info.uid !== uid) return false;
	const status = await readFile(join(procDir, "status"), "utf8");
	const ids = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
	return Boolean(ids && ids.slice(1).every((value) => Number(value) === uid));
}

/** ENOENT 才证明 owner 消失；权限错误或损坏的 stat 都不能作为杀进程的依据。 */
async function ownerIsDead(owner: ManagedProcessOwner, procRoot: string, bootId: string): Promise<boolean> {
	if (owner.bootId !== bootId) return false;
	try {
		await stat(join(procRoot, String(owner.pid)));
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
	}
	const identity = readProcIdentity(owner.pid, { procRoot });
	if (!identity || identity.startTicks === null) return false;
	return identity.state === "Z" || identity.state === "X" || identity.startTicks !== owner.startTicks;
}

/**
 * Linux 只回收同 uid、同 userData 作用域、且 owner 确认已死的有标记进程。
 * 不读 cmdline、不按包名猜归属、不碰旧版无标记进程，杀前重验目标身份与 owner。
 */
export async function sweepLinuxOrphanedManagedProcesses(options: { owner?: ManagedProcessOwner; procRoot?: string; uid?: number; kill?: (pid: number) => void; platform?: NodeJS.Platform } = {}): Promise<{ found: number; killed: number }> {
	const owner = options.owner ?? currentManagedProcessOwner();
	const uid = options.uid ?? process.getuid?.();
	if ((options.platform ?? process.platform) !== "linux" || !owner || uid === undefined) return { found: 0, killed: 0 };
	const procRoot = options.procRoot ?? "/proc";
	let entries: string[];
	let bootId: string;
	try {
		entries = await readdir(procRoot);
		bootId = (await readFile(join(procRoot, "sys/kernel/random/boot_id"), "utf8")).trim();
	} catch {
		return { found: 0, killed: 0 };
	}
	let found = 0;
	let killed = 0;
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid <= 1 || pid === process.pid || pid === owner.pid) continue;
		const procDir = join(procRoot, entry);
		try {
			if (!(await sameUser(procDir, uid))) continue;
			const identity = readProcIdentity(pid, { procRoot });
			if (!identity?.startTicks || identity.state === "Z" || identity.state === "X") continue;
			const marker = await ownerMarker(procDir);
			if (!marker || marker.scope !== owner.scope || !(await ownerIsDead(marker, procRoot, bootId))) continue;
			found += 1;
			// 扫描期间 PID 可复用，环境与 owner 都可变化；无法再次证明就保留。
			const fresh = readProcIdentity(pid, { procRoot });
			const freshMarker = await ownerMarker(procDir);
			if (fresh?.startTicks !== identity.startTicks || JSON.stringify(freshMarker) !== JSON.stringify(marker) || !(await sameUser(procDir, uid)) || !(await ownerIsDead(marker, procRoot, bootId))) continue;
			(options.kill ?? ((target) => process.kill(target, "SIGKILL")))(pid);
			killed += 1;
			if (killed >= MAX_KILLS) break;
		} catch {
			/* 进程退出、权限不足或 /proc 不完整：跳过，不扩大回收范围 */
		}
	}
	return { found, killed };
}
