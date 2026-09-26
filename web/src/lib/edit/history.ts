import type { EditAudioTrack, EditClip, EditMedia, EditOutput, EditProject, EditSubtitle } from "@/types/edit";

/**
 * 一次可撤销改动只保存会被改动的五个切片。
 * store 的更新本来就是不可变更新（`{ ...project, clips: [...] }`），
 * 所以这里存的是**旧数组的引用**，不是深拷贝——一次拖拽不会 clone 整份 project，
 * 内存占用只跟撤销栈长度有关。
 */
export type EditSnapshot = { media: EditMedia[]; clips: EditClip[]; audioTracks: EditAudioTrack[]; subtitles: EditSubtitle[] | undefined; output: EditOutput };

export type EditHistoryEntry = {
    label: string;
    /** 同一个 mergeKey 的连续改动会合成一条（例如属性输入框连续敲键）。 */
    mergeKey?: string;
    at: number;
    before: EditSnapshot;
    after: EditSnapshot;
};

export type EditHistoryStack = { past: EditHistoryEntry[]; future: EditHistoryEntry[] };

export const EMPTY_EDIT_HISTORY: EditHistoryStack = { past: [], future: [] };

/** 每个项目最多留这么多条，超出的从最旧一端丢掉，内存有硬上限。 */
export const EDIT_HISTORY_LIMIT = 100;

/** 同一个 mergeKey 在这个时间窗内视为同一次编辑。 */
export const EDIT_HISTORY_MERGE_MS = 600;

export function editSnapshot(project: Pick<EditProject, "media" | "clips" | "audioTracks" | "subtitles" | "output">): EditSnapshot {
    return { media: project.media, clips: project.clips, audioTracks: project.audioTracks, subtitles: project.subtitles, output: project.output };
}

function sameClip(left: EditClip, right: EditClip) {
    return (
        left === right ||
        (left.id === right.id &&
            left.mediaId === right.mediaId &&
            left.start === right.start &&
            left.end === right.end &&
            left.volume === right.volume &&
            left.fadeIn === right.fadeIn &&
            left.fadeOut === right.fadeOut &&
            left.transition === right.transition &&
            left.transitionDuration === right.transitionDuration &&
            left.subtitle === right.subtitle &&
            // 锁定必须参与比较：漏了它，切换锁定会被判成「值没变」而整条状态更新被丢掉（轨道头的开关就点不动了）。
            left.locked === right.locked &&
            // 同理：关闭原声也是「点一下切状态」，不参与比较就会点了不生效。
            left.muted === right.muted)
    );
}

function sameTrack(left: EditAudioTrack, right: EditAudioTrack) {
    return (
        left === right ||
        (left.id === right.id &&
            left.mediaId === right.mediaId &&
            left.volume === right.volume &&
            left.fadeIn === right.fadeIn &&
            left.fadeOut === right.fadeOut &&
            left.loop === right.loop &&
            // 同上：静音 / 独奏 / 锁定都要参与比较，否则轨道头上的三个开关点了不生效。
            left.muted === right.muted &&
            left.solo === right.solo &&
            left.locked === right.locked &&
            // 同理：时间线起点是「拖一下改变一个值」的编辑，漏了它整次拖动都会被判成「值没变」而丢掉，
            // 现象就是「拖了不动、撤销栈里也没有这一次」。
            left.start === right.start &&
            // 同理，**裁剪的两端**也是「拖一下改变一个值」：漏了它们，拖两端同样会「拖了不动、
            // 撤销栈里也没有这一次」（这个仓库已经两次栽在「新增字段没进比较函数」上，所以这次一并加上）。
            left.sourceStart === right.sourceStart &&
            left.sourceEnd === right.sourceEnd)
    );
}

function sameSubtitle(left: EditSubtitle, right: EditSubtitle) {
    // 缺省与空数组是同一个意思（没有导入过字幕），不能让「undefined → []」被判成一次真改动。
    return left === right || (left.id === right.id && left.start === right.start && left.end === right.end && left.text === right.text);
}

function sameList<T>(left: T[], right: T[], equals: (a: T, b: T) => boolean) {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    return left.every((item, index) => equals(item, right[index]!));
}

/** 值没变就不该产生历史记录，也不该刷新 updatedAt（例如属性区选回原值）。 */
export function sameEditSnapshot(left: EditSnapshot, right: EditSnapshot) {
    if (left === right) return true;
    return (
        left.media === right.media &&
        sameList(left.clips, right.clips, sameClip) &&
        sameList(left.audioTracks, right.audioTracks, sameTrack) &&
        sameList(left.subtitles ?? [], right.subtitles ?? [], sameSubtitle) &&
        left.output === right.output
    );
}

/**
 * 压入一条历史。新改动一律清空重做栈；
 * 与栈顶同 mergeKey 且落在时间窗内时合并成一条（保留旧的 before、换上新的 after），
 * 这样「一次拖拽 = 一条」，而连续敲属性输入框也只有一条。
 */
export function pushEditHistory(stack: EditHistoryStack, entry: EditHistoryEntry, limit = EDIT_HISTORY_LIMIT): EditHistoryStack {
    const top = stack.past[stack.past.length - 1];
    if (top && entry.mergeKey && top.mergeKey === entry.mergeKey && entry.at - top.at <= EDIT_HISTORY_MERGE_MS) {
        return { past: [...stack.past.slice(0, -1), { ...top, after: entry.after, at: entry.at }], future: [] };
    }
    const past = [...stack.past, entry];
    return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

export function undoEditHistory(stack: EditHistoryStack) {
    const entry = stack.past[stack.past.length - 1];
    if (!entry) return { stack, entry: null };
    return { stack: { past: stack.past.slice(0, -1), future: [...stack.future, entry] }, entry };
}

export function redoEditHistory(stack: EditHistoryStack) {
    const entry = stack.future[stack.future.length - 1];
    if (!entry) return { stack, entry: null };
    return { stack: { past: [...stack.past, entry], future: stack.future.slice(0, -1) }, entry };
}

export function editHistoryFlags(stack: EditHistoryStack) {
    return { canUndo: stack.past.length > 0, canRedo: stack.future.length > 0 };
}

/** 下一次撤销 / 重做会作用在哪条记录上，只用于按钮提示文案。 */
export function editHistoryLabels(stack: EditHistoryStack) {
    return { undo: stack.past[stack.past.length - 1]?.label ?? null, redo: stack.future[stack.future.length - 1]?.label ?? null };
}
