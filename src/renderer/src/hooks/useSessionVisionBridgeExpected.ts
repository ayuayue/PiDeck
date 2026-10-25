import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily } from "../atoms";
import { desktopApi } from "../desktopApi";
import { modelSupportsNativeImages, resolveVisionBridgeExpected } from "../utils/modelImageCapability";

/**
 * 本会话发送图片时，视觉桥 UI 是否该出现。
 * 只在时间线里已有用户图片时拉模型目录，避免每条气泡各打一次 IPC。
 * 目录查询与当前模型身份绑定：发图当帧若还拿着上一轮「不支持图片」的缓存，
 * 会误亮「转换中」，所以 key 对不上时按未知处理（静默，不乐观显示动画）。
 */
export function useSessionVisionBridgeExpected(sessionId: string, hasUserImages: boolean): boolean | null {
	const session = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const backend = session?.backend ?? runtime?.backend ?? "pi";
	const provider = runtime?.state?.provider ?? session?.model?.provider;
	const modelId = runtime?.state?.modelId ?? session?.model?.modelId;
	const lookupKey = `${backend}\0${provider ?? ""}\0${modelId ?? ""}\0${hasUserImages ? "1" : "0"}`;
	const [fetched, setFetched] = useState<{ key: string; supports: boolean } | null>(null);

	useEffect(() => {
		if (!hasUserImages || backend === "dsh") return;
		let cancelled = false;
		const listed = desktopApi.projects.listModels(session?.projectId).catch(() => []);
		const localFile = desktopApi.config
			.getModels()
			.then((result) => result.parsed)
			.catch(() => undefined);
		void Promise.all([listed, localFile]).then(([models, parsed]) => {
			if (cancelled) return;
			setFetched({
				key: lookupKey,
				supports: modelSupportsNativeImages(models, { provider, modelId }, parsed),
			});
		});
		return () => {
			cancelled = true;
		};
	}, [lookupKey, hasUserImages, backend, session?.projectId, provider, modelId]);

	const modelSupportsImages = fetched?.key === lookupKey ? fetched.supports : hasUserImages && backend !== "dsh" ? null : false;
	return resolveVisionBridgeExpected({ backend, modelSupportsImages });
}
