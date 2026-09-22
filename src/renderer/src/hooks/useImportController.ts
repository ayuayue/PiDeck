import { useCallback, useEffect, useRef, useState } from "react";
import { toggleSelectedPaths } from "../utils/importSessionList";

export type ImportControllerOptions<TSummary, TReport> = {
	projectId: string | null | undefined;
	scan: (projectId: string) => Promise<TSummary[]>;
	importSelected: (projectId: string, sourcePaths: string[]) => Promise<TReport>;
	/** Providers such as OpenCode intentionally start with no selection. */
	selectInitial?: (sessions: TSummary[]) => string[];
	getSourcePath?: (session: TSummary) => string;
};

export type ImportControllerState<TSummary, TReport> = {
	sessions: TSummary[];
	selectedPaths: string[];
	loading: boolean;
	importing: boolean;
	report: TReport | null;
	error: string | null;
	refresh: () => Promise<void>;
	toggle: (sourcePath: string) => void;
	/** 全选 / 取消全选；传入 sourcePaths 时只在该子集内切换（列表搜索后「全选」不应波及被过滤掉的行）。 */
	toggleAll: (sourcePaths?: string[]) => void;
	importSelected: () => Promise<TReport | null>;
	reset: () => void;
};

function errorMessage(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Provider-agnostic import state. Sequence numbers make a late scan/import unable
 * to overwrite a newer project or a freshly closed overlay.
 */
export function useImportController<TSummary, TReport>(options: ImportControllerOptions<TSummary, TReport>): ImportControllerState<TSummary, TReport> {
	const { projectId, scan, importSelected: importApi, selectInitial, getSourcePath } = options;
	const pathOf = useCallback((session: TSummary) => getSourcePath?.(session) ?? (session as { sourcePath?: string }).sourcePath ?? "", [getSourcePath]);
	const [sessions, setSessions] = useState<TSummary[]>([]);
	const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [importing, setImporting] = useState(false);
	const [report, setReport] = useState<TReport | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sequence = useRef(0);
	const mounted = useRef(false);

	const refresh = useCallback(async () => {
		if (!projectId) return;
		const requestSequence = ++sequence.current;
		setLoading(true);
		setError(null);
		try {
			const next = await scan(projectId);
			if (!mounted.current || requestSequence !== sequence.current) return;
			setSessions(next);
			setSelectedPaths(selectInitial?.(next) ?? []);
		} catch (reason) {
			if (mounted.current && requestSequence === sequence.current) setError(errorMessage(reason));
		} finally {
			if (mounted.current && requestSequence === sequence.current) setLoading(false);
		}
	}, [projectId, scan, selectInitial]);

	useEffect(() => {
		// The effect itself owns the lifecycle so StrictMode's setup -> cleanup -> setup
		// replay restores the gate before the second scan is allowed to commit.
		mounted.current = true;
		sequence.current += 1;
		setSessions([]);
		setSelectedPaths([]);
		setReport(null);
		setError(null);
		setLoading(false);
		setImporting(false);
		if (projectId) void refresh();
		return () => {
			mounted.current = false;
			sequence.current += 1;
		};
	}, [projectId, refresh]);

	const toggle = useCallback((sourcePath: string) => {
		setSelectedPaths((current) => (current.includes(sourcePath) ? current.filter((path) => path !== sourcePath) : [...current, sourcePath]));
	}, []);

	const toggleAll = useCallback(
		(sourcePaths?: string[]) => {
			const targets = sourcePaths ?? sessions.map(pathOf).filter(Boolean);
			setSelectedPaths((current) => toggleSelectedPaths(current, targets));
		},
		[pathOf, sessions],
	);

	const importSelected = useCallback(async () => {
		if (!projectId || selectedPaths.length === 0 || importing) return null;
		const requestSequence = ++sequence.current;
		const paths = [...selectedPaths];
		setImporting(true);
		setReport(null);
		setError(null);
		try {
			const next = await importApi(projectId, paths);
			if (!mounted.current || requestSequence !== sequence.current) return null;
			setReport(next);
			return next;
		} catch (reason) {
			if (mounted.current && requestSequence === sequence.current) setError(errorMessage(reason));
			return null;
		} finally {
			if (mounted.current && requestSequence === sequence.current) setImporting(false);
		}
	}, [importApi, importing, projectId, selectedPaths]);

	const reset = useCallback(() => {
		sequence.current += 1;
		setSessions([]);
		setSelectedPaths([]);
		setReport(null);
		setError(null);
		setLoading(false);
		setImporting(false);
	}, []);

	return { sessions, selectedPaths, loading, importing, report, error, refresh, toggle, toggleAll, importSelected, reset };
}
