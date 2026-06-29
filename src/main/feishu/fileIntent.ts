import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const FILE_NAME_RE = /(?:[^\s，。！？、；;：:]+\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|md|json|png|jpe?g|webp|gif|zip))/iu;

export function resolveFeishuFileSendIntent(message: string, cwd: string): string | undefined {
	const text = message.trim();
	if (!/(发|发送|传|send|share)/i.test(text)) return undefined;
	if (!/(文件|飞书|群|给我|给|chat|group)/i.test(text)) return undefined;

	const match = text.match(FILE_NAME_RE);
	if (!match) return undefined;
	const rawPath = match[0].trim();
	const filePath = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
	return existsSync(filePath) ? filePath : undefined;
}
