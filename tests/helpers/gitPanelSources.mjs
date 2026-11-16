import { existsSync, readFileSync } from "node:fs";

const entryPath = "src/renderer/src/components/app/GitPanel.tsx";
const splitDirectory = "src/renderer/src/components/app/git";

/**
 * 从 `GitPanel.tsx` 拆出去的分区模块：分区布局模型、存储、提交摘要工具与域 hook。
 * 契约测试扫描这里，而不是只扫 `GitPanel.tsx`——否则面板再拆一次，断言会随搬迁失效
 * （顺序敏感：拆分文件在前、入口文件在后，`indexOf` 型切片仍落在原文件的上下文里）。
 *
 * 只列「从 GitPanel.tsx 搬出去的」文件，不扫描整个 `components/app/git/`：
 * GitGraph / GitResourceTree / GitPanelControls / changeTree / floatingMenuPosition
 * 早已独立，各有自己的读取行与契约，「GitPanel 自身不含 X」这类负向断言扫进来就会失真。
 * 文件不存在时按空处理：拆走最后一个文件也不会让读源失败。
 */
const splitFiles = [
	"GitPaneSash.tsx",
	"changeGroupSpecs.ts",
	"gitPaneLayout.ts",
	"gitPanelStorage.ts",
	"gitPanelToasts.ts",
	"useCommitGenProgress.ts",
	"useGitBranchDropdown.ts",
	"useGitCommitChoice.ts",
	"useGitDiscardConfirm.ts",
	"useGitFileActions.ts",
	"useGitPaneState.tsx",
	"useGitStatusRefresh.ts",
	"useGitSyncActions.ts",
];

export const gitPanelSources = [
	...splitFiles
		.map((name) => `${splitDirectory}/${name}`)
		.filter((path) => existsSync(path))
		.map((path) => ({ path, source: readFileSync(path, "utf8") })),
	{ path: entryPath, source: readFileSync(entryPath, "utf8") },
];

export const gitPanelSource = gitPanelSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
