import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import type { ResourceImportCandidate, ResourceImportKind, ResourceImportReport, ResourceImportScanResult, ResourceImportTarget } from "../../../shared/types/resourceImport";

// Keep the renderer on the same restricted desktop bridge used elsewhere.  The hook
// never receives a raw filesystem path or an MCP definition from its caller.
const api = desktopApi;

export type ResourceImportProject = { id: string; name: string; kind?: string };

export type ResourceImportTargetOption = {
	value: string;
	label: string;
	target: ResourceImportTarget;
};

type UseResourceImportDialogOptions = {
	kind: ResourceImportKind;
	sourceProjectId?: string;
	/** 技能导入的项目目标数据源；MCP 导入只写全局层，不需要项目列表。 */
	projects?: ResourceImportProject[];
	fixedProjectId?: string;
	open?: boolean;
	onImported?: () => void;
};

/** A candidate is selectable only when static conversion and target conflict checks pass. */
export function canImportResource(candidate: ResourceImportCandidate): boolean {
	return candidate.importable && !candidate.conflict;
}

export function targetMatches(left: ResourceImportTarget, right: ResourceImportTarget): boolean {
	if (left.scope !== right.scope || left.locationId !== right.locationId) return false;
	if (left.scope === "global" || right.scope === "global") return true;
	return left.projectId === right.projectId;
}

/**
 * Owns the dialog's scan/apply state machine.  Keeping async work here lets the
 * component remain a pure view of the currently selected target and candidates.
 */
