import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** 在 cwd 里跑 git：测试自身要能造仓库，失败就直接抛出（不静默吞掉 git 的真实报错） */
function gitIn(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")} 失败：${result.stderr}${result.stdout}`);
	return (result.stdout ?? "").trim();
}

/** 补齐身份配置：脚本自己也会在这个仓库里 commit，必须能直接跑通 */
function configureIdentity(dir) {
	gitIn(dir, "config", "user.name", "sync-main-test");
	gitIn(dir, "config", "user.email", "sync-main-test@example.com");
	gitIn(dir, "config", "commit.gpgsign", "false");
	return dir;
}

/** 新建仓库（目录不存在时先建，spawnSync 的 cwd 必须是已存在的目录） */
function initRepo(dir, branch = "main") {
	mkdirSync(dir, { recursive: true });
	gitIn(dir, "init", "-b", branch);
	return configureIdentity(dir);
}

function commitFile(dir, name, content, message) {
	writeFileSync(join(dir, name), content);
	gitIn(dir, "add", name);
	gitIn(dir, "commit", "-m", message);
}

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
	// 对齐远端只用快进合并：分叉时宁可中止，也不用 reset/rebase 改写历史
	assert.match(script, /"merge",\s*"--ff-only"/);
	assert.doesNotMatch(script, /"reset"/);
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

/**
 * 回归（2026-10-21 实发版撞上）：本地 main 落后 origin/main（star-history 机器人每 12 小时
 * 自动往 main 提交）时，脚本原先只在「落后/领先」判断里读过远端，合并仍以旧本地 main 为基底，
 * 结果 push 被判定 non-fast-forward 直接失败。这里用真实裸仓库跑一遍完整同步流程，
 * 锁住「先把 target 对齐远端，再并入 source」这个顺序。
 */
test("sync fast-forwards a stale local target before merging, so the push is a clean fast-forward", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-sync-main-case-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const bare = join(root, "origin.git");
	gitIn(root, "init", "--bare", "-b", "main", bare);

	const repo = initRepo(join(root, "repo"), "main");
	gitIn(repo, "remote", "add", "origin", bare);
	commitFile(repo, "README.md", "base\n", "chore: base");
	gitIn(repo, "push", "origin", "main");
	gitIn(repo, "checkout", "-b", "dev");
	commitFile(repo, "dev.txt", "dev\n", "feat: dev work");
	gitIn(repo, "push", "origin", "dev");

	// 模拟 star-history 机器人：从另一个克隆直推 main，本地 main 就此落后一个提交
	const bot = join(root, "bot");
	gitIn(root, "clone", bare, bot);
	configureIdentity(bot);
	commitFile(bot, "star.svg", "<svg/>\n", "chore: update star history [skip ci]");
	gitIn(bot, "push", "origin", "main");
	const robotSha = gitIn(bot, "rev-parse", "HEAD");
	gitIn(repo, "fetch", "origin");
	assert.notEqual(gitIn(repo, "rev-parse", "main"), gitIn(repo, "rev-parse", "origin/main"));

	// CI=true 会让脚本走「拒绝在流水线里推 main」的护栏，这里显式清空
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/sync-main.mjs", import.meta.url)), "--source", "dev", "--target", "main", "--no-atomgit"], { cwd: repo, encoding: "utf8", env: { ...process.env, CI: "" } });
	const output = `${result.stdout}${result.stderr}`;
	assert.equal(result.status, 0, `同步应以 0 退出（落后远端的本地 main 已被对齐），实际：${output}`);

	// 远端 main 同时含机器人提交与 dev 提交，且与本地 main 一致（说明是快进推送而非强推）
	assert.equal(gitIn(repo, "rev-parse", "main"), gitIn(bare, "rev-parse", "main"));
	assert.equal(gitIn(bare, "cat-file", "-t", robotSha), "commit");
	assert.match(gitIn(bare, "log", "--format=%s", "main"), /chore: update star history/);
	assert.match(gitIn(bare, "log", "--format=%s", "main"), /feat: dev work/);
	assert.match(output, /快进/);

	// 当前分支与工作区不受影响（合并仍只发生在临时 worktree 里）
	assert.equal(gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
	assert.equal(gitIn(repo, "status", "--porcelain"), "");
});

/**
 * 对齐只允许快进。本地 target 有未推的提交、远端又往前走了（分叉）时，
 * 自己 reset/rebase 就是在改写历史；正确行为是中止、不推送、把情况告诉人。
 */
test("sync aborts instead of rewriting history when the local target has diverged", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-sync-main-diverged-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const bare = join(root, "origin.git");
	gitIn(root, "init", "--bare", "-b", "main", bare);

	const repo = initRepo(join(root, "repo"), "main");
	gitIn(repo, "remote", "add", "origin", bare);
	commitFile(repo, "README.md", "base\n", "chore: base");
	gitIn(repo, "push", "origin", "main");
	gitIn(repo, "checkout", "-b", "dev");
	commitFile(repo, "dev.txt", "dev\n", "feat: dev work");
	gitIn(repo, "push", "origin", "dev");

	// 本地 main 多一个没推的提交
	gitIn(repo, "checkout", "main");
	commitFile(repo, "local-only.txt", "local\n", "chore: local main only");
	gitIn(repo, "checkout", "dev");

	// 远端 main 也往前走了：两边分叉
	const bot = join(root, "bot");
	gitIn(root, "clone", bare, bot);
	configureIdentity(bot);
	commitFile(bot, "star.svg", "<svg/>\n", "chore: update star history [skip ci]");
	gitIn(bot, "push", "origin", "main");
	const botSha = gitIn(bot, "rev-parse", "HEAD");
	gitIn(repo, "fetch", "origin");

	const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/sync-main.mjs", import.meta.url)), "--source", "dev", "--target", "main", "--no-atomgit"], { cwd: repo, encoding: "utf8", env: { ...process.env, CI: "" } });
	const output = `${result.stdout}${result.stderr}`;
	assert.equal(result.status, 1, `分叉时应当中止（退出 1），实际：${output}`);
	assert.match(output, /已分叉/);
	// 远端一个提交都没动，本地分支也保持原样
	assert.equal(gitIn(bare, "rev-parse", "main"), botSha);
	assert.equal(gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
	assert.notEqual(gitIn(repo, "rev-parse", "main"), botSha);
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
