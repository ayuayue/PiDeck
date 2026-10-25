// 媒介层：把「干净的形」过一遍真实的画材，而不是在扁平矢量上盖噪点。2026-10-16 新增，新风格演示（38–54）用。
//   MEDIUM.figure(c, o)            有体量的着衣人物：钟形袍＋披风褶＋袖＋手＋简化脸（视线是主角）。只给原创平面/壁画/细密画一类明确选择的风格用
//   MEDIUM.plaster(key, o)         灰泥墙底：低频湿干色差＋颗粒＋针孔＋接缝（壁画「一天的活」边），缓存
//   MEDIUM.fresco(c, plate, o)     壁画通道：色粉被石灰吃进去（轻糊＋粉白罩）＋灰泥相乘＋针孔提亮＋接缝
//   MEDIUM.silk(key, o)            绢/纸底：经纬丝纹＋泛黄晕边，缓存
//   MEDIUM.outline(c, path, o)     轮廓线：可变线宽、颜色可偏（赭褐、群青、墨），不是纯黑
//   MEDIUM.flat(c, path, fill, o)  掐丝珐琅式平涂：同色块里有顺笔向的短条＋粗而不均的深群青轮廓（高更）
//   MEDIUM.broken(src, o)          破碎色笔触重绘：把干净的画布重画成一笔一笔的印象派（明处偏暖、暗处偏冷的互补抖动），返回新画布，调用方缓存
//   MEDIUM.hatchFill(c, path, o)   在路径内按方向排线（木刻/铜版/细密画暗部）
// 约定：所有随机走种子；plate 是画好的 1920×1080 离屏画布；通道函数不改 plate。
(() => {
let W = 1920, H = 1080; U.onStage((w, h) => { W = w; H = h; });
const P = window.PAINT, { clamp, lerp, rng, ss } = U, TAU = Math.PI * 2;
const M = window.MEDIUM = {};

const hex = h => P.hex(h);
const mixc = (a, b, t) => P.mix(typeof a === 'string' ? hex(a) : a, typeof b === 'string' ? hex(b) : b, t);
const css = (c, a = 1) => P.rgb(typeof c === 'string' ? hex(c) : c, a);
M.css = css; M.mix = mixc;

// ---------- 灰泥 ----------
// 壁画不是纸：石灰层有低频的湿干色差、细颗粒、针孔；一天的活（giornata）之间有一道几乎看不见的接缝。
M.plaster = (key, { base = '#d9cdb4', seams = [], seed = 7, pits = 1400, mottle = 0.07 } = {}) => P.cached('plaster_' + key, W, H, (g) => {
  const r = rng(seed), im = g.createImageData(W, H), d = im.data, b = hex(base);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const m = P.fbm(x * 0.0035 + seed, y * 0.0035, 4) * mottle * 255 + P.fbm(x * 0.02, y * 0.02 + seed, 3) * 0.035 * 255;
    const f = (r() - 0.5) * 16;                                   // 细颗粒
    d[i] = clamp(b[0] + m + f, 0, 255); d[i + 1] = clamp(b[1] + m + f, 0, 255); d[i + 2] = clamp(b[2] + m * 0.9 + f, 0, 255); d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  for (let i = 0; i < pits; i++) {                                // 针孔：暗点＋右下一侧的亮边
    const x = r() * W, y = r() * H, s = 0.6 + r() * 1.9;
    g.fillStyle = `rgba(70,55,40,${0.12 + r() * 0.22})`; g.beginPath(); g.arc(x, y, s, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,250,235,.28)'; g.beginPath(); g.arc(x + s * 0.7, y + s * 0.7, s * 0.55, 0, TAU); g.fill();
  }
  g.lineCap = 'round';
  for (const sm of seams) {                                       // 接缝：[[x,y],...] 折线；一条亮脊＋一条暗线，两侧底色略差
    g.strokeStyle = 'rgba(80,62,45,.22)'; g.lineWidth = 1.6; g.beginPath(); sm.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke();
    g.strokeStyle = 'rgba(255,248,230,.34)'; g.lineWidth = 1.4; g.beginPath(); sm.forEach((p, k) => k ? g.lineTo(p[0], p[1] + 2) : g.moveTo(p[0], p[1] + 2)); g.stroke();
  }
});

// 壁画通道：plate（干净的形）→ 画面。
// ① 轻糊（色粉被湿灰泥吃进去，边缘不锐）② 石灰粉白罩（screen 低 α，整体粉、哑）③ 灰泥相乘（底色差、颗粒）④ 针孔和接缝提亮
M.fresco = (c, plate, { ground, chalk = 0.10, soften = 0.8, plasterAlpha = 0.55, sat = 0.9, tone = null } = {}) => {
  c.save();
  c.filter = `blur(${soften}px) saturate(${sat})`; c.drawImage(plate, 0, 0); c.filter = 'none';
  c.globalCompositeOperation = 'screen'; c.fillStyle = `rgba(236,226,206,${chalk})`; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'multiply'; c.globalAlpha = plasterAlpha; c.drawImage(ground, 0, 0);
  c.globalCompositeOperation = 'soft-light'; c.globalAlpha = 0.5; c.drawImage(ground, 0, 0);
  if (tone) { c.globalCompositeOperation = 'multiply'; c.globalAlpha = 1; c.fillStyle = tone; c.fillRect(0, 0, W, H); }
  c.restore();
};

// ---------- 绢 / 纸底 ----------
M.silk = (key, { base = '#c9a85e', seed = 3, warp = 0.5, vig = 0.5, fleck = 1800 } = {}) => P.cached('silk_' + key, W, H, (g) => {
  const r = rng(seed), b = hex(base);
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, css(mixc(b, [255, 240, 200], 0.18))); gr.addColorStop(1, css(mixc(b, [120, 80, 30], 0.12)));
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.globalAlpha = 0.5; g.drawImage(P.texture('silk' + key, base, { scale: 0.003, amt: 14, grain: 5, seed }), 0, 0); g.globalAlpha = 1;
  for (let x = 0; x < W; x += 3) { g.fillStyle = `rgba(90,60,20,${(0.02 + r() * 0.045) * warp})`; g.fillRect(x, 0, 1, H); }       // 经线
  for (let y = 0; y < H; y += 3) { g.fillStyle = `rgba(255,236,170,${(0.015 + r() * 0.04) * warp})`; g.fillRect(0, y, W, 1); }     // 纬线
  for (let i = 0; i < fleck; i++) { g.fillStyle = r() < 0.5 ? 'rgba(80,55,25,.10)' : 'rgba(255,240,200,.14)'; g.fillRect(r() * W, r() * H, 1 + r() * 4, 1); }
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.75); v.addColorStop(0, 'rgba(80,50,15,0)'); v.addColorStop(1, `rgba(80,50,15,${vig * 0.5})`);
  g.fillStyle = v; g.fillRect(0, 0, W, H);
});

