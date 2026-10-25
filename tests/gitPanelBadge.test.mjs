/**
 * Git 面板 push/pull 角标颜色契约测试。
 *
 * 背景：角标原本用 bg-[var(--color-accent)] + text-white。浅色下 accent=#18181b（近黑）
 * 黑底白字正常；但暗色下 accent 反转为 #fafafa（近白），角标变白底白字，数字不可读
 * （issue：暗色模式角标背景颜色问题）。修复为 bg-[var(--color-info)]；
 * 但暗色 info 同样是亮蓝 #60a5fa（非深蓝），固定白字只有 ~2.3:1 对比度，
 * 因此文字改为 --color-text-inverse（亮色白 / 暗色近黑 #121212，对比稳定）。
 *
 * 此测试防止未来有人把角标背景改回 accent，或把文字改回固定白色。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");

test("git panel ahead/behind badges use --color-info background and inverse text", () => {
	// 领先（ahead）与落后（behind）角标：各自只出现一次角标样式
	const badgeMarkers = ["领先角标：本地上游提交数", "落后角标：远程领先本地的提交数"];
	for (const marker of badgeMarkers) {
		// 角标 className 在注释之后最近的一处 span className
		const after = source.slice(source.indexOf(marker));
		const match = after.match(/className="([^"]*rounded-full[^"]*)"/);
		assert.ok(match, `应找到角标 className（${marker}）`);
		const cls = match[1];
		// 背景必须用 info 语义色，文字用 inverse token（暗色翻转近黑），明暗两套主题下都保证可读
		assert.match(cls, /bg-\[var\(--color-info\)\]/, "角标背景应为 --color-info");
		// accent 暗色反转为近白，白字在其上不可读——禁止回退
		assert.doesNotMatch(cls, /bg-\[var\(--color-accent\)\]/, "角标背景不得使用 --color-accent");
		// 固定白字只在浅色 info 上对比稳定，暗色 info 是亮蓝——必须走 inverse token
		assert.match(cls, /text-\[var\(--color-text-inverse\)\]/, "角标文字应为 --color-text-inverse");
		assert.doesNotMatch(cls, /text-white/, "角标文字禁止写死白色");
	}
});
