// PiDeck 宣传片 · 第 5–9 镜：工具调用行、用量统计、Git 面板、终端、git status 输出
// 画风锁：真实 PiDeck 界面（暗色主题）当主画面；代码只做压暗、珊瑚红标注、运镜和界面元素动作。
SCENES['s05_timeline'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实时间线放大裁切（2140×1140）——工具行文字全在真实截图里，代码不再重画
      const img = IMG['assets/d_timeline.png'];
      // 镜头：内容持续向上滚（真实列表在滚）
      const f = PD.scrollBand(c, img, { t: lt, z: 1.0, fx: 0.52, fy: 0.5, bandTop: 0, bandH: 850, speed: 520 });
      // 标注：只画一条框住工具行的珊瑚红框（不压字，框的上下缘在行外）+ 当前行高亮下跳
      const R = f.box(520, 400, 900, 380);
      if (lt > 0.5) {
        const t1 = clamp((lt - 0.5) / 0.4, 0, 1);
        PD.edgeLines(c, R, lt, { alpha: t1, lw: 4, pad: 8 });
        PD.sweep(c, R, lt, { at: 0.5, dur: 1.2, alpha: 0.9, lw: 7 });
        PD.rowHi(c, R, lt, { at: 0.7, step: 0.42, rows: 4, alpha: 0.30, color: PD.PAL.accent });
      }
      // 一个标签，贴在框的左上角外侧，引线连到框
      if (lt > 1.0) {
        const t2 = clamp((lt - 1.0) / 0.45, 0, 1);
        const tx = R.x - 30, ty = R.y - 74;
        PD.leader(c, R.x, R.y - 6, tx, ty + 18, { alpha: t2 });
        PD.tag(c, '工具调用', tx, ty, { alpha: t2, size: 34, bg: '#F2EFE8', fg: '#171717' });
      }
    },
  };
})();
SCENES['s06_stats'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实暗色主窗口（状态栏在底部 y=1038..1052）
      const img = IMG['assets/src_dark.png'];
      // 镜头：推近 55% 落到状态栏那一行，再缓慢右移
      const z = 1 + MO.sineInOut(clamp(lt / 1.3)) * 0.55;
      const f = PD.scrollBand(c, img, { t: lt, z, fx: lerp(0.52, 0.66, MO.sineInOut(clamp(lt / 3.5))), fy: 0.965, bandTop: 0, bandH: 1080, speed: 26 });
      // 真实数值就在画面里；代码在每一项下面画一道跳动的珊瑚红下划线（数字在长）
      const stats = [[470, 90], [720, 90], [1010, 95], [1240, 95], [1420, 100]];
      for (let i = 0; i < stats.length; i++) {
        const at = 0.4 + i * 0.42;
        if (lt < at) continue;
        const p = PD.step12(lt, at);
        const [x, y] = f.to(stats[i][0], 1052);
        c.save();
        c.globalAlpha = clamp(p * 1.5, 0, 1);
        c.fillStyle = PD.PAL.accent;
        c.fillRect(x, y, stats[i][1] * f.s * clamp(p, 0, 1), 6 * f.s);
        c.restore();
      }
      // 一道亮边沿着统计行从左往右扫过
      if (lt > 0.6) {
        const R = f.box(430, 1040, 1030, 30);
        PD.sweep(c, R, lt, { at: 0.6, dur: 1.4, alpha: 0.9, lw: 6 });
      }
      if (lt > 2.3) {
        const t2 = clamp((lt - 2.3) / 0.5, 0, 1);
        const [x, y] = f.to(470, 1052);
        const [lx, ly] = f.to(470, 950);
        PD.leader(c, x + 60, y - 12, lx, ly, { alpha: t2 });
        PD.tag(c, '看得见的开销', lx, ly, { alpha: t2, size: 32 });
      }
    },
  };
})();

