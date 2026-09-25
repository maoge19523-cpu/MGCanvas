import { describe, expect, it } from "vitest";

import {
    EDIT_HISTORY_LIMIT,
    EDIT_HISTORY_MERGE_MS,
    EMPTY_EDIT_HISTORY,
    editHistoryFlags,
    editHistoryLabels,
    editSnapshot,
    pushEditHistory,
    redoEditHistory,
    sameEditSnapshot,
    undoEditHistory,
    type EditHistoryEntry,
    type EditHistoryStack,
} from "./history";
import { EDIT_DEFAULT_OUTPUT, type EditAudioTrack as EditTrack, type EditClip, type EditProject } from "@/types/edit";

function project(patch: Partial<EditProject> = {}): EditProject {
    return {
        id: "edit-1",
        name: "测试剪辑",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        media: [{ id: "m1", name: "a.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 6000, createdAt: "2024-01-01T00:00:00.000Z" }],
        clips: [{ id: "c1", mediaId: "m1", start: 1, end: 5, volume: 1, fadeIn: 0, fadeOut: 0 }],
        audioTracks: [],
        output: { ...EDIT_DEFAULT_OUTPUT },
        ...patch,
    };
}

function entry(at: number, patch: Partial<EditHistoryEntry> = {}): EditHistoryEntry {
    return { label: "调整片段顺序", at, before: editSnapshot(project()), after: editSnapshot(project({ clips: [] })), ...patch };
}

describe("剪辑台撤销栈：快照只存会被改动的切片", () => {
    it("快照保存的是旧数组的引用，不做深拷贝；值没变就判定为同一次编辑", () => {
        const before = project();
        const after = { ...before, clips: [...before.clips] };
        expect(editSnapshot(before).clips).toBe(before.clips);
        // 逐字段相同（引用不同）也算没变，避免选回原值也压一条历史。
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot(after))).toBe(true);
    });

    it("片段任何字段变化都算真的改了", () => {
        const before = project();
        const moved = { ...before, clips: [{ ...before.clips[0]!, start: 2 } as EditClip] };
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot(moved))).toBe(false);
        const trimmed = { ...before, clips: [{ ...before.clips[0]!, end: 4 } as EditClip] };
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot(trimmed))).toBe(false);
        const added = { ...before, clips: [...before.clips, { ...before.clips[0]!, id: "c2" }] };
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot(added))).toBe(false);
        const removed = { ...before, clips: [] };
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot(removed))).toBe(false);
    });

    it("输出参数与音轨各自独立比较，素材按引用比较（导入 / 移除素材也是项目改动）", () => {
        const before = project();
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot({ ...before, output: { ...before.output, fps: 60 } }))).toBe(false);
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot({ ...before, audioTracks: [{ id: "t1", mediaId: "m1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false }] }))).toBe(false);
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot({ ...before, media: [...before.media] }))).toBe(false);
        // 素材数组引用没变时不算改动。
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot({ ...before }))).toBe(true);
    });

    /**
     * 轨道头的静音 / 独奏 / 锁定与片段锁定都是「点一下切状态」的编辑。
     * 这三个字段漏进比较函数的话，切换会被判成「值没变」，store 直接把这次更新丢掉 —— 开关点了不动。
     */
    it("静音 / 独奏 / 锁定都必须参与比较，否则开关点了不生效", () => {
        const base = project({ audioTracks: [{ id: "t1", mediaId: "m1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false }] });
        const trackWith = (patch: Partial<EditTrack>) => ({ ...base, audioTracks: [{ ...base.audioTracks[0]!, ...patch }] });

        expect(sameEditSnapshot(editSnapshot(base), editSnapshot(trackWith({ muted: true })))).toBe(false);
        expect(sameEditSnapshot(editSnapshot(base), editSnapshot(trackWith({ solo: true })))).toBe(false);
        expect(sameEditSnapshot(editSnapshot(base), editSnapshot(trackWith({ locked: true })))).toBe(false);
        // 切回缺省值同样算一次改动（取消静音也是编辑）。
        const muted = trackWith({ muted: true });
        expect(sameEditSnapshot(editSnapshot(muted), editSnapshot(trackWith({ muted: undefined })))).toBe(false);

        const clipWith = (patch: Partial<EditClip>) => ({ ...base, clips: [{ ...base.clips[0]!, ...patch }] });
        expect(sameEditSnapshot(editSnapshot(base), editSnapshot(clipWith({ locked: true })))).toBe(false);
    });
});

describe("剪辑台撤销栈：分组与内存上限", () => {
    it("一次拖拽只压一条：同一动作不带 mergeKey，连续两次仍然是两条", () => {
        const first = pushEditHistory(EMPTY_EDIT_HISTORY, entry(1000));
        const second = pushEditHistory(first, entry(1001, { after: editSnapshot(project({ clips: [] })) }));
        expect(second.past.length).toBe(2);
    });

    it("同一个 mergeKey 在时间窗内合成一条，保留最早的 before、换上最新的 after", () => {
        const base = editSnapshot(project());
        const moved = editSnapshot(project({ clips: [] }));
        const trimmed = editSnapshot(project({ clips: [{ ...project().clips[0]!, end: 3 }] }));
        const first = pushEditHistory(EMPTY_EDIT_HISTORY, { label: "调整片段属性", mergeKey: "clip:c1:volume", at: 1000, before: base, after: moved });
        const merged = pushEditHistory(first, { label: "调整片段属性", mergeKey: "clip:c1:volume", at: 1000 + EDIT_HISTORY_MERGE_MS, before: moved, after: trimmed });

        expect(merged.past.length).toBe(1);
        expect(merged.past[0]!.before).toBe(base);
        expect(merged.past[0]!.after).toBe(trimmed);
        expect(merged.past[0]!.at).toBe(1000 + EDIT_HISTORY_MERGE_MS);
    });

    it("超出时间窗或 mergeKey 不同就不合并", () => {
        const outOfWindow = pushEditHistory(pushEditHistory(EMPTY_EDIT_HISTORY, entry(1000, { mergeKey: "k" })), entry(1000 + EDIT_HISTORY_MERGE_MS + 1, { mergeKey: "k" }));
        expect(outOfWindow.past.length).toBe(2);
        const otherKey = pushEditHistory(pushEditHistory(EMPTY_EDIT_HISTORY, entry(1000, { mergeKey: "k" })), entry(1001, { mergeKey: "other" }));
        expect(otherKey.past.length).toBe(2);
    });

    it("新改动清空重做栈", () => {
        const withRedo: EditHistoryStack = { past: [entry(1000)], future: [entry(900)] };
        expect(pushEditHistory(withRedo, entry(1001)).future).toEqual([]);
    });

    it("栈长度有硬上限，超出后丢最旧的一条", () => {
        let stack = EMPTY_EDIT_HISTORY;
        for (let index = 0; index < EDIT_HISTORY_LIMIT + 20; index += 1) stack = pushEditHistory(stack, entry(1000 + index));
        expect(stack.past.length).toBe(EDIT_HISTORY_LIMIT);
        expect(stack.past[0]!.at).toBe(1000 + 20);
    });
});

describe("剪辑台撤销 / 重做", () => {
    it("撤销把最后一条移到重做栈，重做再移回来", () => {
        const stack = pushEditHistory(pushEditHistory(EMPTY_EDIT_HISTORY, entry(1000)), entry(1001));
        const undone = undoEditHistory(stack);
        expect(undone.entry?.at).toBe(1001);
        expect(undone.stack.past.length).toBe(1);
        expect(undone.stack.future.length).toBe(1);

        const redone = redoEditHistory(undone.stack);
        expect(redone.entry?.at).toBe(1001);
        expect(redone.stack.past.length).toBe(2);
        expect(redone.stack.future.length).toBe(0);
    });

    it("没有可撤销 / 可重做的记录时返回原栈与 null，不报错", () => {
        const undone = undoEditHistory(EMPTY_EDIT_HISTORY);
        expect(undone.entry).toBeNull();
        expect(undone.stack).toBe(EMPTY_EDIT_HISTORY);
        const redone = redoEditHistory(EMPTY_EDIT_HISTORY);
        expect(redone.entry).toBeNull();
        expect(redone.stack).toBe(EMPTY_EDIT_HISTORY);
    });

    it("按钮禁用态与提示文案都取栈顶信息", () => {
        expect(editHistoryFlags(EMPTY_EDIT_HISTORY)).toEqual({ canUndo: false, canRedo: false });
        const stack = pushEditHistory(EMPTY_EDIT_HISTORY, entry(1000, { label: "拆分片段" }));
        expect(editHistoryFlags(stack)).toEqual({ canUndo: true, canRedo: false });
        expect(editHistoryLabels(stack)).toEqual({ undo: "拆分片段", redo: null });

        const undone = undoEditHistory(stack).stack;
        expect(editHistoryFlags(undone)).toEqual({ canUndo: false, canRedo: true });
        expect(editHistoryLabels(undone)).toEqual({ undo: null, redo: "拆分片段" });
    });
});
