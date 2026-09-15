import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { navigationTools } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";

/** 主导航按「资产 → 画布 → 提示词 → ComfyUI」排列，配置与系统操作放到底部。 */
const PRIMARY_SLUGS = ["assets", "canvas", "prompts", "comfyui-local"] as const;
const COLLAPSE_KEY = "mgcanvas:side-nav-collapsed";

/**
 * 桌面端左侧导航栏：品牌、主导航、底部配置与系统操作，支持折叠为纯图标模式。
 * 画布项目页（/canvas/{id}）自带完整工具栏，由调用方决定是否隐藏本栏。
 */
export function AppSideNav() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeSlug = pathname === "/" ? "canvas" : slug;
    const primaryTools = PRIMARY_SLUGS.map((target) => navigationTools.find((tool) => tool.slug === target)).filter((tool): tool is (typeof navigationTools)[number] => Boolean(tool));

    const toggleCollapsed = () => {
        setCollapsed((value) => {
            localStorage.setItem(COLLAPSE_KEY, value ? "0" : "1");
            return !value;
        });
    };

    const renderItem = (tool: (typeof navigationTools)[number]) => {
        const Icon = tool.icon;
        const active = tool.slug === activeSlug;
        const label = t(`navigation.${tool.slug}`);
        return (
            <Link
                key={tool.slug}
                to={`/${tool.slug}`}
                aria-current={active ? "page" : undefined}
                title={collapsed ? label : undefined}
                className={cn(
                    "relative flex h-9 w-full items-center rounded-[10px] text-[13px] transition-colors",
                    collapsed ? "justify-center px-0" : "gap-2.5 px-3",
                    // 选中态用左侧竖条表达，比整块底色更轻、辨识度更高。
                    active
                        ? "bg-black/[0.05] font-medium text-stone-950 before:absolute before:-left-1.5 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-[#756bff] dark:bg-white/[0.07] dark:text-zinc-50 dark:before:bg-[#a59eff]"
                        : "text-stone-600 hover:bg-black/[0.04] hover:text-stone-950 dark:text-zinc-400 dark:hover:bg-white/[0.05] dark:hover:text-zinc-100",
                )}
            >
                <Icon className="size-[16px] shrink-0" strokeWidth={1.7} />
                {collapsed ? null : <span className="truncate">{label}</span>}
            </Link>
        );
    };

    return (
        <aside className={cn("td-app-side-nav flex shrink-0 flex-col border-r border-black/[0.07] bg-[#faf9f7] transition-[width] duration-200 ease-out dark:border-white/[0.07] dark:bg-[#0c0d0f]", collapsed ? "w-[64px]" : "w-[176px]")}>
            <div className={cn("flex h-14 shrink-0 items-center", collapsed ? "justify-center px-2" : "gap-2.5 px-4")}>
                <Link to="/" className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80" title={t("meta.title")}>
                    <img src="/logo.png" alt="" aria-hidden="true" className="size-[24px] shrink-0 rounded-[7px]" />
                    {collapsed ? null : <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-stone-950 dark:text-zinc-50">{t("meta.title")}</span>}
                </Link>
                {collapsed ? null : (
                    <button
                        type="button"
                        onClick={toggleCollapsed}
                        aria-label={t("topNav.collapseSideNav")}
                        title={t("topNav.collapseSideNav")}
                        className="ml-auto grid size-7 shrink-0 cursor-pointer place-items-center rounded-[8px] text-stone-400 transition-colors hover:bg-black/[0.05] hover:text-stone-700 dark:text-zinc-500 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
                    >
                        <PanelLeftClose className="size-[15px]" strokeWidth={1.7} />
                    </button>
                )}
            </div>

            <nav className={cn("flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-2 pt-1", collapsed ? "px-2" : "px-2.5")} aria-label={t("topNav.menu")}>
                {primaryTools.map(renderItem)}
            </nav>

            <div className={cn("shrink-0 border-t border-black/[0.07] py-2.5 dark:border-white/[0.07]", collapsed ? "px-2" : "px-2.5")}>
                {navigationTools.filter((tool) => tool.slug === "config").map(renderItem)}

                {collapsed ? (
                    <button
                        type="button"
                        onClick={toggleCollapsed}
                        aria-label={t("topNav.expandSideNav")}
                        title={t("topNav.expandSideNav")}
                        className="mt-1 flex h-9 w-full cursor-pointer items-center justify-center rounded-[10px] text-stone-500 transition-colors hover:bg-black/[0.04] hover:text-stone-900 dark:text-zinc-400 dark:hover:bg-white/[0.05] dark:hover:text-zinc-100"
                    >
                        <PanelLeftOpen className="size-[16px]" strokeWidth={1.7} />
                    </button>
                ) : (
                    <div className="mt-1.5 flex items-center px-1">
                        <UserStatusActions showConfig={false} />
                    </div>
                )}
            </div>
        </aside>
    );
}
