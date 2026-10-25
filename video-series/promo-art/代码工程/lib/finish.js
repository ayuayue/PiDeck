// 成片质感层（spec.finish）：画完一帧之后、对整幅统一加的后期。所有语法通用；默认不开（clean）。
// spec.finish = 预设名 | { vignette, bloom, grain, contrast, saturate, warm }（对象里的键覆盖预设）。
//   soft  ：轻暗角＋极淡泛光＋细颗粒——任何深色／浅色底都不显脏，大多数口播片的默认推荐
//   film  ：暗角更重＋泛光＋可见颗粒＋一点暖——叙事、故事型
//   punch ：对比＋饱和各抬一点＋轻暗角——发布会、财经、需要「抓眼」的段落
//   clean ：什么都不做（和不写一样）
// 键含义：vignette 暗角强度 0–0.6；bloom 泛光强度 0–0.4；grain 颗粒强度 0–0.12（按 24fps 换格，确定性）；contrast/saturate 1=不变；warm 0–0.12 暖色罩。
// alpha 模式（透明背景）一律不加：后期会把透明区域染黑。
// 确定性：颗粒只由帧序号决定，同一时刻渲两次逐像素一致。
(() => {
const { clamp } = U;
const PRESETS = {
  clean: {},
  soft: { vignette: 0.2, bloom: 0.1, grain: 0.035 },
  film: { vignette: 0.34, bloom: 0.12, grain: 0.07, warm: 0.04 },
  punch: { vignette: 0.16, bloom: 0.08, contrast: 1.07, saturate: 1.1 },
};
const cache = {};
const scratch = (k, w, h) => { let c = cache[k]; if (!c || c.width !== w || c.height !== h) { c = cache[k] = document.createElement('canvas'); c.width = w; c.height = h; } return c; };
// 颗粒 tile：3 张 256×256 灰度噪声，种子固定
function grainTiles() {
  if (cache.__grain) return cache.__grain;
  const r = U.rng(20261016), tiles = [];
  for (let k = 0; k < 3; k++) { const cv = document.createElement('canvas'); cv.width = cv.height = 256; const g = cv.getContext('2d'), im = g.createImageData(256, 256);
    for (let i = 0; i < 256 * 256; i++) { const v = 128 + (r() + r() + r() - 1.5) * 90; im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
    g.putImageData(im, 0, 0); tiles.push(cv); }
  return (cache.__grain = tiles);
}
const FINISH = window.FINISH = {
  PRESETS,
  // 解析 spec.finish：返回完整参数对象或 null（不加）。写错预设名 → 抛错（clip.js 转成启动失败）
  resolve(f) {
    if (f == null || f === false || f === 'clean') return null;
    let o = typeof f === 'string' ? PRESETS[f] : { ...(PRESETS[f.preset] || {}), ...f };
    if (!o) throw new Error(`spec.finish「${f}」不是预设：${Object.keys(PRESETS).join(' / ')}（或写对象 {vignette, bloom, grain, contrast, saturate, warm}）`);
    const bad = Object.keys(o).filter(k => !['vignette', 'bloom', 'grain', 'contrast', 'saturate', 'warm', 'preset'].includes(k));
    if (bad.length) throw new Error(`spec.finish 里没有这些键：${bad.join('、')}（可用 vignette bloom grain contrast saturate warm）`);
    return Object.keys(o).length ? o : null;
  },
  apply(c, t, o, W, H, fps = 30) {
    if (!o) return;
    const cv = c.canvas;
    // 对比／饱和：整幅过一遍 CSS filter
    if ((o.contrast && o.contrast !== 1) || (o.saturate && o.saturate !== 1)) {
      const s = scratch('fin_cs', W, H), g = s.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.drawImage(cv, 0, 0);
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.filter = `contrast(${o.contrast || 1}) saturate(${o.saturate || 1})`; c.drawImage(s, 0, 0); c.restore();
    }
    // 泛光：缩小糊化后 screen 叠回（亮处晕开一点）
    if (o.bloom > 0) {
      const sw = Math.max(64, Math.round(W / 6)), sh = Math.max(64, Math.round(H / 6)), s = scratch('fin_bloom', sw, sh), g = s.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, sw, sh); g.filter = 'blur(5px) brightness(1.15)'; g.drawImage(cv, 0, 0, sw, sh); g.filter = 'none';
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'screen'; c.globalAlpha = clamp(o.bloom, 0, 0.5); c.imageSmoothingQuality = 'high'; c.drawImage(s, 0, 0, W, H); c.restore();
    }
    // 暖色罩
    if (o.warm > 0) { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'soft-light'; c.fillStyle = `rgba(255,190,120,${clamp(o.warm, 0, 0.2) * 2})`; c.fillRect(0, 0, W, H); c.restore(); }
    // 颗粒：24fps 换格，随机偏移；overlay 叠灰度噪声
    if (o.grain > 0) {
      const tiles = grainTiles(), f = Math.floor(t * 24 + 1e-6), tile = tiles[f % 3], r = U.rng(f * 7919 + 13), ox = Math.floor(r() * 256), oy = Math.floor(r() * 256);
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'overlay'; c.globalAlpha = clamp(o.grain, 0, 0.2) * 3.2;
      c.fillStyle = c.createPattern(tile, 'repeat'); c.translate(-ox, -oy); c.fillRect(ox, oy, W, H); c.restore();
    }
    // 暗角
    if (o.vignette > 0) {
      const R = Math.hypot(W, H) / 2, g = c.createRadialGradient(W / 2, H / 2, R * 0.45, W / 2, H / 2, R);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${clamp(o.vignette, 0, 0.7)})`);
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = g; c.fillRect(0, 0, W, H); c.restore();
    }
  },
};
})();
