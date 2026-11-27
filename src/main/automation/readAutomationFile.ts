import { readFile } from "node:fs/promises";

/** 只有首次启动缺少文件时才返回 undefined，已有存档必须读对才能继续写入。 */
export async function readAutomationFile(filePath: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch {
		// JSON.parse 的异常可能带有任务正文片段，报告文件名即可。
		throw new Error("Invalid JSON in automation.json. Repair the file and restart PiDeck.");
	}
}
