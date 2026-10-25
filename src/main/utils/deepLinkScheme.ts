/**
 * 本构建使用的 deep link 协议 scheme。
 *
 * stable 通道 = `pideck://`；dev 通道安装包（__PIDECK_DEV_BUILD__，构建期由
 * electron-vite define 注入）= `pideck-dev://`。
 *
 * 双通道必须用不同 scheme：Windows 注册表按 scheme 为键，同一 scheme 会被
 * 后装 / 后启动的包互相抢占——dev 包一启动就会劫持正式版的 pideck:// 关联，
 * 导致点击系统通知唤起错误的通道。electron-builder 的 protocols 配置只在
 * 安装时写注册表，运行时兜底注册（app.setAsDefaultProtocolClient）与通知
 * launch URL 构造都从这里取值，保证两处与安装清单一致。
 */
declare const __PIDECK_DEV_BUILD__: boolean;

export const APP_DEEP_LINK_SCHEME = __PIDECK_DEV_BUILD__ ? "pideck-dev" : "pideck";
