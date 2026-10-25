/**
 * 生成提示词库远程发布资产：xueprompts.db.sha256。
 *
 *   node scripts/publish-xueprompts.mjs
 *
 * 背景：安装包不再内置 xueprompts.db（省 ~3MiB），客户端启动后从 Release 资产
 * 拉取（AtomGit 主 + GitHub latest 兜底，见 src/main/prompts/XuePromptDbStore.ts）。
 * 版本判定 = 本脚本生成的 .sha256 文本与客户端缓存的 db 指纹对比，因此每次更新
 * db 后必须重跑本脚本并把两份资产一起上传，漏一半会导致客户端指纹比对失败。
 *
 * 步骤：轻量健康检查（能打开、有数据）→ 写 .sha256 → 打印上传指引。
 * 健康检查不替代 check:xueprompts（后者跑在打包流水线里做全量断言）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "resources", "xueprompts.db");
const SHA_PATH = `${DB_PATH}.sha256`;

async function main() {
	if (!existsSync(DB_PATH)) {
		console.error(`数据库不存在: ${DB_PATH}`);
		process.exit(1);
	}
	const bytes = readFileSync(DB_PATH);

	// 轻量健康检查：db 可打开且有内容（防把截断/损坏文件发上 Release）
	const SQL = await initSqlJs();
	const db = new SQL.Database(bytes);
	try {
		const [{ count }] = db.exec("SELECT COUNT(*) AS count FROM xueprompts")[0].values.map((row) => ({ count: row[0] }));
		const [{ categories }] = db.exec("SELECT COUNT(*) AS categories FROM xueprompt_categories")[0].values.map((row) => ({ categories: row[0] }));
		if (count <= 0 || categories <= 0) {
			console.error(`数据库为空: prompts=${count} categories=${categories}`);
			process.exit(1);
		}
		console.log(`健康检查通过: prompts=${count} categories=${categories} bytes=${bytes.byteLength}`);
	} finally {
		db.close();
	}

	const sha256 = createHash("sha256").update(bytes).digest("hex");
	// sha256sum 风格输出（hex + 两个空格 + 文件名）；客户端 parseShaText 只取首个 token，两种格式都兼容
	writeFileSync(SHA_PATH, `${sha256}  xueprompts.db\n`, "utf8");
	console.log(`已生成 ${SHA_PATH}`);
	console.log(`sha256 = ${sha256}`);

	console.log(`
发布步骤（两份资产必须同一次 Release 一起上传）:
  1. GitHub: gh release upload v<版本> resources/xueprompts.db resources/xueprompts.db.sha256 --clobber
     （或上传到 latest release；客户端走 /releases/latest/download/<asset> 恒取最新）
  2. AtomGit: 仓库 Release 的 latest tag 下上传同名两份资产
     https://atomgit.com/ayuayue/PiDeck/-/releases
  3. 客户端下次启动（缓存超过 TTL 或首次安装）自动对比 sha 并按需更新。`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
