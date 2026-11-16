import { readFileSync } from "node:fs";

/**
 * SessionCatalog 域的源码读取面：宿主 + `catalog/` 下的协作者。
 *
 * 为什么需要这份聚合：有测试按**源码文本**断言行为（脏标题识别、hostId 属主、错误日志文案…），
 * 而这些规则按域搬进了 `src/main/sessions/catalog/` 的协作者。断言该看的是「这一整片域是否还有
 * 这条规则」，而不是「规则还写在哪一个文件里」——拆文件不该被误读成行为消失。
 * 因此断言内容一个字都不改，只把读取面从单文件换成这份聚合。
 */
export const SESSION_CATALOG_SOURCE_FILES = [
	"src/main/sessions/SessionCatalog.ts",
	"src/main/sessions/catalog/catalogEntryProjection.ts",
	"src/main/sessions/catalog/catalogFileStore.ts",
	"src/main/sessions/catalog/catalogLoadMigration.ts",
	"src/main/sessions/catalog/catalogScannedMerge.ts",
	"src/main/sessions/catalog/catalogTitleOwnership.ts",
	"src/main/sessions/catalog/catalogDraftCreate.ts",
	"src/main/sessions/catalog/catalogStoreCodes.ts",
];

/** 整片域的源码文本（按固定顺序拼接；用于正则/包含判定）。 */
export function readSessionCatalogSources() {
	return SESSION_CATALOG_SOURCE_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
}

/**
 * 按文件读源码，但 `src/main/sessions/SessionCatalog.ts` 读成整片域的聚合。
 * 用于「按 filePath 归属符号/字段」的审计：归属表仍以宿主文件名为键，内容来自整片域。
 */
export function readSessionCatalogSourceOrFile(filePath) {
	return filePath === "src/main/sessions/SessionCatalog.ts" ? readSessionCatalogSources() : readFileSync(filePath, "utf8");
}
