import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 分组标题行「名称 + 数量」的视觉契约。
 *
 * 背景：名称是 text-control(13px/20px)、数量是 text-caption(12px/18px)，容器 items-center
 * 只对齐行盒中心，两条文字基线相差约 2px（数量看起来悬在名称上方）。修复方式是在两个有文字
 * 的元素上覆盖 self-baseline，容器仍保持 items-center（箭头与 trailing 用量徽标没有文字基线，
 * 必须居中）；数量同时去掉 font-mono（串里含中文必然回退 CJK 字体，等宽在此徒增一套字形）。
 * 这些都是"看着不对但代码读起来没错"的回归，用源码契约测试兜住。
 */
const picker = readFileSync("src/renderer/src/components/ui-shadcn/command-picker.tsx", "utf8");
const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");

const lineOf = (source, needle) => {
	const line = source.split("\n").find((entry) => entry.includes(needle));
	assert.ok(line, `源码中找不到包含 ${needle} 的行`);
	return line;
};

test("分组标题行的名称与数量共用文字基线", () => {
	assert.match(lineOf(picker, ">{props.label}</span>"), /self-baseline/);
	const countLine = lineOf(picker, "props.count != null &&");
	assert.match(countLine, /self-baseline/);
	// 数量不再混用等宽字体
	assert.doesNotMatch(countLine, /font-mono/);
	// 容器仍居中：否则箭头与 trailing 用量徽标会跟着基线漂移
	const buttonLine = lineOf(picker, "cursor-pointer");
	assert.match(buttonLine, /items-center/);
	assert.doesNotMatch(buttonLine, /items-baseline/);
});

test("模型选择器三处分组用同一套数量文案", () => {
	for (const id of ['id="favorites"', "id={`provider:${provider}`}", 'id="hidden-models"']) {
		const groupLine = composer.split("\n").find((line) => line.includes("<CommandPickerGroup") && line.includes(id));
		assert.ok(groupLine, `找不到分组 ${id}`);
		assert.match(groupLine, /countText=\{t\("config\.count\.models"/, `分组 ${id} 的数量文案未统一`);
	}
});

test("模型选择器不再引用与标签重复的数量文案", () => {
	// 已隐藏模型分组曾用 app.modelHiddenCount（“已隐藏模型 ({count})”），与同行的
	// label（“已隐藏模型”）重复；统一走 config.count.models 后该 key 不再被引用。
	assert.doesNotMatch(composer, /app\.modelHiddenCount/);
});
