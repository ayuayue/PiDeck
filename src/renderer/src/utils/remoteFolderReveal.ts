/**
 * 「在文件抽屉里定位这个远端目录」请求的投递通道（纯模块，无 React / 无 jotai）。
 *
 * 背景：远端（SSH）项目在本机没有路径，远端目录链接无法交给本机文件管理器
 *（`files:open` 对远端 target 一定 `UNSUPPORTED_CAPABILITY`），唯一可达的入口是文件抽屉里的
 * 远端目录树。而抽屉要「先打开面板」才能渲染那棵树，从发布请求到面板挂载之间会隔一次 React
 * 渲染——纯事件总线会丢掉这一拍，所以这里保留「最近一次请求」供新挂载的树补消费。
 *
 * 判据是 `projectId + nonce`：抽屉跟随当前项目，不是这个项目的请求不消费；同一目录连点两次
 * 也必须能再次定位，因此只比路径会让第二次静默失效（与侧栏「揭示项目行」同一套形状）。
 */
export type RemoteFolderRevealRequest = {
	projectId: string;
	/** 项目内相对路径（空串 = 项目根） */
	relativePath: string;
	nonce: number;
};

type RemoteFolderRevealListener = (request: RemoteFolderRevealRequest) => void;

const listeners = new Set<RemoteFolderRevealListener>();
let latest: RemoteFolderRevealRequest | null = null;
let nonce = 0;

/** 发布一次定位请求；没有项目身份时直接丢弃（否则无从判断该由哪棵树消费）。 */
export function publishRemoteFolderReveal(projectId: string, relativePath: string): void {
	if (!projectId) return;
	nonce += 1;
	latest = { projectId, relativePath, nonce };
	for (const listener of [...listeners]) listener(latest);
}

/** 最近一次请求：面板在请求发出之后才挂载时用它补齐。 */
export function latestRemoteFolderReveal(): RemoteFolderRevealRequest | null {
	return latest;
}

export function subscribeRemoteFolderReveal(listener: RemoteFolderRevealListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
