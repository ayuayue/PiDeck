// PiDeck 宣传片 · 第 1–4 镜：侧栏项目树、五个会话圆点、标签栏、五个 spinner
// 画风锁：真实 PiDeck 界面（暗色主题）当主画面，等比铺满；代码只做压暗、珊瑚红标注、运镜和界面元素动作。
SCENES['s01_sidebar'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      const img = IMG['assets/src_dark.png'];
      // 镜头：停（3 秒只推 6%；画面自己在亮圆点）
      const z = 1 + MO.sineInOut(clamp(lt / 3.0)) * 0.06;
      const f = PD.fit(c, img, { z, fx: 0.09, fy: 0.46 });
      // 侧栏五个会话圆点逐个亮起（真实截图里的琥珀点，位置在 x=57/71 一列）
      const rows = [400, 447, 491, 535, 579];
      for (let i = 0; i < rows.length; i++) {
        const at = 0.40 + i * 0.42;
        if (lt < at) continue;
        const p = PD.step12(lt, at);
        const [dx, dy] = f.to(57, rows[i]);
        const R = 8 * f.s;
        c.save();
        c.globalAlpha = clamp(p * 1.5, 0, 1);
        c.fillStyle = PD.AMBER;
        c.beginPath(); c.arc(dx, dy, R, 0, 7); c.fill();
        for (let k = 0; k < 2; k++) {
          const rp = clamp((p - 0.28 - k * 0.30) / 0.72, 0, 1);
          if (rp > 0 && rp < 1) {
            c.globalAlpha = (1 - rp) * 0.65;
            c.strokeStyle = PD.AMBER_L; c.lineWidth = 3.6;
            c.beginPath(); c.arc(dx, dy, R + rp * 32, 0, 7); c.stroke();
          }
        }
        c.restore();
        // 亮起之后持续脉动（画面里一直有东西在动）
        if (lt > at + 0.5) PD.pulse(c, dx, dy, R * 1.5, { t: lt, period: 0.8 + i * 0.12, color: PD.AMBER_L, alpha: 0.7, lw: 3 });
      }
      // 一道珊瑚红亮边扫过侧栏那一列
      if (lt > 0.8) {
        const R = f.box(26, 378, 262, 224);
        PD.sweep(c, R, lt, { at: 0.8, dur: 1.8, alpha: 0.8, lw: 5 });
      }
    },
  };
})();

SCENES['s02_dots'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      const img = IMG['assets/src_dark.png'];
      // 镜头：缓推 46%（1.6s）——把视线带到侧栏那一列会话点
      const z = 1 + MO.sineInOut(clamp(lt / 1.6)) * 0.34;
      const f = PD.scrollBand(c, img, { t: lt, z, fx: 0.075, fy: 0.5, bandTop: 0, bandH: 1080, speed: 220 });
      const rows = [400, 447, 491, 535, 579];
      for (let i = 0; i < rows.length; i++) {
        const [dx, dy] = f.to(57, rows[i]);
        c.save();
        c.fillStyle = i === 4 ? '#6b7d96' : PD.AMBER;
        c.beginPath(); c.arc(dx, dy, 8 * f.s, 0, 7); c.fill();
        c.restore();
        PD.pulse(c, dx, dy, 13 * f.s, { t: lt, period: 0.75 + i * 0.13, color: PD.AMBER_L, alpha: 0.75, lw: 3.4 });
      }
      const R = f.box(34, 384, 240, 200);
      const t2 = clamp((lt - 1.5) / 0.5, 0, 1);
      PD.markBox(c, R, { t: t2, color: PD.PAL.accent, pad: 16 });
      if (t2 > 0) {
        const [lx, ly] = f.to(280, 372);
        PD.leader(c, R.x + R.w, R.y + 16, lx, ly, { alpha: t2 });
        PD.tag(c, '五个项目', lx + 4, ly - 22, { alpha: t2, size: 32 });
      }
    },
  };
})();

