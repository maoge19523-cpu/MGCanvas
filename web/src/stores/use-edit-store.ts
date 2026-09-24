import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import { EMPTY_EDIT_HISTORY, editHistoryFlags, editHistoryLabels, editSnapshot, pushEditHistory, redoEditHistory, sameEditSnapshot, undoEditHistory, type EditHistoryEntry, type EditHistoryStack } from "@/lib/edit/history";
import { buildEditClips } from "@/lib/edit/timeline";
import { deleteEditClip, splitEditClip } from "@/lib/edit/timeline-edit";
import { EDIT_DEFAULT_OUTPUT, type EditAudioTrack, type EditClip, type EditMedia, type EditOutput, type EditProject } from "@/types/edit";

type EditStore = {
    hydrated: boolean;
    projects: EditProject[];
    /** 撤销栈按项目分开存，**不落盘**：它只是本次会话的编辑历史。 */
    history: Record<string, EditHistoryStack>;
    createProject: (name?: string) => string;
    /** 画布「发送到剪辑台」用：有项目就发给最近更新的那个，没有就新建一个。 */
    ensureProject: (name: string) => string;
    renameProject: (id: string, name: string) => void;
    deleteProject: (id: string) => void;
    addMedia: (projectId: string, media: Omit<EditMedia, "id" | "createdAt">) => string;
    updateMedia: (projectId: string, mediaId: string, patch: Partial<EditMedia>) => void;
    /** 移除素材时同时清掉引用它的片段与音轨。 */
    removeMedia: (projectId: string, mediaId: string) => void;
    addClip: (projectId: string, clip: Omit<EditClip, "id">) => string;
    addClips: (projectId: string, clips: Omit<EditClip, "id">[]) => void;
    /** 时间线换序 / 裁剪 / 属性区编辑都走这里，一次性提交整份片段列表。 */
    updateClips: (projectId: string, clips: EditClip[]) => void;
    updateClip: (projectId: string, clipId: string, patch: Partial<EditClip>) => void;
    removeClip: (projectId: string, clipId: string) => void;
    /** 在播放头处拆分，返回新产生的右半段 id（无法拆分时返回 null）。 */
    splitClip: (projectId: string, clipId: string, seconds: number) => string | null;
    /** 涟漪删除：删掉片段并把指向它的接缝转场一并清干净。 */
    rippleRemoveClip: (projectId: string, clipId: string) => void;
    addAudioTrack: (projectId: string, mediaId: string) => void;
    updateAudioTrack: (projectId: string, trackId: string, patch: Partial<EditAudioTrack>) => void;
    removeAudioTrack: (projectId: string, trackId: string) => void;
    updateOutput: (projectId: string, patch: Partial<EditOutput>) => void;
    undoEdit: (projectId: string) => void;
    redoEdit: (projectId: string) => void;
    historyFlags: (projectId: string) => { canUndo: boolean; canRedo: boolean };
    historyLabels: (projectId: string) => { undo: string | null; redo: string | null };
};

/** 剪辑台与画布各自独立存储：这里是剪辑台自己的项目键。 */
export const EDIT_PROJECTS_KEY = "mgcanvas:edit_projects:v1";

/**
 * 读剪辑台状态。与 zustand 默认的 useStore 差别只有一点：**服务端快照也读当前状态**。
 * 本项目是纯客户端应用（renderToStaticMarkup 只用于测试读回真实产物），没有真正的服务端渲染，
 * 而 zustand 的服务端快照固定是「创建时的初始状态」——用它验证产物会永远只看到空项目。
 */
export function useEditState() {
    return useSyncExternalStore(useEditStore.subscribe, useEditStore.getState, useEditStore.getState);
}

export function createEditClip(mediaId: string): Omit<EditClip, "id"> {
    // 不设转场就是硬切：新建片段绝不能带空串转场，否则会被 FFmpeg 拼成空滤镜名而拒绝出片。
    return { mediaId, start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transition: undefined, transitionDuration: 0.5 };
}

