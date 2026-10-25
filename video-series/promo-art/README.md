# PiDeck 宣传片（promo-art）

用 **huashu-art-motion** 技能做的一支 PiDeck 品牌宣传片。54 秒，1920×1080@30fps，带 BGM。

> 这条流水线和仓库里另一条 `video-series/promo/`（HTML/CSS 重建界面的 EP01）**刻意分工**：
> `promo/` 是「把界面用 DOM 重建出来做形变动画」；本目录是「真实截图当主画面，代码只做标注与运镜」。
> 两套不共用代码，风格也刻意区分。

## 成果

| | |
|---|---|
| 成片 | `output/PiDeck-宣传片.mp4`（54.0s / 1920×1080 / 30fps / H.264+AAC） |
| 交付说明 | `output/交付说明.md`（门禁 + qa + 制作说明） |
| 分镜表 | `镜头表.md`（16 镜，lint 绿灯） |
| 独立审片 | `审片/审片结论.md` |
| 门禁 | 快速运动帧 0.073 ✓ · 空画面 0.000s ✓ · 蓝紫 0.000 ✓ |

## 这片子长什么样

**画风锁**（见 `镜头表.md`）：真实 PiDeck **暗色**界面截图等比铺满当主画面，代码只做三件事——压暗、画珊瑚红标注、运镜。全片一套色板，无人出镜。

| | 颜色 | 来源 |
|---|---|---|
| 底 | `#171717` | 真实暗色截图主底 |
| 面 | `#262626` | 真实暗色截图面板 |
| 墨 | `#F2EFE8` | 真实暗色截图正文 |
| 次 | `#A39E93` | 真实暗色截图次要字 |
| 强调 | `#E79688` | PiDeck logo 珊瑚红 |
| 副强调 | `#619ABB` | PiDeck logo 天蓝 |

**16 镜**：侧栏会话点 → 标签栏 → spinner → 工具行 → 状态栏 → 文件树 → 终端 → Git 面板 → 对话区 → 执行过程 → 模型选择 → 发送按钮 → 会话角标 → 拉远全景 → 推向真实 Logo 落版。

## 目录

```
promo-art/
├── 镜头表.md              ★ 分镜表（16 镜，lint 绿灯）
├── 经验回流-草稿.md        ★ 本次实战经验（已回流进 skill）
├── README.md
├── output/
│   ├── PiDeck-宣传片.mp4   ★ 成片
│   └── 交付说明.md         ★ 门禁 + qa + 制作说明
├── 审片/                  独立审片结论 + 逐帧抽帧
├── qa/final4/             qa.py 输出（逐镜运动/确定性/框景）
├── assets/                真实截图素材 + 放大裁切
├── tools/                 素材准备、测量、亮度扫描等辅助脚本
└── 代码工程/              huashu-art-motion 引擎工程（已裁剪到最小可用）
    ├── eras_pideck.js     16 镜段落表
    ├── engine.js / transitions.js / index.html / render.py
    ├── lib/               引擎核心（MD / CAM / MO / PAL / U）
    ├── assets/            本片用到的真实截图
    └── scenes/
        ├── pd_lib.js      公共绘制库（铺满/标注/纸标/扫过/呼吸/滚动/脉动）
        ├── pd_01_04.js    第 1–4 镜
        ├── pd_05_09.js    第 5–9 镜
        └── pd_10_15.js    第 10–16 镜
```

## 出片流程

```bash
cd video-series/promo-art/代码工程

# 1. 渲成片（54s @30fps）
python render.py --film pideck --out ../成片.mp4 --fps 30

# 2. 配乐（BGM 取自 ../promo/audio-bgm-tech.mp3，14.0s 起 54s，120 BPM）
ffmpeg -y -ss 14.0 -t 54.0 -i ../promo/audio-bgm-tech.mp3 \
  -af "volume=0.85,afade=t=in:st=0:d=0.6,afade=t=out:st=52.4:d=1.6,alimiter=limit=0.94" \
  -c:a pcm_s16le -ar 48000 -ac 2 bgm.wav
ffmpeg -y -i ../成片.mp4 -i bgm.wav -map 0:v -map 1:a \
  -c:v copy -c:a aac -b:a 256k -ar 48000 -shortest ../成片_配乐.mp4

# 3. 验收
python <skill>/scripts/qa.py --project . --film pideck --out ../qa/final
python <skill>/scripts/deliver.py ../成片_配乐.mp4 --root .. --qa ../qa/final --out ../output/
```

## 这条管线上踩的坑

1. **`NODE_OPTIONS` + `ELECTRON_RUN_AS_NODE=1` 会污染 Playwright 的 driver**——DSH 运行时注入了这两个变量，Chromium 直接起不来。跑任何 playwright 命令前先 `$env:NODE_OPTIONS=""; $env:ELECTRON_RUN_AS_NODE=""`。
2. **Python playwright 1.61 要 chromium-1228，缓存里只有 1208/1234**——用目录联接对齐版本（`New-Item -ItemType Junction`）。
3. **Windows 目录名带中文会让 spec/素材路径乱码**（GBK 控制台）——项目目录一律用 ASCII。
4. **skill 侧三个编码 bug**（已修进 skill）：`render.py` 的 `sp.read_text()`、`qa.py` 的 `write_text()`/`read_text()`、`deliver.py` 的 `write_text()` 都没指定 encoding，Windows 上分别导致「中文 spec 全乱码」「报告写不出来崩」「交付说明变成 GBK 乱码」。
5. **用裁切过的素材 + 原图坐标 = 全错位**——标注框必须用「整张原图的像素坐标」再经 `fit()` 换算。
6. **代码画的高亮块会盖住真素材**（/plan 那镜最明显）——改成「压暗周围 + 珊瑚红框住真实元素」，绝不重画截图里已有的东西。
7. **推得太近（z>2）之后标注动画像素占比太小，qa 量不到运动**——重音镜的推近幅度控制在 1.05–1.3，标注动画负责提供运动。
8. **纸标不能落进底部字幕带**（`safe.bottom` = 0.852×1080 ≈ 920px）——标签绘制函数内置安全区（不落底部 14%、不贴边 44px），一处修好全片。
9. **浅色 UI 的大片白底会被门禁判成「空画面」**——做真实截图片优先选暗色主题。
10. **门禁的「快动帧」是 12fps/320 宽灰度/平均绝对差 ≥ 9**——细标注线永远达不到阈值，得让画面里**大面积内容滚动**。
