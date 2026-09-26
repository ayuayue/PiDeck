/**
 * 兼容入口：dev 构建已升级为三平台统一的 scripts/dist-dev.js（独立 productName /
 * appId / pideck-dev 协议，userData 与 stable 共用 pi-desktop）。本文件仅保留
 * 旧调用方式的转发（旧行为 = 仅打 win nsis）。
 */
require("./dist-dev.js").run(["--win", "nsis"]);
