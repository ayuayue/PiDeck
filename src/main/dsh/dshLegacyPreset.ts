/** 旧目录预设的最小组合升级；只转换已确认改名的模块，不改 ID、权限或用户文件。 */
import type { EntryOptions } from "@deepseek-ai/cordis-plugin-loader";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 同一套规范化用于根文件与嵌套 include，保留 Loader 在激活时求值的 !!js。 */
export function normalizeLegacyPresetRows(value: unknown, includeModule: string): EntryOptions[] {
	if (!Array.isArray(value)) throw new Error("Legacy DSH preset must be an entry list");
	return value.map((row: unknown) => {
		if (!record(row) || typeof row.id !== "string" || typeof row.name !== "string" || !row.name) throw new Error("Legacy DSH preset row requires id and name");
		const name = row.name === "@deepseek-ai/dsh-workflow-worker-thread" ? "@deepseek-ai/dsh-workflow-ptc" : row.name === "cordis:include" ? includeModule : row.name;
		const result: EntryOptions = { ...row, id: row.id, name };
		if (row.group === true) result.config = normalizeLegacyPresetRows(row.config, includeModule);
		return result;
	});
}
