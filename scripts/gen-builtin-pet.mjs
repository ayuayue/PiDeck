// 一次性脚本：生成内置宠物 builtin-otter 的 spritesheet（9行×8列，单格 192×208，整图 1536×1872）。
// 运行：node scripts/gen-builtin-pet.mjs  （依赖 sharp）
// MVP-1 用到的行：0 idle / 3 waving / 5 failed / 6 waiting / 7 running；
// 其余行（1,2,4,8）画淡灰虚框占位，完整版再补齐巡游/跳跃/审批动画。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "build", "pets", "builtin-otter");
const CELL_W = 192, CELL_H = 208, COLS = 8, ROWS = 9;
const W = COLS * CELL_W, H = ROWS * CELL_H;

// 每行主色与动画类型；null 表示占位行
const ROWS_DEF = [
  { row: 0, color: "#8a909c", anim: "breathe", label: "idle" },      // 灰·呼吸
  { row: 1, color: "#16a34a", anim: "run-right", label: "running-right" },
  { row: 2, color: "#16a34a", anim: "run-left", label: "running-left" },
  { row: 3, color: "#2563eb", anim: "wave", label: "waving" },       // 蓝·挥手
  { row: 4, color: "#8b5cf6", anim: "jump", label: "jumping" },
  { row: 5, color: "#dc2626", anim: "fail", label: "failed" },      // 红·出错闪烁
  { row: 6, color: "#b45309", anim: "wait", label: "waiting" },    // 琥珀·等待脉动
  { row: 7, color: "#16a34a", anim: "run", label: "running" },     // 绿·工作旋转
  { row: 8, color: "#0ea5e9", anim: "review", label: "review" },
];

