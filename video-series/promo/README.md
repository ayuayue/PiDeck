# PiDeck 宣传片（promo）

`video-series/` 是幻灯片式上手系列（EP01–EP06，`decks/` + `pipeline/`）；
`promo/` 是**品牌宣传片**——不贴截图，用 HTML/CSS 把 PiDeck 的真实界面重建出来，让它活着动。
两套管线互不复用，风格刻意区分：上手系列是文档，宣传片是广告。

## 风格基准

对齐 `AbubakrChan/product-launch-motion` v2（README 原话："Use it with Claude Opus 5.5 to
get results like these films."）。本地副本见下方"参考"。它那套规则基本就是本目录的规矩：

| 规则 | 在本项目怎么落地 |
|------|------------------|
| One shape never cut | 同一个圆角矩形 `#shape` 在像素 logo（168px）、应用窗口（1600px）、知识卡底板之间形变；不靠切图或交叉淡入换画面 |
| Content swaps with a short blur | 换文案/换内容时旧元素短早退场 + 轻模糊，不用硬切 |
| Springs with tiny overshoot | 一律 `stepR(tau,{w,z})` 闭合阻尼弹簧，`SP(z)=>({w:17,z})`，禁用 bouncy easing。**形变（w/h/radius）另用慢弹簧 `{w:5.4,z:0.78}`**，`SP(0.72)` 的 w=17 会让 1600px 生长在 0.3s 内跳完，交接那 1 秒全空 |
| Cursor drives every change | 双光标（「你」/「PiDeck」）按 `Track` 关键帧走真实路径，点击有 press scale + ripple + 渐隐拖尾 |
| Camera frames every state | `#world{transform:translate(960,540) scale(z) translate(-cx,-cy)}`，每次状态变化都重新取景 |
| Music first | 先测节拍网格（`tools/beatmap.py`），cue 对到整拍/半拍/16 分音，drop 落在产品大 beat |
| Real data | 全部文案/数值取自真实运行中的应用：模型名、`git status` 输出、会话标题、状态栏统计 |
| 每拍有事发生 | 冷开场 6s drop，之后每 0.25–0.5s 至少一个元素在动，无 dead time |

## EP01 讲什么（一句话）

**点侧栏开一个会话 → 再点四个 → 五个会话各占一个 Tab 同时在跑 → 拖到边上分屏 → 终端和 Git 也在同一个会话里。**

这条链是 PiDeck 独占的：「一个会话派发五个任务」任何带子代理的 agent 都能做，
**同时开五个会话、每个会话一个 Tab、互不阻塞** 才是本产品。
所以片中必须出现的是**多个 Tab + 多条独立流**，不是一条会话里的五条任务。

全片 **79.6s**：并行主卖点占 16.0–37.5（27%），结尾三段知识卡（Pi/DSH 双后端、一个窗口
vs 五个终端、11 种来源导入）占 45.6–72.4。逐拍表见 `ep01/STORYBOARD.md`。

## 目录

```
promo/
├── README.md               本文件
├── audio-bgm-tech.mp3      BGM（从 huashu-design skill 复制，不入库）
├── sheet/                  抽帧 QA 图（不入库）
├── ref/                    真实应用实测截图（配色/几何的唯一依据）
│   ├── dark-1920.png       暗色主题 1920×1080 主窗口
│   └── live-1920.png       浅色主题
├── tools/                  抓图与取色（Windows）
│   ├── win_shot.ps1        按 hwnd/进程/区域全分辨率截图（内含 SetProcessDPIAware）
│   ├── list_wins.ps1       枚举某进程可见窗口找主窗口 hwnd
│   ├── shot.sh             shot.sh <name> [crop x,y,w,h]，截 PiDeck 主窗口
│   ├── palette.py          像素色板频次直方图
│   ├── runs.py             像素行/列色段扫描（量布局边界）
│   └── beatmap.py          BGM 节拍网格自测（BPM + 能量剖面）
└── ep01/
    ├── STORYBOARD.md       逐拍分镜表 + 决策记录（v4 = 五会话并行 + 三段知识卡，79.6s）
    ├── film.src.html       ★ 影片源（唯一需要手改的文件）
    ├── build.mjs           token → base64 内联 → film.html
    ├── check.mjs           逐帧探针：DOM 断言 + 截图 + 「seek 是否真画出像素」灰度均值门禁
    ├── mix-audio.py        BGM + 137 条按节拍网格摆放的 SFX → audio.wav（cue 时间逐条对 T 时间轴）
    ├── finalize.sh         tmix 运动模糊降帧 120→60 → 混入音轨 → 成片
    └── promo-ep01-final.mp4 成片
```

## 出片流程

