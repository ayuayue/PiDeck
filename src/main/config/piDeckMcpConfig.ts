/** Private MCP host consent/credential file, independent of pi's client configuration. */
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const piDeckMcpAccessSchema = z
	.object({
		enabled: z.boolean(),
		projectIds: z
			.array(
				z
					.string()
					.min(1)
					.max(200)
					.regex(/^[^\u0000-\u001f]+$/),
			)
			.max(1000),
		// 旧文件没有这两个字段。默认值让升级后行为原样延续：“显式白名单 + 无写能力”。
		// 不 bump version：旧构建读到多出来的 key 本来就会被 .strict() 拒（fail closed），
		// 而新构建必须能直接读旧文件——加字段+默认值就能同时做到。
		allProjects: z.boolean().default(false),
		allowControl: z.boolean().default(false),
		// 智能体写能力同样默认关：旧文件缺字段时行为原样延续（只读会话 + 智能体只读）。
		allowAgentWrite: z.boolean().default(false),
		// 定时任务写能力默认关；读（任务/运行历史）仍按项目白名单放行。
		allowAutomationWrite: z.boolean().default(false),
		// 收藏写能力默认关；读收藏只返回无项目归属或已授权项目的条目。
		allowFavoritesWrite: z.boolean().default(false),
	})
	.strict();
const storedSchema = piDeckMcpAccessSchema
	.extend({
		version: z.literal(1),
		port: z.number().int().min(0).max(65535),
		token: z.string().regex(/^(?:[a-f0-9]{64})?$/),
	})
	.strict();
export type PiDeckMcpConfig = z.infer<typeof storedSchema>;
export const emptyPiDeckMcpConfig = (): PiDeckMcpConfig => ({ version: 1, enabled: false, projectIds: [], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false, port: 0, token: "" });

/** Corrupt/oversized files fail closed; absence alone means first-run defaults. */
export async function readPiDeckMcpConfig(path: string): Promise<PiDeckMcpConfig> {
	let handle;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyPiDeckMcpConfig();
		throw new Error("config-read-failed");
	}
	try {
		const buffer = Buffer.alloc(256 * 1024 + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 256 * 1024) throw new Error("config-read-failed");
		const value = storedSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
		// enabled 必须至少有一块可读区域：要么通配，要么非空白名单——否则监听起来也只能拒绝一切。
		if (value.enabled && (!value.token || !value.port || (!value.projectIds.length && !value.allProjects))) throw new Error("config-read-failed");
		return value;
	} catch {
		throw new Error("config-read-failed");
	} finally {
		await handle.close();
	}
}

/** Owner-only atomic replacement. Secrets never enter settings snapshots or logs. */
export async function writePiDeckMcpConfig(path: string, config: PiDeckMcpConfig): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} catch {
		throw new Error("config-write-failed");
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}
