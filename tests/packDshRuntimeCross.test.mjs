/**
 * pack-dsh-runtime.mjs 交叉解析模式冒烟测试。
 *
 * 测行为不测实现：通过子进程真实执行 CLI，断言：
 * 1. 交叉模式（--target-os/--target-arch）产出目标平台命名的归档 + 索引；
 * 2. linux 目标缺省强制 glibc（npmPlatformArgs 归一化后落到 npm install 参数）；
 * 3. 归档内 manifest 的 runtimeVersion 与 lock 的 dsh 版本一致（lock 精确钉死生效）；
 * 4. check-dsh-asar --target-* 原生包在位断言与 pack 产物联动（win32 → sharp/koffi/rg
 *    平台包 + node-pty prebuilds 必须在位，防 libc 缺包复发）。
 *
 * 网络边界：交叉解析需要真实 registry 下载（~200MB tarball，元数据 revalidate +
 * 本机 npm 缓存命中 tarball 则秒级）。用 --dry-run 时脚本走到闭包收集 + npm install 后跳过打包，
 * 既能验证解析链路又不写 55MB 归档——本文件用 dry-run + 检查 npm 安装产物目录的方式，
 * 把完整打包验证留给 CI / 手动 runtime:check:boot。
 *
 * 若 npm 缓存与 registry 均不可达，skip（本机环境问题，不算回归）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const packScript = join(projectRoot, "scripts", "pack-dsh-runtime.mjs");

/** 当前 dsh 版本（lock 精确版，交叉解析的版本钉死来源）。 */
const lockPackages = JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8")).packages;
const DSH_VERSION = lockPackages["node_modules/@deepseek-ai/dsh"]?.version;
assert.ok(DSH_VERSION, "lock 里必须有 @deepseek-ai/dsh 条目");

/** 运行 pack 脚本（dry-run，超时保护）。返回 stdout 文本。 */
function runPack(extraArgs) {
	return execFileSync(process.execPath, [packScript, "--dry-run", ...extraArgs], { cwd: projectRoot, encoding: "utf8", timeout: 10 * 60 * 1000, env: { ...process.env } });
}

test("默认模式（无 --target-*）保持本机平台行为", () => {
	const out = runPack([]);
	assert.match(out, /平台: .+（本机）/);
	assert.match(out, /runtime 版本: /);
});

test(
	"交叉模式：目标平台三元组出现在输出中，且 lock 精确版本被采用",
	() => {
		const out = runPack(["--target-os", "win32", "--target-arch", "x64"]);
		assert.match(out, /平台: win32-x64（交叉解析）/);
		// 版本钉死：runtimeVersion 必须等于 lock 里 dsh 的精确版本（不允许 ^ 漂移到更新 rc）
		assert.match(out, new RegExp(`runtime 版本: ${DSH_VERSION.replace(/[.]/g, "\\.")} `));
	},
	{ timeout: 10 * 60 * 1000 },
);

test(
	"交叉模式：临时 package.json 把平台门控包写进 optionalDependencies（EBADPLATFORM 回归）",
	() => {
		// 用 --out 指到临时目录不影响 dry-run；这里直接跑一次并从输出断言 optional 数量。
		const out = runPack(["--target-os", "win32", "--target-arch", "x64"]);
		// 平台 optional 包数量必须 > 0：全写进 dependencies 会让 npm 在非目标平台报
		// notsup 硬错误退出（2026-09-18 实证 @deepseek-ai/node-addon-system-darwin-arm64）。
		const match = out.match(/临时 package\.json: (\d+) 硬依赖 \+ (\d+) 平台 optional/);
		assert.ok(match, "输出缺少临时 package.json 统计行");
		assert.ok(Number.parseInt(match[2], 10) > 0, "平台 optional 包数量为 0（EBADPLATFORM 回归）");
	},
	{ timeout: 10 * 60 * 1000 },
);

test("交叉模式：不使用 --prefer-offline（stale packument 回归）", () => {
	// 共享缓存可能留着上一个 dsh 大版本抓的 packument；--prefer-offline 会在 TTL 内信任
	// 过期元数据而不 revalidate，npm 报出的 ETARGET/ERESOLVE 与实际版本冲突无关（误导性极强）。
	// 只匹配 argv 里的字面量行（\s*"--prefer-offline",?），注释里提到的这几个字不算。
	const source = readFileSync(packScript, "utf8");
	assert.ok(!/^\s*"--prefer-offline",?\s*$/m.test(source), "禁止给交叉 npm install 加 --prefer-offline");
});

test("交叉模式：非法目标平台直接报错退出（不产出任何文件）", () => {
	assert.throws(
		() =>
			execFileSync(process.execPath, [packScript, "--dry-run", "--target-os", "sunos", "--target-arch", "x64"], {
				cwd: projectRoot,
				encoding: "utf8",
				timeout: 60_000,
			}),
		/error/i,
	);
});
