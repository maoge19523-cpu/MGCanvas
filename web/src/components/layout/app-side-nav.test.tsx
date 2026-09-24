import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { createInstance } from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

// @/i18n 在模块初始化时读 localStorage，node 测试环境没有它；界面文案由下面的真实 zh-CN 资源提供。
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

import zhCN from "@/i18n/locales/zh-CN";
import { AppSideNav } from "./app-side-nav";

// 导航栏折叠状态存在 localStorage 里，node 环境要补一个最小实现（只在组件渲染时读写）。
if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key),
            clear: () => store.clear(),
            key: () => null,
            length: 0,
        },
        configurable: true,
    });
}

const i18n = createInstance();
beforeAll(async () => {
    await i18n.init({ resources: { "zh-CN": { translation: zhCN } }, lng: "zh-CN", fallbackLng: "zh-CN", interpolation: { escapeValue: false }, react: { useSuspense: false } });
});

describe("左侧导航：剪辑台入口", () => {
    it("「剪辑台」排在「提示词库」正下方，且链接与选中态沿用同一套样式", () => {
        const html = renderToStaticMarkup(
            <I18nextProvider i18n={i18n}>
                <MemoryRouter initialEntries={["/prompts"]}>
                    <AppSideNav />
                </MemoryRouter>
            </I18nextProvider>,
        );

        const prompts = html.indexOf(">提示词库<");
        const editor = html.indexOf(">剪辑台<");
        const cloud = html.indexOf(">ComfyUI 云端<");
        expect(prompts).toBeGreaterThan(-1);
        expect(editor).toBeGreaterThan(prompts);
        expect(cloud).toBeGreaterThan(editor);
        // 路由指向 /editor，图标沿用 lucide 的 clapperboard（与合成节点同一套图标语言）。
        expect(html).toContain('href="/editor"');
        expect(html).toContain("lucide-clapperboard");
        // 选中态：当前在提示词库，只有它带 aria-current="page"。
        expect(html.match(/aria-current="page"/g)?.length).toBe(1);
    });
});