// ---------- 线 ----------
// 沿 pts 画变宽线：w 为 [起,中,尾] 宽度，col 颜色。不是纯黑——给素描红土/群青/墨色。
M.outline = (c, pts, { w = [1, 3, 1], col = '#4a3322', a = 0.9, closed = false, jitter = 0, seed = 1 } = {}) => {
  const r = rng(seed), n = pts.length;
  c.save(); c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = typeof col === 'string' ? col : css(col, a); c.globalAlpha = a;
  const seg = closed ? n : n - 1;
  for (let i = 0; i < seg; i++) {
    const A = pts[i], B = pts[(i + 1) % n], q = i / Math.max(1, seg - 1);
    c.lineWidth = q < 0.5 ? lerp(w[0], w[1], q * 2) : lerp(w[1], w[2], (q - 0.5) * 2);
    c.beginPath(); c.moveTo(A[0] + (r() - .5) * jitter, A[1] + (r() - .5) * jitter); c.lineTo(B[0] + (r() - .5) * jitter, B[1] + (r() - .5) * jitter); c.stroke();
  }
  c.restore();
};

M.hatchFill = (c, path, { ang = 0.9, gap = 5, col = 'rgba(40,30,20,.35)', lw = 1, bounds = [0, 0, W, H], seed = 1 } = {}) => {
  const r = rng(seed); c.save(); c.clip(path); c.strokeStyle = col; c.lineWidth = lw; c.beginPath();
  const [bx, by, bw, bh] = bounds, R = Math.hypot(bw, bh), cx = bx + bw / 2, cy = by + bh / 2, ca = Math.cos(ang), sa = Math.sin(ang);
  for (let k = -R; k < R; k += gap) { const j = (r() - .5) * 1.2; c.moveTo(cx + ca * -R - sa * (k + j), cy + sa * -R + ca * (k + j)); c.lineTo(cx + ca * R - sa * (k + j), cy + sa * R + ca * (k + j)); }
  c.stroke(); c.restore();
};

