import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";
import { createMediaDownloadProxyPlugin } from "./server/media-download-proxy";
import { createMediaCachePlugin, resolveMediaCacheDirectory } from "./server/media-cache";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");
const mediaCache = resolveMediaCacheDirectory(resolve(webDir, ".."));

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig(({ mode }) => ({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), createMediaDownloadProxyPlugin(), createMediaCachePlugin({ cacheDir: mediaCache.cacheDir, allowedDataRoot: mediaCache.dataRoot })],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
        // 测试版与正式版共用一份源码，只靠构建模式区分运行渠道。
        __APP_CHANNEL__: JSON.stringify(mode === "beta" ? "beta" : "release"),
    },
    build: {
        rollupOptions: {
            input: {
                app: resolve(webDir, "index.html"),
                splashscreen: resolve(webDir, "splashscreen.html"),
            },
        },
    },
    // 渠道请求在桌面端由 Tauri HTTP 能力直接发送，浏览器调试时按渠道自身地址直连。
    server: {
        strictPort: true,
        watch: {
            ignored: ["**/src-tauri/**"],
        },
    },
}));
