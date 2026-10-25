import { CUSTOM_LOGO_DATA_URL_MAX_LENGTH } from "../../../shared/types/settings";

/**
 * 自定义品牌 logo 图片：把用户选中的本地图片读成内联 data URL（存进 settings.logoCustomImage）。
 *
 * 为什么内嵌进设置文件而不是落盘：图片随设置一起备份/同步/重置，不会出现「设置指向一个已被删掉的图」，
 * 也因此不必为读图新增 IPC 通道（设置写入链路已覆盖）。代价是 base64 会撑大设置文件，所以这里先缩图、
 * 再对照主进程的长度上限收敛。
 *
 * 与 composerImages.ts 的 resizeImageFile 刻意不复用：附件按源格式输出（png→png、其余→jpeg）以控体积，
 * 而 logo 要保住透明背景（任务栏/托盘图标落在桌面上，黑底会很显眼），必须一律输出 PNG。
 */

/** 自定义 logo 最长边：品牌区最大显示 40px、窗口/托盘图标最大 256px，512 足够覆盖 HiDPI 屏。 */
export const LOGO_IMAGE_MAX_EDGE = 512;
/** 源文件字节上限：超过这个体量先拒绝，避免为了缩图先把几十 MB 图片读进内存再编码。 */
export const LOGO_IMAGE_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
/** 编码后仍超上限时的降档阶梯（等比缩到最长边 ≤ 该值）；走完还超就报错，不静默存一张主进程会丢弃的图。 */
const LOGO_IMAGE_EDGE_LADDER = [LOGO_IMAGE_MAX_EDGE, 256, 128];

/** 等比缩放到最长边 ≤ maxEdge；无需缩放（含尺寸非法）时返回 null，由调用方按原图处理。 */
export function computeLogoScale(width: number, height: number, maxEdge: number = LOGO_IMAGE_MAX_EDGE): { width: number; height: number } | null {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	const longest = Math.max(width, height);
	if (longest <= maxEdge) return null;
	const ratio = maxEdge / longest;
	return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("Logo image read failed"));
		reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Logo image read failed")));
		reader.readAsDataURL(file);
	});
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onerror = () => reject(new Error("Logo image decode failed"));
		image.onload = () => resolve(image);
		image.src = dataUrl;
	});
}

/** 按 maxEdge 缩图并编码为 PNG；本来就够小时原样返回（不做无意义的重编码，保住原压缩率）。 */
function encodeScaled(image: HTMLImageElement, source: string, maxEdge: number): string {
	const scale = computeLogoScale(image.naturalWidth, image.naturalHeight, maxEdge);
	if (!scale) return source;
	const canvas = document.createElement("canvas");
	canvas.width = scale.width;
	canvas.height = scale.height;
	const context = canvas.getContext("2d");
	if (!context) return source;
	context.drawImage(image, 0, 0, scale.width, scale.height);
	return canvas.toDataURL("image/png");
}

/**
 * 读取用户选中的 logo 图片 → data URL；体积/格式不合规时抛错，由设置页提示用户换一张。
 *
 * SVG 直接原样返回：矢量图没有固有位图尺寸，缩放只会把它光栅化，反而丢掉清晰度。
 */
export async function readLogoImageFile(file: File): Promise<string> {
	if (file.size > LOGO_IMAGE_MAX_SOURCE_BYTES) throw new Error("Logo image is too large");
	const source = await readAsDataUrl(file);
	if (file.type === "image/svg+xml") return source;
	const image = await loadImage(source);
	let encoded = "";
	for (const maxEdge of LOGO_IMAGE_EDGE_LADDER) {
		encoded = encodeScaled(image, source, maxEdge);
		if (encoded.length <= CUSTOM_LOGO_DATA_URL_MAX_LENGTH) return encoded;
	}
	throw new Error("Logo image is still too large after resizing");
}
