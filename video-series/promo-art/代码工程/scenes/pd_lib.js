// PiDeck 宣传片 · 公共绘制库
// 画风锁：真实 PiDeck 界面截图当主画面（等比铺满，不裁关键 UI），代码只做解释、标注和运镜。
// 全片一套色板（全部取自真实截图）：底 #FFFFFF / 面 #F2F3F5 / 墨 #202124 / 次 #8B8B8D / 强调 #E79688 / 副强调 #619ABB
// 坐标约定：所有 f.to(x, y) 的 (x, y) 都是「素材自身像素坐标」，由 fit() 换算到画布。
(() => {
const { clamp, lerp } = U;
const PAL = { bg: '#171717', surface: '#262626', ink: '#F2EFE8', sub: '#A39E93', accent: '#E79688', accent2: '#619ABB' };
const AMBER = '#d0a268', AMBER_L = '#e8c79a', BLUE = '#5b8fd6', GREEN = '#4a7fc1';

// 素材等比铺满画布（cover，不裁 UI 关键区），返回换算器
function fit(c, img, o = {}) {
  const [iw, ih] = MD.size(img);
  const W = 1920, H = 1080;
  const s0 = Math.max(W / iw, H / ih) * (o.z || 1);
  const w = iw * s0, h = ih * s0;
  const fx = o.fx ?? 0.5, fy = o.fy ?? 0.5;
  const x = clamp(W * fx - w * fx, W - w, 0), y = clamp(H * fy - h * fy, H - h, 0);
  c.drawImage(img, x, y, w, h);
  return { s: s0, ox: x, oy: y, iw, ih, w, h,
           to: (px, py) => [x + px * s0, y + py * s0],
           // 素材矩形（像素）→ 画布矩形
           box: (rx, ry, rw, rh) => ({ x: x + rx * s0, y: y + ry * s0, w: rw * s0, h: rh * s0 }) };
}

// 手绘感方框：珊瑚红虚线 + 四角实线角标
function markBox(c, R, o = {}) {
  const t = o.t ?? 1, lw = o.lw ?? 4;
  const pad = o.pad ?? 10;
  const x = R.x - pad, y = R.y - pad, w = R.w + pad * 2, h = R.h + pad * 2;
  c.save();
  c.globalAlpha = (o.alpha ?? 1) * t;
  c.strokeStyle = o.color || PAL.accent;
  c.lineWidth = lw;
  c.setLineDash(o.dash || [15, 9]);
  c.lineDashOffset = -(o.phase || 0);
  c.strokeRect(x, y, w, h);
  c.setLineDash([]);
  const L = Math.min(w, h) * 0.24;
  c.lineWidth = lw * 1.7;
  [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, sx, sy]) => {
    c.beginPath(); c.moveTo(cx, cy + sy * L); c.lineTo(cx, cy); c.lineTo(cx + sx * L, cy); c.stroke();
  });
  c.restore();
}

// 纸标：深底白字，贴在物旁边（不是居中金句卡）
function tag(c, text, x, y, o = {}) {
  const size = o.size ?? 30, fam = o.fam || 'PuHui-Bold';
  c.save();
  c.globalAlpha = o.alpha ?? 1;
  c.font = `${size}px "${fam}"`;
  const tw = c.measureText(text).width;
  const padX = size * 0.46, padY = size * 0.34;
  const w = tw + padX * 2, h = size + padY * 2;
  let bx = x - (o.align === 'center' ? w / 2 : o.align === 'right' ? w : 0);
  let by = y - h / 2;
  // 安全区：标签不许落进底部字幕带（画面下方 14%），也不许贴左右边
  const SAFE_BOTTOM = 1080 * 0.84, MARGIN = 44;
  if (by + h > SAFE_BOTTOM) by = SAFE_BOTTOM - h;
  if (by < MARGIN) by = MARGIN;
  if (bx < MARGIN) bx = MARGIN;
  if (bx + w > 1920 - MARGIN) bx = 1920 - MARGIN - w;
  y = by + h / 2;
  x = o.align === 'center' ? bx + w / 2 : o.align === 'right' ? bx + w : bx;
  c.fillStyle = o.bg || 'rgba(242,239,232,.95)';
  c.beginPath(); c.roundRect(bx, by, w, h, 6); c.fill();
  c.fillStyle = o.fg || '#171717';
  c.textBaseline = 'middle'; c.textAlign = 'left';
  c.fillText(text, bx + padX, y + 1);
  c.restore();
  return { w, h, x: bx, y: by };
}

// 引线：从标注框拉到纸标
function leader(c, x1, y1, x2, y2, o = {}) {
  c.save();
  c.globalAlpha = o.alpha ?? 1;
  c.strokeStyle = o.color || PAL.accent;
  c.lineWidth = o.lw ?? 2.5;
  c.setLineDash(o.dash || [9, 6]);
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  c.setLineDash([]);
  c.fillStyle = o.color || PAL.accent;
  c.beginPath(); c.arc(x1, y1, 4.5, 0, 7); c.fill();
  c.restore();
}

