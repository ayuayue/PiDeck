// 审计日志契约（静态断言）：误删排查能力（40G 事件教训）的回归保障。
// - 所有删除必须走 trashPath 并带 source 上下文，成功记 warn / 失败记 error
// - 破坏性 git 操作必须留痕
// - SkillManager.delete 拒绝 rm 硬删（改走回收站）
// - LogViewer 走分页查询（时间搜索可翻到任意旧日志）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const trash = read("main/fs/trash.ts");
const gitIpc = read("main/ipc/gitIpc.ts");
const skillManager = read("main/skills/SkillManager.ts");
const logViewer = read("renderer/src/components/app/settings/LogViewer.tsx");
const zh = read("renderer/src/i18n/rendererCopy.zh-CN.ts");
const en = read("renderer/src/i18n/rendererCopy.en-US.ts");
const sharedIpc = read("shared/ipc.ts");
const preload = read("preload/index.ts");

const TRASH_CALLERS = [
	["main/extensions/ExtensionManager.ts", "extension:uninstall"],
	["main/fs/FileSystemService.ts", "files:delete"],
	["main/git/GitService.ts", "git:discard-file"],
	["main/git/GitService.ts", "git:delete-files"],
	["main/git/WorktreeService.ts", "git:worktree-remove"],
	["main/ipc/backgroundsIpc.ts", "backgrounds:cleanup"],
	["main/ipc/backgroundsIpc.ts", "backgrounds:remove"],
	["main/ipc/scratchPadIpc.ts", "scratchPad:delete"],
	["main/projects/ProjectResourceManager.ts", "projects:delete-skill"],
	["main/projects/ProjectResourceManager.ts", "projects:delete-extension"],
	["main/prompts/PromptManager.ts", "prompts:delete"],
	["main/prompts/PromptManager.ts", "prompts:delete-project"],
	["main/skills/SkillManager.ts", "skills:delete"],
];

test("trashPath records success (warn) and failure (error) audit entries with path+source", () => {
	assert.match(trash, /getAppLogger\(\)\?\.warn\("fs:trash", "文件移入回收站"/);
	assert.match(trash, /getAppLogger\(\)\?\.error\("fs:trash", "移入回收站失败"/);
	assert.match(trash, /path: targetPath/);
	assert.match(trash, /source: context\.source/);
	// 失败必须继续抛错：删除失败比永久丢失安全
	assert.match(trash, /throw error/);
});

test("every delete entry point passes a source context", () => {
	for (const [file, source] of TRASH_CALLERS) {
		const content = read(file);
		// 只断言 source 存在（trashPath 带嵌套括号的参数匹配脆弱，可能误报）
		assert.match(content, new RegExp(`source: "${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `${file} must use source "${source}"`);
	}
});

test("SkillManager.delete goes to recycle bin, no rm force on user skills", () => {
	assert.match(skillManager, /trashPath\(skill\.type === "directory" \? skill\.dir : skill\.path, \{ source: "skills:delete" \}\)/);
	const deleteBlock = skillManager.slice(skillManager.indexOf("async delete(skillPath"), skillManager.indexOf("async openFolder"));
	assert.doesNotMatch(deleteBlock, /\brm\(/);
});

test("destructive git operations leave audit traces", () => {
	// git 审计日志带 repoPath: cwd（多仓库支持后统一补字段）
	assert.match(gitIpc, /appLogger\.warn\("git", "Files deleted \(recycle bin\)", \{ projectId, count: paths\.length, paths, repoPath: cwd \}\)/);
	assert.match(gitIpc, /appLogger\.warn\("git", "Reset to commit", \{ projectId, hash, mode, repoPath: cwd \}\)/);
	assert.match(gitIpc, /appLogger\.warn\("git", "Commit dropped", \{ projectId, hash, repoPath: cwd \}\)/);
	assert.match(gitIpc, /appLogger\.warn\("git", "Branch checked out", \{ projectId, branch, repoPath: cwd, changed: result \}\)/);
	assert.match(gitIpc, /appLogger\.info\("git", "Commit created", \{ projectId, message, repoPath: cwd \}\)/);
	assert.match(gitIpc, /appLogger\.info\("git", "Commit cherry-picked", \{ projectId, hash, repoPath: cwd \}\)/);
	assert.match(gitIpc, /appLogger\.info\("git", "Commit reverted", \{ projectId, hash, repoPath: cwd \}\)/);
	assert.match(gitIpc, /appLogger\.info\("git", "Pushed", \{ projectId, repoPath: cwd \}\)/);
	assert.match(gitIpc, /appLogger\.info\("git", "Pulled", \{ projectId, repoPath: cwd \}\)/);
});

test("LogViewer uses paginated listPage with table and pagination components", () => {
	assert.match(logViewer, /logs\.listPage\(query\)/);
	assert.match(logViewer, /from: toTimestamp\(from\)/);
	assert.match(logViewer, /to: toTimestamp\(to\)/); // 起止双端筛选
	assert.match(logViewer, /<Pagination page=\{page \+ 1\}/);
	assert.match(logViewer, /<Table>/);
	assert.match(logViewer, /<TableHead>/);
});

test("listPage channel is wired across shared ipc, systemIpc, preload", () => {
	assert.match(sharedIpc, /logsListPage: "logs:list-page"/);
	assert.match(preload, /listPage: \(query\?: AppLogQuery\)/);
	assert.match(read("main/ipc/systemIpc.ts"), /ipcChannels\.logsListPage/);
});

test("log viewer i18n keys exist in both locales", () => {
	const keys = ["logs.resultsCount", "logs.column.time", "logs.column.level", "logs.column.scope", "logs.column.message", "logs.column.detail", "logs.rangeFilter", "logs.rangeFrom", "logs.rangeTo", "logs.clearRangeFilter"];
	for (const key of keys) {
		assert.match(zh, new RegExp(`"${key}":`), `${key} must exist in zh-CN`);
		assert.match(en, new RegExp(`"${key}":`), `${key} must exist in en-US`);
	}
});
