import { app } from "electron";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeSessionImporter } from "./ClaudeSessionImporter";
import type { SessionImportCopy } from "./SessionImportCopy";

/**
 * 导入 Qoder（~/.qoder-cn/projects）会话为 pi 原生会话文件。
 *
 * Qoder 的 transcript 与 Claude Code 同构（同一套 user/assistant + content block 包裹，
 * 行内带 cwd/sessionId，项目目录 slug 规则一致），因此整条扫描/转换/原子写盘管线
 * 复用 ClaudeSessionImporter，只覆盖来源标识与目录扫描方式。
 */
export class QoderSessionImporter extends ClaudeSessionImporter {
	constructor(translate?: SessionImportCopy) {
		super(translate);
		this.sourceRoot = join(app.getPath("home"), ".qoder-cn", "projects");
		this.sourceKey = "qoder";
		this.sourceLabel = "Qoder";
		this.defaultProvider = "qoder";
		this.defaultModelId = "qoder";
	}

	/**
	 * 只取项目目录顶层的 `<sessionId>.jsonl`，不递归。
	 *
	 * Qoder 把子代理转录存放在会话同名的子目录 `<sessionId>/subagents/`（isSidechain 行）；
	 * 基类面向平铺的 Claude 目录用全递归收集，这里照抄会把子代理会话混进可导入列表。
	 */
	protected override async collectJsonl(dir: string): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(dir, entry.name));
	}
}