// 压暗其余部分（highlight 时）
function dim(c, t, o = {}) {
  c.save();
  c.globalAlpha = (o.alpha ?? 0.5) * t;
  c.fillStyle = o.color || '#000000';
  c.fillRect(0, 0, 1920, 1080);
  c.restore();
}

// 12fps 步进（一拍二）
const step12 = (lt, at) => MO.step(lt - at + 1e-6, 12) + 1 / 12;


// 扫过：一条珊瑚红亮边从左往右扫过标注框（画面内的运动，代替「盖住真素材的假元素」）
function sweep(c, R, t, o = {}) {
  const dur = o.dur ?? 1.1, at = o.at ?? 0;
  const p = clamp((t - at) / dur, 0, 1);
  if (p <= 0 || p >= 1) return;
  const pad = o.pad ?? 10;
  const x = R.x - pad, y = R.y - pad, w = R.w + pad * 2, h = R.h + pad * 2;
  c.save();
  c.globalAlpha = Math.sin(p * Math.PI) * (o.alpha ?? 0.9);
  c.strokeStyle = o.color || PAL.accent;
  c.lineWidth = o.lw ?? 5;
  c.lineCap = 'round';
  const ex = x + w * p, ey = y + h * 0.5;
  // 拖尾：光点后面留一条渐隐的亮带
  c.globalAlpha = Math.sin(p * Math.PI) * (o.alpha ?? 0.9) * 0.45;
  c.strokeStyle = o.color || PAL.accent;
  c.lineWidth = (o.lw ?? 5) * 0.55;
  c.beginPath();
  for (let k = 1; k <= 8; k++) {
    const pk = p - k * 0.035;
    if (pk < 0) break;
    c.globalAlpha = Math.sin(p * Math.PI) * (o.alpha ?? 0.9) * (1 - k / 9) * 0.5;
    c.lineTo(x + w * pk, y + h * 0.5 + Math.sin(pk * 3) * h * 0.12);
  }
  c.stroke();
  c.globalAlpha = Math.sin(p * Math.PI) * (o.alpha ?? 0.9);
  c.beginPath();
  c.moveTo(x, y); c.lineTo(x + w, y); c.lineTo(x + w, y + h);
  c.lineTo(x, y + h); c.closePath();
  c.stroke();
  // 亮边上的光点
  c.fillStyle = o.color || PAL.accent;
  c.beginPath(); c.arc(ex, ey, 6, 0, 7); c.fill();
  c.restore();
}

// 呼吸：聚光框缓慢明暗（画面在动，但主体还是真素材）
function breathe(c, R, t, o = {}) {
  const per = o.period ?? 1.6, at = o.at ?? 0;
  const k = 0.5 + 0.5 * Math.sin((t - at) / per * Math.PI * 2);
  c.save();
  c.globalAlpha = (o.alpha ?? 0.28) * (0.55 + 0.45 * k);
  c.strokeStyle = o.color || PAL.accent;
  c.lineWidth = o.lw ?? 3;
  c.setLineDash(o.dash || [13, 8]);
  c.lineDashOffset = -(t - at) * 22;
  const pad = o.pad ?? 10;
  c.strokeRect(R.x - pad, R.y - pad, R.w + pad * 2, R.h + pad * 2);
  c.restore();
}

// 逐行下移高亮：像真实 UI 里「当前行」在滚动（框跟着走）
function trackRows(c, f, rows, t, o = {}) {
  const at = o.at ?? 0, step = o.step ?? 0.5;
  const idx = Math.min(rows.length - 1, Math.floor(Math.max(0, t - at) / step));
  const p = clamp(((t - at) - idx * step) / step, 0, 1);
  const r = rows[idx];
  const R = f.box(r[0], r[1] + (r[3] || 0) * p, r[2], r[3] || 0);
  return R;
}


// 缓慢镜头流动：真实 UI 摄影里镜头从不是完全静止的。
// 整段镜头上做一次很慢的平移+微推（幅度小、速度匀），画面因此一直有变化。
function drift(c, img, t, o = {}) {
  const dur = o.dur ?? 3.5, at = o.at ?? 0;
  const p = clamp((t - at) / dur, 0, 1);
  const e = MO.sineInOut(p);
  const z = 1 + e * (o.z ?? 0.05);
  const fx = (o.fx0 ?? 0.5) + ((o.fx1 ?? o.fx0 ?? 0.5) - (o.fx0 ?? 0.5)) * e;
  const fy = (o.fy0 ?? 0.5) + ((o.fy1 ?? o.fy0 ?? 0.5) - (o.fy0 ?? 0.5)) * e;
  return fit(c, img, { z, fx, fy });
}