// ---------- 掐丝珐琅式平涂（高更/综合主义）----------
// path: Path2D；fill: 色；o.streak: 笔向（弧度），o.vari: 色差幅度；o.line: 轮廓色（深群青/紫黑，不是纯黑），o.lw: 轮廓宽
// 平涂不等于平：同一色块里有顺笔向的明暗短条（看得见刷子），轮廓粗而不均。每块用 o.seed 固定笔触，确定性。
M.flat = (c, path, fill, { streak = 0.7, vari = 18, line = '#1d2a52', lw = 6, seed = 1, bounds = [0, 0, W, H], n = 46, la = 0.95 } = {}) => {
  const r = rng(seed * 131), f = typeof fill === 'string' ? hex(fill) : fill;
  c.save(); c.fillStyle = css(f); c.fill(path); c.clip(path);
  const [bx, by, bw, bh] = bounds;
  c.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const x = bx + r() * bw, y = by + r() * bh, L = 40 + r() * 120, a = streak + (r() - .5) * 0.25, d = (r() - .5) * 2 * vari;
    c.strokeStyle = css([f[0] + d, f[1] + d * 0.8, f[2] + d * 0.7], 0.55); c.lineWidth = 8 + r() * 22;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); c.stroke();
  }
  c.restore();
  if (lw) { c.save(); c.strokeStyle = line; c.globalAlpha = la; c.lineWidth = lw; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke(path); c.restore(); }
};

