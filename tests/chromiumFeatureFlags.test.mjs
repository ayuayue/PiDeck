import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Chromium disable-features 的唯一拼装点（chromiumFeatureFlags.ts）：
 * Electron appendSwitch 同名 switch 后值覆盖前值——散落第二次 appendSwitch 会静默
 * 吞掉前值（2026-12 内存优化事故面）。锁两件事：合并行为本身 + src/main 内不再有
 * 拼装点之外的裸 appendSwitch("disable-features")。
 */

const { DISABLED_CHROMIUM_FEATURES, applyChromiumFeatureFlags } = loadTsCommonJs("src/main/chromiumFeatureFlags.ts");

function recordingCommandLine() {
	const calls = [];
	return { calls, appendSwitch: (name, value) => calls.push([name, value]) };
}

test("audio service runs in-process by default (feature disabled)", () => {
	assert.ok(DISABLED_CHROMIUM_FEATURES.includes("AudioServiceOutOfProcess"));
});

test("merges default and extra features into a single disable-features switch", () => {
	const cli = recordingCommandLine();
	applyChromiumFeatureFlags(cli, ["CalculateNativeWinOcclusion"]);
	const disableCalls = cli.calls.filter(([name]) => name === "disable-features");
	assert.equal(disableCalls.length, 1);
	const features = disableCalls[0][1].split(",");
	assert.ok(features.includes("AudioServiceOutOfProcess"));
	assert.ok(features.includes("CalculateNativeWinOcclusion"));
});

test("no extras still emits the default feature list once", () => {
	const cli = recordingCommandLine();
	applyChromiumFeatureFlags(cli);
	const disableCalls = cli.calls.filter(([name]) => name === "disable-features");
	assert.equal(disableCalls.length, 1);
	assert.equal(disableCalls[0][1], "AudioServiceOutOfProcess");
});

test("wiring contract: index.ts routes all disable-features through the assembler", () => {
	const indexSource = readFileSync("src/main/index.ts", "utf8");
	// E2E 的 CalculateNativeWinOcclusion 必须经拼装点合并，不得再裸 append（会覆盖掉音频条目）。
	assert.match(indexSource, /applyChromiumFeatureFlags\(\s*app\.commandLine\s*,\s*isE2E\s*\?\s*\[\s*"CalculateNativeWinOcclusion"\s*\]\s*:\s*\[\s*\]\s*\)/);
});

test("source contract: no scattered appendSwitch('disable-features') outside the assembler", () => {
	const offenders = [];
	/** 递归收集 src/main 下含裸 disable-features appendSwitch 的 ts 文件。 */
	function walk(dir) {
		for (const entry of readdirSync(dir)) {
			const full = `${dir}/${entry}`;
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.endsWith(".ts")) continue;
			const source = readFileSync(full, "utf8");
			// 唯一允许的拼装点在 chromiumFeatureFlags.ts 内。
			if (full.endsWith("chromiumFeatureFlags.ts")) continue;
			if (/appendSwitch\(\s*["']disable-features["']/.test(source)) offenders.push(full);
		}
	}
	walk("src/main");
	assert.deepEqual(offenders, []);
});
