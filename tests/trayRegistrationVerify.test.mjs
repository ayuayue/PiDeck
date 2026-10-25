import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Linux 托盘注册验收（见 src/main/tray/trayRegistrationVerify.ts）：
 * 纯诊断 —— 以 watcher 的 RegisteredStatusNotifierItems 里有没有自己的 SNI 名字为准，
 * 只记日志不做修复动作（重建换名实测无效，见 docs/linux-tray-icon.md）。
 */
const { parseRegisteredTrayItems, pidHasTrayItem, startTrayRegistrationVerify } = loadTsCommonJs("src/main/tray/trayRegistrationVerify.ts");

// loadTsCommonJs 在独立 VM realm 执行，数组原型不同，deepEqual 需走 JSON（项目惯例）
const json = (value) => JSON.stringify(value);

/** 手动驱动的验收器：定时器与查询完全由测试控制。 */
function createHarness({ items, ok = true, pid = 13440 } = {}) {
	const events = [];
	let pendingCheck = null;
	const verify = startTrayRegistrationVerify({
		onUnregistered: (detail) => events.push({ kind: "unregistered", detail }),
		onLog: (message) => events.push({ kind: "log", message }),
		queryItems: async () => (ok ? { ok: true, items } : { ok: false }),
		getPid: () => pid,
		setTimer: (handler) => {
			pendingCheck = handler;
			return "handle";
		},
		clearTimer: () => {
			pendingCheck = null;
		},
	});
	return {
		events,
		get hasPendingCheck() {
			return pendingCheck !== null;
		},
		async check() {
			if (!pendingCheck) throw new Error("no pending check");
			const handler = pendingCheck;
			pendingCheck = null;
			handler();
			await new Promise((resolve) => setImmediate(resolve));
		},
		stop: () => verify.stop(),
	};
}

const ITEMS_WITH_SELF = [":1.66@/org/ayatana/NotificationItem/other", "org.freedesktop.StatusNotifierItem-13440-1"];
const ITEMS_WITHOUT_SELF = [":1.66@/org/ayatana/NotificationItem/other", "org.freedesktop.StatusNotifierItem-99999-1"];

test("parseRegisteredTrayItems：从 dbus-send 输出抽字符串，容忍多行", async () => {
	const stdout = ["method return time=1 sender=:1.31 -> destination=:1.2 serial=1 reply_serial=2", "   variant       array [", '         string ":1.66@/org/ayatana/NotificationItem/tray_icon_x"', '         string "org.freedesktop.StatusNotifierItem-13440-1"', "       ]"].join("\n");
	assert.equal(json(parseRegisteredTrayItems(stdout)), json([":1.66@/org/ayatana/NotificationItem/tray_icon_x", "org.freedesktop.StatusNotifierItem-13440-1"]));
	// 首行 method return 里的普通标识符不是 string 字面量，不得混入
	assert.equal(parseRegisteredTrayItems("method return time=1").length, 0);
});

test("pidHasTrayItem：按 pid 匹配，不写死序号、不误命中相似 pid", () => {
	assert.equal(pidHasTrayItem(ITEMS_WITH_SELF, 13440), true);
	assert.equal(pidHasTrayItem(ITEMS_WITH_SELF, 1344), false, "1344 不得命中 13440（needle 以 - 结尾）");
	assert.equal(pidHasTrayItem(ITEMS_WITHOUT_SELF, 13440), false);
	// 序号会随实例变化（-1/-2），匹配必须只看 pid
	assert.equal(pidHasTrayItem(["org.freedesktop.StatusNotifierItem-13440-2"], 13440), true);
});

test("已注册：输出一条成功日志，不做任何修复动作", async () => {
	const harness = createHarness({ items: ITEMS_WITH_SELF });
	await harness.check();
	assert.equal(json(harness.events), json([{ kind: "log", message: "tray verify: registered" }]));
	assert.equal(harness.hasPendingCheck, false, "单次验收，收尾后不得再排检查");
});

test("未注册：只回调诊断出口，不尝试任何动作（重建已证伪）", async () => {
	const harness = createHarness({ items: ITEMS_WITHOUT_SELF });
	await harness.check();
	assert.equal(json(harness.events), json([{ kind: "unregistered", detail: { pid: 13440, items: 2 } }]));
	assert.equal(harness.hasPendingCheck, false);
});

test("watcher 不可判（ok=false）：跳过诊断，不误报未注册", async () => {
	const harness = createHarness({ ok: false });
	await harness.check();
	assert.equal(json(harness.events), json([{ kind: "log", message: "tray verify: watcher unavailable, skipping diagnosis" }]));
	assert.equal(harness.hasPendingCheck, false);
});

test("stop()：清掉待查定时器，重复调用安全", async () => {
	const harness = createHarness({ items: ITEMS_WITHOUT_SELF });
	harness.stop();
	assert.equal(harness.hasPendingCheck, false);
	harness.stop(); // 幂等
	assert.equal(harness.hasPendingCheck, false);
});
