/**
 * 文件树 Git 状态着色（IDEA 风格）：
 * 1. 路径键归一——分隔符/大小写/尾斜杠，Windows 反斜杠必须能对上树节点的键；
 * 2. GitStatus → 着色状态映射——untracked 琥珀棕、added 绿、冲突红、其余（修改/重命名/删除）蓝；
 * 3. 查找表构建——文件行取自身状态（暂存+未暂存并存时 added 胜出）、目录行聚合子树
 *    （含未跟踪文件时红优先，呼应「没进 git 管理」的核心诉求）、祖先只标到项目根；
 * 4. 颜色映射——状态 → Tailwind 语义 token utility（不写死色值，暗色/皮肤自动适配）；
 * 5. 多仓合并——根仓与嵌套仓的状态合并后走同一套优先级规则；
 * 6. 接线契约——文件行与目录行都叠着色类、查表函数顶层传入 + 递归透传、着色重拉只由内容代次驱动；
 *    这些断言按「出现次数」钉住，删掉任一处都会红（此前的 presence 正则对行为级删除全部假绿）。
 * 7. 档位（strong / muted）两档都要可证伪：只有更深后代变化的祖先必须返回 muted；
 *    行组件必须把查表命中原样交给 fileTreeGitStatusClass（解构只剩 status 会让洗淡档变死代码）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const load = (relativePath) => loadTsCommonJs(`${ROOT}/${relativePath}`);
const readSource = (relativePath) => readFileSync(`${ROOT}/${relativePath}`, "utf8");

const { GitStatus } = load("src/shared/types/git.ts");
const { buildFileTreeGitStatusLookup, dropNestedRepoUntrackedPlaceholders, fileTreeGitKey, fileTreeGitStatusClass, fileTreeGitStatusLabelKey, fileTreeGitStatusOf, isCaseInsensitiveFileSystem, mergeGitResourceGroups } = load("src/renderer/src/utils/fileTreeGitStatus.ts");

/** 默认按大小写敏感文件系统（Linux 语义）建表：需要 Windows/macOS 兜底的用例显式打开开关。 */
const lookupOf = (groups, projectRoot, caseInsensitiveFs = false) => buildFileTreeGitStatusLookup(groups, projectRoot, { caseInsensitiveFs });

/** 最小 GitResourceGroups 工厂：只喂 merge/index/workingTree/untracked 四组 */
const groups = ({ merge = [], index = [], workingTree = [], untracked = [] } = {}) => ({ merge, index, workingTree, untracked });
/** GitResource.letter 由状态派生（对齐主进程 parsePorcelainStatus 的口径）：写死 "M" 会造出与状态矛盾的测试数据。 */
const LETTER_OF = {
	[GitStatus.UNTRACKED]: "U",
	[GitStatus.INDEX_ADDED]: "A",
	[GitStatus.INTENT_TO_ADD]: "A",
	[GitStatus.INDEX_DELETED]: "D",
	[GitStatus.DELETED]: "D",
	[GitStatus.INDEX_RENAMED]: "R",
	[GitStatus.INDEX_COPIED]: "C",
	[GitStatus.INTENT_TO_RENAME]: "R",
};
const resource = (path, status) => ({ path, status, letter: LETTER_OF[status] ?? "M" });

/**
 * 命中快照：`status` 或 `status:muted`，未命中为 undefined。
 * 只取字段而不是 deepEqual 整个对象——沙箱里造的对象原型与测试 realm 不同，deepStrictEqual 会误判。
 */
const hitOf = (lookup, path) => {
	const hit = lookup(path);
	return hit ? `${hit.status}${hit.muted ? ":muted" : ":strong"}` : undefined;
};

test("fileTreeGitKey：反斜杠归一 + 去尾斜杠，保留大小写", () => {
	assert.equal(fileTreeGitKey("C:\\Repo\\Src\\A.ts"), "C:/Repo/Src/A.ts", "反斜杠归一成 POSIX，不改大小写");
	assert.equal(fileTreeGitKey("/home/x/proj/"), "/home/x/proj", "尾部斜杠不参与键");
	assert.notEqual(fileTreeGitKey("/p/Foo.ts"), fileTreeGitKey("/p/foo.ts"), "大小写敏感文件系统上这是两个不同的键");
});

