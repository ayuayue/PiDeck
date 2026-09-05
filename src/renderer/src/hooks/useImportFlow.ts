import { useCallback, useMemo, useState } from "react";
import type {
  CodexImportReport,
  CodexSessionSummary,
  ClaudeImportReport,
  ClaudeSessionSummary,
  OpenCodeImportReport,
  OpenCodeSessionSummary,
  ZCodeImportReport,
  ZCodeSessionSummary,
  Project,
} from "../../../shared/types";

function getSelectableCodexImportPaths(sessions: CodexSessionSummary[]) {
  return sessions
    .filter((session) => session.threadSource !== "subagent")
    .map((session) => session.sourcePath);
}

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

export interface UseImportFlowInput {
  setProjectMenu: (menu: any) => void;
  refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<any>;
  showToast: (message: string, duration?: number) => void;
  /** API: scan Codex sessions */
  scanCodexSessions: (projectId: string) => Promise<CodexSessionSummary[]>;
  /** API: import Codex sessions */
  importCodexSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<CodexImportReport>;
  /** API: scan Claude sessions */
  scanClaudeSessions: (projectId: string) => Promise<ClaudeSessionSummary[]>;
  /** API: import Claude sessions */
  importClaudeSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<ClaudeImportReport>;
  /** API: scan OpenCode sessions */
  scanOpenCodeSessions: (projectId: string) => Promise<OpenCodeSessionSummary[]>;
  /** API: import OpenCode sessions */
  importOpenCodeSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<OpenCodeImportReport>;
  /** API: scan ZCode sessions */
  scanZCodeSessions: (projectId: string) => Promise<ZCodeSessionSummary[]>;
  /** API: import ZCode sessions */
  importZCodeSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<ZCodeImportReport>;
  /** Translation function */
  t: (...args: any[]) => string;
}

export interface UseImportFlowOutput {
  codexImportProject: Project | null;
  setCodexImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
  claudeImportProject: Project | null;
  setClaudeImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
  openCodeImportProject: Project | null;
  setOpenCodeImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
  zcodeImportProject: Project | null;
  setZcodeImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
  codexImportController: ImportController<CodexSessionSummary, CodexImportReport>;
  claudeImportController: ImportController<ClaudeSessionSummary, ClaudeImportReport>;
  openCodeImportController: ImportController<OpenCodeSessionSummary, OpenCodeImportReport>;
  zcodeImportController: ImportController<ZCodeSessionSummary, ZCodeImportReport>;
  openCodexImport: (project: Project) => Promise<void>;
  openClaudeImport: (project: Project) => Promise<void>;
  openOpenCodeImport: (project: Project) => Promise<void>;
  openZCodeImport: (project: Project) => Promise<void>;
}

