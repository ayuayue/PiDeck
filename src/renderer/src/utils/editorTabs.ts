import type { ProjectFileAccessScope } from "../../../shared/types";

/**
 * 编辑器文件 Tab 的 VS Code 式预览/常驻策略（纯函数）。
 *
 * - preview：单击打开；至多一个预览 Tab，再点其它文件会替换它
 * - permanent：双击打开，或对预览 Tab 再双击晋升；不再被预览替换挤掉
 *
 * 与 sessionTabs 同语义；身份用 tabId（打开时由 hook 生成）。「同一文件」同时包含
 * path、tabKey 和项目授权：嵌套项目可指向同一宿主路径，但不能复用 Tab 后覆盖 scope，
 * 否则 FileDiffViewer 会重新加载并丢失旧 Tab 尚未落盘的编辑状态。
 */

export type EditorTabOpenMode = "preview" | "permanent";

export type EditorTabIdentity = {
  id: string;
  filePath: string;
  tabKey?: string;
  fileAccessScope?: ProjectFileAccessScope;
};

function sameFile(a: EditorTabIdentity, b: EditorTabIdentity): boolean {
  return (
    a.filePath === b.filePath &&
    a.tabKey === b.tabKey &&
    a.fileAccessScope?.projectId === b.fileAccessScope?.projectId
  );
}

/**
 * 预览打开：已有常驻同文件则只回传其 id（不改列表）；
 * 否则替换旧预览 Tab，登记新预览。
 */
export function openPreviewEditorTab<T extends EditorTabIdentity>(
  tabs: readonly T[],
  previewId: string | null,
  nextTab: T,
): { tabs: T[]; previewId: string | null; activeId: string } {
  const resident = tabs.find(
    (tab) => sameFile(tab, nextTab) && tab.id !== previewId,
  );
  if (resident) {
    return { tabs: [...tabs], previewId, activeId: resident.id };
  }
  const existingPreview = previewId
    ? tabs.find((tab) => tab.id === previewId)
    : undefined;
  if (
    existingPreview &&
    sameFile(existingPreview, nextTab)
  ) {
    return { tabs: [...tabs], previewId, activeId: existingPreview.id };
  }

  let next = tabs.filter((tab) => tab.id !== previewId);
  const already = next.find((tab) => sameFile(tab, nextTab));
  if (already) {
    return { tabs: next, previewId: already.id, activeId: already.id };
  }
  next = [...next, nextTab];
  return { tabs: next, previewId: nextTab.id, activeId: nextTab.id };
}

/**
 * 常驻打开：同文件已在列表则聚焦并取消其预览标记；
 * 否则追加，且若当前有其它预览保持不变。
 */
export function openPermanentEditorTab<T extends EditorTabIdentity>(
  tabs: readonly T[],
  previewId: string | null,
  nextTab: T,
): { tabs: T[]; previewId: string | null; activeId: string } {
  const existing = tabs.find((tab) => sameFile(tab, nextTab));
  if (existing) {
    return {
      tabs: [...tabs],
      previewId: previewId === existing.id ? null : previewId,
      activeId: existing.id,
    };
  }
  return {
    tabs: [...tabs, nextTab],
    previewId,
    activeId: nextTab.id,
  };
}

/** 双击预览 Tab → 常驻 */
export function promotePreviewEditorTab(
  previewId: string | null,
  tabId: string,
): string | null {
  return previewId === tabId ? null : previewId;
}
