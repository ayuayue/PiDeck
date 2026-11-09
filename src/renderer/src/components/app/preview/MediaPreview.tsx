import { useRef, useState } from "react";
import { Play } from "lucide-react";
import { t } from "../../../i18n";

/**
 * 视频预览：原生控制条 + 居中播放按钮。
 *
 * 为什么给 `<video>` 用 max-w/max-h 而不是 h-full：撑满面板时，近方形/竖屏片段会被
 * object-contain 缩在面板中间，原生控制条却贴在面板最下沿——离画面几百像素，窄抽屉
 * 或窗口不够高时还会被面板边缘裁掉，用户看到的就是「只有一帧画面、没有播放按钮」。
 * 让元素收缩到画面尺寸，控制条才会紧贴画面；再叠一个常显的播放按钮兜住原生控制条
 * 自动淡出的情况（Chromium 静止几秒后会把控制条淡掉）。
 */
export default function MediaPreview(props: { url: string; fileName: string; onError: () => void }) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const [playing, setPlaying] = useState(false);
	const [failed, setFailed] = useState(false);

	const start = () => {
		const video = videoRef.current;
		if (!video) return;
		void video.play().catch(() => undefined);
	};

	return (
		<div className="flex h-full w-full items-center justify-center bg-black p-3">
			<div className="relative flex max-h-full max-w-full items-center justify-center">
				<video
					ref={videoRef}
					controls
					playsInline
					preload="auto"
					src={props.url}
					aria-label={props.fileName}
					className="max-h-full max-w-full rounded-md bg-black"
					onPlay={() => setPlaying(true)}
					onPause={() => setPlaying(false)}
					onEnded={() => setPlaying(false)}
					onError={() => {
						setFailed(true);
						props.onError();
					}}
				/>
				{!playing && !failed && (
					<button type="button" onClick={start} aria-label={t("editor.playVideo")} title={t("editor.playVideo")} className="absolute inset-0 m-auto flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/30 transition hover:bg-black/70">
						<Play size={26} className="translate-x-px" aria-hidden="true" />
					</button>
				)}
			</div>
		</div>
	);
}
