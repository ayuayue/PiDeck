import { createContext } from "react";

/** 桌面工作台提供给 Markdown 链接的显式内置浏览器入口。 */
export const BrowserLinkContext = createContext<((url: string) => void) | undefined>(undefined);
