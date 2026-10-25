import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// CDP 租约状态机的直接单测（计划 §11 承诺、此前缺失）：
// 引用计数语义 = 先进入者 attach、并发者复用、最后一个使用者才 detach。

const { BrowserCdpSession } = loadTsCommonJs("src/main/browser/cdpSession.ts");

function makeGuest(id, overrides = {}) {
	const calls = { attach: 0, detach: 0 };
	const guest = {
		id,
		destroyed: false,
		attached: false,
		foreignAttached: false,
		attachError: null,
		calls,
		isDestroyed: () => guest.destroyed,
		debugger: {
			attach: () => {
				if (guest.attachError) throw guest.attachError;
				if (guest.attached || guest.foreignAttached) throw new Error("Debugger is already attached to the target");
				guest.attached = true;
				calls.attach += 1;
			},
			detach: () => {
				if (!guest.attached) throw new Error("Debugger is not attached");
				guest.attached = false;
				calls.detach += 1;
			},
			isAttached: () => guest.attached || guest.foreignAttached,
			sendCommand: async (method, params) => ({ ok: true, method, params }),
		},
		...overrides,
	};
	return guest;
}

test("a single command run attaches and detaches exactly once", async () => {
	const guest = makeGuest(1);
	const session = new BrowserCdpSession();
	const result = await session.withGuest(guest, (send) => send("Test.one", { a: 1 }));
	assert.deepEqual(result, { ok: true, method: "Test.one", params: { a: 1 } });
	assert.equal(guest.calls.attach, 1);
	assert.equal(guest.calls.detach, 1);
});

test("concurrent callers share one lease; only the last user detaches", async () => {
	const guest = makeGuest(2);
	const session = new BrowserCdpSession();
	let releaseFirst;
	const firstDone = new Promise((resolve) => {
		releaseFirst = resolve;
	});
	const first = session.withGuest(guest, async (send) => {
		await send("Test.hold");
		await firstDone;
		return "first";
	});
	// 让先进入者完成 attach 并进入 run 体。
	await new Promise((resolve) => setTimeout(resolve, 0));
	const second = await session.withGuest(guest, async (send) => {
		await send("Test.second");
		return "second";
	});
	assert.equal(second, "second");
	assert.equal(guest.calls.attach, 1, "concurrent caller must reuse the existing lease");
	assert.equal(guest.calls.detach, 0, "the second caller finishing must NOT detach while the first still runs");
	releaseFirst();
	assert.equal(await first, "first");
	assert.equal(guest.calls.detach, 1, "detach happens exactly once, after the last user finishes");
});

test("a foreign debugger attachment is rejected as cdp_busy and never touched", async () => {
	const guest = makeGuest(3);
	guest.foreignAttached = true;
	const session = new BrowserCdpSession();
	await assert.rejects(
		session.withGuest(guest, () => Promise.resolve("never")),
		(error) => {
			assert.equal(error.code, "cdp_busy");
			return true;
		},
	);
	assert.equal(guest.calls.attach, 0);
	assert.equal(guest.calls.detach, 0, "someone else's attachment must not be detached");
});

test("attach failure maps to cdp_unavailable", async () => {
	const guest = makeGuest(4);
	guest.attachError = new Error("attach crashed");
	const session = new BrowserCdpSession();
	await assert.rejects(
		session.withGuest(guest, () => Promise.resolve("never")),
		(error) => {
			assert.equal(error.code, "cdp_unavailable");
			return true;
		},
	);
});

test("a command failing on a destroyed guest maps to browser_guest_gone", async () => {
	const guest = makeGuest(5);
	guest.debugger.sendCommand = async () => {
		guest.destroyed = true;
		throw new Error("Object has been destroyed");
	};
	const session = new BrowserCdpSession();
	await assert.rejects(
		session.withGuest(guest, (send) => send("Test.gone")),
		(error) => {
			assert.equal(error.code, "browser_guest_gone", "destroyed guest must not be reported as a debugger conflict");
			return true;
		},
	);
});

test("command timeout maps to cdp_timeout", async () => {
	const guest = makeGuest(6);
	guest.debugger.sendCommand = () => new Promise(() => {});
	const session = new BrowserCdpSession({ commandTimeoutMs: 15 });
	await assert.rejects(
		session.withGuest(guest, (send) => send("Test.slow")),
		(error) => {
			assert.equal(error.code, "cdp_timeout");
			return true;
		},
	);
});

test("dispose releases an in-flight lease immediately and tolerates the late run finish", async () => {
	const guest = makeGuest(7);
	const session = new BrowserCdpSession();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const run = session.withGuest(guest, async () => {
		await gate;
		return "done";
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	session.dispose();
	assert.equal(guest.calls.detach, 1, "dispose must release the lease even while a run is in flight");
	release();
	assert.equal(await run, "done");
	assert.equal(guest.calls.detach, 1, "late finish must not double-detach");
});
