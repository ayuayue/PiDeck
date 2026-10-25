import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const source = readFileSync(resolve("src/renderer/src/components/app/settings/SecretValueInput.tsx"), "utf8");

function loadModule() {
	return loadTsCommonJs(resolve("src/renderer/src/components/app/settings/SecretValueInput.tsx"), {
		stubs: {
			react: { useState: (init) => [init, () => {}] },
			"lucide-react": { Eye: () => null, EyeOff: () => null },
			"../../../i18n": { t: (key) => key },
			"../../ui-shadcn/button": { Button: () => null },
			"../../ui-shadcn/input": { Input: () => null },
		},
	});
}

test("密钥摘要：只露末几位并保留原长度，够核对不还原", () => {
	const { secretHint } = loadModule();
	const hintOf = (value) => {
		const hint = secretHint(value);
		// 字段逐个比：模块在 vm 沙箱里求值，返回对象的原型与主线程不同，deepStrictEqual 会因跨 realm 恒假。
		return [hint?.tail, hint?.length];
	};
	assert.equal(secretHint(""), null);
	// 长值最多 4 位，长度原样带出，让用户看出「被截断」
	assert.deepEqual(hintOf("sk-abcdef123456"), ["3456", 15]);
	// 短值按一半封顶，避免把整个密钥当摘要吐出去
	assert.deepEqual(hintOf("abcd"), ["cd", 4]);
	// 尾随空格是最常见的错法，刻意不 trim，否则长度看不出来
	assert.equal(secretHint("abc ").length, 4);
});

test("密钥摘要算法与主进程语音配置侧一致", () => {
	const { secretHint } = loadModule();
	const main = readFileSync(resolve("src/main/voice/VoiceTranscriptionConfigStore.ts"), "utf8");
	// 两处摘要必须长得一样：用户在语音页看惯的「末几位（共 N 位）」换到生图页变了形，就没法互相信任了。
	const line = main.split("\n").find((l) => l.includes("tail: plain.slice("));
	assert.ok(line, "主进程侧摘要算法发生了改动，渲染层摘要需要同步");
	const tailExpr = line.slice(line.indexOf("tail: ") + "tail: ".length, line.indexOf(", length:"));
	const mainHint = new Function("plain", `return plain ? { tail: ${tailExpr}, length: plain.length } : null;`);
	for (const value of ["a", "ab", "abcd", "sk-abcdef123456", "x".repeat(32)]) {
		// 逐字段比：渲染层对象在 vm 沙箱里创建，原型与主线程不同，deepStrictEqual 会因跨 realm 恒假。
		const hint = secretHint(value);
		const expected = mainHint(value);
		assert.deepEqual([hint?.tail, hint?.length], [expected?.tail, expected?.length], `摘要在 ${value.length} 位输入上分叉`);
	}
});

test("眼睛切换不得抢焦点，明文展开后不再叠摘要", () => {
	// onMouseDown preventDefault：否则「先看一眼再改」会让输入框失焦，顺手触发一次落盘
	assert.match(source, /onMouseDown=\{\s*\(event\)\s*=>\s*event\.preventDefault\(\)\s*\}/);
	assert.match(source, /type=\{\s*revealed \? "text" : "password"\s*\}/);
	assert.match(source, /props\.hintText && !revealed/);
	// 生图配置整份随草稿落盘，收起不得清值（那等于抹掉用户没碰过的密钥）
	assert.doesNotMatch(source, /onChange\(""\)/);
});
