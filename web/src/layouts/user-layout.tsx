import type { ReactNode } from "react";
import { Tooltip } from "antd";
import { Bot } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppSideNav } from "@/components/layout/app-side-nav";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { useAgentStore } from "@/stores/use-agent-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const { t } = useTranslation();
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const panelMounted = useAgentStore((state) => state.panelMounted);
    const togglePanel = useAgentStore((state) => state.togglePanel);
    // 画布项目页（/canvas/{id}）自带完整工具栏，隐藏左侧导航以保留整块画布空间。
    const isCanvasProject = /^\/canvas\/[^/]+/.test(pathname);
    const hideSideNav = isCanvasProject;
    // Agent 入口固定在右下角；面板展开时自身带有收起方式，浮动按钮随之隐藏避免遮挡。
    const showAgentDock = panelMounted && !panelOpen;

    return (
        <div className="flex h-full min-h-0 overflow-hidden bg-background text-foreground">
            {hideSideNav ? null : <AppSideNav />}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                {/* 路由切换时播放一次淡入上移；画布项目页保持固定 key，避免重新挂载画布。 */}
                <div key={isCanvasProject ? "canvas-project" : pathname} className="td-page-enter min-h-0 flex-1 overflow-hidden">
                    {children}
                </div>
            </div>
            <AgentPanel />
            {showAgentDock ? (
                <Tooltip title={t("topNav.openAgent")} placement="left">
                    <button
                        type="button"
                        data-agent-dock
                        className="fixed bottom-6 right-6 z-[900] flex size-12 cursor-pointer items-center justify-center rounded-full border border-black/[0.08] bg-white text-stone-700 shadow-[0_10px_30px_rgba(0,0,0,0.18)] transition duration-200 hover:-translate-y-0.5 hover:text-stone-950 dark:border-white/[0.12] dark:bg-[#1c1d20] dark:text-zinc-200 dark:hover:text-white"
                        onClick={togglePanel}
                        aria-label={t("topNav.openAgent")}
                    >
                        <Bot className="size-5" strokeWidth={1.7} />
                    </button>
                </Tooltip>
            ) : null}
        </div>
    );
}
