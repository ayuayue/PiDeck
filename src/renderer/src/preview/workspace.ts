import type { PiDesktopApi } from "../../../preload";
import { opOk } from "../../../shared/op";
import { now, projects, files, findPreviewDirectory, noop } from "./fixtures";

/**
 * 工作区域桩：项目、项目资源、文件抽屉、拖入文件、通知历史、对话框与自定义主题。
 */
export function createWorkspacePreview(): Pick<PiDesktopApi, "projects" | "projectResources" | "files" | "pasteFiles" | "noticeHistory" | "dialog" | "customThemes"> {
	return {
		projects: {
			list: async () => projects,
			add: async () => projects[0],
			addByPath: async () => projects[0],
			// 预览/静态模式没有主进程，也没有发行版：浏览报「不可用」，添加抛稳定码，不伪造目录。
			listWslDirectory: async () => ({ ok: false as const, code: "WSL_DIRECTORY_DISTRO_UNAVAILABLE", outcome: "rejected" as const }),
			addWslPath: async () => {
				throw new Error("WSL_DIRECTORY_DISTRO_UNAVAILABLE");
			},
			remove: async () => projects,
			reorder: async (projectIds) => {
				projects.sort((a, b) => projectIds.indexOf(a.id) - projectIds.indexOf(b.id));
				return projects;
			},
			setPinned: async () => projects,
			rename: async () => projects,
			onChanged: noop,
			listRoot: async () => projects,
			listWorktreeChildren: async () => [],
			toggleWorktreeEnabled: async () => projects[0],
			chooseChatPath: async () => null,
			setChatPath: async () => projects[0],
			consumeMigrationNotice: async () => null,
			listModels: async () => [],
			// 预览 iframe 不需要真实模型目录：构造一个恒空报告（无失败原因），
			// 与真实通道的 ModelListReport 形状保持一致，避免类型分叉。
			listModelsReport: async () => ({
				models: [],
				ok: false,
				reason: null,
				version: null,
				detail: "",
				source: "none" as const,
				at: Date.now(),
			}),
			getModelSpec: async () => null,
			onTrustRequest: noop,
			respondTrustRequest: async () => undefined,
		},
		projectResources: {
			list: async () => ({
				skills: [],
				extensions: [],
				skillLocations: [],
				overrides: {
					disabledGlobalExtensions: [],
					disabledGlobalSkills: [],
					disabledGlobalPrompts: [],
				},
			}),
			openDirectory: async () => undefined,
			createSkill: async (input) => ({
				id: `project-pi:${input.name}`,
				name: input.name,
				description: input.description,
				path: `C:/Users/preview/project/.pi/skills/${input.name}/SKILL.md`,
				dir: `C:/Users/preview/project/.pi/skills/${input.name}`,
				sourceId: "project-pi" as const,
				sourceLabel: ".pi/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
			deleteSkill: async () => undefined,
			deleteExtension: async () => undefined,
			toggleExtension: async () => undefined,
			toggleInherited: async (input) => ({
				disabledGlobalExtensions: input.kind === "extension" && !input.enabled ? [input.key] : [],
				disabledGlobalSkills: input.kind === "skill" && !input.enabled ? [input.key] : [],
				disabledGlobalPrompts: input.kind === "prompt" && !input.enabled ? [input.key] : [],
			}),
			renameSkill: async (_projectId, _skillPath, newName) => ({
				id: `project-pi:${newName}`,
				name: newName,
				description: "",
				path: `C:/Users/preview/project/.pi/skills/${newName}/SKILL.md`,
				dir: `C:/Users/preview/project/.pi/skills/${newName}`,
				sourceId: "project-pi" as const,
				sourceLabel: ".pi/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
			toggleSkill: async (_projectId, _skillPath, enabled) => ({
				id: "project-pi:preview-toggle",
				name: "preview-skill",
				description: "",
				path: "C:/Users/preview/project/.pi/skills/preview-skill/SKILL.md",
				dir: "C:/Users/preview/project/.pi/skills/preview-skill",
				sourceId: "project-pi" as const,
				sourceLabel: ".pi/skills",
				type: "directory" as const,
				enabled,
				valid: true,
				warnings: [],
			}),
			discovery: async () => ({ projectResourcesAllowed: false, overrides: { disabledGlobalExtensions: [], disabledGlobalSkills: [], disabledGlobalPrompts: [] }, skills: [], prompts: [], extensions: [] }),
		},
		files: {
			list: async (_projectId, options) => {
				if (options?.directory) {
					const match = findPreviewDirectory(files, options.directory);
					return match?.children ?? [];
				}
				return files;
			},
			// 预览模式没有主进程：公共目录页返回稳定码，不伪造空目录。
			directoryPage: async () => ({ ok: false as const, code: "UNSUPPORTED_PROJECT_LOCATION", outcome: "rejected" as const }),
			open: async () => undefined,
			searchContent: async () => null,
			// 公共搜索页同样没有后端：返回稳定码，不伪造空结果冒充“搜过了”。
			searchPage: async () => ({ ok: false as const, code: "UNSUPPORTED_PROJECT_LOCATION", outcome: "rejected" as const }),
			showInFolder: async () => undefined,
			// 预览模式无主进程：不检测文件管理器（打开方式下拉不显示该入口）
			detectFileManager: async () => null,
			openFileManager: async () => undefined,
			readContent: async () => "",
			// 预览模式无法 stat 真实磁盘：返回空数组，校验方按「未知」处理维持链接现状
			pathsExist: async () => [],
			// 预览模式无主进程：只能证明“不可用”，不能伪装成路径不存在。
			stat: async () => ({ availability: "unavailable" as const, exists: false, isDirectory: false, code: "REMOTE_FEATURE_DISABLED" }),
			readBase64: async () => "",
			create: async () => opOk("/mock/created"),
			writeContent: async () => undefined,
			delete: async () => opOk(undefined),
			rename: async () => opOk(""),
			copy: async () => [],
			move: async () => opOk([]),
			moveTo: async (source) => opOk(source),
			getPathForFile: () => "",
			getClipboardPaths: () => [],
		},
		pasteFiles: {
			// 预览/浏览器模式无主进程：拒绝写盘（调用方会走「按文本粘贴」回退）
			write: async () => {
				throw new Error("preview mode: paste file write is not available");
			},
			delete: async () => undefined,
			cleanup: async () => 0,
			getSize: async () => 0,
			clearAll: async () => 0,
		},
		noticeHistory: {
			// 预览/浏览器模式无主进程落盘：内存环形缓冲照常工作，只是重启不保留
			get: async () => [],
			record: async () => undefined,
			clear: async () => undefined,
			getSize: async () => 0,
		},
		dialog: {
			pickFiles: async () => [],
			pickBackgroundImage: async () => "",
			removeBackgroundImage: async () => undefined,
			pickWallpaperEngineDir: async () => "",
			listWallpaperEngine: async () => ({ dir: "", items: [], error: "no-dir" as const }),
			selectWallpaperEngine: async () => null,
		},
		// 自定义主题预览桩：返回空列表与拒绝保存，预览壳没有真实 userData 目录
		customThemes: {
			list: async () => ({ dir: "", themes: [] }),
			read: async () => null,
			save: async () => ({ ok: false as const, errors: ["preview"] }),
			remove: async () => undefined,
			writeGuide: async () => "",
		},
	};
}
