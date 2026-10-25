// PiDeck 宣传片 · 第 10–15 镜：斜杠命令面板、/plan 高亮、后端下拉、发送箭头、会话角标、主机窗拉远
SCENES['s10_palette'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实暗色主窗口——推近到时间线的对话区，字号与全片同一层级
      const img = IMG['assets/src_dark.png'];
      // 镜头：缓推 30% ＋ 内容持续上滚
      const z = 1 + MO.sineInOut(clamp(lt / 1.4)) * 0.30;
      const f = PD.scrollBand(c, img, { t: lt, z, fx: 0.42, fy: 0.52, bandTop: 0, bandH: 1080, speed: 260 });
      // 标注：只留「当前行高亮下跳」这一层（真实 UI 的选中行），不叠框不叠标签
      const R = f.box(440, 300, 980, 420);
      if (lt > 0.45) {
        PD.rowHi(c, R, lt, { at: 0.45, step: 0.40, rows: 5, alpha: 0.48, color: PD.PAL.accent });
        PD.sweep(c, R, lt, { at: 0.45, dur: 1.5, alpha: 0.8, lw: 6 });
      }
    },
  };
})();
SCENES['s11_plan'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实暗色主窗口——推近到「执行过程」那一行，字号和全片同一层级
      const img = IMG['assets/src_dark.png'];
      // 镜头：快推 0.28s 落到执行过程折叠条上（y≈229），再极缓下沉
      const z = 1 + MO.cubicInOut(clamp(lt / 0.28)) * 0.72;
      const f = PD.scrollBand(c, img, { t: lt, z, fx: 0.42, fy: 0.28, bandTop: 0, bandH: 1080, speed: 130 });
      // 执行过程那一行（真实坐标 x≈440..1420, y≈222..238）
      const R = f.box(440, 220, 980, 22);
      const at = 0.4;
      if (lt >= at) {
        const p = PD.step12(lt, at);
        PD.edgeLines(c, R, lt, { alpha: clamp(p * 1.2, 0, 1), lw: 4, pad: 10 });
        PD.sweep(c, R, lt, { at: at + 0.15, dur: 0.85, alpha: 1.0, lw: 8 });
        if (lt > 0.85) {
          const t3 = clamp((lt - 0.85) / 0.45, 0, 1);
          const tx = R.x, ty = R.y - 82;
          PD.leader(c, R.x + 40, R.y - 10, tx, ty + 20, { alpha: t3 });
          PD.tag(c, '执行过程', tx, ty, { alpha: t3, size: 34, bg: '#F2EFE8', fg: '#171717' });
        }
      }
    },
  };
})();
SCENES['s12_backend'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实暗色主窗口（推近到输入框的模型选择区）
      const img = IMG['assets/src_dark.png'];
      // 镜头：推近 60% 落到输入框，再缓慢右移
      const z0 = 1 + MO.sineInOut(clamp(lt / 1.4)) * 0.42;
      const f = PD.scrollBand(c, img, { t: lt, z: z0, fx: lerp(0.56, 0.66, MO.sineInOut(clamp(lt / 3.5))), fy: 0.92, bandTop: 0, bandH: 1080, speed: 130 });
      // 真实菜单三行在画面里；代码压暗周围 + 珊瑚红框标出 + 亮边扫过
      const at = 0.4;
      if (lt >= at) {
        const p = PD.step12(lt, at);
        PD.dim(c, clamp(p * 1.2, 0, 1), { alpha: 0.28 });
        const R = f.box(700, 960, 640, 50);
        PD.markBox(c, R, { t: clamp(p * 1.2, 0, 1), color: PD.PAL.accent, pad: 14, lw: 6 });
        PD.sweep(c, R, lt, { at: at + 0.2, dur: 1.2, alpha: 1.0, lw: 9 });
        PD.breathe(c, R, lt, { at: at + 0.25, period: 1.2, alpha: 0.55, lw: 5, pad: 24 });
      }
      if (lt > 1.8) {
        const t2 = clamp((lt - 1.8) / 0.5, 0, 1);
        const [x, y] = f.to(700, 950);
        PD.tag(c, '随时换后端', x, y, { alpha: t2, size: 36, bg: '#F2EFE8', fg: '#171717' });
      }
    },
  };
})();

