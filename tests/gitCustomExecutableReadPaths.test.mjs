import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const CUSTOM_GIT = "C:/tools/portable-git/cmd/git.exe";

const calls = [];
// promisify(execFile) 的底层形状：(command, args, options, callback)
function fakeExecFile(command, args, _options, callback) {
	calls.push({ command, args });
	const joined = args.join(" ");
	const stdout = /--verify/.test(joined)
		? "0123456789abcdef0123456789abcdef01234567\n" // resolveCommitHash 需 40 位 hex
		: /for-each-ref/.test(joined)
			? "\n" // getRefs：空 ref 列表
			: /--show-toplevel/.test(joined)
				? "/repo/root\n"
				: /@{upstream}/.test(joined)
					? "origin/main\n"
					: /left-right/.test(joined)
						? "0\t0\n"
						: "";
	callback(null, { stdout, stderr: "" });
}

const gitExecutable = loadTsCommonJs("src/main/git/gitExecutable.ts");
const { GitService } = loadTsCommonJs("src/main/git/GitService.ts", {
	stubs: {
		"./gitExecutable": gitExecutable, // 同一份模块状态：setConfiguredGitPath 对 GitService 生效
		electron: { shell: { trashItem: async () => {} } }, // ../fs/trash 懒加载 electron.shell
		"node:child_process": { execFile: fakeExecFile },
	},
});

function freshService() {
	calls.length = 0;
	gitExecutable.setConfiguredGitPath(CUSTOM_GIT);
	assert.equal(gitExecutable.currentGitExecutable(), CUSTOM_GIT);
	return new GitService();
}

test("读路径全部 spawn currentGitExecutable：getRefs/getOriginalContent/getAheadBehind/diffFileBetweenRefs/compareBranches/getCommitDetail", async () => {
	const service = freshService();
	await service.getRefs("/repo");
	await service.getOriginalContent("/repo/a.txt");
	await service.getAheadBehind("/repo");
	await service.diffFileBetweenRefs("/repo", "main", "dev", "a.txt");
	await service.compareBranches("/repo", "main", "dev");
	await service.getCommitDetail("/repo", "0123456789abcdef0123456789abcdef01234567");
	assert.ok(calls.length >= 10, `应产生多次 git 子进程调用，实际 ${calls.length}`);
	for (const { command } of calls) {
		assert.equal(command, CUSTOM_GIT, "所有读路径必须走用户配置的 git 可执行文件");
	}
});

test("源码契约：GitService 内不再有 execFileAsync(\"git\") 字面量（兜住 :188/:207 等条件路径）", () => {
	const src = readFileSync("src/main/git/GitService.ts", "utf8");
	assert.doesNotMatch(src, /execFileAsync\(\s*"git"/, "所有 execFileAsync 调用点必须用 currentGitExecutable()");
});
