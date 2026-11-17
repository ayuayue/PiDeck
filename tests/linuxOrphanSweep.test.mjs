import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sweepLinuxOrphanedManagedProcesses } = loadTsCommonJs("src/main/process/linuxOrphanSweep.ts");
const { parseManagedProcessOwner, managedProcessEnv } = loadTsCommonJs("src/main/process/managedProcessOwner.ts");
const bootId = "12345678-1234-1234-1234-123456789abc";
const scope = "a".repeat(64);
const owner = { pid: 100, startTicks: 10, scope, bootId };

function setup(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-proc-sweep-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const uid = statSync(root).uid;
	mkdirSync(join(root, "sys/kernel/random"), { recursive: true });
	writeFileSync(join(root, "sys/kernel/random/boot_id"), bootId);
	const proc = (pid, { marker, state = "S", ticks = pid, processUid = uid, rawEnv } = {}) => {
		const dir = join(root, String(pid));
		mkdirSync(dir, { recursive: true });
		const fields = [state, ...Array(18).fill("0"), String(ticks)];
		writeFileSync(join(dir, "stat"), `${pid} (name with (brackets)) ${fields.join(" ")}`);
		writeFileSync(join(dir, "status"), `Uid:\t${processUid}\t${processUid}\t${processUid}\t${processUid}\n`);
		writeFileSync(join(dir, "environ"), rawEnv ?? (marker ? `SECRET=must-not-log\0PIDECK_PROCESS_OWNER=${JSON.stringify(marker)}\0` : "OTHER=value\0"));
	};
	const killed = [];
	const run = () => sweepLinuxOrphanedManagedProcesses({ procRoot: root, uid, owner: { ...owner, pid: 9999 }, platform: "linux", kill: (pid) => killed.push(pid) });
	return { root, proc, run, killed, uid };
}

test("Linux sweep reclaims marked descendants after their owner dies, regardless of parent adoption", async (t) => {
	const { proc, run, killed } = setup(t);
	proc(201, { marker: owner });
	proc(202, { marker: owner });
	proc(203);
	const result = await run();
	assert.equal(result.found, 2);
	assert.deepEqual(killed, [201, 202]);
});

test("live owners, other scopes/users/boots, zombies and malformed markers are untouched", async (t) => {
	const { proc, run, killed, uid } = setup(t);
	proc(100, { ticks: 10 });
	proc(201, { marker: owner });
	proc(202, { marker: { ...owner, pid: 8888, scope: "b".repeat(64) } });
	proc(203, { marker: { ...owner, pid: 8888 }, processUid: uid + 1 });
	proc(204, { marker: { ...owner, pid: 8888, bootId: "87654321-1234-1234-1234-123456789abc" } });
	proc(205, { marker: { ...owner, pid: 8888 }, state: "Z" });
	proc(206, { rawEnv: "PIDECK_PROCESS_OWNER={bad json}\0" });
	proc(207, { rawEnv: "PIDECK_PROCESS_OWNER=" + "x".repeat(1024 * 1024) });
	assert.equal((await run()).found, 0);
	assert.deepEqual(killed, []);
});

test("PID reuse proves old owner dead, but unreadable identity never does", async (t) => {
	const { root, proc, run, killed } = setup(t);
	proc(100, { ticks: 99 });
	proc(201, { marker: owner });
	proc(101, { ticks: 10 });
	writeFileSync(join(root, "101", "stat"), "corrupt");
	proc(202, { marker: { ...owner, pid: 101 } });
	assert.equal((await run()).killed, 1);
	assert.deepEqual(killed, [201]);
});

test("owner marker validates identities and inherited foreign marker is removed", () => {
	assert.equal(parseManagedProcessOwner(JSON.stringify(owner)).startTicks, 10);
	for (const bad of [{ ...owner, pid: 0 }, { ...owner, startTicks: -1 }, { ...owner, scope: "wrong" }, {}]) assert.equal(parseManagedProcessOwner(JSON.stringify(bad)), undefined);
	assert.equal(managedProcessEnv({ PATH: "test", PIDECK_PROCESS_OWNER: "old owner" }).PIDECK_PROCESS_OWNER, undefined);
});
