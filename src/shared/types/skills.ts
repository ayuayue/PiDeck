import type { PromptStoreItem } from "./prompts";

// ── Pi Skills ──────────────────────────────────────────────────────────

export type PiSkillLocation = {
	id: "pi-global" | "agents-global" | "project-pi" | "project-agents";
	label: string;
	path: string;
	rootMarkdownEnabled: boolean;
};

export type PiSkillSummary = {
	id: string;
	name: string;
	description: string;
	path: string;
	dir: string;
	sourceId: PiSkillLocation["id"];
	sourceLabel: string;
	type: "directory" | "markdown";
	/** Pi 禁用模型自动调用时仍可由用户通过 /skill:name 手动调用。 */
	userOnly?: boolean;
	enabled: boolean;
	valid: boolean;
	warnings: string[];
};

export type PiSkillListResult = {
	locations: PiSkillLocation[];
	skills: PiSkillSummary[];
};

/** 技能 SKILL.md 正文读取结果（技能选择器「查看详情 / 插入全文」用）。 */
export type SkillContentResult = {
	/** 截断后的正文（超长时由主进程限制大小，避免渲染层拿全量大文件）。 */
	content: string;
};

export type CreatePiSkillInput = {
	name: string;
	description: string;
	locationId: PiSkillLocation["id"];
};

// ── Skill Store (prompts.chat skills) ────────────────────────────────

/** 从 prompts.chat 通过 get_skill 获取的 skill 详情 */
export interface SkillStoreDetail {
	id: string;
	title: string;
	description: string;
	files: Array<{ filename: string; content: string }>;
}

export interface SkillStoreSearchResult {
	query: string;
	count: number;
	items: PromptStoreItem[];
}

// ── SkillHub（api.skillhub.cn） ─────────────────────────────────────

/** SkillHub 搜索结果中的单个 skill 条目 */
export interface SkillHubItem {
	slug: string;
	name: string;
	description: string;
	description_zh?: string;
	iconUrl?: string;
	stars: number;
	downloads: number;
	installs: number;
	category: string;
	subCategories?: Array<{ key: string; name: string }>;
	version: string;
	ownerName: string;
	namespace?: {
		canonicalName: string;
		displayName: string;
		publicSlug: string;
	};
	labels?: Record<string, string>;
	tags?: Record<string, string>;
	source?: string;
	verified?: boolean;
	updatedAt?: number;
}

/** SkillHub skill 详情（含版本信息） */
export interface SkillHubDetail {
	skill: {
		slug: string;
		displayName: string;
		summary: string;
		summary_zh?: string;
		iconUrl?: string;
		stats: {
			comments: number;
			downloads: number;
			installs: number;
			stars: number;
			versions: number;
		};
		category: string;
		subCategories?: Array<{ key: string; name: string }>;
		labels?: Record<string, string>;
		createdAt: number;
		updatedAt: number;
		source?: string;
		verified?: boolean;
	};
	latestVersion: {
		version: string;
		changelog?: string;
		createdAt: number;
	};
	owner: {
		displayName: string;
		handle: string;
		image?: string | null;
	};
	namespace: {
		canonicalName: string;
		displayName: string;
		handle: string;
		publicSlug: string;
	};
	securityReports?: {
		[key: string]: {
			status: string;
			statusText: string;
			reportUrl?: string;
		};
	};
}

/** SkillHub 搜索结果整体 */
export interface SkillHubSearchResult {
	query: string;
	total: number;
	items: SkillHubItem[];
}

/** SkillHub 安装结果 */
export interface SkillHubInstallResult {
	success: boolean;
	slug: string;
	installDir: string;
	message?: string;
	error?: string;
}
