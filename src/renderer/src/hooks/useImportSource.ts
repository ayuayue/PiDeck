import { useCallback, useMemo, useState } from "react";
import type { t as translateFn, TranslationKey } from "../i18n";
import type { Project } from "../../../shared/types";

export interface ImportController<T = unknown, R = unknown> {
  sessions: T[];
  selectedPaths: string[];
  loading: boolean;
  importing: boolean;
  report: R | null;
  error: string | null;
  refresh: () => Promise<void>;
  toggle: (sourcePath: string) => void;
  toggleAll: () => void;
  importSelected: () => Promise<R | null>;
}

/** 复用 i18n 的 t 签名，保证 App 传入的翻译函数无需适配即可透传。 */
type ImportTranslate = typeof translateFn;

export type ImportSourceConfig<T, R> = {
  /** 文案前缀，如 "workbuddy" → workbuddy.scanFailed / importDone / importFailed */
  copyPrefix: string;
  scan: (projectId: string) => Promise<T[]>;
  importSessions: (projectId: string, sourcePaths: string[]) => Promise<R>;
  /** 可选：限定可被勾选的会话（Codex 用其剔除子代理线程），默认全部可选。 */
  selectablePaths?: (sessions: T[]) => string[];
  /** 扫描后是否预勾选可选会话：Codex 预选，其余源由用户手动选。 */
  preselectOnScan?: boolean;
  setProjectMenu: (menu: null) => void;
  refreshProjectSessions: (projectId: string) => Promise<unknown>;
  showToast: (message: string, duration?: number) => void;
  t: ImportTranslate;
};

export type ImportSource<T, R> = {
  project: Project | null;
  setProject: React.Dispatch<React.SetStateAction<Project | null>>;
  controller: ImportController<T, R>;
  open: (project: Project) => Promise<void>;
};

/**
 * 单个导入源的完整状态机：扫描 / 勾选 / 导入 / 报告。
 *
 * 五个导入源（Codex / Claude / OpenCode / ZCode / WorkBuddy）流程完全一致，
 * 只有 API、文案前缀与可选集合不同，因此收敛成工厂 hook，避免逐源复制状态。
 */
export function useImportSource<
  T extends { sourcePath: string },
  R extends { imported: number; failed: number },
>(config: ImportSourceConfig<T, R>): ImportSource<T, R> {
  const {
    copyPrefix,
    scan,
    importSessions,
    selectablePaths,
    preselectOnScan = false,
    setProjectMenu,
    refreshProjectSessions,
    showToast,
    t,
  } = config;

  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<T[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<R | null>(null);

  const pickPaths = useCallback(
    (list: T[]) =>
      selectablePaths ? selectablePaths(list) : list.map((session) => session.sourcePath),
    [selectablePaths],
  );

  const scanFn = useCallback(
    async (target = project, clearReport = true) => {
      if (!target) return;
      setLoading(true);
      if (clearReport) setReport(null);
      try {
        const next = await scan(target.id);
        setSessions(next);
        setSelected(preselectOnScan ? pickPaths(next) : []);
      } catch (error) {
        showToast(
          t(`${copyPrefix}.scanFailed` as TranslationKey, {
            error: error instanceof Error ? error.message : String(error),
          }),
          4000,
        );
      } finally {
        setLoading(false);
      }
    },
    [project, scan, pickPaths, preselectOnScan, showToast, t, copyPrefix],
  );

  const toggle = useCallback((sourcePath: string) => {
    setSelected((current) =>
      current.includes(sourcePath)
        ? current.filter((item) => item !== sourcePath)
        : [...current, sourcePath],
    );
  }, []);

  const toggleAll = useCallback(() => {
    const allPaths = pickPaths(sessions);
    setSelected((current) =>
      allPaths.length > 0 && allPaths.every((path) => current.includes(path)) ? [] : allPaths,
    );
  }, [pickPaths, sessions]);

  const importSelected = useCallback(async () => {
    if (!project || selected.length === 0) return null;
    setImporting(true);
    setReport(null);
    try {
      const next = await importSessions(project.id, selected);
      setReport(next);
      await scanFn(project, false);
      await refreshProjectSessions(project.id);
      showToast(
        t(`${copyPrefix}.importDone` as TranslationKey, {
          imported: next.imported,
          failed: next.failed,
        }),
      );
      return next;
    } catch (error) {
      showToast(
        t(`${copyPrefix}.importFailed` as TranslationKey, {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
      return null;
    } finally {
      setImporting(false);
    }
  }, [
    project,
    selected,
    importSessions,
    scanFn,
    refreshProjectSessions,
    showToast,
    t,
    copyPrefix,
  ]);

  const open = useCallback(
    async (next: Project) => {
      setProjectMenu(null);
      setProject(next);
      setReport(null);
      setSessions([]);
      setSelected([]);
      await scanFn(next);
    },
    [setProjectMenu, scanFn],
  );

  const controller = useMemo<ImportController<T, R>>(
    () => ({
      sessions,
      selectedPaths: selected,
      loading,
      importing,
      report,
      error: null as string | null,
      refresh: () => scanFn(),
      toggle,
      toggleAll,
      importSelected,
    }),
    [sessions, selected, loading, importing, report, scanFn, toggle, toggleAll, importSelected],
  );

  return { project, setProject, controller, open };
}
