/**
 * zhTwCopySources.mjs —— 繁体词典的「产物 ↔ zh-CN 源区块」清单与源指纹。
 *
 * 从 genZhTwCopy.mjs 拆出来的唯一原因：生成器和守卫测试要共用同一份清单和同一个指纹算法。
 * 生成器本体在导入时就要求 opencc-js（非项目依赖），测试不能 import 它；而清单如果两边各写
 * 一份，新增第五份产物时就会漏掉一处。
 *
 * 指纹解决的是「值的新鲜度」盲区：键集断言（tests/zhTwCopy.test.mjs）只能发现新增/删除键，
 * 只改值而不加键时产量与源不同步却全绿。指纹不需要 opencc，测试可以直接复算。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 四份产物的源区块定义。`startMarker`/`endMarker` 必须能在源文件里唯一命中，且区块内容
 * 就是生成器逐行翻译的范围（区块之外的同文件改动不参与指纹，也不会改变产物）。
 */
export const ZHTW_TARGETS = [
	{
		out: "src/renderer/src/i18n/rendererCopy.zh-TW.ts",
		source: "src/renderer/src/i18n/rendererCopy.zh-CN.ts",
		startMarker: "export const zhCN = {",
		endMarker: "} as const;",
		spread: ["...mainProcessZhCN,", "...mainProcessZhTW,"],
		imports: ['import { mainProcessZhTW } from "../../../shared/i18n/mainProcessCopy.zh-TW";', 'import type { TranslationKey } from "./rendererCopy.zh-CN";', "", "export const zhTW: Record<TranslationKey, string> = {"],
	},
	{
		out: "src/shared/i18n/mainProcessCopy.zh-TW.ts",
		source: "src/shared/i18n/mainProcessCopy.ts",
		startMarker: "export const mainProcessZhCN = {",
		endMarker: "} as const;",
		imports: ['import type { MainProcessTranslationKey } from "./mainProcessCopy";', "", "export const mainProcessZhTW: Record<MainProcessTranslationKey, string> = {"],
	},
	{
		out: "src/main/web/WebI18n.zh-TW.ts",
		source: "src/main/web/WebI18n.ts",
		startMarker: "export const webZhCN = {",
		endMarker: "} as const;",
		spread: ["...mainProcessZhCN,", "...mainProcessZhTW,"],
		imports: ['import { mainProcessZhTW } from "../../shared/i18n/mainProcessCopy.zh-TW";', 'import type { WebTranslationKey } from "./WebI18n";', "", "export const webZhTW: Record<WebTranslationKey, string> = {"],
	},
	{
		out: "src/main/feishu/FeishuI18n.zh-TW.ts",
		source: "src/main/feishu/FeishuI18n.ts",
		startMarker: "const zhCN = {",
		endMarker: "} as const;",
		imports: ['import type { FeishuTranslationKey } from "./FeishuI18n";', "", "export const feishuZhTW: Record<FeishuTranslationKey, string> = {"],
	},
];

/**
 * 读源文件的词典区块，并给出「区块原文」的 sha256。
 *
 * 覆盖范围取 `startMarker`（含）到 `endMarker`（含）：区块内的任何改动（值、新增/删除键、
 * 注释、换行排版）本来就会改变产物内容，所以用它当新鲜度门禁不会误报；区块之外的改动
 * （同文件的其它代码）不参与，改那些不需要重新生成。
 */
export function readSourceRegion(rootDir, target) {
	const lines = readFileSync(join(rootDir, target.source), "utf8").split("\n");
	const start = lines.indexOf(target.startMarker);
	const end = lines.indexOf(target.endMarker, start);
	if (start < 0 || end < 0) throw new Error(`${target.source}: 找不到 ${target.startMarker} / ${target.endMarker} 区块`);
	const region = lines.slice(start, end + 1).join("\n");
	return { lines, start, end, regionSha256: createHash("sha256").update(region, "utf8").digest("hex") };
}