SCENES['s07_git'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实暗色主窗口——右侧文件树。字号与全片同一层级（不再用放大裁切）
      const img = IMG['assets/src_dark.png'];
      // 镜头：拉远（从右侧面板拉回整块工作台），视点在右面板
      const p = MO.longTail(clamp(lt / 1.7));
      const z = lerp(1.55, 1.05, p);
      const f = PD.scrollBand(c, img, { t: lt, z, fx: 0.76, fy: 0.5, bandTop: 0, bandH: 1080, speed: 210 });
      // 改动列表（真实坐标）：一条珊瑚红上下缘线夹住整列 M/U 徽章，不重画徽章本身
      const R = f.box(1850, 380, 62, 500);
      if (lt > 0.5) {
        const t1 = clamp((lt - 0.5) / 0.4, 0, 1);
        PD.edgeLines(c, R, lt, { alpha: t1, lw: 3.5, pad: 6 });
        PD.sweep(c, R, lt, { at: 0.5, dur: 1.6, alpha: 0.85, lw: 6 });
      }
      // 标签贴在列左侧，引线连到列的上端
      if (lt > 1.4) {
        const t2 = clamp((lt - 1.4) / 0.5, 0, 1);
        const tx = R.x - 340, ty = R.y - 92;
        PD.leader(c, R.x - 6, R.y + 8, tx + 232, ty + 20, { alpha: t2 });
        PD.tag(c, '改动都在这', tx, ty, { alpha: t2, size: 34, bg: '#F2EFE8', fg: '#171717' });
      }
    },
  };
})();
SCENES['s08_terminal'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实暗色主窗口（终端面板在底部）
      const img = IMG['assets/src_dark.png'];
      // 镜头：缓推 42%，推到能同时看见终端面板和它左侧的正文——不把侧栏切在字中间
      const z = 1 + MO.sineInOut(clamp(lt / 1.5)) * 0.58;
      const f = PD.scrollBand(c, img, { t: lt, z, fx: 0.34, fy: 0.72, bandTop: 0, bandH: 900, speed: 110 });
      // 终端面板区域（真实坐标）：整块框住，让观众知道「终端在哪」
      const T = f.box(430, 1040, 990, 26);
      if (lt > 0.4) {
        const t1 = clamp((lt - 0.4) / 0.4, 0, 1);
        PD.edgeLines(c, T, lt, { alpha: t1, lw: 3.5, pad: 10 });
        PD.sweep(c, T, lt, { at: 0.4, dur: 1.3, alpha: 0.9, lw: 6 });
      }
      // 终端里敲一行命令（12fps 打字）——落在真实终端行上
      const cmd = 'git add -A && git commit -m "promo"';
      const at = 0.6;
      if (lt >= at) {
        const p = PD.step12(lt, at);
        const n = Math.ceil(p * cmd.length);
        const [x, y] = f.to(300, 1046);
        c.save();
        c.fillStyle = '#7ee787';
        c.font = `${13 * f.s}px "Consolas", monospace"`;
        c.textBaseline = 'middle';
        c.fillText(cmd.slice(0, n), x, y);
        if (p < 1) { const w = c.measureText(cmd.slice(0, n)).width; c.fillRect(x + w + 3, y - 8, 7, 16); }
        c.restore();
      }
      // 标签贴在这块框的右上方，引线连到框的右端（不指向空白）
      if (lt > 1.5) {
        const t2 = clamp((lt - 1.5) / 0.5, 0, 1);
        const ax = T.x + T.w, ay = T.y;
        const tx = ax - 40, ty = ay - 96;
        PD.leader(c, ax, ay - 4, tx, ty + 20, { alpha: t2 });
        PD.tag(c, '终端也在里面', tx, ty, { alpha: t2, size: 32, bg: '#F2EFE8', fg: '#171717' });
      }
    },
  };
})();
SCENES['s09_gitout'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      const img = IMG['assets/src_dark.png'];
      // 镜头：横移，视点落在右侧面板的改动列表上（M/U 徽章在 y≈400–800，必须真在画面里）
      const p = MO.sineInOut(clamp(lt / 3.5));
      const z = 1 + MO.sineInOut(clamp(lt / 1.3)) * 0.55;
      const f = PD.scrollBand(c, img, { t: lt, z, fx: lerp(0.62, 0.70, p), fy: 0.55, bandTop: 180, bandH: 820, speed: 120 });
      // git status：真实输出在右面板，珊瑚红框逐个圈住 M / U 徽章
      const marks = [[1878, 406], [1878, 513], [1878, 616], [1878, 719], [1878, 822]];
      for (let i = 0; i < marks.length; i++) {
        const at = 0.45 + i * 0.55;
        if (lt < at) continue;
        const sp = PD.step12(lt, at);
        const [x, y] = f.to(marks[i][0], marks[i][1]);
        c.save();
        c.globalAlpha = clamp(sp * 1.4, 0, 1);
        c.strokeStyle = PD.PAL.accent; c.lineWidth = 3.4;
        c.beginPath(); c.roundRect(x - 16, y - 14, 32, 28, 4); c.stroke();
        c.restore();
      }
      const R = f.box(1864, 392, 30, 450);
      if (lt > 0.8) PD.sweep(c, R, lt, { at: 0.8, dur: 2.0, alpha: 0.85, lw: 6 });
      // 标签贴在徽章列左侧，引线连到列的上端（落点真在画面里）
      if (lt > 2.2) {
        const t2 = clamp((lt - 2.2) / 0.5, 0, 1);
        const tx = R.x - 300, ty = R.y - 96;
        PD.leader(c, R.x - 8, R.y + 10, tx + 210, ty + 22, { alpha: t2 });
        PD.tag(c, '不用切窗口', tx, ty, { alpha: t2, size: 34, bg: '#F2EFE8', fg: '#171717' });
      }
    },
  };
})();