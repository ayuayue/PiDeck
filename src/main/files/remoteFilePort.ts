import type { FileContentSearchResult } from "../../shared/types";
import type { ProjectPathsExistResult, ProjectDirectoryPageResult } from "../../shared/types/projectFiles";
import type { RemoteProjectSearchResult } from "../../shared/types/remoteHost";

/**
 * `files:*` 通道里「按位置分派到远端」的那一组入口（实现见 `ipc/remoteProjectFileIpc` 与启动装配）。
 *
 * 为什么单独一个类型模块：`filesIpc.ts` 已越过巨文件硬线（>600 行只准降不准升），端口契约仍要
 * 写清楚「远端读只能走远端服务、未装配时给稳定码、不回退本机」这三条边界，于是把类型搬出来，
 * 而不是在 handler 文件里继续长。
 *
 * 未装配（`undefined`）时远端目标必须返回稳定码，绝不静默回退到本机 fs。
 */
export type RemoteFilePort = {
	directoryPage(projectId: string, path: string, force?: boolean): Promise<ProjectDirectoryPageResult>;
	/**
	 * 远端文件名搜索（收口第一片）：`files:search-page` 按位置路由到这里。
	 * 未装配时该通道对 ssh 项目返回稳定码，不静默回退本机。
	 */
	searchProject?(projectId: string, path: string, query: string): Promise<RemoteProjectSearchResult>;
	pathsExist(projectId: string, paths: readonly string[]): Promise<ProjectPathsExistResult>;
	/**
	 * 远端内容搜索：按连接 hello 的 `fs.searchContent` 能力路由，旧 helper 返回 `{ok:true,value:null}`
	 * 而不是失败——"这个位置只支持文件名"是能力边界，不是错误。未装配该方法时同样按不支持处理。
	 */
	searchContent?(projectId: string, query: string): Promise<{ ok: true; value: FileContentSearchResult | null } | { ok: false; code: string }>;
	/** 远端正文读/写（中央编辑器用）：与抽屉编辑器共用同一份远端文本服务与令牌表。 */
	openText?(senderId: number, projectId: string, path: string): Promise<{ content: string; version?: string }>;
	saveText?(senderId: number, projectId: string, path: string, content: string, version: string): Promise<void>;
	/**
	 * 最近一次 `openText` 签出的令牌（中央编辑器保存的乐观锁）。
	 *
	 * 为什么需要它：写前再 openText 一次拿到的是**当下**磁盘内容的令牌，冲突检测恒成立，
	 * 别人的改动会被静默覆盖。缺省时退回旧行为（写前现读），装了它才是真乐观锁。
	 */
	lastTextVersion?(senderId: number, projectId: string, path: string): string | undefined;
	/**
	 * 远端二进制读（`files:read-base64` 的远端分支）：图片/PDF/Office/压缩包预览用裸 base64，
	 * 与本机 backend 同形（超限抛 `FILE_TOO_LARGE:size:max`）。未装配时该通道对 ssh 项目返回稳定码。
	 */
	readBase64?(senderId: number, projectId: string, path: string, maxBytes: number): Promise<string>;
};
