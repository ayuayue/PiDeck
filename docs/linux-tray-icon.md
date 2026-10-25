# Linux / GNOME 托盘图标不显示：根因与修复

适用场景：GNOME（Wayland 或 X11）+ AppIndicator 托盘扩展，PiDeck 图标不出现，且每次启动必现（偶发 ≠ 本文档问题）。

## 现象

- 顶栏没有 PiDeck 图标，但 fcitx5、clash-verge 等其它应用图标正常；
- `journalctl --user -b | grep "initalizing proxy"` 可见：
  `While initalizing proxy for org.freedesktop.StatusNotifierItem-<pid>-1: ... org.freedesktop.DBus.Error.Failed: error occurred in Get`；
- 关键：PiDeck 默认开启「关闭窗口时隐藏到系统托盘」（`closeToTray`），图标缺席时点 X 会让窗口隐藏到无处可寻（进程仍在跑、pi 会话照常）。此时可再次启动 PiDeck 把窗口唤回。

## 根因（2026-09 实测）

托盘协议（StatusNotifierItem / SNI）只约定「有哪些属性」，没约定读取细节：

- Chromium/Electron 的 SNI 服务端对扩展初始化时的**逐个属性 `Get`** 一律返回 `Failed`（对 `GetAll` 则正常）—— 用 gdbus 直接验证过同一 SNI：`Get(Id)` 被秒拒、`GetAll` 成功；
- GNOME 扩展 **v65 及更早**（Debian 13 打包的 `gnome-shell-extension-appindicator 59-4`）初始化恰好走「逐个 Get」；
- 扩展 1s/2s/3s 三轮全部被拒后 `destroy()` 该图标且**不再重试**，图标从此缺席。

因此 Electron 系应用（PiDeck、Slack、Discord 等）在这类扩展上 100% 复现，而 Qt/Tauri 应用正常（它们的实现接受逐个 Get）。

## 修复：托盘扩展升级到 v66+

上游 `ubuntu/gnome-shell-extension-appindicator` [v66](https://github.com/ubuntu/gnome-shell-extension-appindicator/releases)（2026-09-22）把初始化改为 `refreshAllProperties()`（GetAll 路径），绕开 Chromium 的逐个 Get 行为。commit `b27e1d0a`。

用户级安装（不动系统包，可随时回滚）：

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
cd /tmp
curl -sL -o v66.tar.gz https://github.com/ubuntu/gnome-shell-extension-appindicator/archive/refs/tags/v66.tar.gz
tar xzf v66.tar.gz
cp -r gnome-shell-extension-appindicator-66/{*.js,interfaces-xml,icons,schemas,locale,metadata.json} \
  ~/.local/share/gnome-shell/extensions/appindicatorsupport@rgcjonas.gmail.com/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/appindicatorsupport@rgcjonas.gmail.com/schemas/
# 启用新扩展、停用系统旧版（UUID 不同，两者会抢 watcher，必须只留一个）
gsettings set org.gnome.shell enabled-extensions "['appindicatorsupport@rgcjonas.gmail.com']"
```

注意：

- 两个扩展 UUID 不同（`appindicatorsupport@rgcjonas.gmail.com` vs `ubuntu-appindicators@ubuntu.com`），**同时启用会互相抢 watcher，必须禁用其一**；
- **必须完整复制全部 js**：v66 新增了 `logger.js`、`menuUtils.js`、`pixmapsUtils.js`，缺任何一个都会 ImportError 导致扩展 ERROR；
- Wayland 下 Shell 不热加载扩展，装完需**注销重登录**；X11 可 `Alt+F2 → r` 重载。

验证：

```bash
dbus-send --session --dest=org.kde.StatusNotifierWatcher --print-reply /StatusNotifierWatcher \
  org.freedesktop.DBus.Properties.Get string:org.kde.StatusNotifierWatcher \
  string:RegisteredStatusNotifierItems | grep StatusNotifierItem
```

列表里有 `org.freedesktop.StatusNotifierItem-<PiDeck pid>-<n>` 即成功。

## PiDeck 侧的配合诊断

`src/main/tray/trayRegistrationVerify.ts` 在启动 6 秒后（扩展的三轮窗口结束）查一次 watcher 列表并记日志：

- `tray verify: registered` —— 图标已挂上；
- `tray verify: unregistered ...` —— 扩展多半是 v65 及更早，按上文升级；不自动修复（重建 Tray 换名字实测无效：扩展读法不变，结果不变）；
- `tray verify: watcher unavailable ...` —— 本机没有托盘环境（如 GNOME 未装任何 appindicator 扩展），`closeToTray` 无意义，建议在设置里关闭。

## 无关的可能（避免误诊）

- 主进程繁忙/事件循环阻塞：启动期 lag 采样无记录，已排除；
- 托盘重建时机/次数：换名重建后扩展用同样读法再来一遍，v1/v2/延迟 60s 全部失败，已排除；
- 图标文件缺失：`/tmp/org.chromium.*/status_icon_*.png` 正常生成，已排除。
