import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtom, useStore } from "jotai";
import { codeOf } from "../../../shared/op";
import type { ProjectFileTarget } from "../../../shared/types";
import { remoteFileDraftsAtom } from "../atoms/remote-file-atoms";
import type { ProjectServices } from "../services/projectServiceContracts";
import { beginRemoteFileLoad, editRemoteFileDraft, completeRemoteFileSave, remoteFileDraftDirty, remoteFileDraftKey, updateRemoteFileDraft } from "../utils/remoteFileDrafts";

/**
 * 远端文本 IO 单一 owner（Phase B）：读/写都走 `ProjectFileService`。
 *
 * 文本保存的 version 只能来自 `readText` 的返回：缺失/空串由 provider 在触达 IPC 前拒绝
 * （不 statProjectEntry 取 entry 令牌、不重新 open、不自动重试）。服务异常的稳定码直接落进草稿
 * 状态机；未知结果保留草稿并置 blocked，等用户显式重新加载核对。
 */
export function useRemoteFileDraft(services: ProjectServices, path: string) {
	const [drafts, setDrafts] = useAtom(remoteFileDraftsAtom);
	const store = useStore();
	const key = remoteFileDraftKey(services.projectId, path);
	const draft = drafts.get(key);
	const [loadError, setLoadError] = useState<string>();
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
	const save = useCallback(async () => {
		const entry = store.get(remoteFileDraftsAtom).get(key);
		if (!entry || entry.phase !== "ready" || entry.blocked || !remoteFileDraftDirty(entry)) return;
		const { content, version, generation } = entry;
		store.set(remoteFileDraftsAtom, (held) => updateRemoteFileDraft(held, key, generation, (value) => ({ ...value, phase: "saving", errorCode: undefined })));
		try {
			// version 为空串也照常交给 provider：它会在任何 IPC 之前抛 VERSION_REQUIRED，绝不在这里补令牌。
			const receipt = await services.files.writeText(target, content, version);
			setDrafts((held) => updateRemoteFileDraft(held, key, generation, (value) => completeRemoteFileSave(value, content, receipt.version ?? "")));
		} catch (error) {
			// 回执丢失可能已经提交：不谎报未写入，也不自动重试。草稿仍完整保留。
			const code = codeOf(error, "REMOTE_FILE_COMMAND_FAILED");
			setDrafts((held) => updateRemoteFileDraft(held, key, generation, (value) => ({ ...value, phase: "ready", blocked: true, errorCode: code })));
		}
	}, [key, services, setDrafts, store, target]);
	return { draft, loadError, change, save, reload: () => load(true), dirty: draft ? remoteFileDraftDirty(draft) : false };
}
