import { readFileSync } from "node:fs";

/**
 * SessionScanner 拆分后的源码文件清单（显式列出，不扫目录）。
 *
 * 源码断言测试（正则/文本包含）读聚合文本即可：主机与 scanner/ 协作者是同一份实现，
 * 断言不该因为某段逻辑挪了文件而失效。
 */
export const sessionScannerSourceFiles = [
	"src/main/sessions/SessionScanner.ts",
	"src/main/sessions/scanner/sessionHtmlExport.ts",
	"src/main/sessions/scanner/sessionInfoAppender.ts",
	"src/main/sessions/scanner/sessionMessageReads.ts",
	"src/main/sessions/scanner/sessionPathDerivation.ts",
	"src/main/sessions/scanner/sessionRootEnumeration.ts",
	"src/main/sessions/scanner/sessionSummaryRead.ts",
	"src/main/sessions/scanner/sessionTitleProbe.ts",
];

/** 聚合后的 SessionScanner 实现源码（主机 + 协作者，按清单顺序拼接）。 */
export function readSessionScannerSources() {
	return sessionScannerSourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");
}
