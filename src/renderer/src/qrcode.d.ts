/** qrcode（无自带类型声明）：设置页 Web 服务二维码只用 toDataURL。 */
declare module "qrcode" {
	interface QRCodeToDataURLOptions {
		width?: number;
		margin?: number;
		color?: { dark?: string; light?: string };
	}
	const QRCode: {
		toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
	};
	export default QRCode;
}
