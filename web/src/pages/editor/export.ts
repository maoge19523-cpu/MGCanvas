import { open } from "@tauri-apps/plugin-dialog";

import { buildComposeRequest } from "@/lib/edit/timeline";
import { invokeDesktop, isTauriRuntime } from "@/services/platform/desktop-runtime";
import { composeVideo, readFfmpegPath, resolveEditMediaLocalPath } from "@/services/platform/desktop-ffmpeg";
import type { EditProject } from "@/types/edit";

export type EditExportResult = { absolutePath: string; filename: string; directory: string; bytes: number; durationMs: number };

/** 选输出目录（Tauri 目录对话框，与画布批量导出用同一套能力）；用户取消返回 null。 */
export async function pickOutputDirectory(title: string) {
    if (!isTauriRuntime()) return null;
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === "string" && selected ? selected : null;
}

/**
 * 剪辑台导出：把剪辑台自己的项目数据映射成 compose_video 的入参，合成后复制到用户选的目录。
 * 整条链路只读剪辑台数据，不碰画布节点、连线，也不往画布追加成片节点。
 */
export async function exportEditProject(project: EditProject, directory: string): Promise<EditExportResult> {
    const needed = new Set([...project.clips.map((clip) => clip.mediaId), ...project.audioTracks.map((track) => track.mediaId)]);
    const paths: Record<string, string> = {};
    for (const item of project.media.filter((media) => needed.has(media.id))) {
        paths[item.id] = await resolveEditMediaLocalPath(item);
    }
    const request = buildComposeRequest({ project, paths });
    if (!request.segments.length) throw new Error("项目里还没有可合成的视频片段");
    const result = await composeVideo({ ffmpegPath: readFfmpegPath() || undefined, ...request });
    await invokeDesktop("allow_download_directory", { directory });
    const exported = await invokeDesktop<{ exported: number; failed: string[]; directory: string }>("export_canvas_media", { paths: [result.absolutePath], directory });
    if (exported.exported < 1) throw new Error("成片复制到目标目录失败");
    return { absolutePath: result.absolutePath, filename: result.filename, directory: exported.directory, bytes: result.bytes, durationMs: result.durationMs };
}

/** 打开成片所在文件夹（复用现有的打开下载目录能力）。 */
export function openOutputDirectory(directory: string | null) {
    return invokeDesktop("open_downloads_directory", { directory: directory || null });
}
