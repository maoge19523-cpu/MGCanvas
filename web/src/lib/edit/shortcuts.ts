/**
 * 剪辑台快捷键表：少而精，不做上游那几套键位预设。
 * 这里只有纯数据与纯函数，监听与执行放在页面组件里。
 */
export type EditShortcutAction = "playPause" | "split" | "delete" | "rippleDelete" | "undo" | "redo" | "toggleSnap" | "stepBack" | "stepForward" | "stepSecondBack" | "stepSecondForward";

export type EditShortcutBinding = {
    id: string;
    action: EditShortcutAction;
    /** 小写 key（KeyboardEvent.key），修饰键单独声明。 */
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    /** i18n key：这条快捷键做什么。 */
    labelKey: string;
};

export const EDIT_SHORTCUTS: EditShortcutBinding[] = [
    { id: "playPause", action: "playPause", key: " ", labelKey: "editor.shortcutLabels.playPause" },
    { id: "split", action: "split", key: "s", labelKey: "editor.shortcutLabels.split" },
    { id: "delete", action: "delete", key: "delete", labelKey: "editor.shortcutLabels.delete" },
    { id: "rippleDelete", action: "rippleDelete", key: "delete", shift: true, labelKey: "editor.shortcutLabels.rippleDelete" },
    { id: "undo", action: "undo", key: "z", ctrl: true, labelKey: "editor.shortcutLabels.undo" },
    { id: "redo", action: "redo", key: "z", ctrl: true, shift: true, labelKey: "editor.shortcutLabels.redo" },
    { id: "redoAlt", action: "redo", key: "y", ctrl: true, labelKey: "editor.shortcutLabels.redo" },
    { id: "toggleSnap", action: "toggleSnap", key: "n", labelKey: "editor.shortcutLabels.toggleSnap" },
    { id: "stepBack", action: "stepBack", key: "arrowleft", labelKey: "editor.shortcutLabels.stepBack" },
    { id: "stepForward", action: "stepForward", key: "arrowright", labelKey: "editor.shortcutLabels.stepForward" },
    { id: "stepSecondBack", action: "stepSecondBack", key: "arrowleft", shift: true, labelKey: "editor.shortcutLabels.stepSecondBack" },
    { id: "stepSecondForward", action: "stepSecondForward", key: "arrowright", shift: true, labelKey: "editor.shortcutLabels.stepSecondForward" },
];

/** 时间线角落常驻展示的那几条：界面上随时看得到，完整表在帮助弹层里。 */
export const EDIT_SHORTCUT_HINT_IDS = ["playPause", "split", "delete", "rippleDelete", "undo", "toggleSnap"];

export function editShortcutHints(table: EditShortcutBinding[] = EDIT_SHORTCUTS) {
    return EDIT_SHORTCUT_HINT_IDS.flatMap((id) => table.filter((binding) => binding.id === id));
}

/** 界面上的按键写法（帮助面板用）。 */
export function editShortcutDisplay(binding: EditShortcutBinding) {
    const parts: string[] = [];
    if (binding.ctrl) parts.push("Ctrl");
    if (binding.shift) parts.push("Shift");
    if (binding.alt) parts.push("Alt");
    const key = binding.key === " " ? "Space" : binding.key === "arrowleft" ? "←" : binding.key === "arrowright" ? "→" : binding.key === "delete" ? "Del" : binding.key.toUpperCase();
    parts.push(key);
    return parts.join(" + ");
}

/** Backspace 与 Delete 是同义键，统一成 delete 再匹配。 */
export function normalizeEditShortcutKey(key: string) {
    const lower = key.toLowerCase();
    if (lower === "backspace") return "delete";
    if (lower === "spacebar" || lower === "space") return " ";
    return lower;
}

export function matchEditShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, table: EditShortcutBinding[] = EDIT_SHORTCUTS) {
    const key = normalizeEditShortcutKey(event.key);
    const primary = event.ctrlKey || event.metaKey;
    return (
        table.find(
            (binding) =>
                binding.key === key &&
                Boolean(binding.ctrl) === primary &&
                Boolean(binding.shift) === event.shiftKey &&
                Boolean(binding.alt) === event.altKey,
        ) ?? null
    );
}

/** 焦点在输入框 / 文本域 / 可编辑元素上时必须放行，否则用户打不出字。 */
export function isEditShortcutTargetBlocked(target: { tagName?: string; isContentEditable?: boolean } | null | undefined) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = (target.tagName || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
