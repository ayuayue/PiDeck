/** 带字节上界地读完响应正文：超过上限返回 null，调用方按「异常响应」处理。 */
export async function readBoundedResponseText(response: Response, limit: number): Promise<string | null> {
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > limit) return null;
	if (!response.body) {
		const text = await response.text();
		return new TextEncoder().encode(text).byteLength <= limit ? text : null;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		total += chunk.value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return null;
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	return text + decoder.decode();
}
