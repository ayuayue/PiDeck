import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMergeMessage, parseSyncArgs } from "../scripts/sync-main.mjs";

/**
 * dev → main 同步脚本的契约测试。
 *
 * 参数解析与合并说明生成是纯函数，直接断言；剩下的「用临时 worktree 合并、冲突即 abort、
 * 不 force push、失败也清理」是安全约定，用静态断言钉住脚本形状——这些行为一旦被改掉
 * （比如为了图快改回 switch 当前分支、或冲突时用 -X ours 吞掉），测试就该红。
 */

const script = readFileSync("scripts/sync-main.mjs", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

test("sync args default to dev → main on origin and can be overridden", () => {
	assert.deepEqual(parseSyncArgs([]), { source: "dev", target: "main", remote: "origin", message: "", dryRun: false, pushAtomgit: true });
	const custom = parseSyncArgs(["--source", "feature", "--target", "release", "--remote", "upstream", "--message", "自定义", "--no-atomgit", "--dry-run"]);
	assert.equal(custom.source, "feature");
	assert.equal(custom.target, "release");
	assert.equal(custom.remote, "upstream");
	assert.equal(custom.message, "自定义");
	assert.equal(custom.pushAtomgit, false);
	assert.equal(custom.dryRun, true);
	// 缺值的选项回落到默认值，不产生 undefined
	assert.equal(parseSyncArgs(["--source"]).source, "dev");
});

test("merge message lists the incoming commits", () => {
	const subjects = ["a2042f13 fix(config): 恢复新建 Skill/提示词入口", "f457cfa5 chore(dev): git push 自动镜像到 AtomGit"];
	const message = buildMergeMessage({ source: "dev", target: "main", subjects });
	const lines = message.split("\n");
	assert.equal(lines[0], "Merge branch 'dev' into main: 2 个提交");
	assert.equal(lines[1], "");
	assert.deepEqual(
		lines.slice(2),
		subjects.map((subject) => `- ${subject}`),
	);

	// 长列表折叠，避免合并提交信息退化成整份 git log
	const many = buildMergeMessage({ source: "dev", target: "main", subjects: Array.from({ length: 25 }, (_, index) => `c${index} subject`) });
	assert.match(many, /…等 5 个提交/);
	assert.equal((many.match(/^- c\d+ subject$/gm) ?? []).length, 20);

	// 显式 --message 覆盖自动生成
	assert.equal(buildMergeMessage({ source: "dev", target: "main", subjects, message: "手写说明" }), "手写说明");
});

test("merge happens in a throwaway worktree, never in the current working tree", () => {
	// 当前工作区常有别的任务在编辑：切分支会互相打断，所以必须走临时 worktree
	assert.match(script, /git\(\[\s*"worktree",\s*"add",\s*worktree,\s*options\.target\s*\]/);
	assert.match(script, /mkdtempSync\(join\(tmpdir\(\),\s*"pideck-sync-main-"\)\)/);
	// 任何路径都要清理：清理写在 finally，且不在 try 内用 process.exit 打断它
	assert.match(script, /\}\s*finally\s*\{[\s\S]{0,400}?"worktree",\s*"remove",\s*"--force"/);
	assert.doesNotMatch(script, /process\.exit\(/);
	assert.match(script, /process\.exitCode = 1/);
});

test("sync never rewrites history and never resolves conflicts silently", () => {
	assert.match(script, /"merge",\s*"--no-ff",\s*options\.source,\s*"-m",\s*mergeMessage/);
	assert.match(script, /"merge",\s*"--abort"/);
	// 私下选边（-X 策略）与 force push 都是禁区；只查真正的命令行参数形态，避免命中注释里的说明文字
	assert.doesNotMatch(script, /"-X"/);
	assert.doesNotMatch(script, /--force-with-lease/);
	assert.doesNotMatch(script, /push[\s\S]{0,40}?"--force"/);
});

test("sync pushes origin first, then AtomGit as a hook-independent fallback", () => {
	assert.match(script, /"push",\s*options\.remote,\s*options\.target/);
	assert.match(script, /ATOMGIT_REMOTE = "atomgit"/);
	assert.match(script, /"push",\s*ATOMGIT_REMOTE,\s*options\.target/);
	// 没有 atomgit 远端时降级为只推 origin，而不是报错
	assert.match(script, /hasRemote\(ATOMGIT_REMOTE\)/);
	// 已是同一提交时不重复推送（幂等）
	assert.match(script, /已是最新，无需推送/);
});

test("sync is wired as an npm script and self-documents dry-run", () => {
	assert.equal(pkg.scripts["sync:main"], "node scripts/sync-main.mjs");
	assert.match(script, /--dry-run/);
	// dry-run 必须在建 worktree 之前返回，保证预览零副作用
	const dryRunIndex = script.indexOf("if (options.dryRun) {");
	const worktreeIndex = script.indexOf('mkdtempSync(join(tmpdir(), "pideck-sync-main-"))');
	assert.ok(dryRunIndex > 0 && worktreeIndex > 0 && dryRunIndex < worktreeIndex, "dry-run must return before any worktree is created");
});

test("importing the script exposes helpers without ever running a sync", () => {
	// 回归（2026-09-20 CI 红灯）：脚本原先在模块顶层直接 `main();`，于是「import 纯函数做断言」
	// 会顺带执行一次真实的 fetch + 合并 + 推送——本机那次 import 真的把 main 推到了远端，
	// CI 里则整个文件失败（输出「当前正处于 main 分支，请先切回 dev 再执行同步」）。
	// 子进程在临时目录（非 git 仓库）里 import：万一守卫被删，最坏也只是撞上预检，碰不到真实仓库。
	const scriptPath = fileURLToPath(new URL("../scripts/sync-main.mjs", import.meta.url));
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { parseSyncArgs, buildMergeMessage } from ${JSON.stringify(pathToFileURL(scriptPath).href)}; process.stdout.write(\`exports:\${typeof parseSyncArgs},\${typeof buildMergeMessage}\`);`], { cwd: tmpdir(), encoding: "utf8" });
	const output = `${child.stdout}${child.stderr}`;
	assert.equal(child.status, 0, `import 不应触发任何同步动作，但子进程退出码为 ${child.status}：${output}`);
	assert.equal(child.stdout, "exports:function,function");
	assert.doesNotMatch(output, /同步 |已合并|已推送/);
	// 入口守卫与 CI 护栏本身也要钉住：它们被删时上面两条会立刻变红
	assert.match(script, /if \(process\.argv\[1\] && pathToFileURL\(process\.argv\[1\]\)\.href === import\.meta\.url\) main\(\);/);
	assert.doesNotMatch(script, /^main\(\);$/m);
	assert.match(script, /process\.env\.CI/);
});