export function useImportFlow(input: UseImportFlowInput): UseImportFlowOutput {
  const {
    setProjectMenu,
    refreshProjectSessions,
    showToast,
    scanCodexSessions: scanCodexApi,
    importCodexSessionsApi,
    scanClaudeSessions: scanClaudeApi,
    importClaudeSessionsApi,
    scanOpenCodeSessions: scanOpenCodeApi,
    importOpenCodeSessionsApi,
    scanZCodeSessions: scanZCodeApi,
    importZCodeSessionsApi,
    t,
  } = input;

  // ── Codex import state ──
  const [codexImportProject, setCodexImportProject] = useState<Project | null>(null);
  const [codexImportSessions, setCodexImportSessions] = useState<CodexSessionSummary[]>([]);
  const [codexImportSelected, setCodexImportSelected] = useState<string[]>([]);
  const [codexImportLoading, setCodexImportLoading] = useState(false);
  const [codexImportRunning, setCodexImportRunning] = useState(false);
  const [codexImportReport, setCodexImportReport] = useState<CodexImportReport | null>(null);

  // ── Claude import state ──
  const [claudeImportProject, setClaudeImportProject] = useState<Project | null>(null);
  const [claudeImportSessions, setClaudeImportSessions] = useState<ClaudeSessionSummary[]>([]);
  const [claudeImportSelected, setClaudeImportSelected] = useState<string[]>([]);
  const [claudeImportLoading, setClaudeImportLoading] = useState(false);
  const [claudeImportRunning, setClaudeImportRunning] = useState(false);
  const [claudeImportReport, setClaudeImportReport] = useState<ClaudeImportReport | null>(null);

  // ── OpenCode import state ──
  const [openCodeImportProject, setOpenCodeImportProject] = useState<Project | null>(null);
  const [openCodeImportSessions, setOpenCodeImportSessions] = useState<OpenCodeSessionSummary[]>([]);
  const [openCodeImportSelected, setOpenCodeImportSelected] = useState<string[]>([]);
  const [openCodeImportLoading, setOpenCodeImportLoading] = useState(false);
  const [openCodeImportRunning, setOpenCodeImportRunning] = useState(false);
  const [openCodeImportReport, setOpenCodeImportReport] = useState<OpenCodeImportReport | null>(null);

  // ── ZCode import state ──
  const [zcodeImportProject, setZcodeImportProject] = useState<Project | null>(null);
  const [zcodeImportSessions, setZcodeImportSessions] = useState<ZCodeSessionSummary[]>([]);
  const [zcodeImportSelected, setZcodeImportSelected] = useState<string[]>([]);
  const [zcodeImportLoading, setZcodeImportLoading] = useState(false);
  const [zcodeImportRunning, setZcodeImportRunning] = useState(false);
  const [zcodeImportReport, setZcodeImportReport] = useState<ZCodeImportReport | null>(null);

  // ── Codex functions ──
  const scanCodexSessionsFn = useCallback(
    async (project = codexImportProject, clearReport = true) => {
      if (!project) return;
      setCodexImportLoading(true);
      if (clearReport) setCodexImportReport(null);
      try {
        const next = await scanCodexApi(project.id);
        setCodexImportSessions(next);
        setCodexImportSelected(getSelectableCodexImportPaths(next));
      } catch (error) {
        showToast(t("codex.scanFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
      } finally {
        setCodexImportLoading(false);
      }
    },
    [codexImportProject, scanCodexApi, showToast, t],
  );

  const toggleCodexSession = useCallback((sourcePath: string) => {
    setCodexImportSelected((current) =>
      current.includes(sourcePath) ? current.filter((item) => item !== sourcePath) : [...current, sourcePath],
    );
  }, []);

  const toggleAllCodexSessions = useCallback(() => {
    const allPaths = getSelectableCodexImportPaths(codexImportSessions);
    setCodexImportSelected((current) =>
      allPaths.length > 0 && allPaths.every((path) => current.includes(path)) ? [] : allPaths,
    );
  }, [codexImportSessions]);

  const importCodexSessionsFn = useCallback(async () => {
    if (!codexImportProject || codexImportSelected.length === 0) return null;
    setCodexImportRunning(true);
    setCodexImportReport(null);
    try {
      const report = await importCodexSessionsApi(codexImportProject.id, codexImportSelected);
      setCodexImportReport(report);
      await scanCodexSessionsFn(codexImportProject, false);
      await refreshProjectSessions(codexImportProject.id);
      showToast(t("codex.importDone", { imported: report.imported, failed: report.failed }));
      return report;
    } catch (error) {
      showToast(t("codex.importFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
      return null;
    } finally {
      setCodexImportRunning(false);
    }
  }, [codexImportProject, codexImportSelected, importCodexSessionsApi, scanCodexSessionsFn, refreshProjectSessions, showToast, t]);

  const openCodexImport = useCallback(async (project: Project) => {
    setProjectMenu(null);
    setCodexImportProject(project);
    setCodexImportReport(null);
    setCodexImportSessions([]);
    setCodexImportSelected([]);
    await scanCodexSessionsFn(project);
  }, [setProjectMenu, scanCodexSessionsFn]);

  // ── Claude functions ──
  const scanClaudeSessionsFn = useCallback(
    async (project = claudeImportProject, clearReport = true) => {
      if (!project) return;
      setClaudeImportLoading(true);
      if (clearReport) setClaudeImportReport(null);
      try {
        const next = await scanClaudeApi(project.id);
        setClaudeImportSessions(next);
        setClaudeImportSelected([]);
      } catch (error) {
        showToast(t("claude.scanFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
      } finally {
        setClaudeImportLoading(false);
      }
    },
    [claudeImportProject, scanClaudeApi, showToast, t],
  );

  const toggleClaudeSession = useCallback((sourcePath: string) => {
    setClaudeImportSelected((current) =>
      current.includes(sourcePath) ? current.filter((item) => item !== sourcePath) : [...current, sourcePath],
    );
  }, []);

  const toggleAllClaudeSessions = useCallback(() => {
    const allPaths = claudeImportSessions.map((session) => session.sourcePath);
    setClaudeImportSelected((current) =>
      allPaths.length > 0 && allPaths.every((path) => current.includes(path)) ? [] : allPaths,
    );
  }, [claudeImportSessions]);

  const importClaudeSessionsFn = useCallback(async () => {
    if (!claudeImportProject || claudeImportSelected.length === 0) return null;
    setClaudeImportRunning(true);
    setClaudeImportReport(null);
    try {
      const report = await importClaudeSessionsApi(claudeImportProject.id, claudeImportSelected);
      setClaudeImportReport(report);
      await scanClaudeSessionsFn(claudeImportProject, false);
      await refreshProjectSessions(claudeImportProject.id);
      showToast(t("claude.importDone", { imported: report.imported, failed: report.failed }));
      return report;
    } catch (error) {
      showToast(t("claude.importFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
      return null;
    } finally {
      setClaudeImportRunning(false);
    }
  }, [claudeImportProject, claudeImportSelected, importClaudeSessionsApi, scanClaudeSessionsFn, refreshProjectSessions, showToast, t]);

  const openClaudeImport = useCallback(async (project: Project) => {
    setProjectMenu(null);
    setClaudeImportProject(project);
    setClaudeImportReport(null);
    setClaudeImportSessions([]);
    setClaudeImportSelected([]);
    await scanClaudeSessionsFn(project);
  }, [setProjectMenu, scanClaudeSessionsFn]);

  // ── OpenCode functions ──
  const scanOpenCodeSessionsFn = useCallback(
    async (project = openCodeImportProject, clearReport = true) => {
      if (!project) return;
      setOpenCodeImportLoading(true);
      if (clearReport) setOpenCodeImportReport(null);
      try {
        const next = await scanOpenCodeApi(project.id);
        setOpenCodeImportSessions(next);
        setOpenCodeImportSelected([]);
      } catch (error) {
        showToast(t("opencode.scanFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
      } finally {
        setOpenCodeImportLoading(false);
      }
    },
    [openCodeImportProject, scanOpenCodeApi, showToast, t],
  );

  const toggleOpenCodeSession = useCallback((sourcePath: string) => {
    setOpenCodeImportSelected((current) =>
      current.includes(sourcePath) ? current.filter((item) => item !== sourcePath) : [...current, sourcePath],
    );
  }, []);

  const toggleAllOpenCodeSessions = useCallback(() => {
    const allPaths = openCodeImportSessions.map((session) => session.sourcePath);
    setOpenCodeImportSelected((current) =>
      allPaths.length > 0 && allPaths.every((path) => current.includes(path)) ? [] : allPaths,
    );
  }, [openCodeImportSessions]);

  const importOpenCodeSessionsFn = useCallback(async () => {
    if (!openCodeImportProject || openCodeImportSelected.length === 0) return null;
    setOpenCodeImportRunning(true);
    setOpenCodeImportReport(null);
    try {
      const report = await importOpenCodeSessionsApi(openCodeImportProject.id, openCodeImportSelected);
      setOpenCodeImportReport(report);
      await scanOpenCodeSessionsFn(openCodeImportProject, false);
      await refreshProjectSessions(openCodeImportProject.id);
      showToast(t("opencode.importDone", { imported: report.imported, failed: report.failed }));
      return report;
    } catch (error) {
      showToast(t("opencode.importFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
      return null;
    } finally {
      setOpenCodeImportRunning(false);
    }
  }, [openCodeImportProject, openCodeImportSelected, importOpenCodeSessionsApi, scanOpenCodeSessionsFn, refreshProjectSessions, showToast, t]);

  const openOpenCodeImport = useCallback(async (project: Project) => {
    setProjectMenu(null);
    setOpenCodeImportProject(project);
    setOpenCodeImportReport(null);
    setOpenCodeImportSessions([]);
    setOpenCodeImportSelected([]);
    await scanOpenCodeSessionsFn(project);
  }, [setProjectMenu, scanOpenCodeSessionsFn]);

  // ── ZCode functions ──
  const scanZCodeSessionsFn = useCallback(
    async (project = zcodeImportProject, clearReport = true) => {
      if (!project) return;
      setZcodeImportLoading(true);
      if (clearReport) setZcodeImportReport(null);
      try {
        const next = await scanZCodeApi(project.id);
        setZcodeImportSessions(next);
        setZcodeImportSelected([]);
      } catch (error) {
        showToast(t("zcode.scanFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
      } finally {
        setZcodeImportLoading(false);
      }
    },
    [zcodeImportProject, scanZCodeApi, showToast, t],
  );

  const toggleZCodeSession = useCallback((sourcePath: string) => {
    setZcodeImportSelected((current) =>
      current.includes(sourcePath) ? current.filter((item) => item !== sourcePath) : [...current, sourcePath],
    );
  }, []);

  const toggleAllZCodeSessions = useCallback(() => {
    const allPaths = zcodeImportSessions.map((session) => session.sourcePath);
    setZcodeImportSelected((current) =>
      allPaths.length > 0 && allPaths.every((path) => current.includes(path)) ? [] : allPaths,
    );
  }, [zcodeImportSessions]);

  const importZCodeSessionsFn = useCallback(async () => {
    if (!zcodeImportProject || zcodeImportSelected.length === 0) return null;
    setZcodeImportRunning(true);
    setZcodeImportReport(null);
    try {
      const report = await importZCodeSessionsApi(zcodeImportProject.id, zcodeImportSelected);
      setZcodeImportReport(report);
      await scanZCodeSessionsFn(zcodeImportProject, false);
      await refreshProjectSessions(zcodeImportProject.id);
      showToast(t("zcode.importDone", { imported: report.imported, failed: report.failed }));
      return report;
    } catch (error) {
      showToast(t("zcode.importFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
      return null;
    } finally {
      setZcodeImportRunning(false);
    }
  }, [zcodeImportProject, zcodeImportSelected, importZCodeSessionsApi, scanZCodeSessionsFn, refreshProjectSessions, showToast, t]);

  const openZCodeImport = useCallback(async (project: Project) => {
    setProjectMenu(null);
    setZcodeImportProject(project);
    setZcodeImportReport(null);
    setZcodeImportSessions([]);
    setZcodeImportSelected([]);
    await scanZCodeSessionsFn(project);
  }, [setProjectMenu, scanZCodeSessionsFn]);

  // ── Controllers ──
  const codexImportController = useMemo(() => ({
    sessions: codexImportSessions,
    selectedPaths: codexImportSelected,
    loading: codexImportLoading,
    importing: codexImportRunning,
    report: codexImportReport,
    error: null as string | null,
    refresh: () => scanCodexSessionsFn(),
    toggle: toggleCodexSession,
    toggleAll: toggleAllCodexSessions,
    importSelected: importCodexSessionsFn,
  }), [codexImportSessions, codexImportSelected, codexImportLoading, codexImportRunning, codexImportReport, scanCodexSessionsFn, toggleCodexSession, toggleAllCodexSessions, importCodexSessionsFn]);

  const claudeImportController = useMemo(() => ({
    sessions: claudeImportSessions,
    selectedPaths: claudeImportSelected,
    loading: claudeImportLoading,
    importing: claudeImportRunning,
    report: claudeImportReport,
    error: null as string | null,
    refresh: () => scanClaudeSessionsFn(),
    toggle: toggleClaudeSession,
    toggleAll: toggleAllClaudeSessions,
    importSelected: importClaudeSessionsFn,
  }), [claudeImportSessions, claudeImportSelected, claudeImportLoading, claudeImportRunning, claudeImportReport, scanClaudeSessionsFn, toggleClaudeSession, toggleAllClaudeSessions, importClaudeSessionsFn]);

  const openCodeImportController = useMemo(() => ({
    sessions: openCodeImportSessions,
    selectedPaths: openCodeImportSelected,
    loading: openCodeImportLoading,
    importing: openCodeImportRunning,
    report: openCodeImportReport,
    error: null as string | null,
    refresh: () => scanOpenCodeSessionsFn(),
    toggle: toggleOpenCodeSession,
    toggleAll: toggleAllOpenCodeSessions,
    importSelected: importOpenCodeSessionsFn,
  }), [openCodeImportSessions, openCodeImportSelected, openCodeImportLoading, openCodeImportRunning, openCodeImportReport, scanOpenCodeSessionsFn, toggleOpenCodeSession, toggleAllOpenCodeSessions, importOpenCodeSessionsFn]);

  const zcodeImportController = useMemo(() => ({
    sessions: zcodeImportSessions,
    selectedPaths: zcodeImportSelected,
    loading: zcodeImportLoading,
    importing: zcodeImportRunning,
    report: zcodeImportReport,
    error: null as string | null,
    refresh: () => scanZCodeSessionsFn(),
    toggle: toggleZCodeSession,
    toggleAll: toggleAllZCodeSessions,
    importSelected: importZCodeSessionsFn,
  }), [zcodeImportSessions, zcodeImportSelected, zcodeImportLoading, zcodeImportRunning, zcodeImportReport, scanZCodeSessionsFn, toggleZCodeSession, toggleAllZCodeSessions, importZCodeSessionsFn]);

  return {
    codexImportProject,
    setCodexImportProject,
    claudeImportProject,
    setClaudeImportProject,
    openCodeImportProject,
    setOpenCodeImportProject,
    zcodeImportProject,
    setZcodeImportProject,
    codexImportController,
    claudeImportController,
    openCodeImportController,
    zcodeImportController,
    openCodexImport,
    openClaudeImport,
    openOpenCodeImport,
    openZCodeImport,
  };
}
