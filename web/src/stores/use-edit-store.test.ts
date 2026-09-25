import { beforeEach, describe, expect, it, vi } from "vitest";

// i18n 初始化会读 localStorage：node 环境没有它，必须在任何模块导入前补一个最小替身。
vi.hoisted(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, String(value)),
            removeItem: (key: string) => void store.delete(key),
            clear: () => store.clear(),
        },
    });
});

import { EMPTY_EDIT_HISTORY } from "@/lib/edit/history";
import { EDIT_DEFAULT_OUTPUT, type EditProject } from "@/types/edit";
import { useEditStore, createEditClip } from "./use-edit-store";

const PROJECT_ID = "edit-1";

function seed(clips = true) {
    const project: EditProject = {
        id: PROJECT_ID,
        name: "测试剪辑",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        media: [
            { id: "m1", name: "a.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 6000, createdAt: "2024-01-01T00:00:00.000Z" },
            { id: "m2", name: "b.mp4", kind: "video", source: "local", url: "blob:m2", durationMs: 5000, createdAt: "2024-01-01T00:00:00.000Z" },
        ],
        clips: clips
            ? [
                  { id: "c1", mediaId: "m1", start: 1, end: 5, volume: 1, fadeIn: 0, fadeOut: 0, transition: "fade", transitionDuration: 0.8 },
                  { id: "c2", mediaId: "m2", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
              ]
            : [],
        audioTracks: [],
        output: { ...EDIT_DEFAULT_OUTPUT },
        ...{},
    };
    useEditStore.setState({ hydrated: true, projects: [project], history: { [PROJECT_ID]: EMPTY_EDIT_HISTORY } });
    return project;
}

const project = () => useEditStore.getState().projects[0]!;
const history = () => useEditStore.getState().history[PROJECT_ID] ?? EMPTY_EDIT_HISTORY;

describe("剪辑台 store：撤销 / 重做接线", () => {
    beforeEach(() => seed());

    it("一次拖拽提交（updateClips）只压一条记录，撤销后顺序还原", () => {
        const before = project().clips.map((clip) => clip.id);
        useEditStore.getState().updateClips(PROJECT_ID, [...project().clips].reverse());

        expect(project().clips.map((clip) => clip.id)).toEqual(["c2", "c1"]);
        expect(history().past.length).toBe(1);
        expect(useEditStore.getState().historyFlags(PROJECT_ID)).toEqual({ canUndo: true, canRedo: false });

        useEditStore.getState().undoEdit(PROJECT_ID);
        expect(project().clips.map((clip) => clip.id)).toEqual(before);
        expect(useEditStore.getState().historyFlags(PROJECT_ID)).toEqual({ canUndo: false, canRedo: true });

        useEditStore.getState().redoEdit(PROJECT_ID);
        expect(project().clips.map((clip) => clip.id)).toEqual(["c2", "c1"]);
        expect(useEditStore.getState().historyFlags(PROJECT_ID)).toEqual({ canUndo: true, canRedo: false });
    });

    it("属性区连续敲同一个字段在时间窗内合成一条；换了字段就另算一条", () => {
        useEditStore.getState().updateClip(PROJECT_ID, "c1", { volume: 0.8 });
        useEditStore.getState().updateClip(PROJECT_ID, "c1", { volume: 0.6 });
        expect(history().past.length).toBe(1);
        expect(project().clips[0]!.volume).toBe(0.6);

        useEditStore.getState().updateClip(PROJECT_ID, "c1", { fadeIn: 1 });
        expect(history().past.length).toBe(2);
        expect(useEditStore.getState().historyLabels(PROJECT_ID).undo).toBe("调整片段属性");
    });

    it("写回同一个值不产生历史记录", () => {
        useEditStore.getState().updateClip(PROJECT_ID, "c1", { volume: 1 });
        expect(history().past.length).toBe(0);
        expect(useEditStore.getState().historyFlags(PROJECT_ID).canUndo).toBe(false);
    });

    /** 视频轨整轨关闭原声：一次提交改全部片段，只压一条历史，撤销能一次性还原。 */
    it("视频轨关闭原声作用于本轨全部片段，只压一条记录且可撤销", () => {
        useEditStore.getState().setVideoTrackMuted(PROJECT_ID, true);
        expect(project().clips.map((clip) => clip.muted)).toEqual([true, true]);
        expect(history().past.length).toBe(1);
        expect(useEditStore.getState().historyLabels(PROJECT_ID).undo).toBe("关闭原声");

        useEditStore.getState().undoEdit(PROJECT_ID);
        expect(project().clips.map((clip) => clip.muted)).toEqual([undefined, undefined]);

        // 再关一次后恢复：字段被去掉（回缺省），不是留下一堆 muted: false。
        useEditStore.getState().setVideoTrackMuted(PROJECT_ID, true);
        useEditStore.getState().setVideoTrackMuted(PROJECT_ID, false);
        expect(project().clips.map((clip) => clip.muted)).toEqual([undefined, undefined]);
        // 重复关闭同一次状态不再压新记录：关 → 开 两次真实改动各留一条，再关一次也是「值没变」。
        useEditStore.getState().setVideoTrackMuted(PROJECT_ID, false);
        expect(history().past.length).toBe(2);
    });

    it("没有可撤销的记录时 undo 是空操作", () => {
        useEditStore.getState().undoEdit(PROJECT_ID);
        expect(project().clips.map((clip) => clip.id)).toEqual(["c1", "c2"]);
    });
});

describe("剪辑台 store：拆分 / 删除 / 涟漪删除", () => {
    beforeEach(() => seed());

    it("拆分按真实入出点切开并单独压一条记录，撤销能还原成一段", () => {
        // c1 全局 0–4s（素材 1–5s），播放头在 2s → 切点 3s。
        const newId = useEditStore.getState().splitClip(PROJECT_ID, "c1", 2);

        expect(newId).toBeTruthy();
        expect(project().clips.map((clip) => [clip.id, clip.start, clip.end])).toEqual([
            ["c1", 1, 3],
            [newId, 3, 5],
            ["c2", 0, 0],
        ]);
        expect(history().past.length).toBe(1);

        useEditStore.getState().undoEdit(PROJECT_ID);
        expect(project().clips.map((clip) => clip.id)).toEqual(["c1", "c2"]);
        expect(project().clips[0]).toMatchObject({ start: 1, end: 5 });

        useEditStore.getState().redoEdit(PROJECT_ID);
        expect(project().clips.length).toBe(3);
    });

    it("播放头落在段外时拆分什么也不做", () => {
        expect(useEditStore.getState().splitClip(PROJECT_ID, "c1", 0)).toBeNull();
        expect(useEditStore.getState().splitClip(PROJECT_ID, "c1", 99)).toBeNull();
        expect(history().past.length).toBe(0);
    });

    it("普通删除保留接缝转场，涟漪删除把它清干净，两者都能撤销", () => {
        useEditStore.getState().removeClip(PROJECT_ID, "c2");
        expect(project().clips.map((clip) => clip.id)).toEqual(["c1"]);
        expect(project().clips[0]!.transition).toBe("fade");

        useEditStore.getState().undoEdit(PROJECT_ID);
        expect(project().clips.length).toBe(2);

        useEditStore.getState().rippleRemoveClip(PROJECT_ID, "c2");
        expect(project().clips.map((clip) => clip.id)).toEqual(["c1"]);
        expect(project().clips[0]!.transition).toBeUndefined();
        // 撤销之后又做了新改动：重做栈被清空，栈里只剩这一条。
        expect(history().past.length).toBe(1);
        expect(history().future.length).toBe(0);

        useEditStore.getState().undoEdit(PROJECT_ID);
        expect(project().clips[0]!.transition).toBe("fade");
    });

    it("加入 / 移出时间线各自一条记录，撤销栈各自独立", () => {
        useEditStore.getState().addClip(PROJECT_ID, { mediaId: "m2", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0 });
        expect(project().clips.length).toBe(3);
        expect(history().past.length).toBe(1);
        expect(useEditStore.getState().historyLabels(PROJECT_ID).undo).toBe("加入时间线");

        useEditStore.getState().removeMedia(PROJECT_ID, "m2");
        expect(project().media.length).toBe(1);
        // 移除素材会连带清掉引用它的片段，一次写入一条记录。
        expect(project().clips.map((clip) => clip.mediaId)).toEqual(["m1"]);
        expect(history().past.length).toBe(2);

        useEditStore.getState().undoEdit(PROJECT_ID);
        expect(project().media.length).toBe(2);
        expect(project().clips.length).toBe(3);
    });

    it("删除项目时把它的撤销栈一起清掉，不留下无主记录", () => {
        useEditStore.getState().updateClip(PROJECT_ID, "c1", { volume: 0.5 });
        expect(history().past.length).toBe(1);
        useEditStore.getState().deleteProject(PROJECT_ID);
        expect(useEditStore.getState().history[PROJECT_ID]).toBeUndefined();
        expect(useEditStore.getState().projects.length).toBe(0);
    });
});

describe("剪辑台 store：新建片段的数据入口", () => {
    beforeEach(() => seed());

    it("新建片段默认硬切，落盘数据里不会出现空串转场", () => {
        const fresh = createEditClip("m1");

        expect(fresh.transition).toBeUndefined();
        expect(fresh.transitionDuration).toBe(0.5);
        useEditStore.getState().addClip(PROJECT_ID, fresh);
        expect(JSON.stringify(project().clips.at(-1))).not.toContain('"transition"');
    });
});
