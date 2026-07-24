import { shell } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type {
	CreatePiPromptTemplateInput,
	PiPromptTemplateListResult,
	PiPromptTemplateSummary,
} from "../../shared/types";
import type { WslEnvironment } from "../wsl/WslPaths";

function makeBuiltinContent(name: string, body: string): string {
	return `---\ndescription: ${name}\n---\n\n${body}`;
}

/** 推荐模板：用户刚接触 prompt templates 时可快速上手的实用模板。
 * 标记 userCreated: false，在 UI 中显示为只读条目。 */
const BUILTIN_TEMPLATES: PiPromptTemplateSummary[] = [
	{
		name: "review",
		path: "builtin://review",
		description: "Review staged git changes for bugs, security issues, and logic errors",
		content: makeBuiltinContent(
			"Review staged git changes",
			"Review the staged changes (\\`git diff --cached\\`). Focus on:\n- Bugs and logic errors\n- Security issues\n- Error handling gaps\n- Edge cases and boundary conditions",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "test",
		path: "builtin://test",
		description: "Write tests for a function or component covering edge cases",
		content: makeBuiltinContent(
			"Write tests for a function or component",
			"Write comprehensive tests. Cover:\n- Happy path\n- Edge cases and boundary conditions\n- Error handling\n- Type correctness",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "fix",
		path: "builtin://fix",
		description: "Debug and fix issues with root cause analysis",
		content: makeBuiltinContent(
			"Debug and fix issues with root cause analysis",
			"Debug and fix the following issue. Before making any changes:\n1. Analyze the root cause\n2. List affected files\n3. Propose the fix\n4. After confirming, apply the fix",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "refactor",
		path: "builtin://refactor",
		description: "Refactor code for better readability and maintainability",
		content: makeBuiltinContent(
			"Refactor code",
			"Refactor. Follow these principles:\n- Keep the same external behavior\n- Improve readability and naming\n- Reduce duplication\n- Add type annotations where they improve clarity\n- Maintain backward compatibility",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "doc",
		path: "builtin://doc",
		description: "Add or improve documentation and comments",
		content: makeBuiltinContent(
			"Add or improve documentation",
			"Add or improve documentation. Include:\n- A brief overview of what it does\n- Parameters and return values\n- Usage examples where helpful\n- Edge cases and assumptions",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "explain",
		path: "builtin://explain",
		description: "Explain code or architecture in simple terms",
		content: makeBuiltinContent(
			"Explain code or architecture",
			"Explain in simple terms. Cover:\n- What it does at a high level\n- Key design decisions\n- How it fits into the broader architecture\n- Potential improvements or concerns",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "pi-system",
		path: "builtin://pi-system",
		description: "View pi's default system prompt (identity, tools, guidelines)",
		content: makeBuiltinContent(
			"Pi system prompt",
			"这是 pi 的默认系统提示词——核心身份描述、可用工具列表、行为准则和文档路径，定义了 AI agent 的行为基础。\n\n---\n\nYou are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n- read: Read file contents\n- bash: Execute bash commands (ls, grep, find, etc.)\n- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call\n- write: Create or overwrite files\n- ask_question: Ask the user a question (or a batch of questions) and wait for responses\n- todo: Manage a todo list (add / toggle / clear)\n- web_search: Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles\n- fetch_content: Use to extract readable content from URL(s), YouTube, GitHub repos, or local videos\n- mcp: MCP gateway - connect to MCP servers and call their tools\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n- Use bash for file operations like ls, rg, find\n- Use read to examine files instead of cat or sed.\n- Use edit for precise changes\n- Keep edits[].oldText as small as possible while still being unique\n- Be concise in your responses\n- Show file paths clearly when working with files\n\nCurrent date: YYYY-MM-DD\nCurrent working directory: /path/to/project",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "commit",
		path: "builtin://commit",
		description: "Generate a conventional commit message from staged changes",
		content: makeBuiltinContent(
			"Generate a conventional commit message",
			"Generate a conventional commit message from the staged changes (\\`git diff --cached\\`).\nFormat: \\`type(scope): description\\`\n\nTypes: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "skill-discipline",
		path: "builtin://skill-discipline",
		description: "Skills execution discipline: rules for when and how to trigger agent skills",
		content: `---
description: Skills execution discipline: rules for when and how to trigger agent skills
---

# ========================================================================
# Skill Execution Discipline
# ========================================================================

This section defines when and how skills from available_skills should be triggered.
It helps suppress the tendency to "think first, then call a skill", ensuring skills
are invoked promptly when appropriate.

## Core Principle

Available skills are registered in this system. You should and must call them
when appropriate. If unsure whether a skill is needed, follow the rule:
**"Call before thinking"**—the cost of calling a skill is far lower than the risk of missing one.
**Skills are not a substitute for thinking; they are the starting point for thinking.**

## Execution Rules

1. **Trigger and Execute**: When user input matches any description or TRIGGERS
   keyword/scenario in a skill, call it immediately. Do NOT:
   - "Let me reason first, then decide"
   - "This is simple enough, I'll handle it"
   - "I'll give a preliminary answer first"

2. **No Bypassing**: If you catch yourself "answering yourself" instead of
   "calling a skill then answering", pause and re-evaluate.

3. **Priority Order** (conflict resolution):
   P0 — Meta skills (always first)
   P1 — Process discipline (testing, debugging, verification)
   P2 — Problem solving (plans, diagnosis, conflict resolution)
   P3 — Functional tools (browser, file organizer, vault)
   P4 — Design/review (codebase design, domain modeling, code review)
   P5 — Other skills by relevance

4. **Fallback**: When multiple skills might match and you're unsure which to pick,
   call the meta skill or output the candidate list for the user to choose.

## Thinking Inhibition

> Do NOT perform prolonged independent reasoning before calling a skill.
> The right flow: user input → check TRIGGERS → call skill → follow skill instructions

## Recursion Guard
> Each skill is called at most once per conversation turn unless context changes significantly.
> Avoid A calls B, B references A in an infinite loop.`,
		userCreated: false,
		scope: "global",
	},
];

/**
 * 管理 pi 全局 Prompt Templates 目录 (~/.pi/agent/prompts/)。
 * 
 * Prompt Templates 是 markdown 文件，用户可在 pi 中输入 /<name> 快速展开。
 * frontmatter 支持 description、argument-hint 等元数据。
 */
export class PromptManager {
	private promptsDir: string;

	constructor(home?: string) {
		this.promptsDir = join(home ?? homedir(), ".pi", "agent", "prompts");
	}

	/** 将 prompt 目录切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.promptsDir = join(environment?.windowsHome ?? homedir(), ".pi", "agent", "prompts");
	}

	getDir(): string {
		return this.promptsDir;
	}

	async list(): Promise<PiPromptTemplateListResult> {
		await mkdir(this.promptsDir, { recursive: true });
		const entries = await readdir(this.promptsDir).catch(() => []);
		const templates: PiPromptTemplateSummary[] = [];

		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			if (entry.endsWith(".d.md")) continue;
			const fullPath = join(this.promptsDir, entry);
			const raw = await readFile(fullPath, "utf8").catch(() => "");
			if (!raw) continue;

			const name = basename(entry, ".md");
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";

			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^["']|["']$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "global",
			});
		}

		// 合并内置推荐模板（同名不覆盖用户已有模板）
		const userNames = new Set(templates.map((t) => t.name));
		for (const builtin of BUILTIN_TEMPLATES) {
			if (!userNames.has(builtin.name)) {
				templates.push(builtin);
			}
		}

		// 按 name 排序
		templates.sort((a, b) => a.name.localeCompare(b.name));

		return { templates, globalDir: this.promptsDir };
	}

	async create(input: CreatePiPromptTemplateInput): Promise<PiPromptTemplateSummary> {
		const name = this.normalizeName(input.name);
		if (!name) throw new Error("模板名称不能为空，且至少包含一个字母或数字");
		const description = input.description.trim();
		if (!description) throw new Error("模板描述不能为空");

		const filePath = join(this.promptsDir, `${name}.md`);
		if (existsSync(filePath)) throw new Error(`模板已存在：${name}`);

		// 内容仅含 frontmatter 中的 description，正文由用户后续在编辑器中编写，不与 skill 重复展示描述
		const content = `---\ndescription: ${description.replace(/\n/g, " ")}\n---\n`;
		await writeFile(filePath, content, "utf8");

		return {
			name,
			path: filePath,
			description,
			content,
			userCreated: true,
		};
	}

	async delete(filePath: string): Promise<void> {
		if (!filePath.startsWith(this.promptsDir)) {
			throw new Error("只能删除全局 prompt templates 目录下的文件");
		}
		if (!existsSync(filePath)) {
			throw new Error("模板文件不存在");
		}
		await rm(filePath, { force: true });
	}

	/** 扫描项目 .pi/prompts/ 目录下的模板 */
	async listByProject(projectPath: string): Promise<PiPromptTemplateListResult> {
		const projectPromptsDir = join(projectPath, ".pi", "prompts");
		const entries = await readdir(projectPromptsDir).catch(() => []);
		const templates: PiPromptTemplateSummary[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			if (entry.endsWith(".d.md")) continue;
			const fullPath = join(projectPromptsDir, entry);
			const raw = await readFile(fullPath, "utf8").catch(() => "");
			if (!raw) continue;
			const name = basename(entry, ".md");
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";

			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^["']|["']$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "project",
			});
		}
		templates.sort((a, b) => a.name.localeCompare(b.name));
		return { templates, globalDir: projectPromptsDir };
	}

	/** 在项目 .pi/prompts/ 下创建模板 */
	async createInProject(
		projectPath: string,
		input: CreatePiPromptTemplateInput,
	): Promise<PiPromptTemplateSummary> {
		const projectPromptsDir = join(projectPath, ".pi", "prompts");
		await mkdir(projectPromptsDir, { recursive: true });
		const name = this.normalizeName(input.name);
		if (!name) throw new Error("模板名称不能为空，且至少包含一个字母或数字");
		const description = input.description.trim();
		if (!description) throw new Error("模板描述不能为空");
		const filePath = join(projectPromptsDir, `${name}.md`);
		if (existsSync(filePath)) throw new Error(`模板已存在：${name}`);
		// 内容仅含 frontmatter 中的 description，正文由用户后续编辑
		const content = `---\ndescription: ${description.replace(/\n/g, " ")}\n---\n`;
		await writeFile(filePath, content, "utf8");
		return {
			name,
			path: filePath,
			description,
			content,
			userCreated: true,
			scope: "project",
		};
	}

	/** 从项目 .pi/prompts/ 删除模板 */
	async deleteFromProject(projectPath: string, fileName: string): Promise<void> {
		const filePath = join(projectPath, ".pi", "prompts", fileName);
		if (!existsSync(filePath)) throw new Error("模板文件不存在");
		await rm(filePath, { force: true });
	}

	async openFolder(): Promise<void> {
		await mkdir(this.promptsDir, { recursive: true });
		await shell.openPath(this.promptsDir);
	}

	/**
	 * 读取模板原始内容（供编辑器使用）
	 */
	async readContent(filePath: string): Promise<string> {
		return readFile(filePath, "utf8");
	}

	/**
	 * 保存模板内容
	 */
	async writeContent(filePath: string, content: string): Promise<void> {
		if (!filePath.startsWith(this.promptsDir)) {
			throw new Error("只能修改全局 prompt templates 目录下的文件");
		}
		await writeFile(filePath, content, "utf8");
	}

	private parseFrontmatter(raw: string): Record<string, string> {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const result: Record<string, string> = {};
		if (!match) return result;
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			let value = line.slice(index + 1).trim();
			value = value.replace(/^['\"]|['\"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
	}

	/** 重命名全局模板：将 <oldName>.md 重命名为 <newName>.md */
	async rename(oldName: string, newName: string): Promise<PiPromptTemplateSummary> {
		const normalizedOld = this.normalizeName(oldName);
		const normalizedNew = this.normalizeName(newName);
		if (!normalizedOld || !normalizedNew) throw new Error("模板名称不能为空");
		if (normalizedOld === normalizedNew) throw new Error("新旧名称相同");

		const oldPath = join(this.promptsDir, `${normalizedOld}.md`);
		const newPath = join(this.promptsDir, `${normalizedNew}.md`);
		if (!existsSync(oldPath)) throw new Error(`模板不存在：${oldName}`);
		if (existsSync(newPath)) throw new Error(`模板已存在：${normalizedNew}`);

		await rename(oldPath, newPath);
		// 读取新文件内容返回摘要
		const raw = await readFile(newPath, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		const description = frontmatter.description ?? "";
		return {
			name: normalizedNew,
			path: newPath,
			description: description.replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "global",
		};
	}

	/** 重命名项目级模板 */
	async renameInProject(projectPath: string, oldName: string, newName: string): Promise<PiPromptTemplateSummary> {
		const projectPromptsDir = join(projectPath, ".pi", "prompts");
		const normalizedOld = this.normalizeName(oldName);
		const normalizedNew = this.normalizeName(newName);
		if (!normalizedOld || !normalizedNew) throw new Error("模板名称不能为空");
		if (normalizedOld === normalizedNew) throw new Error("新旧名称相同");

		const oldPath = join(projectPromptsDir, `${normalizedOld}.md`);
		const newPath = join(projectPromptsDir, `${normalizedNew}.md`);
		if (!existsSync(oldPath)) throw new Error(`模板不存在：${oldName}`);
		if (existsSync(newPath)) throw new Error(`模板已存在：${normalizedNew}`);

		await rename(oldPath, newPath);
		const raw = await readFile(newPath, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		const description = frontmatter.description ?? "";
		return {
			name: normalizedNew,
			path: newPath,
			description: description.replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "project",
		};
	}

	/** 规范化模板名称：保留 Unicode 字母（含中文等非拉丁文字）、数字和连字符，其余替换为连字符 */
	private normalizeName(value: string): string {
		return value
			.trim()
			// 替换非（Unicode 字母/数字/连字符）的字符为连字符
			.replace(/[^\p{L}\p{N}-]/gu, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.toLowerCase();
	}
}
