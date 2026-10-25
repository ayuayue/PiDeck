// PiDeck 宣传片 · 段落表（15 段，对应镜头表的 16 镜：s15 一段内含「拉远全景」+「推向 Logo 落版」两镜）
// 画风锁：真实 PiDeck 界面（暗色主题）当主画面，等比铺满，不裁关键 UI；代码只做解释、标注和运镜。
// 色板（全部取自真实暗色截图）：底 #171717 / 面 #262626 / 字 #F2EFE8 / 次 #A39E93 / 强调 #E79688 / 副强调 #619ABB
// 共用脚本先加载（PD 库），再加载三段场景文件
window.SCENE_LIBS = ['scenes/pd_lib.js', 'scenes/pd_01_04.js', 'scenes/pd_05_09.js', 'scenes/pd_10_15.js'];
window.PUNCH = 0;                       // 关掉拍点冲击：解说片不该有这一下
window.BPM = 120;
window.ERAS = [
  { id: 's01_sidebar',   dur: 3.0,  assets: ['assets/src_dark.png'] },
  { id: 's02_dots',      dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's03_tabs',      dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's04_spinners',  dur: 4.0,  assets: ['assets/src_dark.png'] },
  { id: 's05_timeline',  dur: 4.0,  assets: ['assets/d_timeline.png'] },
  { id: 's06_stats',     dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's07_git',       dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's08_terminal',  dur: 4.0,  assets: ['assets/src_dark.png'] },
  { id: 's09_gitout',    dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's10_palette',   dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's11_plan',      dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's12_backend',   dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's13_send',      dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's14_badge',     dur: 3.5,  assets: ['assets/src_dark.png'] },
  { id: 's15_wide',      dur: 5.0,  assets: ['assets/src_dark.png'] },
];