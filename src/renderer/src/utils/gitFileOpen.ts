import type { ProjectFileAccessScope } from "../../../shared/types";
import type { EditorTabOpenMode } from "./editorTabs";

/**
 * Git 变更行内「打开文件」按钮的统一动作：先清掉 Git Diff，再以可编辑的常驻 Tab 打开文件。
 *
 * 为什么必须先清 Diff：Diff 在中间栏阅读面独占优先级（WorkbenchContent 先渲染 gitDiff），
 * 不清掉的话新 Tab 会被 Diff 盖住，表现为「点击打开文件没反应」。其他文件入口
 * （viewFilePath / diffFilePath）内部已做同样清理，只有 Git 行内按钮走 raw openEditorTab，
 * 所以此规则收敛在这里，避免各入口再各写一次。
 */
export function openGitFileInEditor(
  dismissGitDiff: () => void,
  openTab: (
    path: string,
    mode: "view" | "diff",
    originalContent?: string,
    modifiedContent?: string,
    allowSave?: boolean,
    tabKey?: string,
    label?: string,
    preserveDrawer?: boolean,
    openMode?: EditorTabOpenMode,
    initialLine?: number,
    fileAccessScope?: ProjectFileAccessScope,
  ) => void,
  path: string,
): void {
  dismissGitDiff();
  openTab(path, "view", undefined, undefined, true, undefined, undefined, undefined, "permanent");
}
