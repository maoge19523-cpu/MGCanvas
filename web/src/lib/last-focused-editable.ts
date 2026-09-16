/**
 * 记录最后一次获得焦点的输入框。
 *
 * 右键时输入框不一定处于焦点状态，仅靠 document.activeElement 或光标位置
 * 都可能判断失败（WebView 行为有差异）。这里在文档层面记录焦点历史，
 * 供右键菜单提供粘贴等文本操作。
 */

let lastEditable: HTMLInputElement | HTMLTextAreaElement | null = null;

function isEditable(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** 在应用启动时安装一次；返回卸载函数。 */
export function trackFocusedEditable() {
    if (typeof document === "undefined") return () => undefined;
    const onFocusIn = (event: FocusEvent) => {
        if (isEditable(event.target)) lastEditable = event.target;
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => document.removeEventListener("focusin", onFocusIn, true);
}

/** 取最后一次聚焦且仍在页面中的输入框。 */
export function lastFocusedEditable(): HTMLInputElement | HTMLTextAreaElement | null {
    if (!lastEditable) return null;
    if (typeof document !== "undefined" && !document.contains(lastEditable)) {
        lastEditable = null;
        return null;
    }
    return lastEditable;
}

/** 写入受控输入框：必须用原生 setter 再派发 input 事件，React 才能感知变化。 */
export function writeEditableValue(target: HTMLInputElement | HTMLTextAreaElement, nextValue: string) {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(target, nextValue);
    else target.value = nextValue;
    target.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 在光标处插入文本（替换选中内容），并把光标移到插入内容之后。 */
export function insertIntoEditable(target: HTMLInputElement | HTMLTextAreaElement, text: string) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    writeEditableValue(target, target.value.slice(0, start) + text + target.value.slice(end));
    const caret = start + text.length;
    target.setSelectionRange(caret, caret);
}

/** 读取输入框当前选中文本。 */
export function readEditableSelection(target: HTMLInputElement | HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    return target.value.slice(start, end);
}
