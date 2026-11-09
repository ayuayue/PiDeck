import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAtom, useSetAtom, useStore } from "jotai";
import { codeOf } from "../../../shared/op";
import type { ProjectFileTarget } from "../../../shared/types";
import { remoteFileDraftsAtom } from "../atoms/remote-file-atoms";
import { updateInstallPreflightTasksAtom } from "../atoms/update-install-preflight";
import type { ProjectServices } from "../services/projectServiceContracts";
import { beginRemoteFileLoad, editRemoteFileDraft, completeRemoteFileSave, remoteFileDraftDirty, remoteFileDraftKey, updateRemoteFileDraft } from "../utils/remoteFileDrafts";

/**
 * 远端文本 IO 单一 owner（Phase B）：读/写都走 `ProjectFileService`。
 *
 * 文本保存的 version 只能来自 `readText` 的返回：缺失/空串由 provider 在触达 IPC 前拒绝
 * （不 statProjectEntry 取 entry 令牌、不重新 open、不自动重试）。服务异常的稳定码直接落进草稿
 * 状态机；未知结果保留草稿并置 blocked，等用户显式重新加载核对。
 *
 * 安装更新会直接终止 Electron：草稿只在渲染层 atom 里，退出即丢。因此有未保存内容时这里把自己
 * 注册成安装前置任务（与本机编辑器 FileDiffViewer 同一张表），任务体就是一次真实写入；
 * 写不成（非 ready、已被未知结果锁住、写失败）一律返回 false 让安装流程停下，绝不谎报已落盘。
 * 已知边界：草稿只在**编辑器挂载期间**被覆盖（卸载后草稿仍留在 atom 里，但这里不再持有写通道）。
 */
export function useRemoteFileDraft(services: ProjectServices, path: string) {
	const [drafts, setDrafts] = useAtom(remoteFileDraftsAtom);
	const store = useStore();
	const key = remoteFileDraftKey(services.projectId, path);
	const draft = drafts.get(key);
	const [loadError, setLoadError] = useState<string>();
	const preflightId = useId();
	const setPreflightTasks = useSetAtom(updateInstallPreflightTasksAtom);
	/** 在途保存：Ctrl+S 与安装前置任务必须等同一趟，安装闸门不能在写入途中放行。 */
	const savePendingRef = useRef<Promise<boolean> | null>(null);
	const projectId = services.projectId;
	const target = useMemo<ProjectFileTarget>(() => ({ projectId, relativePath: path }), [projectId, path]);
	const load = useCallback(
		async (reload = false) => {
			const current = store.get(remoteFileDraftsAtom);
			if (current.has(key) && !reload) return;
			let next: ReturnType<typeof beginRemoteFileLoad>;
			try {
				next = beginRemoteFileLoad(current, projectId, path, reload);
				setLoadError(undefined);
			} catch (error) {
				setLoadError(error instanceof Error ? error.message : "REMOTE_FILE_COMMAND_FAILED");
				return;
			}
			const generation = next.get(key)?.generation;
			if (generation === undefined) return;
			store.set(remoteFileDraftsAtom, next);
			try {
				const document = await services.files.readText(target);
				setDrafts((held) => updateRemoteFileDraft(held, key, generation, (entry) => ({ ...entry, content: document.content, savedContent: document.content, version: document.version ?? "", phase: "ready", errorCode: undefined, blocked: false })));
			} catch (error) {
				const code = codeOf(error, "REMOTE_FILE_COMMAND_FAILED");
				setDrafts((held) => updateRemoteFileDraft(held, key, generation, (entry) => ({ ...entry, phase: "failed", errorCode: code, blocked: true })));
			}
		},
		[key, path, projectId, services, setDrafts, store, target],
	);
	useEffect(() => {
		void load();
	}, [load]);
	const change = useCallback(
		(content: string) => {
			setDrafts((held) => {
				const entry = held.get(key);
				return entry ? updateRemoteFileDraft(held, key, entry.generation, (value) => editRemoteFileDraft(value, content)) : held;
			});
		},
		[key, setDrafts],
	);
	/**
	 * 一次真实写入。返回 true = 已落盘或本来就没有未保存内容；false = 此刻写不了
	 * （非 ready、已被未知结果锁住、写失败）：正文原样保留，由调用方决定是否阻断。
	 */
	const performSave = useCallback(async (): Promise<boolean> => {
		const entry = store.get(remoteFileDraftsAtom).get(key);
		if (!entry || !remoteFileDraftDirty(entry)) return true;
		// blocked = 上一次写结果未知（可能已提交）：不重放，也不谎报已保存。
		if (entry.phase !== "ready" || entry.blocked) return false;
		const { content, version, generation } = entry;
		store.set(remoteFileDraftsAtom, (held) => updateRemoteFileDraft(held, key, generation, (value) => ({ ...value, phase: "saving", errorCode: undefined })));
		try {
			// version 为空串也照常交给 provider：它会在任何 IPC 之前抛 VERSION_REQUIRED，绝不在这里补令牌。
			const receipt = await services.files.writeText(target, content, version);
			setDrafts((held) => updateRemoteFileDraft(held, key, generation, (value) => completeRemoteFileSave(value, content, receipt.version ?? "")));
			return true;
		} catch (error) {
			// 回执丢失可能已经提交：不谎报未写入，也不自动重试。草稿仍完整保留。
			const code = codeOf(error, "REMOTE_FILE_COMMAND_FAILED");
			setDrafts((held) => updateRemoteFileDraft(held, key, generation, (value) => ({ ...value, phase: "ready", blocked: true, errorCode: code })));
			return false;
		}
	}, [key, services, setDrafts, store, target]);
	/** 写操作串行：Ctrl+S 与安装前置任务等同一趟，避免两次写同一份正文。 */
	const save = useCallback((): Promise<boolean> => {
		const pending = savePendingRef.current;
		if (pending) return pending;
		const started = performSave().finally(() => {
			if (savePendingRef.current === started) savePendingRef.current = null;
		});
		savePendingRef.current = started;
		return started;
	}, [performSave]);
	/**
	 * 安装更新/退出前的前置保存：在途写入先等完，再按**最新**草稿决定。
	 * true 只代表「没有未落盘内容」或「已成功写入」；无法确定时返回 false（安装流程据此停在应用内，
	 * 草稿与 blocked/errorCode 都还在，编辑器照常显示失败原因），不静默丢草稿。
	 */
	const flushForInstall = useCallback(async (): Promise<boolean> => {
		const pending = savePendingRef.current;
		if (pending !== null) await pending;
		const entry = store.get(remoteFileDraftsAtom).get(key);
		if (!entry || !remoteFileDraftDirty(entry)) return true;
		if (entry.phase !== "ready" || entry.blocked) return false;
		return save();
	}, [key, save, store]);
	const dirty = draft ? remoteFileDraftDirty(draft) : false;
	// 有未保存草稿才挂前置任务（与本机编辑器同一张表）：无草稿即注销，干净编辑器不改安装流程。
	const flushRef = useRef(flushForInstall);
	flushRef.current = flushForInstall;
	useEffect(() => {
		if (!dirty) return;
		const task = () => flushRef.current();
		setPreflightTasks((current) => {
			const next = new Map(current);
			next.set(preflightId, task);
			return next;
		});
		return () => {
			setPreflightTasks((current) => {
				if (!current.has(preflightId)) return current;
				const next = new Map(current);
				next.delete(preflightId);
				return next;
			});
		};
	}, [dirty, preflightId, setPreflightTasks]);
	return { draft, loadError, change, save, reload: () => load(true), dirty };
}
