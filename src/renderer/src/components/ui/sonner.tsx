import { Toaster as Sonner, type ToasterProps } from "sonner";
import { CircleCheck, Info, TriangleAlert, XCircle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Sonner Toaster 封装，适配 PiDeck 主题系统。
 *
 * 从 document.documentElement.dataset.theme 读取当前主题（"light" | "dark"），
 * 并监听变化同步更新。不依赖 next-themes。
 *
 * 风格参考 shadcn 的素雅设计：无 richColors 全色背景，改为中性底色 + 左侧细色条区分类型，
 * 图标更小（14px）、留白更克制，避免喧宾夺主。
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    if (typeof document === "undefined") return "system";
    return (document.documentElement.dataset.theme as "light" | "dark") || "system";
  });

  useEffect(() => {
    // 监听 data-theme 属性变化，同步更新 sonner 主题
    const observer = new MutationObserver(() => {
      const t = document.documentElement.dataset.theme;
      if (t === "light" || t === "dark") setTheme(t);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheck className="size-3.5" />,
        info: <Info className="size-3.5" />,
        warning: <TriangleAlert className="size-3.5" />,
        error: <XCircle className="size-3.5" />,
        loading: <Loader2 className="size-3.5 animate-spin" />,
      }}
      closeButton
      style={
        {
          "--normal-bg": "var(--color-bg-panel)",
          "--normal-text": "var(--color-text-primary)",
          "--normal-border": "var(--color-border-default)",
          "--border-radius": "var(--radius-sm)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
