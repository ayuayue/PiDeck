import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadSoundAlert() {
	const source = readFileSync("src/shared/types/soundAlert.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const module = { exports: {} };
	vm.runInNewContext(outputText, { module, exports: module.exports }, {
		filename: "soundAlert.ts",
	});
	return module.exports;
}

const S = loadSoundAlert();

test("normalize accepts valid full settings unchanged", () => {
	const input = {
		enabled: true,
		volume: 0.5,
		done: { enabled: true, sound: "done-bell" },
		error: { enabled: true, sound: "error-alert" },
		waiting: { enabled: false, sound: "waiting-ping" },
	};
	assert.deepEqual(JSON.parse(JSON.stringify(S.normalizeSoundAlertSettings(input))), input);
});

test("normalize falls back to defaults for missing/invalid fields", () => {
	const normalized = S.normalizeSoundAlertSettings({});
	assert.equal(normalized.enabled, true);
	assert.equal(normalized.volume, 0.6);
	assert.equal(normalized.done.sound, "done-chime");
	assert.equal(normalized.error.sound, "error-buzz");
	assert.equal(normalized.waiting.enabled, false);
});

test("normalize clamps volume and rejects unknown preset refs", () => {
	const normalized = S.normalizeSoundAlertSettings({
		volume: 7,
		done: { enabled: true, sound: "not-a-preset" },
		error: { enabled: true, sound: "custom:../../etc/passwd" },
		waiting: { enabled: true, sound: "custom:my-sound.wav" },
	});
	assert.equal(normalized.volume, 1);
	// 非法预设回落默认
	assert.equal(normalized.done.sound, "done-chime");
	// 路径逃逸的自定义名被拒，回落默认
	assert.equal(normalized.error.sound, "error-buzz");
	// 合法自定义名保留
	assert.equal(normalized.waiting.sound, "custom:my-sound.wav");
});

test("parseSoundAlertRef distinguishes preset / custom / invalid", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(S.parseSoundAlertRef("done-chime"))), { kind: "preset", id: "done-chime" });
	assert.deepEqual(JSON.parse(JSON.stringify(S.parseSoundAlertRef("custom:ding.wav"))), { kind: "custom", file: "ding.wav" });
	assert.equal(S.parseSoundAlertRef("custom:../evil.wav"), null);
	assert.equal(S.parseSoundAlertRef("custom:no-extension"), null);
	assert.equal(S.parseSoundAlertRef("random"), null);
});

test("isAllowedCustomSoundName only accepts safe basenames with known extensions", () => {
	assert.equal(S.isAllowedCustomSoundName("ding.wav"), true);
	assert.equal(S.isAllowedCustomSoundName("my-sound.mp3"), true);
	assert.equal(S.isAllowedCustomSoundName("My Sound.wav"), false); // 空格不允许
	assert.equal(S.isAllowedCustomSoundName("../ding.wav"), false);
	assert.equal(S.isAllowedCustomSoundName("ding.exe"), false);
	assert.equal(S.isAllowedCustomSoundName("a".repeat(130) + ".wav"), false); // 超长
});