SCENES['s13_send'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实暗色主窗口（推近到输入框右下角的发送按钮）
      const img = IMG['assets/src_dark.png'];
      // 镜头：缓推 30% ＋ 缓慢右移
      const z = 1 + MO.sineInOut(clamp(lt / 1.2)) * 0.44;
      const f = PD.scrollBand(c, img, { t: lt, z, fx: lerp(0.68, 0.78, MO.sineInOut(clamp(lt / 3.5))), fy: 0.93, bandTop: 0, bandH: 1080, speed: 30 });
      // 真实的发送按钮在输入框右下角；代码用珊瑚红框标出，按下时框收紧
      const at = 0.45;
      const press = lt >= at ? clamp((lt - at) / 0.12, 0, 1) : 0;
      const R = f.box(1322, 966, 46, 46);
      c.save();
      c.globalAlpha = 0.6 + press * 0.4;
      c.strokeStyle = PD.PAL.accent;
      c.lineWidth = 5;
      const g = press * 7;
      c.beginPath(); c.roundRect(R.x - g, R.y - g, R.w + g * 2, R.h + g * 2, 30); c.stroke();
      c.restore();
      // 按下时输入框边缘泛起一圈珊瑚红
      const glow = lt < at ? 0 : clamp((lt - at) / 0.3, 0, 1) * (lt < at + 1.3 ? 1 : clamp(1 - (lt - at - 1.3) / 0.5, 0, 1));
      if (glow > 0) {
        c.save();
        c.globalAlpha = glow * 0.85;
        c.strokeStyle = PD.PAL.accent; c.lineWidth = 5;
        c.beginPath(); c.roundRect(f.box(430, 860, 990, 150).x, f.box(430, 860, 990, 150).y, f.box(430, 860, 990, 150).w, f.box(430, 860, 990, 150).h, 16); c.stroke();
        c.restore();
      }
      // 按钮在按下去之前一直在呼吸 + 核心脉动（画面在动）
      if (lt < at + 1.3) {
        PD.breathe(c, R, lt, { at: 0.2, period: 0.8, alpha: 0.5, lw: 4, pad: 10 });
      }
      PD.pulse(c, R.x + R.w / 2, R.y + R.h / 2, R.w * 0.42, { t: lt, period: 0.85, color: PD.PAL.accent, alpha: 0.8, lw: 4 });
      // 一道亮边扫过整个输入框
      if (lt > 0.3) {
        const BR = f.box(60, 40, 2355, 295);
        PD.sweep(c, BR, lt, { at: 0.3, dur: 1.3, alpha: 0.85, lw: 7 });
      }
      if (lt > 1.1) {
        const t2 = clamp((lt - 1.1) / 0.45, 0, 1);
        const [tx, ty] = f.to(1300, 940);
        PD.tag(c, '一次五路', tx, ty, { alpha: t2, size: 36, bg: '#F2EFE8', fg: '#171717', align: 'center' });
      }
    },
  };
})();

SCENES['s14_badge'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      // 素材：真实暗色主窗口（推近到侧栏项目行的会话角标）
      const img = IMG['assets/src_dark.png'];
      // 镜头：横移（从侧栏上方横移到项目行的角标）
      const z = 1 + MO.sineInOut(clamp(lt / 1.3)) * 0.34;
      const f = PD.scrollBand(c, img, { t: lt, z, fx: lerp(0.10, 0.17, MO.sineInOut(clamp(lt / 2.6))), fy: 0.32, bandTop: 0, bandH: 1080, speed: 60 });
      // 角标数字从 1 滚到 5
      const at = 0.6;
      if (lt >= at) {
        const p = PD.step12(lt, at);
        const n = Math.max(1, Math.ceil(p * 5));
        // 真实角标在 src_dark 的 (x=281, y=331)
        const [x, y] = f.to(281, 331);
        c.save();
        c.globalAlpha = clamp(p * 2, 0, 1);
        c.fillStyle = PD.AMBER;
        c.beginPath(); c.arc(x, y, 12 * f.s, 0, 7); c.fill();
        c.fillStyle = '#171717';
        c.font = `bold ${15 * f.s}px "Inter"`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(n), x, y + 2);
        c.restore();
        PD.pulse(c, x, y, 15 * f.s, { t: lt, period: 0.8, color: PD.AMBER_L, alpha: 0.7, lw: 2.6 });
      }
      if (lt > 1.7) {
        const t2 = clamp((lt - 1.7) / 0.5, 0, 1);
        const [x, y] = f.to(281, 331);
        PD.leader(c, x + 30, y - 10, x + 190, y - 70, { alpha: t2 });
        PD.tag(c, '五个后台', x + 190, y - 94, { alpha: t2, size: 34 });
      }
    },
  };
})();

SCENES['s15_wide'] = (() => {
  const { clamp, lerp } = U, PD = window.PD;
  return {
    init(IMG) {},
    draw(c, lt, t, IMG) {
      const img = IMG['assets/src_dark.png'];
      // 前段：拉远（从侧栏拉回完整工作台全景，1.6s）
      const p = MO.longTail(clamp(lt / 1.6));
      const f = PD.fit(c, img, { z: lerp(1.85, 1.0, p), fx: lerp(0.10, 0.5, p), fy: lerp(0.36, 0.5, p) });
      // 收尾：1.6s 起镜头推向窗口左上角真实的 PiDeck Logo（结尾落在主角身上）
      if (lt > 1.6) {
        const q = MO.sineInOut(clamp((lt - 1.6) / 1.7));
        const f2 = PD.fit(c, img, { z: lerp(1.0, 2.45, q), fx: lerp(0.5, 0.052, q), fy: lerp(0.5, 0.020, q) });
        const L = f2.box(38, 8, 118, 36);
        const t2 = clamp((lt - 1.75) / 0.45, 0, 1);
        // Logo 外面一圈呼吸光晕（品牌锁定）
        PD.breathe(c, L, lt, { at: 1.75, period: 1.0, alpha: 0.55, lw: 4, pad: 18 });
        PD.sweep(c, L, lt, { at: 1.9, dur: 0.9, alpha: 0.95, lw: 8 });
        // 品牌名贴在 Logo 右侧
        if (lt > 2.5) {
          const t3 = clamp((lt - 2.5) / 0.45, 0, 1);
          const [lx, ly] = f2.to(160, 26);
          PD.tag(c, 'PiDeck', lx, ly, { alpha: t3, size: 40, bg: '#F2EFE8', fg: '#171717' });
        }
        // 最后 1 秒：一句 slogan 从 Logo 下方浮起
        if (lt > 3.3) {
          const t4 = clamp((lt - 3.3) / 0.5, 0, 1);
          const [sx, sy] = f2.to(46, 44);
          c.save();
          c.globalAlpha = t4;
          c.fillStyle = '#A39E93';
          c.font = '20px "PuHui-Medium"';
          c.textAlign = 'left'; c.textBaseline = 'middle';
          c.fillText('多个项目 · 多个 Agent · 一块屏幕', sx, sy);
          c.restore();
        }
      }
    },
  };
})();