export function useResourceImportDialog(options: UseResourceImportDialogOptions) {
	const [open, setOpen] = useState(Boolean(options.open));
	const [target, setTarget] = useState<ResourceImportTarget>(() => (options.kind === "skill" && options.fixedProjectId ? { scope: "project", projectId: options.fixedProjectId, locationId: "project-pi" } : { scope: "global", locationId: "pi-global" }));
	const [scan, setScan] = useState<ResourceImportScanResult | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(false);
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [report, setReport] = useState<ResourceImportReport | null>(null);
	const requestGeneration = useRef(0);
	const onImportedRef = useRef(options.onImported);

	useEffect(() => {
		onImportedRef.current = options.onImported;
	}, [options.onImported]);

	// MCP 导入只写全局层：配置页已收敛为全局作用域，写进项目 .pi/mcp.json 的内容在页面里看不到。
	const availableProjects = useMemo(() => (options.kind === "skill" ? (options.projects ?? []).filter((project) => project.kind !== "chat" && (!options.fixedProjectId || project.id === options.fixedProjectId)) : []), [options.fixedProjectId, options.kind, options.projects]);
	const targetOptionEntries = useMemo(() => {
		const entries: ResourceImportTargetOption[] =
			options.kind === "mcp"
				? [
						{
							value: "global:pi-global",
							label: t("config.import.targetGlobalMcp"),
							target: { scope: "global", locationId: "pi-global" },
						},
					]
				: options.fixedProjectId
					? []
					: [
							{
								value: "global:pi-global",
								label: t("config.import.targetPiSkills"),
								target: { scope: "global", locationId: "pi-global" },
							},
							{
								value: "global:agents-global",
								label: t("config.import.targetAgentsSkills"),
								target: { scope: "global", locationId: "agents-global" },
							},
						];
		for (const project of availableProjects) {
			entries.push(
				{
					value: `project:${project.id}:project-pi`,
					label: `${project.name} · ${t("config.import.targetProjectPiSkills")}`,
					target: { scope: "project", projectId: project.id, locationId: "project-pi" },
				},
				{
					value: `project:${project.id}:project-agents`,
					label: `${project.name} · ${t("config.import.targetProjectAgentsSkills")}`,
					target: { scope: "project", projectId: project.id, locationId: "project-agents" },
				},
			);
		}
		return entries;
	}, [availableProjects, options.fixedProjectId, options.kind]);

	const targetOptions = useMemo(() => targetOptionEntries.map(({ value, label }) => ({ value, label })), [targetOptionEntries]);
	const selectedTargetEntry = useMemo(() => targetOptionEntries.find((entry) => targetMatches(entry.target, target)) ?? targetOptionEntries[0], [target, targetOptionEntries]);
	const selectedTargetValue = selectedTargetEntry?.value ?? "";
	// Option entries are recreated when the project list is refreshed. Their stable
	// value, rather than object identity, determines whether a new scan is needed.
	const selectedTargetKey = selectedTargetEntry?.value ?? "";
	// Resolve the selectable entry at submit time so a removed project cannot leave a
	// stale target object in an IPC request.
	const effectiveTarget = selectedTargetEntry?.target ?? target;

	const runScan = useCallback(
		async (nextTarget: ResourceImportTarget) => {
			const generation = ++requestGeneration.current;
			setLoading(true);
			setError(null);
			setSelected(new Set());
			setReport(null);
			try {
				const response = await api.resourceImport.scan({
					kind: options.kind,
					sourceProjectId: options.sourceProjectId,
					target: nextTarget,
				});
				if (generation !== requestGeneration.current) return;
				if (!response.ok) throw new Error(response.error.message);
				setScan(response.result);
			} catch (caught) {
				if (generation !== requestGeneration.current) return;
				setScan(null);
				setError(caught instanceof Error ? caught.message : String(caught));
			} finally {
				if (generation === requestGeneration.current) setLoading(false);
			}
		},
		[options.kind, options.sourceProjectId],
	);

	useEffect(() => {
		if (options.open === undefined) return;
		if (!options.open) {
			// A controlled parent can close the dialog while a scan is in flight. Invalidate
			// that request so it cannot repopulate state after the dialog has been dismissed.
			requestGeneration.current += 1;
			setLoading(false);
			setScan(null);
			setSelected(new Set());
			setReport(null);
			setError(null);
		}
		setOpen(options.open);
	}, [options.open]);

	useEffect(() => {
		const firstTarget = targetOptionEntries[0]?.target;
		if (firstTarget && !targetOptionEntries.some((entry) => targetMatches(entry.target, target))) {
			setTarget(firstTarget);
			if (open) {
				setScan(null);
				setSelected(new Set());
				setReport(null);
			}
		}
	}, [open, target, targetOptionEntries]);

	useEffect(() => {
		if (!open || !selectedTargetEntry) return;
		setScan(null);
		setReport(null);
		setError(null);
		setSelected(new Set());
		void runScan(selectedTargetEntry.target);
	}, [open, runScan, selectedTargetKey]);

	const selectTarget = useCallback(
		(value: string) => {
			const next = targetOptionEntries.find((entry) => entry.value === value)?.target;
			if (next) setTarget(next);
		},
		[targetOptionEntries],
	);

	const toggleAll = useCallback(
		(checked: boolean) => {
			if (!scan) return;
			setSelected(checked ? new Set(scan.candidates.filter(canImportResource).map((candidate) => candidate.candidateId)) : new Set());
		},
		[scan],
	);

	const toggleCandidate = useCallback((candidateId: string, checked: boolean) => {
		setSelected((current) => {
			const next = new Set(current);
			if (checked) next.add(candidateId);
			else next.delete(candidateId);
			return next;
		});
	}, []);

	const apply = useCallback(async () => {
		if (!scan || selected.size === 0 || applying) return;
		setApplying(true);
		setError(null);
		try {
			const response = await api.resourceImport.apply({
				scanId: scan.scanId,
				target: effectiveTarget,
				candidateIds: [...selected],
			});
			if (!response.ok) throw new Error(response.error.message);
			setReport(response.result);
			setSelected(new Set());
			onImportedRef.current?.();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setApplying(false);
		}
	}, [applying, effectiveTarget, scan, selected]);

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (applying) return;
			if (!nextOpen) {
				// Ignore any late scan response after cancel and return the trigger to an idle
				// state, rather than leaving it disabled until the old request resolves.
				requestGeneration.current += 1;
				setLoading(false);
				setScan(null);
				setSelected(new Set());
				setReport(null);
			}
			setOpen(nextOpen);
		},
		[applying],
	);

	return {
		open,
		openDialog: () => setOpen(true),
		handleOpenChange,
		targetOptions,
		selectedTargetValue,
		selectTarget,
		effectiveTarget,
		scan,
		selected,
		toggleAll,
		toggleCandidate,
		loading,
		applying,
		error,
		report,
		apply,
	};
}