function newProject(name: string): EditProject {
    const now = new Date().toISOString();
    return { id: nanoid(), name, createdAt: now, updatedAt: now, media: [], clips: [], audioTracks: [], output: { ...EDIT_DEFAULT_OUTPUT } };
}

const editStorage: PersistStorage<EditStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        return JSON.parse(value) as StorageValue<EditStore>;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useEditStore = create<EditStore>()(
    persist(
        (set, get) => {
            /**
             * 所有会写项目数据的动作都经过这里：
             * 值真的变了才写状态、才压一条历史。一次调用 = 一条撤销记录（同 mergeKey 的连续输入会合并）。
             */
            const patchProject = (projectId: string, label: string, updater: (project: EditProject) => EditProject, mergeKey?: string) =>
                set((state) => {
                    const current = state.projects.find((project) => project.id === projectId);
                    if (!current) return state;
                    const updated = { ...updater(current), updatedAt: new Date().toISOString() };
                    const before = editSnapshot(current);
                    const after = editSnapshot(updated);
                    if (sameEditSnapshot(before, after)) return state;
                    return {
                        projects: state.projects.map((project) => (project.id === projectId ? updated : project)),
                        history: {
                            ...state.history,
                            [projectId]: pushEditHistory(state.history[projectId] ?? EMPTY_EDIT_HISTORY, { label, mergeKey, at: Date.now(), before, after }),
                        },
                    };
                });

            /** 项目名这类不进撤销栈的改动。 */
            const touchProject = (projectId: string, updater: (project: EditProject) => EditProject) =>
                set((state) => ({ projects: state.projects.map((project) => (project.id === projectId ? { ...updater(project), updatedAt: new Date().toISOString() } : project)) }));

            const applyHistory = (
                projectId: string,
                pick: (stack: EditHistoryStack) => { stack: EditHistoryStack; entry: EditHistoryEntry | null },
                side: "before" | "after",
            ) =>
                set((state) => {
                    const result = pick(state.history[projectId] ?? EMPTY_EDIT_HISTORY);
                    if (!result.entry) return state;
                    const restored = result.entry[side];
                    return {
                        projects: state.projects.map((project) => (project.id === projectId ? { ...project, ...restored, updatedAt: new Date().toISOString() } : project)),
                        history: { ...state.history, [projectId]: result.stack },
                    };
                });

            return {
                hydrated: false,
                projects: [],
                history: {},
                createProject: (name = i18n.t("editor.untitled")) => {
                    const project = newProject(name);
                    set((state) => ({ projects: [project, ...state.projects] }));
                    return project.id;
                },
                ensureProject: (name) => {
                    const latest = [...get().projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
                    if (latest) return latest.id;
                    const project = newProject(name);
                    set((state) => ({ projects: [project, ...state.projects] }));
                    return project.id;
                },
                renameProject: (id, name) => touchProject(id, (project) => ({ ...project, name: name.trim() || project.name })),
                deleteProject: (id) =>
                    set((state) => {
                        const { [id]: _removed, ...history } = state.history;
                        return { projects: state.projects.filter((project) => project.id !== id), history };
                    }),
                addMedia: (projectId, media) => {
                    const id = nanoid();
                    patchProject(projectId, i18n.t("editor.history.addMedia"), (project) => ({ ...project, media: [...project.media, { ...media, id, createdAt: new Date().toISOString() }] }));
                    return id;
                },
                updateMedia: (projectId, mediaId, patch) =>
                    patchProject(
                        projectId,
                        i18n.t("editor.history.media"),
                        (project) => ({ ...project, media: project.media.map((item) => (item.id === mediaId ? { ...item, ...patch } : item)) }),
                        `media:${mediaId}:${Object.keys(patch).join(",")}`,
                    ),
                removeMedia: (projectId, mediaId) =>
                    patchProject(projectId, i18n.t("editor.history.removeMedia"), (project) => ({
                        ...project,
                        media: project.media.filter((item) => item.id !== mediaId),
                        clips: project.clips.filter((clip) => clip.mediaId !== mediaId),
                        audioTracks: project.audioTracks.filter((track) => track.mediaId !== mediaId),
                    })),
                addClip: (projectId, clip) => {
                    const id = nanoid();
                    patchProject(projectId, i18n.t("editor.history.addClip"), (project) => ({ ...project, clips: [...project.clips, { ...clip, id }] }));
                    return id;
                },
                addClips: (projectId, clips) =>
                    patchProject(projectId, i18n.t("editor.history.addClips"), (project) => ({ ...project, clips: [...project.clips, ...clips.map((clip) => ({ ...clip, id: nanoid() }))] })),
                updateClips: (projectId, clips) => patchProject(projectId, i18n.t("editor.history.reorder"), (project) => ({ ...project, clips })),
                updateClip: (projectId, clipId, patch) =>
                    patchProject(
                        projectId,
                        i18n.t("editor.history.clip"),
                        (project) => ({ ...project, clips: project.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)) }),
                        `clip:${clipId}:${Object.keys(patch).join(",")}`,
                    ),
                removeClip: (projectId, clipId) =>
                    patchProject(projectId, i18n.t("editor.history.delete"), (project) => ({ ...project, clips: deleteEditClip(project.clips, clipId, "cut") })),
                splitClip: (projectId, clipId, seconds) => {
                    const project = get().projects.find((item) => item.id === projectId);
                    if (!project) return null;
                    const newId = nanoid();
                    const next = splitEditClip(project.clips, buildEditClips(project.media, project.clips), clipId, seconds, newId);
                    if (!next) return null;
                    patchProject(projectId, i18n.t("editor.history.split"), (current) => ({ ...current, clips: next }));
                    return newId;
                },
                rippleRemoveClip: (projectId, clipId) =>
                    patchProject(projectId, i18n.t("editor.history.rippleDelete"), (project) => ({ ...project, clips: deleteEditClip(project.clips, clipId, "ripple") })),
                addAudioTrack: (projectId, mediaId) =>
                    patchProject(projectId, i18n.t("editor.history.audioTrack"), (project) => ({
                        ...project,
                        audioTracks: [...project.audioTracks, { id: nanoid(), mediaId, volume: 1, fadeIn: 0, fadeOut: 0, loop: false }],
                    })),
                updateAudioTrack: (projectId, trackId, patch) =>
                    patchProject(
                        projectId,
                        i18n.t("editor.history.audioTrack"),
                        (project) => ({ ...project, audioTracks: project.audioTracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track)) }),
                        `track:${trackId}:${Object.keys(patch).join(",")}`,
                    ),
                removeAudioTrack: (projectId, trackId) =>
                    patchProject(projectId, i18n.t("editor.history.audioTrack"), (project) => ({ ...project, audioTracks: project.audioTracks.filter((track) => track.id !== trackId) })),
                updateOutput: (projectId, patch) =>
                    patchProject(projectId, i18n.t("editor.history.output"), (project) => ({ ...project, output: { ...project.output, ...patch } }), `output:${Object.keys(patch).join(",")}`),
                undoEdit: (projectId) => applyHistory(projectId, undoEditHistory, "before"),
                redoEdit: (projectId) => applyHistory(projectId, redoEditHistory, "after"),
                historyFlags: (projectId) => editHistoryFlags(get().history[projectId] ?? EMPTY_EDIT_HISTORY),
                historyLabels: (projectId) => editHistoryLabels(get().history[projectId] ?? EMPTY_EDIT_HISTORY),
            };
        },
        {
            name: EDIT_PROJECTS_KEY,
            storage: editStorage,
            // 撤销栈只在内存里，不写进 localforage。
            partialize: (state) => ({ projects: state.projects }) as StorageValue<EditStore>["state"],
            onRehydrateStorage: () => () => {
                useEditStore.setState({ hydrated: true });
            },
        },
    ),
);
