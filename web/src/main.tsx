import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import { APP_WINDOW_TITLE, IS_BETA_CHANNEL } from "@/constant/env";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { installNativeContextMenuGuard } from "@/lib/native-context-menu";
import { router } from "@/router";
import { registerComfyWorkflowCanvasNode } from "@/integrations/comfyui-local/canvas-node";
import { syncDesktopWindowTitle } from "@/services/platform/desktop-runtime";

initAnalytics();
installNativeContextMenuGuard();
registerComfyWorkflowCanvasNode();

// 测试版与正式版共用窗口配置，只有测试版在启动时改写标题以便区分。
if (IS_BETA_CHANNEL) void syncDesktopWindowTitle(APP_WINDOW_TITLE);

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </React.StrictMode>,
);
