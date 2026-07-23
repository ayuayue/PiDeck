/**
 * 对 xueprompts.db 做瘦身处理：
 * 1. 删除 xueprompts_fts 全文索引（回到 JS 端 LIKE 搜索）
 * 2. content 列 gzip 压缩后存为 BLOB
 * 3. VACUUM 回收空闲页
 *
 * 用法: node scripts/compact-xueprompts.mjs
 * 输入: resources/xueprompts.db
 * 输出: resources/xueprompts.db（原地覆盖）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "resources", "xueprompts.db");

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`数据库不存在: ${DB_PATH}`);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const buf = readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  console.log("=== 处理前 ===");
  printStat(db);

  // ---- 1. 删除 FTS 表 ----
  console.log("\n[1/4] 删除 FTS 全文索引...");
  db.run("DROP TABLE IF EXISTS xueprompts_tsv;"); // FTS 内容表
  db.run("DROP TABLE IF EXISTS xueprompts_fts;"); // FTS 虚拟表
  db.run("DROP TABLE IF EXISTS xueprompts_fts_content;"); // FTS 内容表
  db.run("DROP TABLE IF EXISTS xueprompts_fts_segments;"); // FTS 段表
  db.run("DROP TABLE IF EXISTS xueprompts_fts_segdir;"); // FTS 段目录
  db.run("DROP TABLE IF EXISTS xueprompts_fts_docsize;"); // FTS 文档大小
  db.run("DROP TABLE IF EXISTS xueprompts_fts_stat;"); // FTS 统计

  // ---- 2. content / description gzip 压缩为 BLOB ----
  console.log("[2/4] 压缩 content/description 字段...");

  // 先加临时 BLOB 列
  db.run("ALTER TABLE xueprompts ADD COLUMN content_gz BLOB;");
  db.run("ALTER TABLE xueprompts ADD COLUMN desc_gz BLOB;");

  // 逐条压缩（sql.js 不支持 UPDATE 内嵌 gzip 函数）
  const rows = db.exec("SELECT id, content, description FROM xueprompts");
  const updateStmt = db.prepare(
    "UPDATE xueprompts SET content_gz = ?, desc_gz = ? WHERE id = ?"
  );

  db.run("BEGIN TRANSACTION");
  for (const row of rows[0]?.values ?? []) {
    const id = Number(row[0]);
    const content = String(row[1] ?? "");
    const description = String(row[2] ?? "");
    const contentGz = gzipSync(content, { level: 9 });
    const descGz = gzipSync(description, { level: 9 });
    updateStmt.run([contentGz, descGz, id]);
  }
  updateStmt.free();
  db.run("COMMIT");

  // 删除旧文本列，重命名新列为原名
  db.run(
    "ALTER TABLE xueprompts RENAME TO xueprompts_old;"
  );
  db.run(`
    CREATE TABLE xueprompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      content BLOB NOT NULL DEFAULT '',
      description BLOB NOT NULL DEFAULT ''
    )
  `);
  db.run(`
    INSERT INTO xueprompts (id, slug, url, title, category, content, description)
    SELECT id, slug, url, title, category, content_gz, desc_gz FROM xueprompts_old;
  `);
  db.run("DROP TABLE xueprompts_old;");

  // ---- 3. 重建分类表保持兼容 ----
  console.log("[3/4] 重建分类表...");
  // 分类表不需要改，但之前可能残留 FTS 关联数据

  // ---- 4. VACUUM ----
  console.log("[4/4] VACUUM 回收空间...");
  // sql.js 的 VACUUM 直接返回新数据库，老数据库会自动清理
  db.run("VACUUM;");

  console.log("\n=== 处理后 ===");
  printStat(db);

  // 验证解压
  const verify = db.exec("SELECT content FROM xueprompts LIMIT 1");
  if (verify[0]?.values?.[0]?.[0]) {
    const decompressed = gunzipSync(new Uint8Array(verify[0].values[0][0]));
    console.log(`\n解压验证 OK: 前100字 = ${decompressed.toString("utf8").slice(0, 100)}`);
  }

  // 导出
  const out = db.export();
  writeFileSync(DB_PATH, Buffer.from(out));
  console.log(`\n最终大小: ${(out.length / 1024 / 1024).toFixed(2)} MB`);
  db.close();
}

function printStat(db) {
  const r = db.exec("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'");
  const tables = r[0]?.values?.[0]?.[0] ?? 0;
  
  const r2 = db.exec("SELECT SUM(LENGTH(content)), SUM(LENGTH(description)), SUM(LENGTH(title)) FROM xueprompts");
  const v = r2[0]?.values?.[0];
  
  const fileSize = existsSync(DB_PATH) ? readFileSync(DB_PATH).length : 0;
  console.log(`  表数: ${tables}`);
  if (v) {
    const contentSize = Number(v[1] ?? 0); // description
    console.log(`  content+desc BLOB 总长: ${((Number(v[0] ?? 0) + contentSize) / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log(`  文件大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error("瘦身失败:", err);
  process.exit(1);
});
