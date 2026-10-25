/**
 * YAML frontmatter 剥离——**逐条对齐 pi 的 `utils/frontmatter.js`**。
 *
 * 为什么必须对齐：模板正文会被 PiDeck 本地展开后原样发给模型（为了保住 `<prompt_template>`
 * 块里的模板名）。pi 自己展开时用的是它的 `stripFrontmatter`，两边规则不一致就会出现
 * 「pi 展开干净、PiDeck 展开漏出 `---\ndescription: …\n---`」的差异。
 *
 * pi 的三条规则（缺一条就会走偏，2026-10 实测）：
 * 1. 先 `stripBom` + 换行归一（`\r\n` 与裸 `\r` 都变 `\n`）——Windows 编辑器保存的
 *    模板常带 BOM 或裸 `\r`，不归一时 `startsWith("---")` 直接失败，YAML 头会漏进消息；
 * 2. 结束标记是**第一个** `\n---`（从下标 3 开始找），所以 `--- ` 带尾空格也能剥；
 * 3. 正文 `.trim()`（首尾空白都去掉）。
 *
 * 放在 renderer/utils 而不是 shared：目前只有渲染层的展开/插入用它；主进程侧没有
 * 对应的读取需求，放 shared 会多一份没人用的契约。
 */

/** pi 的 `stripBom` + 换行归一。 */
function normalizeFrontmatterSource(content: string): string {
	return content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

/**
 * 拆出 frontmatter 与正文（与 pi 的 `extractFrontmatter` 同构）。
 * `yaml` 为 null 表示没有可识别的 frontmatter（此时 body 是归一化后的完整内容）。
 */
export function extractFrontmatter(content: string): { yaml: string | null; body: string } {
	const normalized = normalizeFrontmatterSource(content);
	if (!normalized.startsWith("---")) return { yaml: null, body: normalized };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { yaml: null, body: normalized };
	return {
		yaml: normalized.slice(4, endIndex),
		// endIndex + 4 跳过 "\n---"；pi 只在这个分支 trim 正文（见下方 stripFrontmatter 注释）
		body: normalized.slice(endIndex + 4).trim(),
	};
}

/**
 * pi 的 `stripFrontmatter`：**原样返回** extract 出来的 body。
 *
 * 注意一个 pi 的细节（实测 1.4.0 dist 逐字对齐）：trim 只发生在「确实有 frontmatter」的分支里；
 * 没有 frontmatter 时正文**不做 trim**（`"  正文  "` 会原样保留）。别在这里补 trim——
 * 那会让纯正文模板的前后空白被静默吃掉，与 pi 展开的结果不一致。
 */
export function stripFrontmatter(content: string): string {
	return extractFrontmatter(content).body;
}