// ---------- 破碎色笔触重绘（印象派：毕沙罗/西斯莱/瓜尔迪/雷诺阿）----------
// src：画好的干净画布（可比舞台宽，如拖动的天空）；返回新画布（调用方缓存）。
// 每个采样点画一小笔：沿 angleFn(x,y) 方向、两头尖的弯笔，颜色＝该点颜色按「明暗＋冷暖互补」抖动——
// 亮处偏暖黄/粉、暗处偏冷紫/蓝（不是单纯明度噪声）；随机跳过一些点让底色透出；笔序确定性打乱，所以厚笔压薄笔。
// o: cell 采样间距, len 笔长, wid 笔宽, passes 遍数（第二遍更小更碎）, angle(x,y)→弧度, seed, warm/cool 互补抖动色, sat 饱和度增益
M.broken = (src, { cell = 9, len = 26, wid = 8, passes = 2, angle = () => 0, seed = 1, warm = [255, 226, 160], cool = [120, 120, 190], jit = 22, skip = 0.1, sat = 1.06, base = true } = {}) => {
  const w = src.width, h = src.height, out = P.canvas(w, h), g = out.getContext('2d');
  const sg = src.getContext('2d', { willReadFrequently: true }), d = sg.getImageData(0, 0, w, h).data, r = rng(seed * 977);
  if (base) { g.filter = 'blur(6px)'; g.drawImage(src, -14, -14, w + 28, h + 28); g.filter = 'none'; }   // 外扩 14px 再糊：边缘不留半透明圈（左缘一排缺口小圆点就是这么来的）
  g.lineCap = 'round';
  for (let pass = 0; pass < passes; pass++) {
    const cs = cell * (pass ? 0.62 : 1), L = len * (pass ? 0.6 : 1), Wd = wid * (pass ? 0.6 : 1), pts = [];
    for (let y = 0; y < h + cs; y += cs) for (let x = 0; x < w + cs; x += cs) pts.push([x + (r() - .5) * cs, y + (r() - .5) * cs]);
    for (let i = pts.length - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [pts[i], pts[j]] = [pts[j], pts[i]]; }
    for (const [x, y] of pts) {
      if (r() < skip) continue;
      const xi = clamp(x | 0, 0, w - 1), yi = clamp(y | 0, 0, h - 1), k = (yi * w + xi) * 4;
      if (d[k + 3] < 8) continue;
      let R = d[k], G = d[k + 1], B = d[k + 2];
      const lum = (R * 0.3 + G * 0.59 + B * 0.11) / 255, t2 = (r() - 0.5) * 2;
      const tint = lum > 0.55 ? warm : cool, tm = Math.abs(t2) * 0.22 * (lum > 0.55 ? lum : 1 - lum);
      R = lerp(R, tint[0], tm) + t2 * jit * 0.5; G = lerp(G, tint[1], tm) + t2 * jit * 0.45; B = lerp(B, tint[2], tm) + t2 * jit * 0.4;
      const mx = (R + G + B) / 3; R = mx + (R - mx) * sat; G = mx + (G - mx) * sat; B = mx + (B - mx) * sat;
      const a = angle(x, y) + (r() - .5) * 0.35, l = L * (0.6 + r() * 0.8), wd = Wd * (0.6 + r() * 0.7), bend = (r() - .5) * 0.5 * l;
      const cx = Math.cos(a), sx = Math.sin(a);
      g.strokeStyle = `rgb(${clamp(R, 0, 255) | 0},${clamp(G, 0, 255) | 0},${clamp(B, 0, 255) | 0})`; g.globalAlpha = 0.9; g.lineWidth = wd;
      g.beginPath(); g.moveTo(x - cx * l / 2, y - sx * l / 2); g.quadraticCurveTo(x - sx * bend, y + cx * bend, x + cx * l / 2, y + sx * l / 2); g.stroke();
    }
  }
  g.globalAlpha = 1; return out;
};

