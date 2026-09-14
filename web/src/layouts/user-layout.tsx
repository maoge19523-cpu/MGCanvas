import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppSideNav } from "@/components/layout/app-side-nav";
import { AppTopNav } from "@/components/layout/app-top-nav";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    // 画布项目页（/canvas/{id}）自带完整工具栏，隐藏左侧导航以保留整块画布空间。
    const hideSideNav = /^\/canvas\/[^/]+/.test(pathname);

    return (
        <div className="flex h-full min-h-0 overflow-hidden bg-background text-foreground">
            {hideSideNav ? null : <AppSideNav />}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            <AgentPanel />
        </div>
    );
}
