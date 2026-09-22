import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBackend, Project, SessionRecord } from "../../../shared/types";
import type { QuickTaskErrorCode, QuickTaskState } from "../../../shared/types/quickTask";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";
import { quickTaskIntent, sameQuickTaskPath } from "../utils/quickTaskIntent";

/** 主进程只回稳定错误码，文案在渲染层映射——用户可见文本一律走 i18n，不显示 IPC 技术串。 */
function quickTaskErrorText(code: QuickTaskErrorCode): string {
	return t(`quickTask.error.${code}`);
}

/** Owns compact task selection; launch requests never submit prompts or replace an existing draft. */
export function useQuickTask(options: {
	ready: boolean;
	backend: AgentBackend;
	upsertSession: (session: SessionRecord) => void;
	selectSession: (projectId: string, sessionId: string) => void;
	registerSession: (sessionId: string) => void;
	refreshProjects: () => Promise<unknown>;
	getSessionRecord: (sessionId: string) => SessionRecord | undefined;
}) {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	/** 紧凑模式的根节点：聚焦输入框时用它限定查询范围，避免生产逻辑依赖 data-testid 这类测试契约。 */
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const [launch, setLaunch] = useState<QuickTaskState>({ active: false, requestId: 0 });
	const [session, setSession] = useState<SessionRecord | null>(null);
	const sessionRef = useRef<SessionRecord | null>(null);
	const [path, setPath] = useState("");
	const pathRef = useRef("");
	const [pendingPath, setPendingPath] = useState<string | null>(null);
	const [needsProject, setNeedsProject] = useState(false);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const handled = useRef(0);
	const mounted = useRef(true);
	const activeRef = useRef(false);
	useEffect(() => {
		mounted.current = true;
		let receivedEvent = false;
		const unsubscribe = api.quickTask.onChanged((state) => {
			receivedEvent = true;
			activeRef.current = state.active;
			setLaunch(state);
		});
		void api.quickTask
			.getState()
			.then((state) => {
				if (mounted.current && !receivedEvent) {
					activeRef.current = state.active;
					setLaunch(state);
				}
			})
			.catch(() => {
				if (mounted.current) setError(t("quickTask.error.unknown"));
			});
		return () => {
			mounted.current = false;
			unsubscribe();
		};
	}, []);

	const focusSession = useCallback((record: SessionRecord) => {
		optionsRef.current.selectSession(record.projectId, record.id);
		optionsRef.current.registerSession(record.id);
	}, []);

	const prepare = useCallback(
		async (targetPath: string, add: boolean) => {
			if (busyRef.current) return;
			busyRef.current = true;
			setBusy(true);
			setError(null);
			try {
				const projects = await api.projects.list();
				let project: Project | undefined = projects.find((item) => sameQuickTaskPath(item.path, targetPath));
				if (!project && !add) {
					setNeedsProject(true);
					return;
				}
				if (!project) {
					project = await api.projects.addByPath(targetPath);
					await optionsRef.current.refreshProjects();
				}
				// createDraft persists identity only. Normal Composer owns the first explicit send/runtime start.
				const record = await api.sessions.createDraft({ projectId: project.id, title: project.name, backend: optionsRef.current.backend });
				optionsRef.current.upsertSession(record);
				sessionRef.current = record;
				setSession(record);
				setNeedsProject(false);
				// A slow project/catalog write may finish after Close: retain the draft, but never steal focus.
				if (activeRef.current) focusSession(record);
			} catch {
				// 目录/项目/草稿任一环节失败对用户都是同一件事：这条任务没准备好，给通用文案而不是 IPC 原始串。
				setError(t("quickTask.error.unknown"));
			} finally {
				busyRef.current = false;
				if (mounted.current) setBusy(false);
			}
		},
		[focusSession],
	);

	useEffect(() => {
		if (!launch.active || !options.ready || !launch.path || busy || handled.current === launch.requestId) return;
		handled.current = launch.requestId;
		if (launch.error) {
			setError(`${quickTaskErrorText(launch.error)} ${launch.path}`);
			return;
		}
		setError(null);
		if (sessionRef.current && !optionsRef.current.getSessionRecord(sessionRef.current.id)) {
			// A task deleted in the workbench must not be revived by a subsequent shell invocation.
			sessionRef.current = null;
			setSession(null);
			pathRef.current = "";
		}
		const intent = quickTaskIntent(pathRef.current, launch.path);
		if (intent !== "prepare") {
			// The existing composer belongs to its session. A new shell invocation never clears it.
			if (sessionRef.current) focusSession(sessionRef.current);
			if (intent === "offer-new") setPendingPath(launch.path);
			return;
		}
		pathRef.current = launch.path;
		setPath(launch.path);
		void prepare(launch.path, false);
	}, [launch, options.ready, busy, prepare, focusSession]);

	useEffect(() => {
		if (!launch.active || !session || busy) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const focus = (attempt = 0) => {
			// 只在紧凑模式自己的根节点内查找，不再用 data-testid 当选择器（testid 属于测试契约）。
			const input = surfaceRef.current?.querySelector<HTMLElement>(".composer-box .rich-input, .composer-box textarea");
			if (input) input.focus();
			else if (attempt < 10) timer = setTimeout(() => focus(attempt + 1), 50);
		};
		const frame = requestAnimationFrame(() => focus());
		return () => {
			cancelAnimationFrame(frame);
			if (timer) clearTimeout(timer);
		};
	}, [launch.active, launch.requestId, session, busy]);

	const startNew = useCallback(() => {
		if (busyRef.current) return;
		const targetPath = pendingPath ?? pathRef.current;
		if (!targetPath) return;
		// Explicit New keeps the previous session and its draft in the normal catalog/tabs.
		pathRef.current = targetPath;
		setPath(targetPath);
		setPendingPath(null);
		sessionRef.current = null;
		setSession(null);
		void prepare(targetPath, false);
	}, [pendingPath, prepare]);
	const exit = useCallback(() => {
		activeRef.current = false;
		if (sessionRef.current) focusSession(sessionRef.current);
		void api.quickTask.exit().catch(() => setError(t("quickTask.error.unknown")));
	}, [focusSession]);
	return { surfaceRef, active: launch.active, session, path: path || launch.path || "", pendingPath, needsProject, busy, error, canRetry: Boolean(path), startNew, exit, keepCurrent: () => setPendingPath(null), addProject: () => void prepare(pathRef.current, true), retry: () => void prepare(pathRef.current, false) };
}
