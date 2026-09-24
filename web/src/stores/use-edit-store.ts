import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import { EDIT_DEFAULT_OUTPUT, type EditAudioTrack, type EditClip, type EditMedia, type EditOutput, type EditProject } from "@/types/edit";

type EditStore = {
    hydrated: boolean;
    projects: EditProject[];
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
    addAudioTrack: (projectId: string, mediaId: string) => void;
    updateAudioTrack: (projectId: string, trackId: string, patch: Partial<EditAudioTrack>) => void;
    removeAudioTrack: (projectId: string, trackId: string) => void;
    updateOutput: (projectId: string, patch: Partial<EditOutput>) => void;
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
    return { mediaId, start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 };
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
            const patchProject = (projectId: string, updater: (project: EditProject) => EditProject) =>
                set((state) => ({ projects: state.projects.map((project) => (project.id === projectId ? { ...updater(project), updatedAt: new Date().toISOString() } : project)) }));

            return {
                hydrated: false,
                projects: [],
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
                renameProject: (id, name) => patchProject(id, (project) => ({ ...project, name: name.trim() || project.name })),
                deleteProject: (id) => set((state) => ({ projects: state.projects.filter((project) => project.id !== id) })),
                addMedia: (projectId, media) => {
                    const id = nanoid();
                    patchProject(projectId, (project) => ({ ...project, media: [...project.media, { ...media, id, createdAt: new Date().toISOString() }] }));
                    return id;
                },
                updateMedia: (projectId, mediaId, patch) =>
                    patchProject(projectId, (project) => ({ ...project, media: project.media.map((item) => (item.id === mediaId ? { ...item, ...patch } : item)) })),
                removeMedia: (projectId, mediaId) =>
                    patchProject(projectId, (project) => ({
                        ...project,
                        media: project.media.filter((item) => item.id !== mediaId),
                        clips: project.clips.filter((clip) => clip.mediaId !== mediaId),
                        audioTracks: project.audioTracks.filter((track) => track.mediaId !== mediaId),
                    })),
                addClip: (projectId, clip) => {
                    const id = nanoid();
                    patchProject(projectId, (project) => ({ ...project, clips: [...project.clips, { ...clip, id }] }));
                    return id;
                },
                addClips: (projectId, clips) => patchProject(projectId, (project) => ({ ...project, clips: [...project.clips, ...clips.map((clip) => ({ ...clip, id: nanoid() }))] })),
                updateClips: (projectId, clips) => patchProject(projectId, (project) => ({ ...project, clips })),
                updateClip: (projectId, clipId, patch) => patchProject(projectId, (project) => ({ ...project, clips: project.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)) })),
                removeClip: (projectId, clipId) => patchProject(projectId, (project) => ({ ...project, clips: project.clips.filter((clip) => clip.id !== clipId) })),
                addAudioTrack: (projectId, mediaId) =>
                    patchProject(projectId, (project) => ({
                        ...project,
                        audioTracks: [...project.audioTracks, { id: nanoid(), mediaId, volume: 1, fadeIn: 0, fadeOut: 0, loop: false }],
                    })),
                updateAudioTrack: (projectId, trackId, patch) =>
                    patchProject(projectId, (project) => ({ ...project, audioTracks: project.audioTracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track)) })),
                removeAudioTrack: (projectId, trackId) => patchProject(projectId, (project) => ({ ...project, audioTracks: project.audioTracks.filter((track) => track.id !== trackId) })),
                updateOutput: (projectId, patch) => patchProject(projectId, (project) => ({ ...project, output: { ...project.output, ...patch } })),
            };
        },
        {
            name: EDIT_PROJECTS_KEY,
            storage: editStorage,
            partialize: (state) => ({ projects: state.projects }) as StorageValue<EditStore>["state"],
            onRehydrateStorage: () => () => {
                useEditStore.setState({ hydrated: true });
            },
        },
    ),
);
