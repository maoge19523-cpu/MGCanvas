import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ClipboardCopy, ClipboardPaste, Copy, Plus, Redo2, Scissors, Trash2, Undo2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { insertIntoEditable, lastFocusedEditable, readEditableSelection, writeEditableValue } from "@/lib/last-focused-editable";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "@/types/canvas";

type CanvasContextMenuProps = {
    menu: ContextMenuState;
    canUndo: boolean;
    canRedo: boolean;
    canCopyAll: boolean;
    onClose: () => void;
    onUpload: () => void;
    onAddNode: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onCopyAll: () => void;
    onPaste: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
};

export function CanvasNodeContextMenu({ menu, canUndo, canRedo, canCopyAll, onClose, onUpload, onAddNode, onUndo, onRedo, onCopyAll, onPaste, onDuplicate, onDelete }: CanvasContextMenuProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const menuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ left: menu.x, top: menu.y });

    useLayoutEffect(() => {
        const rect = menuRef.current?.getBoundingClientRect();
        if (!rect) return;
        setPosition({
            left: Math.max(12, Math.min(menu.x, window.innerWidth - rect.width - 12)),
            top: Math.max(12, Math.min(menu.y, window.innerHeight - rect.height - 12)),
        });
    }, [menu]);

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("pointerdown", close);
        window.addEventListener("keydown", closeOnEscape);
        return () => {
            window.removeEventListener("pointerdown", close);
            window.removeEventListener("keydown", closeOnEscape);
        };
    }, [onClose]);

    // 在输入框 / 文本域上右键时给出文本编辑菜单（剪切、复制、粘贴、全选），
    // 而不是节点菜单，符合用户对右键的预期。
    // 右键位置下的输入框优先；取不到时回退到「最后一次获得焦点的输入框」，
    // 这样即使在面板空白处右键也能粘贴到刚才编辑的提示词框里。
    const [clickTarget] = useState<HTMLInputElement | HTMLTextAreaElement | null>(() => {
        const under = document.elementFromPoint(menu.x, menu.y);
        for (const candidate of [under, document.activeElement]) {
            if (candidate instanceof HTMLTextAreaElement || candidate instanceof HTMLInputElement) return candidate;
            const editable = candidate instanceof Element ? candidate.closest("textarea, input") : null;
            if (editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement) return editable;
        }
        return null;
    });
    const pasteTarget = clickTarget ?? lastFocusedEditable();

    const replaceSelection = (target: HTMLInputElement | HTMLTextAreaElement, text: string) => {
        if (!text) return;
        insertIntoEditable(target, text);
    };

    const copySelection = async (target: HTMLInputElement | HTMLTextAreaElement | null) => {
        if (!target) return;
        const selected = readEditableSelection(target);
        if (selected) await navigator.clipboard.writeText(selected).catch(() => undefined);
    };

    const pasteClipboard = async (target: HTMLInputElement | HTMLTextAreaElement | null) => {
        if (!target) return;
        const text = await navigator.clipboard.readText().catch(() => "");
        if (text) replaceSelection(target, text);
    };

    const cutSelection = async (target: HTMLInputElement | HTMLTextAreaElement | null) => {
        if (!target) return;
        await copySelection(target);
        writeEditableValue(target, target.value.slice(0, target.selectionStart ?? 0) + target.value.slice(target.selectionEnd ?? 0));
    };

    const run = (action: () => void) => {
        action();
        onClose();
    };

    return (
        <div
            ref={menuRef}
            className="fixed z-[80] w-[212px] overflow-hidden rounded-xl border p-1.5 shadow-2xl backdrop-blur-xl"
            data-canvas-context-menu={menu.type}
            style={{ ...position, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {clickTarget ? (
                <>
                    <MenuButton icon={<Scissors className="size-4" />} label="剪切" shortcut="Ctrl+X" onClick={() => run(() => void cutSelection(clickTarget))} />
                    <MenuButton icon={<Copy className="size-4" />} label="复制" shortcut="Ctrl+C" onClick={() => run(() => void copySelection(clickTarget))} />
                    <MenuButton icon={<ClipboardPaste className="size-4" />} label="粘贴" shortcut="Ctrl+V" onClick={() => run(() => void pasteClipboard(clickTarget))} />
                    <MenuDivider />
                    <MenuButton icon={<ClipboardCopy className="size-4" />} label="全选" shortcut="Ctrl+A" onClick={() => run(() => clickTarget.select())} />
                </>
            ) : menu.type === "canvas" ? (
                <>
                    <MenuButton icon={<Upload className="size-4" />} label={t("canvas.toolbar.upload")} onClick={() => run(onUpload)} />
                    <MenuButton icon={<Plus className="size-4" />} label={t("canvas.addNode", { defaultValue: "添加节点" })} onClick={() => run(onAddNode)} />
                    <MenuDivider />
                    <MenuButton icon={<Undo2 className="size-4" />} label={t("canvas.undo")} shortcut="Ctrl+Z" onClick={() => run(onUndo)} disabled={!canUndo} />
                    <MenuButton icon={<Redo2 className="size-4" />} label={t("canvas.redo")} shortcut="Ctrl+Shift+Z" onClick={() => run(onRedo)} disabled={!canRedo} />
                    <MenuDivider />
                    <MenuButton icon={<ClipboardCopy className="size-4" />} label={t("canvas.copyAll", { defaultValue: "复制所有节点" })} onClick={() => run(onCopyAll)} disabled={!canCopyAll} />
                    <MenuButton icon={<ClipboardPaste className="size-4" />} label={t("canvas.paste", { defaultValue: "粘贴" })} shortcut="Ctrl+V" onClick={() => run(onPaste)} />
                </>
            ) : (
                <>
                    {menu.type === "node" ? <MenuButton icon={<Plus className="size-4" />} label={t("canvas.controls.duplicate")} onClick={() => run(onDuplicate)} /> : null}
                    <MenuButton icon={<Trash2 className="size-4" />} label={t("canvas.controls.delete")} onClick={() => run(onDelete)} danger />
                    {pasteTarget ? (
                        <>
                            <MenuDivider />
                            <MenuButton icon={<ClipboardPaste className="size-4" />} label="粘贴到输入框" shortcut="Ctrl+V" onClick={() => run(() => void pasteClipboard(pasteTarget))} />
                        </>
                    ) : null}
                </>
            )}
        </div>
    );
}

function MenuDivider() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return <div className="mx-2 my-1 h-px" style={{ background: theme.toolbar.border, opacity: 0.7 }} />;
}

function MenuButton({ icon, label, shortcut, onClick, danger = false, disabled = false }: { icon: ReactNode; label: string; shortcut?: string; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button
            type="button"
            disabled={disabled}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-xs transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-30"
            style={{ color: danger ? "#f87171" : theme.node.text }}
            onClick={onClick}
        >
            <span className="opacity-70">{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {shortcut ? <span className="text-[10px] opacity-35">{shortcut}</span> : null}
        </button>
    );
}
