import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const { smoothVoiceLevel, voiceLevelFromPeak } = load("src/renderer/src/utils/voiceLevelMeter.ts");

test("电平映射：没说话恒为 0，门限以上按对数刻度上升并封顶", () => {
	// 房间噪声 floor（约 0.002）与静音预检门限（0.01）以下必须是 0，否则波纹会一直微动，
	// 用户仍然分不清「在录」和「在说话」。
	assert.equal(voiceLevelFromPeak(0), 0);
	assert.equal(voiceLevelFromPeak(0.002), 0, "噪声 floor 不算说话");
	assert.equal(voiceLevelFromPeak(0.01), 0, "门限本身仍是 0");
	assert.equal(voiceLevelFromPeak(Number.NaN), 0);
	assert.equal(voiceLevelFromPeak(0.5), 1);
	assert.equal(voiceLevelFromPeak(1), 1, "封顶，喊话不会把柱子顶出界");
	const quiet = voiceLevelFromPeak(0.02);
	const normal = voiceLevelFromPeak(0.1);
	assert.ok(quiet > 0 && quiet < normal, "门限之上必须单调递增");
	assert.ok(normal < 1);
	// 对数刻度的意义：正常说话音量（0.1）就应该占到中上段，线性刻度只有 0.2。
	assert.ok(normal > 0.5, `线性映射会让正常音量看起来没动，实际 ${normal}`);
});

test("平滑：上升快、回落慢，且残值归零不残留微抖", () => {
	const up = smoothVoiceLevel(0, 1);
	const down = smoothVoiceLevel(1, 0);
	assert.ok(up > 0.5, `上升要跟得住音节起始，实际 ${up}`);
	assert.ok(down > 0.5, `回落应缓慢，实际 ${down}`);
	assert.equal(smoothVoiceLevel(0, 0), 0, "持续静音不应被浮点残差顶起");
	assert.equal(smoothVoiceLevel(0.005, 0), 0, "低于 epsilon 直接归零");
	// 越界输入（analyser 理论不会给，但组件里乘了每根柱的系数）必须收窄到 0~1。
	assert.equal(smoothVoiceLevel(0.5, 5) <= 1, true);
	assert.equal(smoothVoiceLevel(0.5, -1) >= 0, true);
});
