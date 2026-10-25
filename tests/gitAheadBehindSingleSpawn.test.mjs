/**
 * GitService.getAheadBehind 单次 spawn 契约测试。
 *
 * 背景：push/pull 角标（ahead/behind）现在会被 5 秒轮询重读一次——AI 在终端里
 * commit/push 后本地 refs 立即变化，重读本地差距即可把角标归零，不必等下一轮
 * fetch。调用频率上升后，原先「先 rev-parse 解析上游名 + 再 rev-list 计数」的两次
 * 子进程就浪费了：那次 rev-parse 只是为了区分「无上游」与「命令失败」，而两者对
 * UI 都是「不显示角标」。改为直接用 `HEAD...@{upstream}` 一次完成，
 * 无上游时 git 以 exit 128 失败 → 返回 null。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const calls = [];
let failWith = null;
// promisify(execFile) 的底层形状：(command, args, options, callback)
function fakeExecFile(command, args, _options, callback) {
	calls.push({ command, args });
	if (failWith) {
		// 无上游 / 非仓库：git 打印 fatal 并以非 0 退出
		const error = Object.assign(new Error(failWith), { code: 128, stdout: "", stderr: failWith });
		callback(error, { stdout: "", stderr: failWith });
		return;
	}
	callback(null, { stdout: "3\t1\n", stderr: "" });
}

const gitExecutable = loadTsCommonJs("src/main/git/gitExecutable.ts");
const { GitService } = loadTsCommonJs("src/main/git/GitService.ts", {
	stubs: {
		"./gitExecutable": gitExecutable,
		electron: { shell: { trashItem: async () => {} } }, // ../fs/trash 懒加载 electron.shell
		"node:child_process": { execFile: fakeExecFile },
	},
});

test("单次 rev-list 完成计数：参数用 HEAD...@{upstream}，不再先 rev-parse 解析上游名", async () => {
	calls.length = 0;
	failWith = null;
	const result = await new GitService().getAheadBehind("/repo");
	// 跨 vm 加载的对象原型不同，逐字段断言（deepStrictEqual 会因原型不一致失败）
	assert.equal(result?.ahead, 3);
	assert.equal(result?.behind, 1);
	// 只允许一次子进程：多一次 spawn 就是每 5 秒多付一次进程开销
	assert.equal(calls.length, 1, `getAheadBehind 应只 spawn 一次 git，实际 ${calls.length}`);
	// 同上：args 数组来自 vm 沙箱，用 join 比较避免原型差异
	assert.equal(calls[0].args.join(" "), "rev-list --left-right --count HEAD...@{upstream}");
});

test("无上游（git exit 128）返回 null，UI 不显示角标", async () => {
	calls.length = 0;
	failWith = "fatal: no upstream configured for branch 'master'";
	const result = await new GitService().getAheadBehind("/repo");
	assert.equal(result, null);
	// 失败也要单次调用，不能退化成「先探测再计数」
	assert.equal(calls.length, 1);
	failWith = null;
});
