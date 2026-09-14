import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { navigationTools } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";

/** 主导航按「资产 → 画布 → 提示词 → ComfyUI」排列，配置与系统操作放到底部。 */
const PRIMARY_SLUGS = ["assets", "canvas", "prompts", "comfyui-local"] as const;

/**
 * 桌面端左侧导航栏：品牌、主导航、底部配置与系统操作。
 * 画布项目页（/canvas/{id}）自带完整工具栏，由调用方决定是否隐藏本栏。
 */
export function AppSideNav() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeSlug = pathname === "/" ? "canvas" : slug;
    const primaryTools = PRIMARY_SLUGS.map((target) => navigationTools.find((tool) => tool.slug === target)).filter((tool): tool is (typeof navigationTools)[number] => Boolean(tool));

    const renderItem = (tool: (typeof navigationTools)[number]) => {
        const Icon = tool.icon;
        const active = tool.slug === activeSlug;
        return (
            <Link
                key={tool.slug}
                to={`/${tool.slug}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                    "flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-[13px] transition-colors",
                    active
                        ? "bg-black/[0.06] font-medium text-stone-950 dark:bg-white/[0.08] dark:text-zinc-50"
                        : "text-stone-600 hover:bg-black/[0.04] hover:text-stone-950 dark:text-zinc-400 dark:hover:bg-white/[0.05] dark:hover:text-zinc-100",
                )}
            >
                <Icon className="size-[16px] shrink-0" strokeWidth={1.7} />
                <span className="truncate">{t(`navigation.${tool.slug}`)}</span>
            </Link>
        );
    };

    return (
        <aside className="td-app-side-nav flex w-[176px] shrink-0 flex-col border-r border-black/[0.07] bg-[#faf9f7] dark:border-white/[0.07] dark:bg-[#0c0d0f]">
            <Link to="/" className="flex h-14 shrink-0 items-center gap-2.5 px-4 transition-opacity hover:opacity-80">
                <span
                    aria-hidden="true"
                    className="size-[22px] shrink-0 bg-[#292524] dark:bg-zinc-100"
                    style={{
                        mask: "url(/logo.svg) center / contain no-repeat",
                        WebkitMask: "url(/logo.svg) center / contain no-repeat",
                    }}
                />
                <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-stone-950 dark:text-zinc-50">{t("meta.title")}</span>
            </Link>

            <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2 pt-1" aria-label={t("topNav.menu")}>
                {primaryTools.map(renderItem)}
            </nav>

            <div className="shrink-0 border-t border-black/[0.07] px-2.5 py-2.5 dark:border-white/[0.07]">
                {navigationTools.filter((tool) => tool.slug === "config").map(renderItem)}
                <div className="mt-1.5 flex items-center px-1">
                    <UserStatusActions showConfig={false} />
                </div>
            </div>
        </aside>
    );
}
