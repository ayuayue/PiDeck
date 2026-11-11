/**
 * Web 端 `/` 菜单数据源（hook）。
 *
 * 优先级与桌面端一致：
 * 1. 会话已有 runtime → 运行时权威命令表（扩展命令 + 提示词模板 + `skill:名称`）；
 * 2. 草稿会话（pi）→ 本地发现：项目提示词模板（`/api/prompt-templates`）+ 已启用技能；
 * 3. 都没有 → 只有 Web 自己接管的两条 builtin（`/new`、`/compact`）。
 *
 * 失败一律降级为空列表：菜单是输入辅助，不能让命令表查询把输入框拖住。
 * 入参用 runtime 的标量身份（而不是 target 对象）：对象每次渲染都是新引用，会让 effect 反复重拉。
 */
import { useEffect, useMemo, useState } from "react";
import type { AgentBackend } from "../../../shared/types";
import { t } from "@/i18n";
import { fetchPromptTemplates, fetchRuntimeCommands, listWebSkills } from "./webApi";
import { mergeWebSlashItems, slashItemsFromCommands, slashItemsFromResources, type WebSlashItem } from "./webSlashCommands";

function builtinItems(): WebSlashItem[] {
	return [
		{ name: "new", description: t("web.slashNewDesc"), source: "builtin" },
		{ name: "compact", description: t("web.slashCompactDesc"), source: "builtin" },
	];
}

export function useWebSlashItems(input: { sessionId?: string; agentId?: string; runtimeGeneration?: number; projectId?: string; backend?: AgentBackend }): WebSlashItem[] {
	const { sessionId, agentId, runtimeGeneration, projectId, backend } = input;
	const [runtimeItems, setRuntimeItems] = useState<WebSlashItem[]>([]);
	const [draftItems, setDraftItems] = useState<WebSlashItem[]>([]);
	const hasRuntime = Boolean(sessionId && agentId);

	// 权威命令表：绑定 runtime 身份（agentId + generation），重启/换进程后重新拉。
	useEffect(() => {
		if (!sessionId || !agentId) {
			setRuntimeItems([]);
			return;
		}
		let cancelled = false;
		// 切会话/换进程时旧命令表先清空：否则新会话打开瞬间会看到上一个会话的命令。
		setRuntimeItems([]);
		void fetchRuntimeCommands(sessionId, { sessionId, agentId, runtimeGeneration: runtimeGeneration ?? 0 })
			.then((commands) => {
				if (!cancelled) setRuntimeItems(slashItemsFromCommands(commands));
			})
			.catch(() => {
				if (!cancelled) setRuntimeItems([]);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId, agentId, runtimeGeneration]);

	// 草稿会话的本地发现。DSH/ACP/生图没有「pi 提示词模板 + 技能」这套命令语义，不猜。
	useEffect(() => {
		const isPi = (backend ?? "pi") === "pi";
		if (hasRuntime || !isPi || !projectId) {
			setDraftItems([]);
			return;
		}
		let cancelled = false;
		void Promise.all([fetchPromptTemplates(projectId), listWebSkills()])
			.then(([prompts, skills]) => {
				if (!cancelled) setDraftItems(slashItemsFromResources(prompts, skills.skills));
			})
			.catch(() => {
				if (!cancelled) setDraftItems([]);
			});
		return () => {
			cancelled = true;
		};
	}, [hasRuntime, backend, projectId]);

	return useMemo(() => mergeWebSlashItems([builtinItems(), runtimeItems.length > 0 ? runtimeItems : draftItems]), [runtimeItems, draftItems]);
}
