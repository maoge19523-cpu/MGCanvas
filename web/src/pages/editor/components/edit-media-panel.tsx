import { App, Button, Empty, Modal, Tooltip } from "antd";
import { Captions, Film, FolderOpen, Images, Music2, Plus, TimerOff, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { decodeSubtitleBytes, parseSubtitleFile, summarizeSubtitleImport, type SubtitleIssue, type SubtitleIssueReason } from "@/lib/edit/subtitles";
import { buildEditClips, formatEditTime } from "@/lib/edit/timeline";
import { importAssetToEditMedia, importLocalMediaFiles, probeEditMediaDuration, resolveEditMediaUrl } from "@/services/edit-media";
import { useAssetStore } from "@/stores/use-asset-store";
import { createEditClip, useEditState } from "@/stores/use-edit-store";
import type { EditClip, EditMedia } from "@/types/edit";

// 项目不存在时用固定引用兜底，避免每次渲染都产生新数组导致 zustand 误判状态变化。
const EMPTY_MEDIA: EditMedia[] = [];
const EMPTY_CLIPS: EditClip[] = [];

/** 素材区（左）：当前项目的素材列表，以及本地文件 / 我的资产 / 画布发送三条来源的入口。 */
export function EditMediaPanel({ projectId }: { projectId: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { projects, addMedia, updateMedia, removeMedia, addClip, addAudioTrack, importSubtitles } = useEditState();
    const project = projects.find((item) => item.id === projectId);
    const media = project?.media ?? EMPTY_MEDIA;
    const assets = useAssetStore((state) => state.assets);
    const videoAssets = useMemo(() => assets.filter((asset) => asset.kind === "video"), [assets]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const subtitleInputRef = useRef<HTMLInputElement>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [importing, setImporting] = useState(false);

    const importFiles = async (files: File[]) => {
        setImporting(true);
        try {
            const imported = await importLocalMediaFiles(files);
            imported.forEach((item) => addMedia(projectId, item));
            if (imported.length) message.success(t("editor.imported", { count: imported.length }));
            else message.warning(t("editor.importUnsupported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setImporting(false);
        }
    };

    /** 跳过原因按类别合并计数：用户要能看清「跳过了几条、每条为什么」。 */
    const describeIssues = (issues: SubtitleIssue[]) => {
        const counts = new Map<SubtitleIssueReason, number>();
        issues.forEach((issue) => counts.set(issue.reason, (counts.get(issue.reason) ?? 0) + 1));
        return [...counts].map(([reason, count]) => t("editor.subtitleIssueCount", { count, reason: t(`editor.subtitleIssueReasons.${reason}`) })).join("、");
    };

    /**
     * 导入 SRT / WebVTT。解析是纯函数、绝不抛异常：畸形条目跳过并计数，
     * 导入后按成片时间轴逐条核算「会怎样」并原话告诉用户——不静默丢弃、也不静默合并。
     */
    const importSubtitleFile = async (file: File) => {
        try {
            const parsed = parseSubtitleFile(decodeSubtitleBytes(new Uint8Array(await file.arrayBuffer())));
            if (!parsed.cues.length) {
                message.warning(t("editor.subtitleImportNone"));
                return;
            }
            const views = buildEditClips(media, project?.clips ?? EMPTY_CLIPS);
            const summary = summarizeSubtitleImport(parsed.cues, views);
            importSubtitles(projectId, parsed.cues);
            const notes = [
                views.length ? null : t("editor.subtitleImportEmptyTimeline"),
                summary.beyondEnd ? t("editor.subtitleImportBeyondEnd", { count: summary.beyondEnd }) : null,
                summary.truncated ? t("editor.subtitleImportTruncated", { count: summary.truncated }) : null,
                summary.crossingSeams ? t("editor.subtitleImportSeams", { count: summary.crossingSeams }) : null,
                summary.overlapping ? t("editor.subtitleImportOverlap", { count: summary.overlapping }) : null,
            ].filter((note): note is string => Boolean(note));
            message.success({
                // 停留久一点：这几行是用户唯一能知道「到底导入了什么、丢了什么」的地方。
                duration: 6,
                content: (
                    <div className="flex flex-col gap-0.5 text-[12px] leading-5">
                        <span>{t("editor.subtitleImportDone", { count: parsed.cues.length, format: t(`editor.subtitleFormats.${parsed.format}`), total: (project?.subtitles?.length ?? 0) + parsed.cues.length })}</span>
                        {parsed.issues.length ? <span>{t("editor.subtitleImportSkipped", { count: parsed.issues.length, reasons: describeIssues(parsed.issues) })}</span> : null}
                        {notes.map((note) => (
                            <span key={note}>{note}</span>
                        ))}
                    </div>
                ),
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };

    const importAsset = async (assetId: string) => {
        setPickerOpen(false);
        const asset = videoAssets.find((item) => item.id === assetId);
        if (!asset) return;
        try {
            const imported = await importAssetToEditMedia(asset);
            if (!imported) return;
            addMedia(projectId, imported);
            message.success(t("editor.imported", { count: 1 }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };

    const addToTimeline = (item: EditMedia) => {
        addClip(projectId, createEditClip(item.id));
        message.success(t("editor.addedToTimeline"));
    };

    // 探测失败（网络/编码异常）时可以再探一次：拿到真实时长后该素材才能排上时间线。
    const reprobe = async (item: EditMedia) => {
        const durationMs = await probeEditMediaDuration(await resolveEditMediaUrl(item), item.kind);
        if (!durationMs) {
            message.warning(t("editor.reprobeFailed"));
            return;
        }
        updateMedia(projectId, item.id, { durationMs });
        message.success(t("editor.reprobeDone"));
    };

    return (
        <section className="flex min-h-0 flex-col bg-black/[0.012] dark:bg-white/[0.02]" aria-label={t("editor.media")}>
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.07] px-3 dark:border-white/[0.07]">
                <span className="text-[12px] font-medium tracking-[-0.01em] text-stone-900 dark:text-zinc-100">{t("editor.media")}</span>
                <span className="text-[10px] tabular-nums text-stone-400 dark:text-zinc-600">{media.length}</span>
                <span className="ml-auto inline-flex items-center gap-0.5">
                    <Tooltip title={t("editor.importLocalHint")}>
                        <Button type="text" size="small" loading={importing} icon={<Upload className="size-3.5" />} aria-label={t("editor.importLocal")} onClick={() => fileInputRef.current?.click()} />
                    </Tooltip>
                    <Tooltip title={t("editor.importSubtitleHint")}>
                        <Button data-edit-import-subtitle-button type="text" size="small" icon={<Captions className="size-3.5" />} aria-label={t("editor.subtitleImport")} onClick={() => subtitleInputRef.current?.click()} />
                    </Tooltip>
                    <Tooltip title={t("editor.importAssetHint")}>
                        <Button type="text" size="small" icon={<Images className="size-3.5" />} aria-label={t("editor.importAsset")} onClick={() => setPickerOpen(true)} />
                    </Tooltip>
                </span>
            </header>

            <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
                <button type="button" className="td-workspace-action" onClick={() => fileInputRef.current?.click()}>
                    <Upload className="size-3.5" />
                    {t("editor.importLocal")}
                </button>
                <button type="button" className="td-workspace-action" onClick={() => subtitleInputRef.current?.click()}>
                    <Captions className="size-3.5" />
                    {t("editor.subtitleImport")}
                </button>
                <button type="button" className="td-workspace-action" onClick={() => setPickerOpen(true)}>
                    <Images className="size-3.5" />
                    {t("editor.importAsset")}
                </button>
            </div>

            <p className="px-3 pb-2 text-[10px] leading-4 text-stone-400 dark:text-zinc-600">{t("editor.importSubtitleHint")}</p>
            <p className="px-3 pb-2 text-[10px] leading-4 text-stone-400 dark:text-zinc-600">{t("editor.importCanvasHint")}</p>

            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {!media.length ? (
                    <div className="px-3 py-8">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-[12px] text-stone-500 dark:text-zinc-500">{t("editor.emptyMedia")}</span>}>
                            <button type="button" className="td-workspace-action is-primary" onClick={() => fileInputRef.current?.click()}>
                                <Plus className="size-3.5" />
                                {t("editor.importLocal")}
                            </button>
                        </Empty>
                    </div>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {media.map((item) => {
                            const playable = item.kind === "video" && Boolean(item.durationMs);
                            return (
                                <li key={item.id} className="group flex items-center gap-2 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04]">
                                    {item.kind === "audio" ? <Music2 className="size-3.5 shrink-0 text-stone-400 dark:text-zinc-600" /> : <Film className="size-3.5 shrink-0 text-stone-400 dark:text-zinc-600" />}
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[12px] text-stone-800 dark:text-zinc-200" title={item.name}>
                                            {item.name}
                                        </span>
                                        {item.kind === "video" && !item.durationMs ? (
                                            <span className="block truncate text-[10px] text-amber-600 dark:text-amber-500/90">{t("editor.noDurationInline")}</span>
                                        ) : (
                                            <span className="block truncate text-[10px] text-stone-400 dark:text-zinc-600">
                                                {t(`editor.source.${item.source}`)} · {item.durationMs ? formatEditTime(item.durationMs / 1000) : t("editor.durationUnknown")}
                                            </span>
                                        )}
                                    </span>
                                    {item.kind === "video" ? (
                                        playable ? (
                                            <Button type="text" size="small" icon={<Plus className="size-3.5" />} aria-label={t("editor.addToTimeline")} onClick={() => addToTimeline(item)} />
                                        ) : (
                                            <Tooltip title={t("editor.noDurationHint")}>
                                                <Button type="text" size="small" icon={<TimerOff className="size-3.5" />} aria-label={t("editor.reprobe")} onClick={() => void reprobe(item)}>
                                                    {t("editor.reprobe")}
                                                </Button>
                                            </Tooltip>
                                        )
                                    ) : (
                                        <Tooltip title={t("editor.addAudioTrackHint")}>
                                            <Button type="text" size="small" icon={<Plus className="size-3.5" />} aria-label={t("editor.addAudioTrack")} onClick={() => addAudioTrack(projectId, item.id)} />
                                        </Tooltip>
                                    )}
                                    <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={t("editor.removeMedia")} onClick={() => removeMedia(projectId, item.id)} />
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <input
                ref={fileInputRef}
                type="file"
                accept="video/*,audio/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.target.files || []);
                    event.target.value = "";
                    void importFiles(files);
                }}
            />

            {/* 字幕文件必须走 WebView 自己的 <input type="file">：Tauri 侧的 fs:allow-read-file
                只授权到媒体缓存目录，用户随手放在桌面上的 .srt 读不了（与本地素材导入同一条路）。 */}
            <input
                ref={subtitleInputRef}
                type="file"
                data-edit-import-subtitle
                accept=".srt,.vtt,text/vtt,application/x-subrip"
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void importSubtitleFile(file);
                }}
            />

            <Modal title={t("editor.importAsset")} open={pickerOpen} footer={null} onCancel={() => setPickerOpen(false)}>
                {videoAssets.length ? (
                    <ul className="thin-scrollbar flex max-h-[420px] flex-col gap-1 overflow-y-auto">
                        {videoAssets.map((asset) => (
                            <li key={asset.id} className="flex items-center gap-3 rounded-[10px] px-2 py-2 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04]">
                                <span className="min-w-0 flex-1 truncate text-[12px] text-stone-800 dark:text-zinc-200">{asset.title}</span>
                                <Button size="small" type="text" icon={<FolderOpen className="size-3.5" />} onClick={() => void importAsset(asset.id)}>
                                    {t("editor.importAssetPick")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-[12px] text-stone-500 dark:text-zinc-500">{t("editor.emptyAssetLibrary")}</span>} />
                )}
            </Modal>
        </section>
    );
}
