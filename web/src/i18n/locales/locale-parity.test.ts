import { describe, expect, it } from "vitest";

import enUS from "./en-US";
import zhCN from "./zh-CN";

function paths(value: unknown, prefix = ""): string[] {
    if (!value || typeof value !== "object") return [prefix];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
}

describe("编辑器 locale 键位对齐", () => {
    it("剪辑台（editor）新增文案在中英两份里键完全一致", () => {
        const zh = paths((zhCN as Record<string, unknown>).editor, "editor");
        const en = paths((enUS as Record<string, unknown>).editor, "editor");
        expect(zh.filter((key) => !en.includes(key))).toEqual([]);
        expect(en.filter((key) => !zh.includes(key))).toEqual([]);
    });

    it("本次新增的撤销栈与快捷键文案两份都在", () => {
        const editor = (locale: typeof zhCN) => locale.editor as Record<string, unknown>;
        for (const key of ["undo", "redo", "snapToggle", "shortcuts", "shortcutsTitle", "splitNowhere", "deleteNowhere", "history", "shortcutLabels"]) {
            expect(editor(zhCN)[key]).toBeTruthy();
            expect(editor(enUS)[key]).toBeTruthy();
        }
    });
});
