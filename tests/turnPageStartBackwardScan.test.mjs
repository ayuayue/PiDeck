import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { findTurnPageStart, boundTurnWindowStart } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

const ROLES = ["user", "assistant", "toolResult", "system", "error"];

/** 旧的实现（前向预建布尔表 + 全量扫）：只作差分参照，不进产线。 */
function referenceTurnPageStart(entries, before, turnCount) {
	if (before <= 0 || turnCount < 1) return 0;
	const turnStartFlags = new Array(before).fill(false);
	let prev;
	for (let i = 0; i < before; i += 1) {
		const role = entries[i]?.role;
		if (role === "user") {
			if (prev !== "user") turnStartFlags[i] = true;
			prev = "user";
		} else if (role === "assistant") {
			prev = "assistant";
		}
	}
	let turnsSeen = 0;
	let start = 0;
	for (let i = before - 1; i >= 0; i -= 1) {
		if (!turnStartFlags[i]) continue;
		turnsSeen += 1;
		if (turnsSeen === turnCount) {
			start = i;
			break;
		}
	}
	if (turnsSeen < turnCount) start = 0;
	else {
		let hasEarlierUser = false;
		for (let i = 0; i < start; i += 1) {
			if (entries[i]?.role === "user") {
				hasEarlierUser = true;
				break;
			}
		}
		if (!hasEarlierUser) start = 0;
	}
	return start;
}

/** 确定性伪随机：不引 Math.random，失败可复现。 */
function makeRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

test("差分：随机 role 序列 × 全部 before/turnCount 与旧实现逐例一致", () => {
	const random = makeRandom(20261126);
	let cases = 0;
	for (let round = 0; round < 60; round += 1) {
		const length = 1 + Math.floor(random() * 40);
		const entries = [];
		for (let i = 0; i < length; i += 1) entries.push({ role: ROLES[Math.floor(random() * ROLES.length)] });
		for (let before = 0; before <= entries.length; before += 1) {
			for (let turnCount = 0; turnCount <= 6; turnCount += 1) {
				assert.equal(findTurnPageStart(entries, before, turnCount), referenceTurnPageStart(entries, before, turnCount), `roles=${entries.map((e) => e.role).join(",")} before=${before} turns=${turnCount}`);
				cases += 1;
			}
		}
	}
	assert.ok(cases > 1000, `样本量太小：${cases}`);
});

test("差分：连发 user / 头部碎片 / 单轮无回复三类边界与旧实现一致", () => {
	const shapes = [
		["user", "user", "assistant", "user", "user"],
		["system", "system", "user", "assistant"],
		["user", "user", "user"],
		["assistant", "user", "assistant", "user", "assistant"],
		["toolResult", "user", "toolResult", "user"],
		["system", "system", "system"],
	];
	for (const roles of shapes) {
		const entries = roles.map((role) => ({ role }));
		for (let before = 0; before <= entries.length; before += 1) {
			for (let turnCount = 1; turnCount <= 4; turnCount += 1) {
				assert.equal(findTurnPageStart(entries, before, turnCount), referenceTurnPageStart(entries, before, turnCount), `${roles.join(",")} before=${before} turns=${turnCount}`);
			}
		}
	}
});

test("远跳只读目标附近的条目：读数不随会话长度线性上涨", () => {
	// 700 轮 = 700 个 (user, assistant) 对 + 每轮夹 6 条工具条目，总计约 5600 条。
	const entries = [];
	for (let turn = 0; turn < 700; turn += 1) {
		entries.push({ role: "user" });
		for (let i = 0; i < 6; i += 1) entries.push({ role: "toolResult" });
		entries.push({ role: "assistant" });
	}
	let reads = 0;
	const counted = new Proxy(entries, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
			return Reflect.get(target, key, receiver);
		},
	});
	// 先建一次前缀（O(n)，按数组引用缓存），再量跳转本身的读数。
	findTurnPageStart(counted, counted.length, 3);
	reads = 0;
	const before = counted.length - 700; // 跳到接近尾部的位置
	const start = findTurnPageStart(counted, before, 3);
	assert.ok(start > 0 && start < before, `窗口起点必须严格变小：start=${start} before=${before}`);
	assert.ok(reads <= 3 * 8 + 4, `后向扫描只该读到目标附近的 3 轮，实际读 ${reads} 条（旧实现读 ${before} 条）`);
});

test("条目预算叠加：超预算时按完整轮次收紧，且不读全历史", () => {
	const entries = [];
	for (let turn = 0; turn < 700; turn += 1) {
		entries.push({ role: "user" });
		entries.push({ role: "assistant" });
	}
	let reads = 0;
	const counted = new Proxy(entries, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
			return Reflect.get(target, key, receiver);
		},
	});
	const before = entries.length;
	boundTurnWindowStart(counted, before, 12, 100);
	reads = 0;
	const start = boundTurnWindowStart(counted, before, 12, 100);
	assert.ok(start > 0, "预算生效时必须收紧窗口");
	assert.ok(reads <= 2200, `预算收紧不应扫满全历史，实际读 ${reads} 条`);
});
