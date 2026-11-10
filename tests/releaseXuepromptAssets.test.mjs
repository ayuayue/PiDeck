/**
 * 发布资产的提示词库守卫（2026-11 v0.11.3 事故）。
 *
 * 事故：0.11.3 起安装包不再内置 `resources/xueprompts.db`，客户端改为从
 * `/releases/latest/download/xueprompts.db(.sha256)` 拉取；但发版流水线里没有任何一步上传
 * 这两份资产，`releases/latest` 指向的新 Release 里根本没有它们 → 全体客户端 404，提示词商店
 * 固定「下载失败」，看起来像用户网络问题。
 *
 * 根因不是代码 bug 而是「远程资产靠人记得手工 gh release upload」：`/releases/latest/download/<asset>`
 * 只解析到**当前**最新 Release 的资产，不跨版本继承，所以每个新 Release 都必须重新带上。
 *
 * 这里守两件事（都是 workflow 接线，无法在单测里真跑一遍发版）：
 *   1. 发布 workflow 每次发版都上传 db + .sha256，且缺少文件时失败（不是静默跳过）；
 *   2. 在把 tag 指成 /releases/latest 之前断言资产已存在——缺资产就不发布，保证存量客户端
 *      仍能从前一个（有资产的）Release 取库。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const RELEASE_YML = fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url));
const CHECK_SCRIPT = fileURLToPath(new URL("../scripts/check-xueprompts.mjs", import.meta.url));

/** 两份资产名必须成套出现（客户端按源配对拉 sha + db 并校验）。 */
const ASSET_NAMES = ["xueprompts.db", "xueprompts.db.sha256"];

test("release.yml 每次发版都上传提示词库资产（db + sha256 成套）", () => {
	const source = readFileSync(RELEASE_YML, "utf8");
	// 语义判据：既有 gh release upload 调用，也要带上两份资产名；不能只靠 softprops files 清单里
	// 的可选 glob（那里 fail_on_unmatched_files: false，漏文件会静默跳过）。
	const uploadStep = /- name: Upload prompt-library assets[\s\S]*?(?=\n {2}[a-zA-Z#]|\n {6}- name:)/.exec(source)?.[0] ?? "";
	assert.ok(uploadStep, "release.yml 缺少「Upload prompt-library assets」步骤：发版后不会上传提示词库资产");
	for (const name of ASSET_NAMES) {
		assert.ok(uploadStep.includes(`resources/${name}`), `上传步骤必须包含 resources/${name}`);
	}
	assert.match(uploadStep, /gh release upload/, "上传必须用 gh release upload（需要 --clobber 幂等重跑）");
	assert.match(uploadStep, /--clobber/, "上传必须带 --clobber，否则重跑发版会 422");
	// 缺文件必须红：静默跳过就会再次发生「发出版本商店不可用」。
	assert.match(uploadStep, /exit 1/, "资产文件缺失时必须退出非 0，不能静默跳过");
});

test("release.yml 在把 tag 指成 latest 之前断言提示词库资产齐全", () => {
	const source = readFileSync(RELEASE_YML, "utf8");
	const finalize = source.slice(source.indexOf("finalize-release:"));
	assert.ok(finalize.length > 0, "release.yml 缺少 finalize-release job（latest 指针收尾）");
	const assertIndex = finalize.indexOf("Assert prompt-library assets present");
	const editIndex = finalize.indexOf('gh release edit "$TAG"');
	assert.ok(assertIndex > 0, "finalize-release 必须在发布前断言提示词库资产存在");
	assert.ok(editIndex > assertIndex, "资产断言必须排在 gh release edit（发布/改 latest）之前");
	for (const name of ASSET_NAMES) {
		assert.ok(finalize.includes(name), `资产断言必须覆盖 ${name}`);
	}
});

test("check:xueprompts 挡住「.sha256 与 db 内容不一致」（过期指纹＝全员下载失败）", () => {
	const source = readFileSync(CHECK_SCRIPT, "utf8");
	assert.match(source, /createHash\(["']sha256["']\)/, "check-xueprompts 必须重算 db 的 sha256");
	assert.match(source, /\.sha256/, "check-xueprompts 必须读取并比对 .sha256 资产");
	assert.match(source, /不一致|mismatch/, "指纹不一致时必须给出明确失败信息");
});