test("大小写敏感文件系统：仅大小写不同的兄弟文件不互相染色", () => {
	const lookup = lookupOf(groups({ workingTree: [resource("/p/src/Foo.ts", GitStatus.MODIFIED)] }), "/p");
	assert.equal(lookup("/p/src/Foo.ts")?.status, "modified", "精确命中");
	assert.equal(lookup("/p/src/foo.ts"), undefined, "干净的同名（仅大小写不同）文件不得被染");
});

test("大小写不敏感文件系统：精确优先，落空才忽略大小写兜底", () => {
	// git 索引里的拼写与磁盘大小写不一致（Windows/macOS 上的仅大小写改名）时靠兜底救回上色
	const lookup = lookupOf(groups({ untracked: [resource("C:\\MyRepo\\src\\Draft.ts", GitStatus.UNTRACKED)] }), "C:/MyRepo", true);
	assert.equal(lookup("C:/MyRepo/src/Draft.ts")?.status, "untracked", "精确命中优先");
	assert.equal(lookup("c:/myrepo/src/draft.ts")?.status, "untracked", "大小写不同也命中兜底");
	assert.equal(lookup("C:\\MyRepo\\SRC")?.status, "untracked", "目录键同样兜底，反斜杠仍归一");
});

test("大小写不敏感兜底：折叠键有歧义时宁可不染色", () => {
	const lookup = lookupOf(
		groups({
			workingTree: [resource("/p/src/Foo.ts", GitStatus.MODIFIED)],
			untracked: [resource("/p/src/foo.ts", GitStatus.UNTRACKED)],
		}),
		"/p",
		true,
	);
	assert.equal(lookup("/p/src/Foo.ts")?.status, "modified", "精确命中不受歧义影响");
	assert.equal(lookup("/p/src/foo.ts")?.status, "untracked", "精确命中不受歧义影响");
	assert.equal(lookup("/p/src/FOO.ts"), undefined, "第三种拼写不猜：折叠键歧义时按未命中处理");
});

test("平台判定：默认保守（拿不到平台信息时按大小写敏感处理）", () => {
	// 测试进程的 navigator.userAgent 是 Node 自身标识，不含 Windows/Macintosh
	assert.equal(isCaseInsensitiveFileSystem(), false);
});

/** 全量归属表：每个 GitStatus 成员都必须显式决定着色归属，新增成员会被下面的用例拦下。 */
const STATUS_TABLE = {
	[GitStatus.UNTRACKED]: "untracked",
	[GitStatus.IGNORED]: undefined,
	[GitStatus.INDEX_ADDED]: "added",
	[GitStatus.INTENT_TO_ADD]: "added",
	[GitStatus.INDEX_MODIFIED]: "modified",
	[GitStatus.INDEX_DELETED]: "modified",
	[GitStatus.INDEX_RENAMED]: "modified",
	[GitStatus.INDEX_COPIED]: "modified",
	[GitStatus.INDEX_TYPE_CHANGED]: "modified",
	[GitStatus.MODIFIED]: "modified",
	[GitStatus.DELETED]: "modified",
	[GitStatus.TYPE_CHANGED]: "modified",
	[GitStatus.INTENT_TO_RENAME]: "modified",
	[GitStatus.ADDED_BY_US]: "conflict",
	[GitStatus.ADDED_BY_THEM]: "conflict",
	[GitStatus.DELETED_BY_US]: "conflict",
	[GitStatus.DELETED_BY_THEM]: "conflict",
	[GitStatus.BOTH_ADDED]: "conflict",
	[GitStatus.BOTH_DELETED]: "conflict",
	[GitStatus.BOTH_MODIFIED]: "conflict",
};

