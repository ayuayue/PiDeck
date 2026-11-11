/**
 * 生成提示词库远程发布资产：xueprompts.db.sha256。
 *
 *   node scripts/publish-xueprompts.mjs
 *
 * 背景：安装包不再内置 xueprompts.db（省 ~3MiB），客户端启动后从 Release 资产
 * 拉取（AtomGit 主 + GitHub latest 兜底，见 src/main/prompts/XuePromptDbStore.ts）。
 * 版本判定 = 本脚本生成的 .sha256 文本与客户端缓存的 db 指纹对比，因此 db 一变就必须重跑
 * 本脚本（两个文件一起提交）；指纹与内容不一致会被 check:xueprompts 挡下——发一份过期指纹
 * 等于全体客户端校验失败。上传已由 release.yml 每次发版自动完成，无需手工传。
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
下一步:
  1. resources/xueprompts.db 与 resources/xueprompts.db.sha256 一起 commit。
  2. 平时的发版无需手工上传：release.yml 每次发版都会把这两份资产传到该 tag 的 Release
     （finalize-release 在指 latest 前断言齐全）。
  3. 只有给「已发布的历史 tag」补资产时才需要手工：
       gh release upload v<版本> resources/xueprompts.db resources/xueprompts.db.sha256 --clobber
     然后手动重跑 sync-atomgit.yml 补 AtomGit（追加资产只产生 release: edited，不会自动触发）。
  4. 客户端下次启动（缓存超过 TTL 或首次安装）自动对比 sha 并按需更新。`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
