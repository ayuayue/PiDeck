/**
 * 发布收尾「latest 指针」守卫（2026-10 v0.9.9 事故回归）。
 *
 * 背景：GitHub Release 若是先建成 draft / 预发布暂存（如 "vX.Y.Z (runtime staging)"），
 * 之后由 build 矩阵往它补资产、并把 prerelease 翻成 false，GitHub **不会**提升它为
 * latest —— latest 静默停在上一版。而 Windows（electron-updater）与 macOS/Linux 手动
 * 更新检查读的都是 `/releases/latest`，于是「发版成功、CI 全绿、存量用户收不到更新」。
 * v0.9.9 就是这样漏出去的，靠手工 PATCH 才补回来。
 *
 * 无法在单测里真跑一遍发布流水线，这里守接线语义：
 *   - release.yml 必须有收尾作业显式 PATCH `make_latest=true`（不依赖 action 默认值）；
 *   - 该作业必须排在全部资产上传之后（needs 含 build-release 与 pack-dsh-runtime）；
 *   - 只对正式发布执行（prerelease 时跳过，dev 通道不得抢 latest）；
 *   - 必须断言 /releases/latest 已指向本 tag，否则门禁形同虚设。
 * 另外守 scripts/probe-update-check.mjs 引用的生产模块必须存在（v0.7.4 删掉
 * githubFeed/appUpdateCheck 后该自检脚本烂了一年没人发现，正是这次回归没被拦住的原因）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const RELEASE_WORKFLOW = fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url));
const PROBE_SCRIPT = fileURLToPath(new URL("../scripts/probe-update-check.mjs", import.meta.url));

/** 按 2 空格缩进切出某个 job 的 YAML 块（够用即可，不引入 yaml 依赖）。 */
function jobBlock(source, jobName) {
	const pattern = new RegExp(`^ {2}${jobName}:\\n([\\s\\S]*?)(?=^ {2}[A-Za-z0-9_-]+:|(?![\\s\\S]))`, "m");
	return source.match(pattern)?.[1] ?? null;
}

test("release.yml 有收尾作业把本次 tag 显式设为 latest", () => {
	const source = readFileSync(RELEASE_WORKFLOW, "utf8");
	const block = jobBlock(source, "finalize-release");
	assert.ok(block, "release.yml 缺少 finalize-release 作业：latest 指针会静默停在上一版");

	// 顺序：必须等全部资产（build 矩阵 + DSH runtime 矩阵）上传完成。
	const needs = block.match(/^ {4}needs:\s*(.+)$/m)?.[1] ?? "";
	for (const dependency of ["build-release", "pack-dsh-runtime"]) {
		assert.match(needs, new RegExp(dependency), `finalize-release 必须 needs ${dependency}，否则可能在资产没传完时就把 latest 指过来`);
	}

	// dev 通道恒 prerelease：不得抢占 latest，否则 dev 包会被推给所有稳定用户。
	assert.match(block, /prerelease != 'true'/, "finalize-release 必须跳过 prerelease（dev 通道）发布");

	// 修复动作 + 断言动作都必须在：只有 PATCH 没有断言 = 修了也不知道有没有生效。
	assert.match(block, /make_latest=true/, "finalize-release 必须显式 PATCH make_latest=true（不依赖 softprops/action-gh-release 的默认值）");
	assert.match(block, /releases\/latest/, "finalize-release 必须读回 /releases/latest 断言已指向本 tag");
});

test("更新探查自检脚本引用的生产模块都还存在", () => {
	const source = readFileSync(PROBE_SCRIPT, "utf8");
	const referenced = [...source.matchAll(/compileModule\("([^"]+)"/g)].map((match) => match[1]);
	assert.ok(referenced.length > 0, "未从 probe 脚本里解析到 compileModule 引用，扫描规则失效");
	for (const relativePath of referenced) {
		assert.ok(existsSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url))), `probe-update-check.mjs 引用的 ${relativePath} 不存在——自检脚本已失效`);
	}
	// 核心判据：必须比对「latest 的 tag」与「latest.yml 的 version」，这正是 v0.9.9 漏过的检查。
	assert.match(source, /latest\.yml 版本 === \/releases\/latest 的 tag/, "probe-update-check.mjs 缺少 latest tag 与 latest.yml 版本的一致性判定");
});