test("fileTreeGitStatusOf：枚举全量成员的归属都被钉住（新状态不会静默落进兜底）", () => {
	const members = Object.values(GitStatus).filter((value) => typeof value === "number");
	for (const member of members) {
		assert.ok(Object.hasOwn(STATUS_TABLE, member), `GitStatus.${GitStatus[member]} 必须显式决定着色归属`);
		assert.equal(fileTreeGitStatusOf(member), STATUS_TABLE[member], `GitStatus.${GitStatus[member]}`);
	}
	assert.equal(members.length, Object.keys(STATUS_TABLE).length, "反查：表里不得留已删除的成员");
});

test("fileTreeGitStatusOf：被忽略的文件显式不染色", () => {
	assert.equal(fileTreeGitStatusOf(GitStatus.IGNORED), undefined, "IGNORED 既不是「没进管理」也不是「有改动」");
});

test("fileTreeGitStatusLabelKey：四个状态各有一条文字替代通道", () => {
	assert.equal(fileTreeGitStatusLabelKey("modified"), "drawer.gitStatus.modified");
	assert.equal(fileTreeGitStatusLabelKey("added"), "drawer.gitStatus.added");
	assert.equal(fileTreeGitStatusLabelKey("untracked"), "drawer.gitStatus.untracked");
	assert.equal(fileTreeGitStatusLabelKey("conflict"), "drawer.gitStatus.conflict");
	assert.equal(fileTreeGitStatusLabelKey(undefined), undefined, "未命中不出文案");
});

test("查找表：IGNORED 资源不参与着色，也不沿祖先目录上染", () => {
	const lookup = lookupOf(groups({ workingTree: [resource("/p/ignored/logs", GitStatus.IGNORED)] }), "/p");
	assert.equal(lookup("/p/ignored/logs"), undefined);
	assert.equal(lookup("/p/ignored"), undefined, "被忽略的内容不得让目录变色");
});

test("查找表：未跟踪文件标红，祖先目录同色（用户核心诉求：没进 git 管理一眼可辨）", () => {
	const lookup = lookupOf(groups({ untracked: [resource("/proj/notes/draft.md", GitStatus.UNTRACKED)] }), "/proj");
	assert.equal(lookup("/proj/notes/draft.md")?.status, "untracked", "文件行取自身状态");
	assert.equal(lookup("/proj/notes")?.status, "untracked", "父目录聚合子树状态");
	assert.equal(lookup("/proj"), undefined, "项目根不是树节点，不标记");
});

test("查找表：目录里未跟踪 + 已修改并存时，目录红优先于蓝", () => {
	const lookup = lookupOf(
		groups({
			workingTree: [resource("/proj/src/old.ts", GitStatus.MODIFIED)],
			untracked: [resource("/proj/src/new.ts", GitStatus.UNTRACKED)],
		}),
		"/proj",
	);
	assert.equal(lookup("/proj/src/old.ts")?.status, "modified", "已跟踪改动文件行保持蓝");
	assert.equal(lookup("/proj/src/new.ts")?.status, "untracked", "未跟踪文件行保持琥珀棕");
	assert.equal(lookup("/proj/src")?.status, "untracked", "目录聚合：提示「有东西没进 git」");
});

test("查找表：同一文件暂存新增后又改（index+workingTree 并存），文件行 added 胜出", () => {
	const lookup = lookupOf(
		groups({
			index: [resource("/proj/a.ts", GitStatus.INDEX_ADDED)],
			workingTree: [resource("/proj/a.ts", GitStatus.MODIFIED)],
		}),
		"/proj",
	);
	assert.equal(lookup("/proj/a.ts")?.status, "added", "新文件信息量最大：绿（IDEA 同款）");
});

test("查找表：冲突资源走琥珀，且优先级高于其他状态", () => {
	const lookup = lookupOf(
		groups({
			merge: [resource("/proj/conflict.ts", GitStatus.BOTH_MODIFIED)],
			workingTree: [resource("/proj/conflict.ts", GitStatus.MODIFIED)],
		}),
		"/proj",
	);
	assert.equal(lookup("/proj/conflict.ts")?.status, "conflict");
	assert.equal(lookup("/proj"), undefined, "根目录仍不标记");
});

