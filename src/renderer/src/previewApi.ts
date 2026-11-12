import type { PiDesktopApi } from "../../preload";
import { createPlatformPreview } from "./preview/platform";
import { createSettingsPreview } from "./preview/settings";
import { createRemotePreview } from "./preview/remote";
import { createWorkspacePreview } from "./preview/workspace";
import { createSessionsPreview } from "./preview/sessions";
import { createSessionSourcesPreview } from "./preview/sessionSources";
import { createGitPreview } from "./preview/git";
import { createRuntimePreview } from "./preview/runtime";
import { createAppPreview } from "./preview/app";
import { createResourcesPreview } from "./preview/resources";
import { createConfigPreview } from "./preview/config";
import { createIntegrationsPreview } from "./preview/integrations";
import { createCloudSyncPreview } from "./preview/cloudSync";
import { createChatPreview } from "./preview/chat";

/**
 * 无 Electron 的预览/浏览器模式 API：按命名空间域返回惰性桩，镜像 preload 的 PiDesktopApi 形状。
 * 每个域都返回新对象，previewSettings、资源导入 kind 缓存等可变态因此保持实例隔离。
 */
export function createPreviewApi(): PiDesktopApi {
	return {
		...createPlatformPreview(),
		...createSettingsPreview(),
		...createRemotePreview(),
		...createWorkspacePreview(),
		...createSessionsPreview(),
		...createSessionSourcesPreview(),
		...createGitPreview(),
		...createRuntimePreview(),
		...createAppPreview(),
		...createResourcesPreview(),
		...createConfigPreview(),
		...createIntegrationsPreview(),
		...createCloudSyncPreview(),
		...createChatPreview(),
	};
}