SCENES['s03_tabs'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      const img = IMG['assets/src_dark.png'];
      // 镜头：横移（从标签栏左端扫到右端）
      const p = MO.sineInOut(clamp(lt / 3.5));
      const f = PD.scrollBand(c, img, { t: lt, z: 1.34, fx: lerp(0.12, 0.52, p), fy: 0.035, bandTop: 0, bandH: 1080, speed: 120 });
      // 标签逐个描边（12fps 步进）
      const tabs = [[336, 452], [468, 590], [600, 700], [716, 790]];
      for (let i = 0; i < tabs.length; i++) {
        const at = 0.3 + i * 0.6;
        if (lt < at) continue;
        const sp = PD.step12(lt, at);
        const R = f.box(tabs[i][0], 6, tabs[i][1] - tabs[i][0], 34);
        c.save();
        c.globalAlpha = 0.6 * clamp(sp, 0, 1);
        c.strokeStyle = PD.PAL.accent2; c.lineWidth = 2.6;
        c.setLineDash([10, 7]);
        c.strokeRect(R.x, R.y, R.w, R.h);
        c.restore();
        PD.pulse(c, R.x + 14, R.y + R.h / 2, 9, { t: lt, period: 0.8 + i * 0.15, color: PD.PAL.accent2, alpha: 0.85, lw: 3 });
      }
      if (lt > 2.4) {
        const t2 = clamp((lt - 2.4) / 0.5, 0, 1);
        const [x, y] = f.to(800, 10);
        PD.tag(c, '各跑各的', x, y - 70, { alpha: t2, size: 32 });
      }
    },
  };
})();

SCENES['s04_spinners'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实暗色主窗口（推近到标签栏那一排 spinner）
      const img = IMG['assets/src_dark.png'];
      // 镜头：快推 22% ＋ 缓慢右移
      const z = 1 + MO.cubicInOut(clamp(lt / 0.28)) * 0.62;
      const f = PD.scrollBand(c, img, { t: lt, z, fx: 0.30, fy: 0.5, bandTop: 0, bandH: 140, speed: 60 });
      // 五个 spinner：真实截图里已有 2 个（x=472 / 605），补齐另外 3 个
      // 坐标是 src_dark 原图像素
      const pos = [[472, 23], [605, 23], [738, 23], [871, 23], [1004, 23]];
      for (let i = 0; i < pos.length; i++) {
        const at = 0.45 + i * 0.3;
        if (lt < at) continue;
        const spin = (lt - at) * 5.0 + i * 1.3;       // 各自异相
        const [dx, dy] = f.to(pos[i][0], pos[i][1]);
        const R = 13 * f.s;
        c.save();
        c.strokeStyle = PD.AMBER; c.lineWidth = 6 * f.s; c.lineCap = 'round';
        c.beginPath(); c.arc(dx, dy, R, spin, spin + 1.9); c.stroke();
        c.globalAlpha = 0.3;
        c.beginPath(); c.arc(dx, dy, R, spin + 1.9, spin + 6.28); c.stroke();
        c.restore();
      }
      // 聚光框把五个 spinner 圈住（呼吸）——0.5s 就出现，标签出现时框已在画面里
      if (lt > 0.5) {
        const R = f.box(440, 0, 600, 46);
        PD.breathe(c, R, lt, { at: 0.5, period: 1.1, alpha: 0.8, lw: 5, pad: 16 });
        PD.sweep(c, R, lt, { at: 1.2, dur: 1.0, alpha: 0.9, lw: 6 });
      }
      if (lt > 1.8) {
        const t2 = clamp((lt - 1.8) / 0.45, 0, 1);
        // 标签贴在聚光框右端，用引线连到框上——不是悬在空白里
        const BR = f.box(440, 0, 600, 46);
        const bx = BR.x + BR.w + 12, by = BR.y + BR.h * 0.5;
        const tx = bx + 96, ty = by - 78;
        PD.leader(c, bx, by, tx, ty, { alpha: t2 });
        PD.tag(c, '同时在跑', tx, ty - 22, { alpha: t2, size: 34, bg: '#F2EFE8', fg: '#171717' });
      }
    },
  };
})();