import type { ImageContent } from "../../../shared/types";

export const COMPOSER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const COMPOSER_IMAGE_MAX_EDGE = 2000;
export const COMPOSER_IMAGE_QUALITY = 0.86;
export const COMPOSER_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type ComposerImageErrorCode = "too-large" | "unsupported" | "read-failed";

export class ComposerImageError extends Error {
  readonly code: ComposerImageErrorCode;

  constructor(code: ComposerImageErrorCode, message: string) {
    super(message);
    this.name = "ComposerImageError";
    this.code = code;
  }
}

export function dataUrlToImageContent(
  dataUrl: string,
  fallbackMimeType: string,
): ImageContent {
  const comma = dataUrl.indexOf(",");
  const meta = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mimeType = meta.match(/^data:(.*?);base64$/)?.[1] || fallbackMimeType;
  return { type: "image", data, mimeType };
}

export function getClipboardImageFiles(data: DataTransfer): File[] {
  return Array.from(data.items)
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/** 粘贴/附件场景支持的图片扩展名（与 COMPOSER_IMAGE_MIME_TYPES 对齐，bmp 不支持故排除） */
const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp)$/i;

/** 判断本地路径是否为受支持的图片文件（大小写不敏感，允许带空格/多段扩展名） */
export function isImageFilePath(path: string): boolean {
  return IMAGE_PATH_RE.test(path);
}

/** 按扩展名推导图片 MIME（未知扩展名默认 image/png） */
export function imageMimeTypeFromPath(path: string): string {
  const ext = (path.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return "image/png";
  }
}

/** dataURL → File（粘贴资源管理器图片文件时，把主进程读回的原图字节包装成 File 走统一附件流程） */
export function dataUrlToFile(dataUrl: string, mimeType: string, fileName: string): File {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mimeType });
}

export function getDroppedImageFiles(data: DataTransfer): File[] {
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

export async function processComposerImageFile(file: File): Promise<ImageContent> {
  if (file.size > COMPOSER_IMAGE_MAX_BYTES) {
    throw new ComposerImageError("too-large", "Image exceeds the composer size limit");
  }
  if (!COMPOSER_IMAGE_MIME_TYPES.has(file.type)) {
    throw new ComposerImageError("unsupported", "Unsupported composer image type");
  }
  if (file.type === "image/gif") return fileToImageContent(file);

  try {
    return await resizeImageFile(
      file,
      COMPOSER_IMAGE_MAX_EDGE,
      COMPOSER_IMAGE_QUALITY,
    );
  } catch {
    return fileToImageContent(file);
  }
}

export function fileToImageContent(file: File): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(
      new ComposerImageError("read-failed", reader.error?.message ?? "Image read failed"),
    );
    reader.onload = () => resolve(
      dataUrlToImageContent(String(reader.result), file.type),
    );
    reader.readAsDataURL(file);
  });
}

export function resizeImageFile(
  file: File,
  maxEdge: number,
  quality: number,
): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Canvas 2D context is unavailable"));
          return;
        }
        context.drawImage(image, 0, 0, width, height);
        const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
        resolve(dataUrlToImageContent(canvas.toDataURL(outputType, quality), outputType));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
