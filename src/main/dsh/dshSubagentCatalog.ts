/** 0.2 的子代投影是目录，不含运行状态；合并官方会话摘要，保持冷读。 */
export type DshSubagentView = {
	id: string;
	label?: string;
	activity: "running" | "inactive";
	hasChildren: boolean;
	mode: "one-shot" | "continuable";
	kind: "child" | "diagnostic";
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 缺失父会话返回空目录；无效成功响应报错，不能伪装为没有子代理。 */
export function readSubagentCatalog(value: unknown): Record<string, unknown>[] {
	if (value === null) return [];
	if (!isRecord(value) || !isRecord(value.values) || !Array.isArray(value.values.subagentCatalog)) throw new Error("DSH subagent catalog is unavailable");
	return value.values.subagentCatalog.filter(isRecord);
}

/** 未知模式呈现为诊断项，禁止把它当成可读取的 one-shot 会话。 */
export function projectSubagentCatalog(catalog: Record<string, unknown>[], value: unknown): DshSubagentView[] {
	if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("DSH session summaries are unavailable");
	const sessions = value.items.filter(isRecord);
	return catalog.flatMap((entry): DshSubagentView[] => {
		if (typeof entry.id !== "string" || !entry.id) return [];
		const session = sessions.find((item) => item.sessionId === entry.id);
		return [
			{
				id: entry.id,
				...(typeof entry.label === "string" ? { label: entry.label } : {}),
				activity: session?.running === true ? "running" : "inactive",
				hasChildren: sessions.some((item) => item.parentSessionId === entry.id && item.origin === "subagent"),
				mode: entry.mode === "continuable" ? "continuable" : "one-shot",
				kind: entry.mode === "continuable" || entry.mode === "one-shot" ? "child" : "diagnostic",
			},
		];
	});
}
