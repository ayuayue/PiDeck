import type { PiDesktopApi } from "../../preload";

declare global {
  interface Window {
    piDesktop: PiDesktopApi;
  }

  /** <webview> 的 DOM 元素形状：Electron 自定义元素，只声明 BrowserPanel 实际调用的能力。
   *  renderer 禁止 import Electron 运行时，故不用 Electron.WebviewTag 作运行时引用，
   *  在全局声明最小结构类型（loadURL/setUserAgent/getUserAgent/goBack/goForward/reload）。 */
  interface WebviewElement extends HTMLElement {
    loadURL(url: string): Promise<void>;
    setUserAgent(userAgent: string): void;
    getUserAgent(): string;
    canGoBack(): boolean;
    canGoForward(): boolean;
    isLoading(): boolean;
    goBack(): void;
    goForward(): void;
    reload(): void;
  }

  /** @types/react 把 JSX <webview> 硬编码为全局 HTMLWebViewElement（空接口，见
   *  node_modules/@types/react/global.d.ts），react-jsx 模式只认该命名空间的声明，
   *  模块内/全局 namespace JSX 增强都不生效。这里增强同名的全局接口，使 React 的
   *  ref 参数（HTMLWebViewElement | null）与 WebviewElement 结构等价，
   *  BrowserPanel 的 ref 回调无需任何强转。 */
  interface HTMLWebViewElement extends HTMLElement {
    loadURL(url: string): Promise<void>;
    setUserAgent(userAgent: string): void;
    getUserAgent(): string;
    canGoBack(): boolean;
    canGoForward(): boolean;
    isLoading(): boolean;
    goBack(): void;
    goForward(): void;
    reload(): void;
  }

  /** <webview> 是 Electron 的自定义元素，React JSX 需要显式声明类型。 */
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<WebviewElement> & {
          src?: string;
          partition?: string;
        },
        WebviewElement
      >;
    }
  }
}