function frameSVG(row, col, def) {
  const cx = col * CELL_W + CELL_W / 2;
  const cy = row * CELL_H + CELL_H / 2;
  const t = col; // 0..7 帧相位
  if (!def.anim) {
    // 占位行：淡灰虚框 + 行号
    return `<rect x="${col * CELL_W + 8}" y="${row * CELL_H + 8}" width="${CELL_W - 16}" height="${CELL_H - 16}" fill="none" stroke="#e3e6ec" stroke-dasharray="6 6" rx="16"/><text x="${cx}" y="${cy + 5}" font-family="sans-serif" font-size="22" fill="#cfd3dc" text-anchor="middle">${def.label}</text>`;
  }
  const parts = [];
  switch (def.anim) {
    case "breathe": {
      const r = 58 + 6 * Math.sin((t / 8) * Math.PI * 2);
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${def.color}" opacity="0.9"/>`);
      parts.push(`<circle cx="${cx - 18}" cy="${cy - 8}" r="6" fill="#fff"/><circle cx="${cx + 18}" cy="${cy - 8}" r="6" fill="#fff"/><circle cx="${cx - 18}" cy="${cy - 6}" r="3" fill="#1a1d24"/><circle cx="${cx + 18}" cy="${cy - 6}" r="3" fill="#1a1d24"/>`);
      break;
    }
    case "fail": {
      // 出错：闪烁透明度 + X 眼
      const op = t % 2 === 0 ? 0.95 : 0.55;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="60" fill="${def.color}" opacity="${op}"/>`);
      const ex = 16;
      parts.push(`<line x1="${cx - ex - 6}" y1="${cy - ex - 6}" x2="${cx - ex + 6}" y2="${cy - ex + 6}" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`);
      parts.push(`<line x1="${cx - ex + 6}" y1="${cy - ex - 6}" x2="${cx - ex - 6}" y2="${cy - ex + 6}" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`);
      parts.push(`<line x1="${cx + ex - 6}" y1="${cy - ex - 6}" x2="${cx + ex + 6}" y2="${cy - ex + 6}" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`);
      parts.push(`<line x1="${cx + ex + 6}" y1="${cy - ex - 6}" x2="${cx + ex - 6}" y2="${cy - ex + 6}" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`);
      break;
    }
    case "wait": {
      // 等待：脉动 + 三点加载（依次亮）
      const r = 56 + 5 * Math.sin((t / 8) * Math.PI * 2);
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${def.color}" opacity="0.85"/>`);
      for (let i = 0; i < 3; i++) {
        const dx = cx - 18 + i * 18;
        const on = (t + i) % 3 === 0;
        parts.push(`<circle cx="${dx}" cy="${cy + 22}" r="5" fill="${on ? "#fff" : "#fef3c7"}"/>`);
      }
      break;
    }
    case "run": {
      // 工作：绿色稳定 + 旋转齿轮标记
      parts.push(`<circle cx="${cx}" cy="${cy}" r="60" fill="${def.color}"/>`);
      const ang = (t / 8) * 360;
      parts.push(`<g transform="rotate(${ang} ${cx} ${cy})"><path d="M ${cx} ${cy - 38} L ${cx + 10} ${cy - 24} L ${cx - 10} ${cy - 24} Z" fill="#fff"/></g>`);
      parts.push(`<circle cx="${cx}" cy="${cy}" r="14" fill="#fff" opacity="0.9"/>`);
      break;
    }
    case "wave": {
      // 挥手：蓝色 + 右侧手摆动
      parts.push(`<circle cx="${cx - 6}" cy="${cy}" r="58" fill="${def.color}"/>`);
      const handY = cy - 30 + 12 * Math.sin((t / 8) * Math.PI * 2);
      parts.push(`<circle cx="${cx + 44}" cy="${handY}" r="11" fill="${def.color}"/>`);
      parts.push(`<rect x="${cx + 24}" y="${(cy + handY) / 2 - 5}" width="22" height="10" fill="${def.color}" rx="5" transform="rotate(${t * 8} ${cx + 34} ${(cy + handY) / 2})"/>`);
      break;
    }
    case "run-right": {
      // 右向巡游：绿色圆 + 右箭头平移
      const dx = (t - 3.5) * 12;
      parts.push(`<circle cx="${cx + dx}" cy="${cy}" r="56" fill="${def.color}"/>`);
      parts.push(`<polygon points="${cx + dx},${cy - 16} ${cx + dx + 22},${cy} ${cx + dx},${cy + 16}" fill="#fff" opacity="0.8"/>`);
      parts.push(`<circle cx="${cx + dx - 16}" cy="${cy - 6}" r="5" fill="#fff"/><circle cx="${cx + dx + 16}" cy="${cy - 6}" r="5" fill="#fff"/>`);
      parts.push(`<circle cx="${cx + dx - 16}" cy="${cy - 4}" r="2.5" fill="#1a1d24"/><circle cx="${cx + dx + 16}" cy="${cy - 4}" r="2.5" fill="#1a1d24"/>`);
      break;
    }
    case "run-left": {
      // 左向巡游：绿色圆 + 左箭头平移
      const dx = -(t - 3.5) * 12;
      parts.push(`<circle cx="${cx + dx}" cy="${cy}" r="56" fill="${def.color}"/>`);
      parts.push(`<polygon points="${cx + dx},${cy - 16} ${cx + dx - 22},${cy} ${cx + dx},${cy + 16}" fill="#fff" opacity="0.8"/>`);
      parts.push(`<circle cx="${cx + dx - 16}" cy="${cy - 6}" r="5" fill="#fff"/><circle cx="${cx + dx + 16}" cy="${cy - 6}" r="5" fill="#fff"/>`);
      parts.push(`<circle cx="${cx + dx - 16}" cy="${cy - 4}" r="2.5" fill="#1a1d24"/><circle cx="${cx + dx + 16}" cy="${cy - 4}" r="2.5" fill="#1a1d24"/>`);
      break;
    }
    case "jump": {
      // 跳跃：紫色圆 + 上下弹跳
      const jy = -Math.abs(Math.sin((t / 8) * Math.PI * 2)) * 40;
      const squash = 1 + (jy > -5 ? 0.12 : -0.08) * Math.cos((t / 8) * Math.PI);
      parts.push(`<ellipse cx="${cx}" cy="${cy + jy}" rx="${56 * squash}" ry="${56 / squash}" fill="${def.color}"/>`);
      parts.push(`<circle cx="${cx - 16}" cy="${cy + jy - 10}" r="5" fill="#fff"/><circle cx="${cx + 16}" cy="${cy + jy - 10}" r="5" fill="#fff"/>`);
      parts.push(`<circle cx="${cx - 14}" cy="${cy + jy - 8}" r="2.5" fill="#1a1d24"/><circle cx="${cx + 14}" cy="${cy + jy - 8}" r="2.5" fill="#1a1d24"/>`);
      break;
    }
    case "review": {
      // 审查：浅蓝圆 + 放大镜旋转
      parts.push(`<circle cx="${cx}" cy="${cy}" r="56" fill="${def.color}" opacity="0.85"/>`);
      const magR = 18;
      const ang = (t / 8) * 360;
      parts.push(`<g transform="rotate(${ang} ${cx} ${cy})">`);
      parts.push(`<circle cx="${cx}" cy="${cy - 16}" r="${magR}" fill="none" stroke="#fff" stroke-width="5"/>`);
      parts.push(`<line x1="${cx + 10}" y1="${cy + 6}" x2="${cx + 18}" y2="${cy + 14}" stroke="#fff" stroke-width="4" stroke-linecap="round"/>`);
      parts.push(`</g>`);
      break;
    }
  }
  return parts.join("");
}

// 拼接整张 SVG
let body = "";
for (const def of ROWS_DEF) {
  for (let col = 0; col < COLS; col++) {
    body += frameSVG(def.row, col, def);
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="none"/>${body}</svg>`;

mkdirSync(outDir, { recursive: true });

try {
  const { default: sharpInit } = await import("sharp");
  await sharpInit(Buffer.from(svg)).webp({ quality: 90 }).toFile(join(outDir, "spritesheet.webp"));
  console.log("✓ spritesheet.webp 生成完成:", outDir);
} catch (err) {
  // 无 sharp 时退化为写 SVG（运行时 PetSpriteSheet 也可加载 SVG）
  writeFileSync(join(outDir, "spritesheet.svg"), svg);
  console.log("⚠ sharp 不可用，已写 SVG 占位:", outDir, err.message);
}

const petJson = {
  id: "builtin-otter",
  displayName: "Boba Otter",
  description: "Pideck 内置水獭 · 随 Agent 状态变换",
  spritesheetPath: "spritesheet.webp",
  gridCols: COLS,
  gridRows: ROWS,
  cellWidth: CELL_W,
  cellHeight: CELL_H,
};
writeFileSync(join(outDir, "pet.json"), JSON.stringify(petJson, null, 2));
console.log("✓ pet.json 生成完成");