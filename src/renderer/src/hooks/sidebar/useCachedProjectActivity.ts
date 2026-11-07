import { useEffect, useRef, useState } from "react";
import type { Project } from "../../../../shared/types/project";
import type { SessionRecord } from "../../../../shared/types/session";

type ListCachedCatalog = (projectId: string, options: { scan: false }) => Promise<readonly Pick<SessionRecord, "updatedAt">[]>;

/** 折叠项目也参与最近活动排序；只读本机 catalog，不触发目录扫描或改写会话缓存。 */
export function useCachedProjectActivity(projects: readonly Pick<Project, "id" | "kind">[], enabled: boolean, listCatalog: ListCachedCatalog, onError: (error: unknown) => void): Readonly<Record<string, number>> {
	const [activity, setActivity] = useState<Record<string, number>>({});
	const reportError = useRef(onError);
	reportError.current = onError;
	const projectIds = projects
		.filter((project) => project.kind !== "chat")
		.map((project) => project.id)
		.sort();
	const projectIdsKey = projectIds.join(",");
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		void Promise.allSettled(
			projectIds.map(async (projectId) => {
				const sessions = await listCatalog(projectId, { scan: false });
				return { projectId, updatedAt: sessions.reduce((latest, session) => Math.max(latest, session.updatedAt), 0) };
			}),
		).then((results) => {
			if (!active) return;
			const next: Record<string, number> = {};
			for (const result of results) {
				if (result.status === "fulfilled") next[result.value.projectId] = result.value.updatedAt;
			}
			setActivity(next);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") reportError.current(failure.reason);
		});
		return () => {
			active = false;
		};
	}, [enabled, projectIdsKey, listCatalog]);
	return activity;
}