test("查找表：删除文件按新路径标记——文件不在树上，着色落在父目录", () => {
	const lookup = lookupOf(groups({ workingTree: [resource("/proj/src/gone.ts", GitStatus.DELETED)] }), "/proj");
	assert.equal(lookup("/proj/src/gone.ts")?.status, "modified", "文件键仍标记（树外节点查不到，无害）");
	assert.equal(lookup("/proj/src")?.status, "modified", "目录确有变更：蓝");
});

test("查表档位：直接父目录实色，更远祖先洗淡（IDEA 的 immediate / descendants 两档）", () => {
	const lookup = lookupOf(groups({ untracked: [resource("/proj/src/renderer/hooks/new.ts", GitStatus.UNTRACKED)] }), "/proj");
	assert.equal(hitOf(lookup, "/proj/src/renderer/hooks/new.ts"), "untracked:strong", "文件本身实色");
	assert.equal(hitOf(lookup, "/proj/src/renderer/hooks"), "untracked:strong", "直接父目录实色：这层就有变化");
	assert.equal(hitOf(lookup, "/proj/src/renderer"), "untracked:muted", "祖父目录洗淡：只有更深处才有变化");
	assert.equal(hitOf(lookup, "/proj/src"), "untracked:muted", "更远祖先同样洗淡（留提示但不喊）");
});

test("查表档位：目录有直接子资源即实色（哪怕取胜的状态来自更深层）", () => {
	const lookup = lookupOf(
		groups({
			workingTree: [resource("/proj/a/own.ts", GitStatus.MODIFIED)],
			untracked: [resource("/proj/a/deep/new.ts", GitStatus.UNTRACKED)],
		}),
		"/proj",
	);
	assert.equal(hitOf(lookup, "/proj/a"), "untracked:strong", "含直接改动即按 immediate 档展示（状态仍按 rank 取未跟踪）");
	assert.equal(hitOf(lookup, "/proj/a/deep"), "untracked:strong", "直接父目录实色");
});

test("多仓：嵌套仓目录的「外层仓未跟踪」占位被丢弃，改按嵌套仓自己的状态上色", () => {
	// 场景：根仓把嵌套仓目录当未跟踪（git 不递归进另一个仓），嵌套仓自己报一条已暂存新增
	const rootRepo = groups({ untracked: [resource("/proj/packages/app", GitStatus.UNTRACKED)] });
	const nestedRepo = groups({ index: [resource("/proj/packages/app/main.ts", GitStatus.INDEX_ADDED)] });
	const nestedRoots = ["/proj/packages/app"];
	const merged = mergeGitResourceGroups([dropNestedRepoUntrackedPlaceholders(rootRepo, nestedRoots), dropNestedRepoUntrackedPlaceholders(nestedRepo, nestedRoots)]);
	assert.equal(merged.untracked.length, 0, "嵌套仓根目录的未跟踪占位被丢掉");
	assert.equal(merged.index.length, 1);
	const lookup = lookupOf(merged, "/proj");
	assert.equal(lookup("/proj/packages/app/main.ts")?.status, "added", "嵌套仓文件按自己仓库的状态上色");
	assert.equal(lookup("/proj/packages/app")?.status, "added", "嵌套仓目录取子树聚合，不再被外层仓标成未跟踪");
	assert.equal(hitOf(lookup, "/proj/packages/app"), "added:strong", "嵌套仓文件是它的直接子资源：实色档");
	assert.equal(lookup("/proj/packages")?.status, "added", "祖先目录同步聚合");
});

test("多仓：未跟踪占位过滤只打嵌套仓根目录，仓内真未跟踪文件与子模块 gitlink 都保留", () => {
	const outer = groups({
		workingTree: [resource("/proj/packages/app", GitStatus.MODIFIED)],
		untracked: [resource("/proj/packages/app", GitStatus.UNTRACKED), resource("/proj/packages/app/src/new.ts", GitStatus.UNTRACKED), resource("/proj/packages/app2", GitStatus.UNTRACKED)],
	});
	const filtered = dropNestedRepoUntrackedPlaceholders(outer, ["/proj/packages/app"]);
	assert.deepEqual(
		Array.from(filtered.untracked, (r) => r.path),
		["/proj/packages/app/src/new.ts", "/proj/packages/app2"],
		"只丢「恰好等于嵌套仓根目录的未跟踪项」",
	);
	assert.equal(filtered.workingTree.length, 1, "子模块 gitlink 的已跟踪改动保留（git 报的是 M 不是 untracked）");
	assert.equal(dropNestedRepoUntrackedPlaceholders(outer, []), outer, "没有嵌套仓时原样返回（免重建）");
});