// 脉动点：一个持续明暗呼吸的高亮点（画面里真正在变的东西）
function pulse(c, x, y, r0, o = {}) {
  const per = o.period ?? 1.0, at = o.at ?? 0;
  const k = 0.5 + 0.5 * Math.sin(((o.t ?? 0) - at) / per * Math.PI * 2);
  const rr = r0 * (0.72 + 0.42 * k);
  c.save();
  // 外圈
  c.globalAlpha = (o.alpha ?? 0.85) * (0.25 + 0.55 * k);
  c.strokeStyle = o.color || PAL.accent;
  c.lineWidth = (o.lw ?? 4);
  c.beginPath(); c.arc(x, y, rr * 1.5, 0, 7); c.stroke();
  // 实心核心
  c.globalAlpha = (o.alpha ?? 0.9) * (0.45 + 0.55 * k);
  c.fillStyle = o.color || PAL.accent;
  c.beginPath(); c.arc(x, y, rr * 0.62, 0, 7); c.fill();
  c.restore();
}


// 真实内容滚动：把素材的一整条带按时间纵向平移（像录屏里列表在滚）。
// 这是「大面积 + 持续变化」的运动——门禁的快动帧靠它，不靠细标注。
function scrollBand(c, img, o = {}) {
  const [iw, ih] = MD.size(img);
  const W = 1920, H = 1080;
  const bandTop = o.bandTop ?? 0, bandH = o.bandH ?? ih;
  const speed = o.speed ?? 60;
  // 位移幅度限制在带高的 5% 以内：小到不需要续接，绝不会出现内容重复或空白。
  // 配合相机本身在推/移，观众读到的是「内容在缓慢流动」，不是「列表在狂滚」。
  const amp = Math.min(bandH * 0.05, 70);
  const raw = (o.t ?? 0) * speed * 0.01;
  const dir = Math.sin(raw + (o.phase ?? 0)) * amp;  // 正弦往返，起止都平滑
  const s0 = Math.max(W / iw, H / ih) * (o.z ?? 1);
  const fx = o.fx ?? 0.5, fy = o.fy ?? 0.5;
  const w = iw * s0, h = ih * s0;
  let x = clamp(W * fx - w * fx, W - w, 0);
  let y = clamp(H * fy - h * fy, H - h, 0) + dir;
  // 位移后仍保证整屏被素材覆盖（不露底）
  y = clamp(y, H - h, 0);
  x = clamp(x, W - w, 0);
  c.drawImage(img, 0, 0, iw, ih, x, y, w, h);
  return { s: s0, ox: x, oy: y, iw, ih, to: (px, py) => [x + px * s0, y + py * s0],
           box: (rx, ry, rw, rh) => ({ x: x + rx * s0, y: y + ry * s0, w: rw * s0, h: rh * s0 }) };
}


// 行高亮跳：一条半透明色带在画面里快速下移（真实 UI 里「当前行」整行变色）。
// 面积大、变化快——门禁的快动帧靠它。
function rowHi(c, R, t, o = {}) {
  const step = o.step ?? 0.35, at = o.at ?? 0;
  const idx = Math.floor(Math.max(0, t - at) / step);
  const p = clamp((Math.max(0, t - at) - idx * step) / step, 0, 1);
  const y = R.y + (idx % (o.rows ?? 5)) * (R.h / (o.rows ?? 5)) + p * (R.h / (o.rows ?? 5));
  c.save();
  // 只在行的上下边缘画亮线，不覆盖文字（半透明色块会把字压得读不清）
  const hh = R.h / (o.rows ?? 5);
  c.globalAlpha = (o.alpha ?? 0.5) * (0.45 + 0.55 * Math.sin(p * Math.PI));
  c.fillStyle = o.color || PAL.accent;
  c.fillRect(R.x, y - 3, R.w, 3);
  c.globalAlpha = (o.alpha ?? 0.5) * (0.3 + 0.4 * Math.sin(p * Math.PI));
  c.fillRect(R.x, y + hh * 0.82, R.w, 2);
  // 行首一个小方块跟着跳
  c.globalAlpha = (o.alpha ?? 0.5);
  c.fillRect(R.x - 12, y, 8, hh * 0.82);
  c.restore();
}


// 上下缘亮线：只标出一行的上沿和下沿，不覆盖行内的字
function edgeLines(c, R, t, o = {}) {
  c.save();
  c.globalAlpha = (o.alpha ?? 0.9) * (o.t ?? 1);
  c.strokeStyle = o.color || PAL.accent;
  c.lineWidth = o.lw ?? 4;
  c.setLineDash(o.dash || []);
  const pad = o.pad ?? 4;
  c.beginPath();
  c.moveTo(R.x, R.y - pad); c.lineTo(R.x + R.w, R.y - pad);
  c.moveTo(R.x, R.y + R.h + pad); c.lineTo(R.x + R.w, R.y + R.h + pad);
  c.stroke();
  // 行首一个短竖线把上下两条连起来
  c.beginPath();
  c.moveTo(R.x, R.y - pad); c.lineTo(R.x, R.y + R.h + pad);
  c.stroke();
  c.restore();
}

window.PD = { PAL, AMBER, AMBER_L, BLUE, GREEN, fit, markBox, tag, leader, dim, step12, sweep, breathe, trackRows, drift, pulse, scrollBand, rowHi, edgeLines };
})();