```bash
cd video-series/promo/ep01

# 0. 字体内联（单文件交付，不外链 CDN）
node build.mjs                       # film.src.html → film.html

# 1. 门禁：DOM 断言 + 关键帧截图 + 灰度均值（纯黑会红）
node check.mjs --fast                # 只跑断言，快
node check.mjs                       # 抽 38 帧到 verify/

# 2. 渲染（120fps → finalize 里 tmix 出 60fps 运动模糊）
export NODE_PATH=C:/Users/14012/pi-desktop-dev/node_modules
node "$HOME/.pi/agent/skills/huashu-design/scripts/render-video-seek.js" \
  film.html --duration=40 --fps=120 --width=1920 --height=1080 \
  --concurrency=8 --settle=1

# 3. 混音（必须先有 render.log 里的实测 BPM，cue 时间是手摆的）
python mix-audio.py                  # → audio.wav

# 4. 封装
./finalize.sh                        # → promo-ep01-final.mp4
```

`film.src.html` 里的 tick 必须配合渲染器：

```js
window.__seek = t => render(clamp(t, 0, DUR));
(function tick(t) {
  if (window.__seekRender) { window.__ready = true; render(t); return; }
  if (lastTick === null) window.__ready = true;
  lastTick = t; render(t);
  if (!window.__recording) requestAnimationFrame(tick);
})(0);
```

## 改动画的规矩

1. **只改 `film.src.html`**，改完 `node build.mjs` 再渲染；`film.html` 是产物。
2. **`will-change` 绝不加在会被相机缩放的元素上**（文字会糊成一团）。缩放靠 `#world` 的
   `transform`，被摄物本身不要带 `will-change: transform`。
3. **`Track.to(t, v, sp, dur)` 的语义**：`dur` 是动画时长，动画从 `t-dur` 起、在 `t` 落定，
   然后保持到下一个关键帧。目标要"在 T 到达"就得提前 ≈dur 下发事件。
4. **只写 `transform` / `opacity` / `filter`**。改 `left/top/width` 会每帧触发布局。
5. **`prefers-reduced-motion` 不用管**：影片是 seek 驱动的，不吃 CSS 动画。
6. **seek 是纯函数**：`render(t)` 不得依赖任何在时间线上只前进不复回的状态，否则
   `check.mjs` 的逐帧 seek 会和连续播放对不上。
7. **`stepR` 的 `z` 必须 < 1**。`z:1` 时 `wd=w*sqrt(1-z*z)=0`，式子里的 `(z*w/wd)*sin(wd*tau)`
   变成 `Infinity*0 = NaN`，`opacity="NaN"` 被浏览器丢弃，元素静默停在 0——不报错，只是没出现。
   这类「静默没出现」最难发现，因为 DOM 断言取到的是 0 而不是异常。
8. **同一批元素的绝对坐标要真的写进去**。五格网格的 `left/top` 第一版只在 `drawGrid()` 里读
   `dataset.x/y` 算位移、忘了赋给 style，六张卡全叠在 (0,0)，只看得见一张。判据是截图，不是 DOM 断言。
9. **成对出现的两个视图不能同时在场**（`#tl1` 单会话时间线 / `#tl2` 切 Tab 后的时间线）。
   `#tl1` 要在五格涌入时就让位，而不是等切 Tab 才淡出——否则单会话内容会透在网格底下。
10. **`__seekRender` 分支里绝对不能再 `render()`**。rAF 回调的 `t` 是**毫秒时间戳**，
    `__seek()` 之后下一拍会用 `clamp(毫秒)` 画出片尾帧——浏览器播放时下一帧就盖住了看不出来，
    但 `check.mjs` 逐帧 seek 读到的是别的时刻，`render-video-seek.js` 也可能把尾帧混进成片。
    正确写法：`__seek=function(time){ window.__seekRender=true; render(clamp(time,0,DUR)); }`，
    tick 里 `if(window.__seekRender){ window.__ready=true; return; }`（只 return，不排下一帧）。
11. **`stepR` 单调，「淡回来」必须写成反向因子相乘**：`stepR(a)*(1-stepR(b))`。
    写成 `stepR(t-T.morphEnd)` 的话，morph 结束后恒为 1，尾板的像素 logo 再也不会出现。
12. **行内元素必须给显式尺寸 + `display:block`**。42 个 provider 色块是 `<i>`，
    CSS 没给 `width/height` 时全 0×0，只剩一条 gap 空带——DOM 断言全绿、元素「存在」。
13. **`el.style.opacity = "NaN"` 被浏览器静默丢弃**，读回的是 `""` 而不是 `"NaN"`。
    函数签名写错（多一个参数、少一个参数）就是这样无声地把整棵子树变成不可见。
    调试判据：`element.style.opacity === ""` 就说明值非法，而不是"它现在是 0"。

## 踩过的坑（都真踩过）

1. **`__seekRender` 分支必须置 `__ready`**。渲染器 `waitForFunction(() => window.__ready && typeof
   window.__seek === 'function')`；把"首帧哨兵"和 seek 分支混在一起写会让 `__ready` 永不置位。
