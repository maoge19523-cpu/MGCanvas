import { describe, expect, it } from "vitest";

import { EDIT_SHORTCUTS, editShortcutDisplay, editShortcutHints, isEditShortcutTargetBlocked, matchEditShortcut, normalizeEditShortcutKey } from "./shortcuts";

function key(keyValue: string, patch: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
    return { key: keyValue, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...patch };
}

describe("剪辑台快捷键表：少而精", () => {
    it("表里覆盖播放、拆分、删除、涟漪删除、撤销、重做、吸附开关与逐帧微调", () => {
        const actions = new Set(EDIT_SHORTCUTS.map((binding) => binding.action));
        expect([...actions].sort()).toEqual(["delete", "playPause", "redo", "rippleDelete", "split", "stepBack", "stepForward", "stepSecondBack", "stepSecondForward", "toggleSnap", "undo"]);
    });

    it("每个 action 至少有一条键位，且不会出现「同键同修饰键」的冲突", () => {
        expect(EDIT_SHORTCUTS.length).toBeGreaterThanOrEqual(11);
        const combos = EDIT_SHORTCUTS.map((binding) => [binding.key, Boolean(binding.ctrl), Boolean(binding.shift), Boolean(binding.alt)].join("|"));
        expect(new Set(combos).size).toBe(combos.length);
    });
});

describe("剪辑台快捷键：匹配", () => {
    it("空格、S、Delete、Shift+Delete、N 与方向键都按定义匹配", () => {
        expect(matchEditShortcut(key(" "))?.action).toBe("playPause");
        expect(matchEditShortcut(key("s"))?.action).toBe("split");
        expect(matchEditShortcut(key("S"))?.action).toBe("split");
        expect(matchEditShortcut(key("Delete"))?.action).toBe("delete");
        expect(matchEditShortcut(key("Delete", { shiftKey: true }))?.action).toBe("rippleDelete");
        expect(matchEditShortcut(key("n"))?.action).toBe("toggleSnap");
        expect(matchEditShortcut(key("ArrowLeft"))?.action).toBe("stepBack");
        expect(matchEditShortcut(key("ArrowRight"))?.action).toBe("stepForward");
        expect(matchEditShortcut(key("ArrowLeft", { shiftKey: true }))?.action).toBe("stepSecondBack");
        expect(matchEditShortcut(key("ArrowRight", { shiftKey: true }))?.action).toBe("stepSecondForward");
    });

    it("撤销 / 重做：Ctrl+Z、Ctrl+Shift+Z、Ctrl+Y 与 macOS 的 Cmd 都认", () => {
        expect(matchEditShortcut(key("z", { ctrlKey: true }))?.action).toBe("undo");
        expect(matchEditShortcut(key("z", { ctrlKey: true, shiftKey: true }))?.action).toBe("redo");
        expect(matchEditShortcut(key("y", { ctrlKey: true }))?.action).toBe("redo");
        expect(matchEditShortcut(key("z", { metaKey: true }))?.action).toBe("undo");
        expect(matchEditShortcut(key("z", { metaKey: true, shiftKey: true }))?.action).toBe("redo");
    });

    it("修饰键必须严格一致，否则不匹配", () => {
        expect(matchEditShortcut(key("s", { ctrlKey: true }))).toBeNull();
        expect(matchEditShortcut(key("z"))).toBeNull();
        expect(matchEditShortcut(key("Delete", { ctrlKey: true }))).toBeNull();
        expect(matchEditShortcut(key("ArrowLeft", { ctrlKey: true }))).toBeNull();
        expect(matchEditShortcut(key("q"))).toBeNull();
    });

    it("Backspace 与 Delete 同义，统一后再匹配", () => {
        expect(normalizeEditShortcutKey("Backspace")).toBe("delete");
        expect(normalizeEditShortcutKey("Spacebar")).toBe(" ");
        expect(normalizeEditShortcutKey("KeyS")).toBe("keys");
        expect(matchEditShortcut(key("Backspace"))?.action).toBe("delete");
        expect(matchEditShortcut(key("Backspace", { shiftKey: true }))?.action).toBe("rippleDelete");
    });
});

describe("剪辑台快捷键：输入框内不拦截", () => {
    it("输入框 / 文本域 / 下拉 / 可编辑元素都放行", () => {
        expect(isEditShortcutTargetBlocked({ tagName: "INPUT" })).toBe(true);
        expect(isEditShortcutTargetBlocked({ tagName: "input" })).toBe(true);
        expect(isEditShortcutTargetBlocked({ tagName: "TEXTAREA" })).toBe(true);
        expect(isEditShortcutTargetBlocked({ tagName: "SELECT" })).toBe(true);
        expect(isEditShortcutTargetBlocked({ tagName: "DIV", isContentEditable: true })).toBe(true);
    });

    it("普通元素与拿不到的 target 都照常拦截快捷键", () => {
        expect(isEditShortcutTargetBlocked({ tagName: "DIV" })).toBe(false);
        expect(isEditShortcutTargetBlocked({ tagName: "BUTTON" })).toBe(false);
        expect(isEditShortcutTargetBlocked(null)).toBe(false);
        expect(isEditShortcutTargetBlocked(undefined)).toBe(false);
    });
});

describe("剪辑台快捷键：界面展示", () => {
    it("按键写法稳定可读", () => {
        const display = (id: string) => editShortcutDisplay(EDIT_SHORTCUTS.find((binding) => binding.id === id)!);
        expect(display("playPause")).toBe("Space");
        expect(display("split")).toBe("S");
        expect(display("delete")).toBe("Del");
        expect(display("rippleDelete")).toBe("Shift + Del");
        expect(display("undo")).toBe("Ctrl + Z");
        expect(display("redo")).toBe("Ctrl + Shift + Z");
        expect(display("stepBack")).toBe("←");
    });

    it("常驻提示固定取那几条核心快捷键", () => {
        expect(editShortcutHints().map((binding) => binding.id)).toEqual(["playPause", "split", "delete", "rippleDelete", "undo", "toggleSnap"]);
    });
});
