import { Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { cn } from "@/lib/utils";
import { isWindowsDesktopRuntime } from "@/services/platform/desktop-runtime";
import { useAgentStore } from "@/stores/use-agent-store";

type DesktopTitlebarSlots = {
    navigation: HTMLElement;
    actions: HTMLElement;
};

export function AppTopNav() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [desktopTitlebarSlots, setDesktopTitlebarSlots] = useState<DesktopTitlebarSlots | null>(null);
    const autoConnectRef = useRef(false);
    const windowsDesktop = isWindowsDesktopRuntime();
    const agentToken = useAgentStore((state) => state.token);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentConnected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = pathname === "/" ? "canvas" : navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    useEffect(() => {
        if (autoConnectRef.current || agentEnabled || agentConnected || !agentToken.trim()) return;
        autoConnectRef.current = true;
        connectAgent({ silent: true });
    }, [agentConnected, agentEnabled, agentToken, connectAgent]);

    useEffect(() => {
        if (!windowsDesktop) return;
        const navigation = document.getElementById("td-desktop-titlebar-navigation-slot");
        const actions = document.getElementById("td-desktop-titlebar-actions-slot");
        if (navigation && actions) setDesktopTitlebarSlots({ navigation, actions });
    }, [windowsDesktop]);

    // 主导航已迁移到左侧边栏（AppSideNav），Agent 入口固定在右下角，标题栏只承载状态操作。
    const desktopActions = (
        <div className="flex h-full items-center gap-1 whitespace-nowrap">
            <UserStatusActions />
        </div>
    );

    return (
        <>
            {windowsDesktop && !hideHeader && desktopTitlebarSlots ? createPortal(desktopActions, desktopTitlebarSlots.actions) : null}

            {!windowsDesktop && !hideHeader ? (
                <header className="td-app-top-nav sticky top-0 z-20 h-14 shrink-0 border-b border-black/[0.06] bg-background/86 backdrop-blur-xl dark:border-white/[0.06]">
                    <div className="td-app-top-nav-inner mx-auto flex h-full w-full max-w-[1440px] items-stretch justify-between gap-5 px-6">
                        <div className="flex min-w-0 items-center">
                            <Link to="/" className="flex h-full shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-stone-950 transition hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300">
                                <span
                                    className="size-5 shrink-0 bg-current"
                                    style={{
                                        mask: "url(/logo.svg) center / contain no-repeat",
                                        WebkitMask: "url(/logo.svg) center / contain no-repeat",
                                    }}
                                />
                                <span className="td-app-top-nav-brand-label text-base font-medium">{t("meta.title")}</span>
                            </Link>

                            <button
                                type="button"
                                className="td-app-top-nav-menu ml-3 size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white"
                                onClick={() => setMobileNavOpen(true)}
                                aria-label={t("topNav.openMenu")}
                                title={t("topNav.menu")}
                            >
                                <Menu className="size-5" />
                            </button>

                            <nav className="td-app-top-nav-links hide-scrollbar ml-8 h-14 min-w-0 items-center gap-7 overflow-x-auto">
                                {navigationTools.map((tool) => {
                                    const Icon = tool.icon;
                                    const active = tool.slug === activeToolSlug;
                                    return (
                                        <Link
                                            key={tool.slug}
                                            to={`/${tool.slug}`}
                                            className={cn(
                                                "relative flex h-14 shrink-0 items-center gap-2 text-sm leading-6 transition after:absolute after:inset-x-0 after:bottom-0 after:h-px",
                                                active
                                                    ? "font-medium text-stone-950 after:bg-stone-950 dark:text-stone-100 dark:after:bg-stone-100"
                                                    : "text-stone-500 after:bg-transparent hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100",
                                            )}
                                        >
                                            <Icon className="size-4" />
                                            <span className="truncate">{t(`navigation.${tool.slug}`)}</span>
                                        </Link>
                                    );
                                })}
                            </nav>
                        </div>

                        <div className="td-app-top-nav-actions my-auto flex h-9 min-w-0 items-center justify-end gap-2 justify-self-end whitespace-nowrap">
                            <UserStatusActions />
                        </div>
                    </div>
                </header>
            ) : null}

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} />
            <AppConfigModal />
        </>
    );
}