test("查找表：同一路径既是资源又是祖先目录时按目录聚合（刻意规则，必须有断言钉住）", () => {
	// 根仓把嵌套仓目录整个报成未跟踪，同时该目录里有它自己的改动。
	// 若改成「文件语义优先」（if (!map.has)），这个目录会被标成未跟踪，与内部每个文件的状态矛盾。
	const lookup = lookupOf(
		groups({
			untracked: [resource("/proj/packages/app", GitStatus.UNTRACKED)],
			index: [resource("/proj/packages/app/main.ts", GitStatus.INDEX_ADDED)],
		}),
		"/proj",
	);
	assert.equal(lookup("/proj/packages/app")?.status, "added", "目录语义覆盖文件语义");
	assert.equal(lookup("/proj/packages")?.status, "untracked", "祖先目录仍按未跟踪优先（子树里有未跟踪内容）");
});

test("多仓合并：空数组不产生任何条目，原分组不被修改", () => {
	const single = groups({ workingTree: [resource("/proj/a.ts", GitStatus.MODIFIED)] });
	const before = JSON.stringify(single);
	const merged = mergeGitResourceGroups([single, groups()]);
	assert.equal(merged.workingTree.length, 1);
	assert.equal(JSON.stringify(single), before, "合并必须是纯函数：不得改动入参分组");
	assert.equal(mergeGitResourceGroups([]).workingTree.length, 0);
});

test("查找表：空分组返回空表", () => {
	const lookup = lookupOf(groups(), "/proj");
	assert.equal(lookup("/proj/a.ts"), undefined);
});

test("着色类映射：两档各自的 utility，未命中不染色", () => {
	// 必须走 utility 而非写死色值：暗色与各皮肤经 token 自动适配（AGENTS.md CSS 双轨）
	const strong = (status) => fileTreeGitStatusClass({ status, muted: false });
	const muted = (status) => fileTreeGitStatusClass({ status, muted: true });
	assert.equal(strong("modified"), "text-info");
	assert.equal(strong("added"), "text-success");
	assert.equal(strong("untracked"), "text-warning", "未跟踪用琥珀棕（IDEA unversioned 同族），不是报警红");
	assert.equal(strong("conflict"), "text-danger", "红留给真正要处理的冲突");
	// 洗淡档必须写成整串字面量（Tailwind 按字面量生成 utility）：保留色相，只有透明度不同
	assert.equal(muted("modified"), "text-info/65");
	assert.equal(muted("added"), "text-success/65");
	assert.equal(muted("untracked"), "text-warning/65");
	assert.equal(muted("conflict"), "text-danger/65");
	assert.equal(fileTreeGitStatusClass(undefined), undefined, "未命中（干净文件/非仓库）不加类");
});

test("查表档位：四种状态都必须区分「直接含变更」与「只有更深后代变化」", () => {
	// muted 恒 false 时下面每个 :muted 断言都会红——洗淡档（Have changed descendants）只靠
	// 这些断言活着，缺了就是死代码级风险。
	const cases = [
		{ status: "modified", file: "/proj/pkg/deep/own.ts", group: groups({ workingTree: [resource("/proj/pkg/deep/own.ts", GitStatus.MODIFIED)] }) },
		{ status: "added", file: "/proj/pkg/deep/new.ts", group: groups({ index: [resource("/proj/pkg/deep/new.ts", GitStatus.INDEX_ADDED)] }) },
		{ status: "untracked", file: "/proj/pkg/deep/draft.md", group: groups({ untracked: [resource("/proj/pkg/deep/draft.md", GitStatus.UNTRACKED)] }) },
		{ status: "conflict", file: "/proj/pkg/deep/both.ts", group: groups({ merge: [resource("/proj/pkg/deep/both.ts", GitStatus.BOTH_MODIFIED)] }) },
	];
	for (const { status, file, group } of cases) {
		const lookup = lookupOf(group, "/proj");
		assert.equal(hitOf(lookup, file), `${status}:strong`, `${status}：文件本身实色`);
		assert.equal(hitOf(lookup, "/proj/pkg/deep"), `${status}:strong`, `${status}：直接含变更子项 —— 实色档`);
		assert.equal(hitOf(lookup, "/proj/pkg"), `${status}:muted`, `${status}：只有更深后代变化 —— 必须洗淡`);
	}
});