2. **`Track.at()` 写错会静默穿帮**。第一版实现跨过某事件后继续向更晚事件插值，窗口在 9.6s
   就塌成了 168px——成片才发现。判据：`check.mjs` 的 DOM 断言（winEarly/winA/winB/winC/winDead）。
3. **相机缩放 + 子元素绝对定位要分清坐标系**。`#tile` 是 `#shape` 的子元素却按绝对坐标设
   `left/top`，π 一度被推到 x=2979 画面外。同类错：composer/terminal 用窗口坐标而非 `#main`
   相对坐标，整体右移 250px 被裁。
4. **全局 `box-sizing: border-box`**。少这一行，`.tab`/`.ububble` 的 padding 撑出容器，
   模型名和气泡被裁。
5. **`position:absolute` 的祖先要有 relative**；`{top:...}` 只在绝对定位元素上生效。
6. **多帧同屏判空要靠像素**。`check.mjs` 用 `ffmpeg -pix_fmt gray` 算 mean luma：纯黑 ≈ 4，
   阈值 9。第一版 seek 全黑就是靠这道门禁抓到的——DOM 断言全绿、画面是黑的。
7. **渲染吞吐 ≈ 0.23s/帧，与 `--concurrency` 无关**（瓶颈在 headless 截图合成，不在本页）。
   40s×120fps = 4800 帧 ≈ 18 分钟，别按"concurrency=8 就能快 8 倍"来排期。
8. **CUA 抓图要 `SetProcessDPIAware()`**。本机 125% DPI，不设的话窗口 rect 被虚拟化成
   2048×1152 逻辑坐标，截出来是错位的。
9. **`.ps1` 注释只能写 ASCII**。Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 解码，
   中文注释会变成非法 token，报 `表达式或语句中包含意外的标记"}"`。
10. **同一窗口里有并行 agent 在跑的时候别乱点 UI**——会污染对方正在做的界面截图审计。
    抓图前先确认那个窗口的输入框是空闲态。
11. **ffmpeg 的 `asetpts` 只能写 `asetpts=N/SR/TB`**，`SB` 不是合法常数（报
   `Undefined constant or missing '(' in 'SB'`）；Python 脚本里别 `print("✓")`，
    Windows GBK 控制台会抛 `UnicodeEncodeError`。
12. **`tmix=frames` 要按源帧率换算**：120fps 下 `frames=2` 才是 8.3ms；`frames=4` = 33ms，
    UI 会拖成鬼影。
13. **绝对定位的「知识卡」是屏幕坐标，在 `#world` 之外**，窗口在世界空间里会压上来。
    窗口退场时必须**连 `#shape` 一起淡**——`#shape` 自带 `background:#171717`，只淡 `#win` 会剩一块灰板。
14. **`docs/images/` 里的截图久未维护，别再拿来当素材**。全部按 CUA 现抓的 `promo/ref/`
    实测几何/配色/文案用 DOM 复刻——贴图既过时又没法做形变与逐拍动画。

## 系列规划

| 期 | 主题 | 时长 | 核心 beat |
|----|------|------|-----------|
| **EP01** | 总纲：5 个会话各占一个 Tab，同时在跑 | 80s | 像素 logo→窗口 morph / 连点侧栏开 5 个 Tab / 五路并行 / 拖 Tab 分屏 / 终端+文件+Git 同会话 / Pi vs DSH · 一个窗口 vs 五个终端 · 11 种导入 |
| EP02 | 一次输入，Agent 就开工：提问、工具调用、可视化执行过程 | 45s | 打开一个真实长会话，逐条 replay 工具行，读 diff 与文件变更 |
| EP03 | 上下文与成本看得见：用量、缓存命中、会话时间线 | 40s | 状态栏统计滚动 → 缓存命中 100% 的会话 → 圆环压缩 → 时间线回放 |
| EP04 | 模型 · 信任 · 技能 · 提示词，一个面板配好 | 35s | 设置页分段切换：模型/认证/信任/MCP/技能，五段实拍式重建 |
| EP05 | 开源三平台：Windows · macOS · Linux，MIT | 30s | 三个系统窗口依次 morph，落到仓库地址 |

每期沿用同一套 `film.src.html` 骨架（shape morph + 双光标 + 相机），只换 `#scene` 内容与
caption——所以 EP02 起主要成本在"按实测几何重建界面"，不在动画。

## 参考

- `product-launch-motion` v2：<https://github.com/AbubakrChan/product-launch-motion>
  本地副本曾 clone 到 `C:/tmp/pi-github-repos/` 下（`SKILL.md` + `references/technique.md`
  + `references/prompts.md`）。方法论以它为准，本文表格是它的规则在本项目的落地。
- 音效库：huashu-design skill 的 `assets/sfx/`（37 个）；BGM 同 skill 的 `assets/bgm-*.mp3`。
- 仓库地址：<https://atomgit.com/ayuayue/PiDeck> · <https://github.com/ayuayue/PiDeck>（MIT）
