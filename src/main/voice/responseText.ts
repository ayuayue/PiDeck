import { readBoundedTextOrNull } from "../modelHttp/bounded";

/** 带字节上界地读完响应正文：超过上限返回 null，调用方按「异常响应」处理。 */
export async function readBoundedResponseText(response: Response, limit: number): Promise<string | null> {
	return readBoundedTextOrNull(response, limit);
}
