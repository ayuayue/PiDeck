import { t as i18nT } from "../i18n";
import { useCallback } from "react";
import type { ImageContent } from "../../../shared/types";

export interface UseImagePasteInput {
	showToast: (message: string, duration?: number) => void;
	t: typeof i18nT;
}

export interface UseImagePasteOutput {
	processImageFile: (file: File) => Promise<ImageContent | null>;
	fileToImageContent: (file: File) => Promise<ImageContent>;
	dataUrlToImageContent: (dataUrl: string, fallbackMimeType: string) => ImageContent;
	resizeImageFile: (file: File, maxEdge: number, quality: number) => Promise<ImageContent>;
}

export function useImagePaste(input: UseImagePasteInput): UseImagePasteOutput {
	const { showToast, t } = input;

	const dataUrlToImageContent = useCallback((dataUrl: string, fallbackMimeType: string): ImageContent => {
		const [meta, data = ""] = dataUrl.split(",");
		const mimeType = meta.match(/^data:(.*?);base64$/)?.[1] || fallbackMimeType;
		return { type: "image" as const, data, mimeType };
	}, []);

	const fileToImageContent = useCallback(
		(file: File): Promise<ImageContent> => {
			return new Promise((resolve) => {
				const reader = new FileReader();
				reader.onload = () => resolve(dataUrlToImageContent(String(reader.result), file.type));
				reader.readAsDataURL(file);
			});
		},
		[dataUrlToImageContent],
	);

	const resizeImageFile = useCallback(
		(file: File, maxEdge: number, quality: number): Promise<ImageContent> => {
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
						canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
						const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
						resolve(dataUrlToImageContent(canvas.toDataURL(outputType, quality), outputType));
					};
					image.src = String(reader.result);
				};
				reader.readAsDataURL(file);
			});
		},
		[dataUrlToImageContent],
	);

	const processImageFile = useCallback(
		async (file: File): Promise<ImageContent | null> => {
			const maxSize = 10 * 1024 * 1024;
			if (file.size > maxSize) {
				showToast(t("app.imageTooLarge"), 3000);
				return null;
			}
			const validTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
			if (!validTypes.includes(file.type)) {
				showToast(t("app.imageUnsupported"), 3000);
				return null;
			}
			if (file.type === "image/gif") return fileToImageContent(file);
			return resizeImageFile(file, 2000, 0.86).catch(() => fileToImageContent(file));
		},
		[fileToImageContent, resizeImageFile, showToast, t],
	);

	return {
		processImageFile,
		fileToImageContent,
		dataUrlToImageContent,
		resizeImageFile,
	};
}
