import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_ATOMGIT_REMOTE, DEFAULT_ATOMGIT_URL, ZERO_SHA, parsePushRefLines, planAtomgitMirror } from "../scripts/atomgit-mirror.mjs";

/**
 * push 自动镜像 AtomGit 的契约测试。
 *
 * 判定逻辑（递归防护 / 删除跳过 / refspec 构造 / 开关）全在 scripts/atomgit-mirror.mjs 的纯函数里，
 * 这里直接对函数断言；.githooks/pre-push 只负责「找 node → 找仓库根 → 交权」，用静态断言把它的
 * 极简形状钉死——逻辑一旦从模块里挪回 sh，测试就该红。
 */

const hook = readFileSync(".githooks/pre-push", "utf8");
const installer = readFileSync("scripts/install-git-hooks.mjs", "utf8");
const mirror = readFileSync("scripts/atomgit-mirror.mjs", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const readme = readFileSync("README.md", "utf8");

const BRANCH_LINE = `refs/heads/dev ${"1".repeat(40)} refs/heads/dev ${"2".repeat(40)}`;
const TAG_LINE = `refs/tags/v0.7.7-beta ${"3".repeat(40)} refs/tags/v0.7.7-beta ${ZERO_SHA}`;
const DELETE_LINE = `(delete) ${ZERO_SHA} refs/heads/gone ${"4".repeat(40)}`;

test("pre-push ref list is parsed per git's documented contract", () => {
	const refs = parsePushRefLines(`${BRANCH_LINE}\n\n${TAG_LINE}\n`);
	assert.equal(refs.length, 2);
	assert.deepEqual(refs[0], { localRef: "refs/heads/dev", localSha: "1".repeat(40), remoteRef: "refs/heads/dev", remoteSha: "2".repeat(40) });
	assert.equal(refs[1].localRef, "refs/tags/v0.7.7-beta");
	// 脏数据（半截行 / 只有 ref 名）不能把钩子搞崩
	assert.deepEqual(parsePushRefLines("refs/heads/only-ref\n   \n"), []);
	assert.deepEqual(parsePushRefLines(""), []);
});

test("mirror pushes exactly the incoming refs (branches and tags)", () => {
	const plan = planAtomgitMirror({ remoteName: "origin", remoteUrl: "git@github.com:ayuayue/PiDeck.git", stdin: `${BRANCH_LINE}\n${TAG_LINE}`, env: {} });
	assert.equal(plan.action, "push");
	assert.deepEqual(plan.refspecs, ["refs/heads/dev:refs/heads/dev", "refs/tags/v0.7.7-beta:refs/tags/v0.7.7-beta"]);
	assert.equal(plan.remote, DEFAULT_ATOMGIT_REMOTE);
	assert.deepEqual(plan.droppedDeletes, []);
});

test("mirror refuses to mirror itself (no recursion)", () => {
	// 镜像 push 自己也是一次 push，会再次触发 pre-push：远端名命中要放行
	assert.equal(planAtomgitMirror({ remoteName: "atomgit", remoteUrl: "https://atomgit.com/ayuayue/PiDeck.git", stdin: BRANCH_LINE, env: {} }).reason, "target-is-atomgit");
	// 远端名不叫 atomgit 但 URL 指向 atomgit 也要放行
	assert.equal(planAtomgitMirror({ remoteName: "mirror", remoteUrl: "https://atomgit.com/ayuayue/PiDeck.git", stdin: BRANCH_LINE, env: {} }).reason, "target-is-atomgit");
});

test("mirror never propagates ref deletions", () => {
	// 本地清理分支是高频动作，跟着删会把镜像上的分支一起删掉：只跳过并记录
	const mixed = planAtomgitMirror({ remoteName: "origin", remoteUrl: "", stdin: `${BRANCH_LINE}\n${DELETE_LINE}`, env: {} });
	assert.equal(mixed.action, "push");
	assert.deepEqual(mixed.refspecs, ["refs/heads/dev:refs/heads/dev"]);
	assert.deepEqual(mixed.droppedDeletes, ["refs/heads/gone"]);

	const onlyDelete = planAtomgitMirror({ remoteName: "origin", remoteUrl: "", stdin: DELETE_LINE, env: {} });
	assert.equal(onlyDelete.action, "skip");
	assert.equal(onlyDelete.reason, "only-deletions");
	assert.deepEqual(onlyDelete.droppedDeletes, ["refs/heads/gone"]);

	assert.equal(planAtomgitMirror({ remoteName: "origin", remoteUrl: "", stdin: "", env: {} }).reason, "nothing-to-mirror");
});

test("mirror respects its switches", () => {
	assert.equal(planAtomgitMirror({ remoteName: "origin", remoteUrl: "", stdin: BRANCH_LINE, env: { PI_DECK_SKIP_ATOMGIT: "1" } }).reason, "skip-env");
	// 自定义远端名同样要参与递归防护
	const custom = planAtomgitMirror({ remoteName: "ag", remoteUrl: "", stdin: BRANCH_LINE, env: { PI_DECK_ATOMGIT_REMOTE: "ag" } });
	assert.equal(custom.action, "skip");
	assert.equal(custom.reason, "target-is-atomgit");
	assert.equal(planAtomgitMirror({ remoteName: "origin", remoteUrl: "", stdin: BRANCH_LINE, env: { PI_DECK_ATOMGIT_REMOTE: "ag" } }).remote, "ag");
});

test("failure is non-blocking by default, strict only when asked", () => {
	// 失败路径：默认退出 0（绝不阻断主 push），PI_DECK_ATOMGIT_STRICT=1 才升级为失败
	assert.match(mirror, /strictEnabled/);
	assert.match(mirror, /PI_DECK_ATOMGIT_STRICT/);
	assert.match(mirror, /process\.exit\(strictEnabled\(env\) \? 1 : 0\)/);
	// 镜像 push 带 --no-verify（与远端名判定构成双重递归防护）
	assert.match(mirror, /"push", "--no-verify", plan\.remote/);
	// 镜像源不可达时按低速阈值快速放弃，不拖住一次 push
	assert.match(mirror, /GIT_HTTP_LOW_SPEED_LIMIT/);
	assert.match(mirror, /GIT_HTTP_LOW_SPEED_TIME/);
	// dry-run 只打印命令，便于在别的设备上自检
	assert.match(mirror, /PI_DECK_ATOMGIT_DRY_RUN/);
});

test("pre-push hook stays a thin delegator", () => {
	assert.match(hook, /exec node "\$mirror" "\$@"/);
	assert.match(hook, /atomgit-mirror\.mjs/);
	// node 缺失时放行：钩子不能因为环境缺东西让开发者的 push 失败
	assert.match(hook, /command -v node >\/dev\/null 2>&1 \|\| \{[\s\S]{0,200}?exit 0/);
	// 不含自己的 git push（逻辑唯一来源是 node 模块，否则单测覆盖不到）
	assert.doesNotMatch(hook, /git push/);
});

test("installer wires the hook for other devices", () => {
	assert.match(installer, /git\(\[\s*"config",\s*"--local",\s*"core\.hooksPath"/);
	assert.match(installer, /HOOKS_PATH = "\.githooks"/);
	// 新设备常见缺 atomgit 远端：安装时补齐，地址与镜像脚本同源
	assert.match(installer, /import \{ DEFAULT_ATOMGIT_REMOTE, DEFAULT_ATOMGIT_URL \} from "\.\/atomgit-mirror\.mjs"/);
	assert.match(installer, /git\(\[\s*"remote",\s*"add",\s*DEFAULT_ATOMGIT_REMOTE,\s*DEFAULT_ATOMGIT_URL\s*\]/);
	// 已有别人（husky）接管 hooks 时不硬抢，除非 --force
	assert.match(installer, /--force/);
	assert.match(installer, /core\.hooksPath 已被设置为/);
	// 默认永远不让 npm install 失败
	assert.match(installer, /钩子安装永远不该打断 npm install/);
	assert.match(installer, /process\.exit\(strict \|\| checkOnly \? code : 0\)/);
});

test("npm install installs the hook automatically", () => {
	assert.equal(pkg.scripts.prepare, "node scripts/install-git-hooks.mjs");
	assert.equal(pkg.scripts["hooks:install"], "node scripts/install-git-hooks.mjs");
	// postinstall 只做本地依赖修补（node-pty 权限、electron-builder 解压 rename 重试补丁），不承载 git hook 安装
	assert.equal(pkg.scripts.postinstall, "node scripts/fix-pty-permissions.js && node scripts/patch-electron-builder-rename-retry.js");
});

test("atomgit URL has a single source of truth", () => {
	assert.equal(DEFAULT_ATOMGIT_URL, "https://atomgit.com/ayuayue/PiDeck.git");
	// README 对外声明的 AtomGit 地址必须与脚本自愈写入的地址一致
	assert.match(readme, /https:\/\/atomgit\.com\/ayuayue\/PiDeck/);
});
