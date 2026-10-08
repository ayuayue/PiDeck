/**
 * 把访问 URL 编码成二维码 data URL 的共享 hook。
 * 设置页 Web 服务二维码与外网访问二维码共用；失败/空 URL 返回空串。
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function useQrDataUrl(url: string): string {
	const [dataUrl, setDataUrl] = useState("");

	useEffect(() => {
		if (!url) {
			setDataUrl("");
			return;
		}
		let active = true;
		void QRCode.toDataURL(url, {
			width: 192,
			margin: 1,
			color: { dark: "#111827", light: "#ffffff" },
		})
			.then((encoded) => {
				if (active) setDataUrl(encoded);
			})
			.catch(() => {
				if (active) setDataUrl("");
			});
		return () => {
			active = false;
		};
	}, [url]);

	return dataUrl;
}