// ---------- 有体量的着衣人物 ----------
// o: x,y（脚底中心）, h（全高）, robe:[亮,中,暗], under（内衣露出色）, mantle（披风色组或 null）, skin, hair,
//    face（-1 朝左／1 朝右）, lean（髋以上前倾，弧度，朝 face 方向为正）, bow（低头 0..1）, gaze:[x,y]（看向哪，画眼珠）,
//    hands:[[x,y],[x,y]]（两只手的目标点，null 则自然下垂）, sway（衣摆摆动 0..1）, halo（金色光环，默认无）, line（轮廓色）
// 画法：袍＝钟形多边形＋沿宽度的明暗渐变＋数条褶线（暗线＋相邻亮线）；袖＝两段式（肩→肘→手）的变宽带；头＝椭圆＋发＋眼（视线）。
// 不画五官细节：吉卜力式大眼、乔托式「杏仁眼斜视」都靠眼珠偏向 gaze 表达关系。
M.figure = (c, o) => {
  const { x, y, h, face = 1, lean = 0, bow = 0, sway = 0, hands = [null, null], gaze = null, halo = false } = o;
  const robe = (o.robe || ['#d98a78', '#b85a4c', '#7a3a34']).map(hex), under = hex(o.under || '#e7d9b0'), skin = hex(o.skin || '#e0b48c'), hairC = hex(o.hair || '#5a3a24'), line = o.line || '#4a2f22';
  const mantle = o.mantle ? o.mantle.map(hex) : null, seed = o.seed || 1, r = rng(seed * 97);
  const hipY = y - h * 0.42, sh = h * 0.2;
  const cs = Math.cos(lean * face), sn = Math.sin(lean * face);
  const up = (dx, dy) => [x + dx * cs - dy * sn * face, hipY + dx * sn * face + dy * cs];          // 髋为原点、绕髋前倾
  const shL = up(-h * 0.15, -h * 0.30), shR = up(h * 0.15, -h * 0.30), neck = up(0, -h * 0.335);
  const head = [neck[0] + face * h * 0.014 * bow, neck[1] - h * 0.088 + h * 0.025 * bow];
  const hw = h * 0.078, hh = h * 0.094;
  c.save(); c.lineJoin = 'round'; c.lineCap = 'round';

  // 地面影
  c.fillStyle = 'rgba(40,28,18,.22)'; c.beginPath(); c.ellipse(x + face * h * 0.03, y + 3, h * 0.22, h * 0.03, 0, 0, TAU); c.fill();

  // --- 袍身 ---
  const hemW = h * (0.25 * (o.hemK || 1) + 0.012 * sway), waistW = h * 0.115, sw = Math.sin(o.t * 2.3 + seed) * sway * h * 0.012 || 0;
  const body = new Path2D();
  body.moveTo(shL[0], shL[1]); body.lineTo(neck[0] - h * 0.03, neck[1] + 4); body.lineTo(neck[0] + h * 0.03, neck[1] + 4); body.lineTo(shR[0], shR[1]);
  body.quadraticCurveTo(shR[0] + h * 0.02, hipY - h * 0.1, x + waistW, hipY + h * 0.05);
  body.quadraticCurveTo(x + hemW * 0.9 + sw, y - h * 0.18, x + hemW + sw, y);
  body.quadraticCurveTo(x, y + h * 0.018, x - hemW + sw, y);
  body.quadraticCurveTo(x - hemW * 0.9 + sw, y - h * 0.18, x - waistW, hipY + h * 0.05);
  body.quadraticCurveTo(shL[0] - h * 0.02, hipY - h * 0.1, shL[0], shL[1]); body.closePath();
  const lx = x - face * h * 0.2, gr = c.createLinearGradient(lx, 0, x + face * h * 0.26, 0);               // 光从背后一侧来：亮在 -face 侧
  gr.addColorStop(0, css(robe[0])); gr.addColorStop(0.3, css(robe[0])); gr.addColorStop(0.52, css(robe[1])); gr.addColorStop(0.82, css(robe[2])); gr.addColorStop(1, css(robe[2]));
  c.fillStyle = gr; c.fill(body);
  // 褶：先铺软的明暗大面（模糊），再压一条细硬折痕——乔托的衣褶是「大面渐变＋少数硬边」，不是排线
  const nF = 5, folds = [];
  for (let i = 0; i < nF; i++) { const q = (i + 0.5) / nF - 0.5; folds.push({ x0: x + q * h * 0.22 + (r() - .5) * h * 0.02, x1: x + q * hemW * 2 * 0.92 + sw * (0.4 + Math.abs(q)), cy: y - h * (0.22 + r() * 0.12), k: 0.7 + r() * 0.6 }); }
  c.save(); c.clip(body);
  c.filter = `blur(${Math.max(2, h * 0.012)}px)`;
  for (const f of folds) { c.strokeStyle = css(robe[2], 0.34 * f.k); c.lineWidth = h * 0.05 * f.k; c.beginPath(); c.moveTo(f.x0, hipY - h * 0.1); c.quadraticCurveTo(f.x0 + (f.x1 - f.x0) * 0.2 + face * h * 0.015, f.cy, f.x1, y - h * 0.01); c.stroke();
    c.strokeStyle = css(robe[0], 0.3 * f.k); c.lineWidth = h * 0.035 * f.k; c.beginPath(); c.moveTo(f.x0 - face * h * 0.04, hipY - h * 0.1); c.quadraticCurveTo(f.x0 + (f.x1 - f.x0) * 0.2 - face * h * 0.03, f.cy, f.x1 - face * h * 0.045, y - h * 0.01); c.stroke(); }
  c.filter = 'none';
  for (const f of folds) { c.strokeStyle = css(robe[2], 0.5); c.lineWidth = h * 0.0065; c.beginPath(); c.moveTo(f.x0, hipY - h * 0.1); c.quadraticCurveTo(f.x0 + (f.x1 - f.x0) * 0.2 + face * h * 0.015, f.cy, f.x1, y - h * 0.01); c.stroke(); }
  // 膝/腰的受力：两处弧形暗影（衣料被撑起的地方）
  c.filter = `blur(${h * 0.02}px)`; c.fillStyle = css(robe[2], 0.22); c.beginPath(); c.ellipse(x + face * h * 0.04, hipY + h * 0.12, h * 0.07, h * 0.16, 0.2 * face, 0, TAU); c.fill(); c.filter = 'none';
  // 腰带/内衣下摆
  c.fillStyle = css(under, 0.95); c.beginPath(); c.moveTo(x - hemW * 0.5 + sw, y); c.quadraticCurveTo(x + sw, y - h * 0.05, x + hemW * 0.5 + sw, y); c.quadraticCurveTo(x + sw, y + h * 0.015, x - hemW * 0.5 + sw, y); c.fill();
  c.restore();
  c.strokeStyle = line; c.globalAlpha = 0.75; c.lineWidth = Math.max(1.6, h * 0.007); c.stroke(body); c.globalAlpha = 1;

  // --- 披风：从背侧肩斜过身体盖到对侧髋，厚重的大褶 ---
  if (mantle) {
    const back = face > 0 ? shL : shR, front = face > 0 ? shR : shL, sideX = face;
    const mp = new Path2D();
    mp.moveTo(back[0] - sideX * h * 0.03, back[1] - h * 0.03);
    mp.quadraticCurveTo(neck[0], neck[1] - h * 0.015, front[0] + sideX * h * 0.015, front[1] + h * 0.02);
    mp.quadraticCurveTo(front[0] - sideX * h * 0.02, hipY, x - sideX * hemW * 0.05 + sw, y - h * 0.01);
    mp.quadraticCurveTo(x - sideX * hemW * 0.5 + sw, y + h * 0.022, x - sideX * hemW * 1.02 + sw, y);
    mp.quadraticCurveTo(back[0] - sideX * h * 0.16, hipY, back[0] - sideX * h * 0.03, back[1] - h * 0.03); mp.closePath();
    const mg = c.createLinearGradient(x - h * 0.2, 0, x + h * 0.26, 0); mg.addColorStop(0, css(mantle[0])); mg.addColorStop(0.5, css(mantle[1])); mg.addColorStop(1, css(mantle[2]));
    c.fillStyle = mg; c.fill(mp);
    c.save(); c.clip(mp);
    for (let i = 0; i < 5; i++) {
      const q = i / 4, sx = lerp(back[0], front[0], q), ex = x + (q - 0.45) * hemW * 1.8 + sw;
      c.strokeStyle = css(mantle[2], 0.5); c.lineWidth = h * 0.011; c.beginPath(); c.moveTo(sx, lerp(back[1], front[1], q) + h * 0.03); c.quadraticCurveTo(sx + sideX * h * 0.03, hipY + h * 0.03, ex, y - h * 0.01); c.stroke();
      c.strokeStyle = css(mantle[0], 0.4); c.lineWidth = h * 0.006; c.beginPath(); c.moveTo(sx - sideX * h * 0.012, lerp(back[1], front[1], q) + h * 0.03); c.quadraticCurveTo(sx + sideX * h * 0.02, hipY + h * 0.03, ex - sideX * h * 0.014, y - h * 0.01); c.stroke();
    }
    c.restore(); c.strokeStyle = line; c.globalAlpha = 0.7; c.lineWidth = Math.max(1.6, h * 0.007); c.stroke(mp); c.globalAlpha = 1;
  }

  // --- 袖与手：肩→肘→手，肘按「向外下方」弯 ---
  const sleeveCol = mantle ? mantle : robe;
  const arm = (S, T, k) => {
    if (!T) T = [S[0] + (k ? 1 : -1) * h * 0.05, S[1] + h * 0.26];
    const L1 = h * 0.17, L2 = h * 0.16, dx = T[0] - S[0], dy = T[1] - S[1], dist = Math.min(Math.hypot(dx, dy), L1 + L2 - 1), a = Math.atan2(dy, dx);
    const ca = Math.acos(clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1)), side = (T[0] > x ? 1 : -1) * (k ? 1 : -1) || 1;
    const el = [S[0] + Math.cos(a + ca * -side) * L1, S[1] + Math.sin(a + ca * -side) * L1];
    const hd = [S[0] + Math.cos(a) * dist, S[1] + Math.sin(a) * dist];
    const w0 = h * 0.078, w1 = h * 0.058, w2 = h * 0.04;
    const pts = [S, el, hd], nx = i => { const A = pts[Math.max(0, i - 1)], B = pts[Math.min(2, i + 1)], d = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1; return [-(B[1] - A[1]) / d, (B[0] - A[0]) / d]; };
    const W3 = [w0, w1, w2], L = [], R = [];
    for (let i = 0; i < 3; i++) { const n = nx(i); L.push([pts[i][0] + n[0] * W3[i] / 2, pts[i][1] + n[1] * W3[i] / 2]); R.push([pts[i][0] - n[0] * W3[i] / 2, pts[i][1] - n[1] * W3[i] / 2]); }
    const sp = new Path2D(); sp.moveTo(...L[0]); sp.quadraticCurveTo(...L[1], ...L[2]); sp.lineTo(...R[2]); sp.quadraticCurveTo(...R[1], ...R[0]); sp.closePath();
    const sg = c.createLinearGradient(S[0] - h * 0.05, S[1], hd[0] + h * 0.05, hd[1]); sg.addColorStop(0, css(sleeveCol[0])); sg.addColorStop(1, css(sleeveCol[1]));
    c.fillStyle = sg; c.fill(sp); c.strokeStyle = line; c.globalAlpha = 0.7; c.lineWidth = Math.max(1.4, h * 0.006); c.stroke(sp); c.globalAlpha = 1;
    c.strokeStyle = css(sleeveCol[2], 0.4); c.lineWidth = h * 0.007; c.beginPath(); c.moveTo(el[0], el[1]); c.quadraticCurveTo(el[0] + h * 0.01, el[1] + h * 0.03, hd[0] - h * 0.005, hd[1] - h * 0.04); c.stroke();
    c.fillStyle = css(skin); c.strokeStyle = line; c.globalAlpha = 0.8; c.lineWidth = Math.max(1.2, h * 0.005);
    // 手：掌＋拇指＋并拢的三指，朝向沿前臂方向（托物时看得出是手，不是圆片）
    c.save(); c.translate(hd[0], hd[1]); c.rotate(a);
    c.beginPath(); c.ellipse(h * 0.012, 0, h * 0.028, h * 0.022, 0, 0, TAU); c.fill(); c.stroke();
    c.beginPath(); c.ellipse(h * 0.04, h * 0.002, h * 0.026, h * 0.012, 0.08, 0, TAU); c.fill(); c.stroke();
    c.beginPath(); c.ellipse(h * 0.012, -h * 0.022 * (k ? 1 : -1), h * 0.016, h * 0.008, 0.5 * (k ? 1 : -1), 0, TAU); c.fill(); c.stroke();
    c.restore(); c.globalAlpha = 1;
  };
  arm(face > 0 ? shL : shR, hands[0], 0); arm(face > 0 ? shR : shL, hands[1], 1);

  // --- 头 ---
  if (halo) { c.fillStyle = 'rgba(214,170,70,.95)'; c.beginPath(); c.arc(head[0], head[1], hh * 1.55, 0, TAU); c.fill(); c.strokeStyle = 'rgba(120,80,30,.8)'; c.lineWidth = 2; c.stroke(); }
  c.fillStyle = css(hairC); c.beginPath(); c.ellipse(head[0] - face * hw * 0.1, head[1] - hh * 0.12, hw * 1.12, hh * 1.06, 0, 0, TAU); c.fill();
  const fg = c.createLinearGradient(head[0] - hw, head[1], head[0] + hw, head[1]); fg.addColorStop(0, css(mixc(skin, [255, 235, 205], 0.25))); fg.addColorStop(1, css(mixc(skin, [90, 50, 30], 0.35)));
  c.fillStyle = fg; c.beginPath(); c.ellipse(head[0] + face * hw * 0.1, head[1] + hh * 0.1 + h * 0.008 * bow, hw * 0.92, hh * 0.92, 0, 0, TAU); c.fill();
  c.strokeStyle = line; c.globalAlpha = 0.65; c.lineWidth = Math.max(1.2, h * 0.005); c.stroke(); c.globalAlpha = 1;
  // 眼：杏仁形，眼珠偏向 gaze；鼻：一道暗线；口：短线
  const ey = head[1] + hh * 0.12 + h * 0.01 * bow, ex = head[0] + face * hw * 0.22;
  let gx = 0, gy = 0; if (gaze) { const dd = Math.hypot(gaze[0] - ex, gaze[1] - ey) || 1; gx = (gaze[0] - ex) / dd; gy = (gaze[1] - ey) / dd; }
  [-1, 1].forEach(sd => {
    const px = ex + sd * hw * 0.38 * (face > 0 ? 1 : 1) - 0, ew = hw * 0.26;
    c.fillStyle = '#f4ead4'; c.beginPath(); c.ellipse(px, ey, ew, ew * 0.5, 0, 0, TAU); c.fill();
    c.fillStyle = '#2a1c14'; c.beginPath(); c.arc(px + gx * ew * 0.45, ey + gy * ew * 0.25, ew * 0.42, 0, TAU); c.fill();
    c.strokeStyle = line; c.lineWidth = Math.max(1, h * 0.0045); c.beginPath(); c.ellipse(px, ey, ew, ew * 0.5, 0, Math.PI * 1.05, Math.PI * 1.95); c.stroke();
  });
  c.strokeStyle = css(hairC, 0.85); c.lineWidth = Math.max(1.4, h * 0.006); [-1, 1].forEach(sd => { const px = ex + sd * hw * 0.38; c.beginPath(); c.moveTo(px - hw * 0.26, ey - hh * 0.2 + (sd * face > 0 ? 1 : 0) * 2); c.quadraticCurveTo(px, ey - hh * 0.34, px + hw * 0.26, ey - hh * 0.18); c.stroke(); });
  c.fillStyle = css(mixc(skin, [90, 40, 25], 0.28), 0.5); c.beginPath(); c.ellipse(head[0] + face * hw * 0.5, head[1] + hh * 0.55, hw * 0.3, hh * 0.2, 0, 0, TAU); c.fill();      // 颧红/阴影
  c.fillStyle = css(skin); c.beginPath(); c.ellipse(head[0] - face * hw * 0.82, head[1] + hh * 0.2, hw * 0.14, hh * 0.24, 0, 0, TAU); c.fill();
  if (o.beard) { c.fillStyle = css(mixc(hairC, [190, 180, 165], 0.45), 0.96); c.beginPath(); c.moveTo(head[0] - hw * 0.8, head[1] + hh * 0.28); c.quadraticCurveTo(head[0] - hw * 0.7, head[1] + hh * 1.35, head[0], head[1] + hh * 1.55); c.quadraticCurveTo(head[0] + hw * 0.7, head[1] + hh * 1.35, head[0] + hw * 0.8, head[1] + hh * 0.28); c.quadraticCurveTo(head[0] + hw * 0.35, head[1] + hh * 0.62, head[0], head[1] + hh * 0.6); c.quadraticCurveTo(head[0] - hw * 0.35, head[1] + hh * 0.62, head[0] - hw * 0.8, head[1] + hh * 0.28); c.fill(); }
  c.strokeStyle = css(mixc(skin, [60, 30, 20], 0.5), 0.8); c.lineWidth = Math.max(1, h * 0.0045);
  c.beginPath(); c.moveTo(ex + face * hw * 0.04, ey + hh * 0.08); c.lineTo(ex + face * hw * 0.08, ey + hh * 0.42); c.lineTo(ex - face * hw * 0.05, ey + hh * 0.46); c.stroke();
  c.beginPath(); c.moveTo(ex - hw * 0.14, ey + hh * 0.7); c.quadraticCurveTo(ex, ey + hh * 0.74, ex + hw * 0.14, ey + hh * 0.68); c.stroke();
  c.restore();
};
})();
