import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadDragDirection() {
	const source = readFileSync("src/renderer/src/pet/PetDragDirection.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const module = { exports: {} };
	vm.runInNewContext(
		outputText,
		{ module, exports: module.exports },
		{
			filename: "PetDragDirection.ts",
		},
	);
	return module.exports;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("drag direction ignores horizontal pointer noise", () => {
	const { updatePetDragDirection } = loadDragDirection();
	const initial = { anchorX: 100, mode: "idle" };

	assert.deepEqual(plain(updatePetDragDirection(initial, 105)), initial);
});

test("drag direction follows left and right movement with hysteresis", () => {
	const { updatePetDragDirection } = loadDragDirection();
	const right = updatePetDragDirection({ anchorX: 100, mode: "idle" }, 106);
	const noise = updatePetDragDirection(right, 102);
	const left = updatePetDragDirection(noise, 100);

	assert.deepEqual(plain(right), { anchorX: 106, mode: "running-right" });
	assert.deepEqual(plain(noise), { anchorX: 106, mode: "running-right" });
	assert.deepEqual(plain(left), { anchorX: 100, mode: "running-left" });
});

test("settings preview is cleared when the pet settings tab unmounts", () => {
	// 设置页拆分后宠物预览清理随 PetTab 走：tab 卸载时真实 Agent 状态重新接管宠物
	const source = readFileSync("src/renderer/src/components/app/settings/PetTab.tsx", "utf8");
	assert.match(source, /useEffect\(\s*\(\) => \(\) => \{\s*void window\.piDesktop\.pet\.setPreviewMode\(""\);\s*\},\s*\[\],?\s*\);/);
});

test("main-process pet IPC boundary validates untrusted renderer args", () => {
	// 边界校验契约（AGENTS.md 安全规则 2）：petMoveWindow/petMoveBy 必须先做有限数校验，
	// 否则 NaN 进 setBounds 会抛 TypeError 变 unhandledRejection；petPreviewMode 校验字符串形态。
	// 正则空白容忍（\s*），改格式不破坏断言。
	const source = readFileSync("src/main/pet/index.ts", "utf8");
	assert.match(source, /petMoveWindow[\s\S]*?!Number\.isFinite\(pos\.x\)\s*\|\|\s*!Number\.isFinite\(pos\.y\)/, "petMoveWindow 必须校验 pos.x/pos.y 有限数");
	assert.match(source, /petMoveBy[\s\S]*?!Number\.isFinite\(delta\.dx\)\s*\|\|\s*!Number\.isFinite\(delta\.dy\)/, "petMoveBy 必须校验 dx/dy 有限数");
	assert.match(source, /petPreviewMode[\s\S]*?typeof mode !== "string"\s*\|\|\s*mode\.length === 0\s*\|\|\s*mode\.length > 64/, "petPreviewMode 必须校验字符串形态");
	// 校验必须在动作之前：moveTo 不得出现在校验之前
	const moveWindow = source.split("petMoveWindow")[1].split("petMoveBy")[0];
	assert.ok(moveWindow.indexOf("Number.isFinite") < moveWindow.indexOf("this.petWindow.moveTo"), "petMoveWindow 校验先于 moveTo");
	const moveBy = source.split("petMoveBy")[1].split("petPreviewMode")[0];
	assert.ok(moveBy.indexOf("Number.isFinite") < moveBy.indexOf("this.petWindow.moveTo"), "petMoveBy 校验先于 moveTo");
});
