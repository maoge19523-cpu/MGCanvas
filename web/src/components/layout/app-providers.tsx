import type { ReactNode } from "react";
import { useEffect } from "react";
import axios from "axios";

import { trackFocusedEditable } from "@/lib/last-focused-editable";
import { desktopAxiosAdapter } from "@/services/platform/desktop-axios-adapter";
import { isTauriRuntime } from "@/services/platform/desktop-runtime";
import { ProConfigProvider } from "@ant-design/pro-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import enUS from "antd/es/locale/en_US";
import zhCN from "antd/es/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useTranslation } from "react-i18next";

import { ClientRootInit } from "@/components/layout/client-root-init";
import { DesktopStartupReady } from "@/components/layout/desktop-startup-ready";
import { DesktopTitlebar } from "@/components/layout/desktop-titlebar";
import type { AppLocale } from "@/i18n";
import { getAntThemeConfig } from "@/lib/app-theme";
import { isWindowsDesktopRuntime, syncDesktopWindowTheme } from "@/services/platform/desktop-runtime";
import { useThemeStore } from "@/stores/use-theme-store";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            retry: false,
            refetchOnWindowFocus: false,
        },
    },
});

// 弹层容器统一固定为模块级函数与 document.body：antd 的 Portal 内部有一个没有依赖
// 数组的 useEffect，会把 getContainer 的结果反复写回 state；只要容器引用每次变化就会
// 无限重渲染（React #185）。这里保证所有弹层拿到的容器函数与容器节点恒定不变。
const getPopupContainer = () => document.body;

export function AppProviders({ children }: { children: ReactNode }) {
    const { i18n, t } = useTranslation();
    const theme = useThemeStore((state) => state.theme);
    const dark = theme === "dark";
    const locale = i18n.resolvedLanguage as AppLocale;
    const windowsDesktop = isWindowsDesktopRuntime();

    useEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = theme;
        void syncDesktopWindowTheme(theme).catch(() => undefined);
    }, [dark, theme]);

    useEffect(() => {
        document.documentElement.lang = locale;
        document.title = t("meta.title");
        document.querySelector('meta[name="description"]')?.setAttribute("content", t("meta.description"));
        dayjs.locale(locale === "zh-CN" ? "zh-cn" : "en");
    }, [locale, t]);

    // 记录最后一次聚焦的输入框，供画布右键菜单提供粘贴等文本操作。
    useEffect(() => trackFocusedEditable(), []);

    // 诊断用：包装全局 fetch，失败时带上具体地址，便于定位「Failed to fetch」来自哪一步。
    useEffect(() => {
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            try {
                return await original(input, init);
            } catch (error) {
                const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
                const reason = error instanceof Error ? error.message : String(error);
                throw new Error(`请求 ${target} 失败（${reason}）`);
            }
        }) as typeof fetch;
        return () => {
            globalThis.fetch = original;
        };
    }, []);
    // 桌面端让 axios 走原生 HTTP：浏览器直连会被服务商的 CORS 拦下（Failed to fetch）。
    useEffect(() => {
        if (!isTauriRuntime()) return;
        const previous = axios.defaults.adapter;
        axios.defaults.adapter = desktopAxiosAdapter;
        return () => {
            axios.defaults.adapter = previous;
        };
    }, []);

    return (
        <ConfigProvider locale={locale === "zh-CN" ? zhCN : enUS} theme={getAntThemeConfig(dark)} getPopupContainer={getPopupContainer}>
            <ProConfigProvider dark={dark}>
                <App>
                    <QueryClientProvider client={queryClient}>
                        <DesktopStartupReady />
                        <div className="td-desktop-window-frame flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground" data-desktop-platform={windowsDesktop ? "windows" : undefined}>
                            <DesktopTitlebar />
                            <div className="min-h-0 flex-1 overflow-hidden">
                                <ClientRootInit>{children}</ClientRootInit>
                            </div>
                        </div>
                    </QueryClientProvider>
                </App>
            </ProConfigProvider>
        </ConfigProvider>
    );
}
