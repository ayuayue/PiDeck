/**
 * 将 xueprompt JSON 数据转换为 SQLite 数据库。
 * content/description 存为 TEXT，后续运行 compact-xueprompts.mjs 可压缩为 BLOB。
 *
 * 用法: node scripts/convert-xueprompts.mjs
 * 输入: C:\Users\<user>\...\xueprompt-prompts.json
 * 输出: resources/xueprompts.db
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const INPUT_JSON =
  "C:\\Users\\14012\\AppData\\Roaming\\pi-desktop\\chat-workspace\\xueprompt-data\\xueprompt-prompts.json";
const OUTPUT_DB = join(ROOT, "resources", "xueprompts.db");

async function main() {
  if (!existsSync(INPUT_JSON)) {
    console.error(`输入文件不存在: ${INPUT_JSON}`);
    process.exit(1);
  }
  const raw = readFileSync(INPUT_JSON, "utf8");
  const records = JSON.parse(raw);
  console.log(`读取到 ${records.length} 条记录`);

  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS xueprompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS xueprompt_categories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO xueprompts (slug, url, title, category, content, description)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const catCount = {};
  db.run("BEGIN TRANSACTION");

  for (const item of records) {
    const slug =
      (item.url ?? "").split("/").filter(Boolean).pop() ||
      `prompt-${Math.random().toString(36).slice(2, 8)}`;

    insertStmt.run([
      slug,
      item.url ?? "",
      item.title ?? "",
      item.category ?? "",
      item.content ?? "",
      item.description ?? "",
    ]);

    const cat = item.category || "未分类";
    catCount[cat] = (catCount[cat] || 0) + 1;
  }
  insertStmt.free();

  const catInsertStmt = db.prepare(
    `INSERT OR REPLACE INTO xueprompt_categories (slug, name, count) VALUES (?, ?, ?)`
  );
  for (const [name, count] of Object.entries(catCount)) {
    const slug = name
      .replace(/[^\w\u4e00-\u9fff]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    catInsertStmt.run([slug, name, count]);
  }
  catInsertStmt.free();
  db.run("COMMIT");

  const data = db.export();
  writeFileSync(OUTPUT_DB, Buffer.from(data));
  console.log(`数据库已写入: ${OUTPUT_DB}`);
  console.log(`大小: ${(data.length / 1024).toFixed(1)} KB`);
  console.log(`分类数: ${Object.keys(catCount).length}`);
  console.log(`提示词数: ${records.length}`);

  db.close();
  console.log("\n提示: 可运行 node scripts/compact-xueprompts.mjs 做进一步瘦身");
}

main().catch((err) => {
  console.error("转换失败:", err);
  process.exit(1);
});