test("着色类映射：洗淡档与实色档必须是不同的类名，洗淡档保留色相只降不透明度", () => {
	for (const status of ["modified", "added", "untracked", "conflict"]) {
		const strong = fileTreeGitStatusClass({ status, muted: false });
		const muted = fileTreeGitStatusClass({ status, muted: true });
		assert.notEqual(muted, strong, `${status}：忽略 muted 会让两档完全同色（洗淡档失效）`);
		assert.match(muted, /^text-(info|success|warning|danger)\/65$/, `${status}：洗淡档是同色 token 的 65% 档，不换色相`);
		assert.match(strong, /^text-(info|success|warning|danger)$/, `${status}：实色档是整串 token utility，不带透明度后缀`);
	}
});

test("接线契约：行组件把查表命中原样交给着色映射，目录递归透传查表函数", () => {
	// 行组件已从面板文件整块迁出（WorkspaceSurface > 600 行红线）：着色接线断言跟到行组件宿主文件
	const rows = readSource("src/renderer/src/components/session/FileTreeRows.tsx");
	// 命中对象必须整体传入：中间解构只剩 status 会把 muted 丢掉，洗淡档变成死代码（评审 P1-b）
	const classCalls = rows.match(/fileTreeGitStatusClass\(\s*gitStatus\s*\)/g) ?? [];
	assert.equal(classCalls.length, 2, "文件行与目录行都必须用完整命中（含 muted）取类");
	const lookups = rows.match(/props\.gitStatusOf\?\.\(\s*node\.path\s*\)/g) ?? [];
	assert.equal(lookups.length, 2, "两种行都按节点路径查表");
	assert.doesNotMatch(rows, /fileTreeGitStatusClass\(\s*\{/, "不得手工拼命中对象（会写死档位）");
	assert.doesNotMatch(rows, /muted\s*:\s*(?:true|false)/, "档位只能来自查表结果，行组件不得写死");
	assert.match(rows, /gitStatusOf=\{\s*props\.gitStatusOf\s*\}/, "目录递归必须透传查表函数（缺了深层节点全失色）");
});

test("接线契约：文件行与目录行都叠着色类、查表函数接进树、着色重拉只由内容代次驱动", () => {
	const surface = readSource("src/renderer/src/components/session/WorkspaceSurface.tsx");
	// 行组件与面板已分居两个文件（行拆分在上游「分批渲染」重构中被合并回去，本轮再按 600 行红线迁出）：
	// 断言照旧按出现次数钉住，只是行级断言读新宿主、面板级断言留在原文件。
	const row = readSource("src/renderer/src/components/session/FileTreeRows.tsx");
	// 出现次数而不是「有没有」：文件行 + 目录行各一处，删掉任何一种行都会红
	const coloredRows = row.match(/cn\(\s*"file-node-name"\s*,\s*gitStatusClass\s*\)/g) ?? [];
	assert.equal(coloredRows.length, 2, "文件行与目录行都必须按同一份着色类渲染");
	// 查表函数必须真的接到树上：面板传入 + 行组件递归透传缺一不可（缺后者深层节点全失色）
	assert.match(surface, /gitStatusOf=\{\s*gitStatus\.statusOf\s*\}/, "面板把查表函数传给树根");
	assert.match(row, /gitStatusOf=\{\s*props\.gitStatusOf\s*\}/, "目录节点把查表函数透传给子节点");
	assert.match(row, /isActiveFile\s*\?\s*undefined\s*:\s*fileTreeGitStatusClass/, "活跃编辑器行的选中高亮优先于 Git 着色");
	// 着色重拉的触发权：刷新按钮一处显式调用 + 内容代次交给防抖 hook（两处，删任一处都红）
	const refreshCalls = surface.match(/void\s+gitStatus\.refresh\(\)/g) ?? [];
	assert.equal(refreshCalls.length, 1, "只有刷新按钮显式重拉（内容变化走防抖 hook）");
	assert.match(surface, /useFileTreeGitStatusRefresh\(\s*props\.fileTreeContentRevision\s*,\s*gitStatus\.refresh\s*\)/, "防抖重拉由内容代次驱动");
	// 旧启发式（props.files 引用 + expandedDirs + 两个 ref）必须消失：展开已加载目录也会换引用，
	// 那会让每次展开都白付一轮 listRepos + 每仓 git status -uall（评审 P1-a 缺陷 1）。
	assert.doesNotMatch(surface, /firstTreeChangeRef|prevExpandedDirsRef/, "「首帧 + 展开」启发式必须删掉");
	assert.doesNotMatch(surface, /useFileTreeGitStatusRefresh\([^)]*expandedDirs/, "展开/收起不得参与着色触发");
	// 防抖规则本体在 hook 里：只以代次为键，定时器回调走 ref（回调重建不打断待执行刷新）
	const refreshHook = readSource("src/renderer/src/hooks/files/useFileTreeGitStatusRefresh.ts");
	assert.match(refreshHook, /FILE_TREE_GIT_STATUS_REFRESH_DEBOUNCE_MS\s*=\s*400\s*;/, "防抖窗口 400ms");
	assert.match(refreshHook, /window\.setTimeout\(\s*\(\)\s*=>\s*void\s+refreshRef\.current\(\)\s*,\s*FILE_TREE_GIT_STATUS_REFRESH_DEBOUNCE_MS\s*\)/, "防抖重拉必须挂在定时器上（不是每次内容变化都拉）");
	assert.match(refreshHook, /\}\s*,\s*\[\s*contentRevision\s*\]\s*\)/, "effect 只以内容代次为键（引用/展开变化不得取消待执行的刷新）");
	// 代次 owner 是文件树 state hook：代次与 nodes 同源，setFiles 返回同一引用＝不推进、
	// 返回新数组＝推进一次（等价重载也会推进，代价只是一轮多拉，不是回归）
	const projectSync = readSource("src/renderer/src/hooks/useProjectSync.ts");
	assert.match(projectSync, /const\s*\{\s*files\s*,\s*fileTreeContentRevision\s*,\s*setFiles\s*\}\s*=\s*useFileTreeContentState\(\)/, "内容代次由 useFileTreeContentState 拥有");
	const drawerSurface = readSource("src/renderer/src/components/workspace/DrawerSurface.tsx");
	assert.match(drawerSurface, /fileTreeContentRevision=\{\s*files\.fileTreeContentRevision\s*\}/, "port 把内容代次透传给抽屉面板");
	// 按下底色显式收口到 hover 同档：themeContrast 契约的 bg-muted 面才覆盖得住按下态
	assert.match(row, /active:bg-muted/, "行按下底必须与 hover 同档（legacy :active 规则已删）");
	assert.match(row, /active:bg-accent/, "选中行按下时保持强调底，不被按下色抢走");
	// 文字替代通道：颜色之外的第二种信号（色弱可辨）
	assert.match(row, /fileTreeGitStatusLabelKey\(\s*gitStatus\?\.status\s*\)/, "行必须取状态名文案键");
	assert.match(row, /aria-label=\{\s*gitStatusLabel\s*\?/, "状态名要进 aria-label，屏幕阅读器也能读到");
	// 颜色只走 utility：legacy 样式表不得再为行名写状态色（改成正向扫描，拦住真的手写色规则）
	const css = readSource("src/renderer/src/styles/timeline.css");
	assert.doesNotMatch(css, /\.file-node-name[^{}]*\{[^{}]*\bcolor\s*:/, "不得为行名写手写状态色规则（CSS 双轨：新改动走 Tailwind）");
});
