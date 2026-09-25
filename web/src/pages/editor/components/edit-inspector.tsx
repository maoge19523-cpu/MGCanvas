import { App, Button, Empty, Input, InputNumber, Select, Switch, Tooltip } from "antd";
import { FolderOpen, Lock, LockOpen, Music2, Scissors, Trash2, VolumeX } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { buildEditClips, editOutputSeconds, formatEditTime } from "@/lib/edit/timeline";
import { isTauriRuntime } from "@/services/platform/desktop-runtime";
import { useEditState } from "@/stores/use-edit-store";
import { EDIT_TRANSITIONS } from "@/types/edit";
import { exportEditProject, openOutputDirectory, pickOutputDirectory, type EditExportResult } from "../export";

function clampNumber(value: number | null, minimum: number, maximum: number, fallback: number) {
    const parsed = Number(value);
    if (value === null || !Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

/** 属性区（右）：选中片段的参数、附加音轨、输出参数与导出。 */
export function EditInspector({ projectId, clipId }: { projectId: string; clipId: string | null }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { projects, updateClip, removeClip, updateAudioTrack, removeAudioTrack, updateOutput } = useEditState();
    const project = projects.find((item) => item.id === projectId);
    const [exporting, setExporting] = useState(false);
    const [result, setResult] = useState<EditExportResult | null>(null);

    if (!project) return null;
    const views = buildEditClips(project.media, project.clips);
    const clip = project.clips.find((item) => item.id === clipId) || null;
    const view = views.find((item) => item.id === clipId) || null;
    const outputSeconds = editOutputSeconds(views);
    const locked = clip?.locked === true;

    /** 锁定（片段或音轨）的编辑一律拒绝，并给出同一句可理解的反馈，绝不静默失效。 */
    const refuseLocked = (locked: boolean) => {
        if (!locked) return false;
        message.warning(t("editor.trackLockedNotice"));
        return true;
    };

    const runExport = async () => {
        if (!isTauriRuntime()) {
            message.warning(t("editor.desktopOnly"));
            return;
        }
        const directory = await pickOutputDirectory(t("editor.pickOutputDir"));
        if (!directory) return;
        setExporting(true);
        try {
            const exported = await exportEditProject(project, directory);
            setResult(exported);
            message.success(t("editor.exportDone", { name: exported.filename }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setExporting(false);
        }
    };

    return (
        <section data-edit-area="inspector" aria-label={t("editor.inspector")} className="thin-scrollbar flex min-h-0 flex-col overflow-y-auto bg-black/[0.012] dark:bg-white/[0.02]">
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.07] px-3 dark:border-white/[0.07]">
                <span className="text-[12px] font-medium text-stone-900 dark:text-zinc-100">{t("editor.inspector")}</span>
                <span className="truncate text-[10px] text-stone-400 dark:text-zinc-600">{view ? `${t("editor.clipNumber", { index: views.indexOf(view) + 1 })} · ${view.name}` : t("editor.noClipSelected")}</span>
            </header>

            {clip && view ? (
                <div className="flex flex-col gap-2.5 px-3 py-3">
                    {/* 锁定 = 这一段只读：参数控件全部禁用，拖动 / 裁剪 / 拆分 / 删除另外在时间线里拒绝（见 edit-stage）。
                        锁定按钮本身始终可用，否则会把自己锁死。 */}
                    <Field label={t("editor.start")}>
                        <InputNumber disabled={locked} size="small" min={0} max={view.sourceSeconds || undefined} step={0.1} controls={false} addonAfter={t("editor.seconds")} value={clip.start} style={{ width: 108 }} onChange={(value) => updateClip(projectId, clip.id, { start: clampNumber(value, 0, view.sourceSeconds || Number.MAX_SAFE_INTEGER, clip.start) })} />
                    </Field>
                    <Field label={t("editor.end")}>
                        <InputNumber disabled={locked} size="small" min={0} max={view.sourceSeconds || undefined} step={0.1} controls={false} addonAfter={t("editor.seconds")} value={clip.end || undefined} placeholder={view.sourceSeconds ? String(Number(view.sourceSeconds.toFixed(1))) : "—"} style={{ width: 108 }} onChange={(value) => updateClip(projectId, clip.id, { end: value === null || !Number.isFinite(Number(value)) ? 0 : clampNumber(value, 0, view.sourceSeconds || Number.MAX_SAFE_INTEGER, clip.end) })} />
                    </Field>
                    <Field label={t("editor.volume")}>
                        <InputNumber disabled={locked} size="small" min={0} max={400} step={5} controls={false} addonAfter="%" value={Math.round(clip.volume * 100)} style={{ width: 108 }} onChange={(value) => updateClip(projectId, clip.id, { volume: clampNumber(value, 0, 400, clip.volume * 100) / 100 })} />
                    </Field>
                    <Field label={t("editor.fadeIn")}>
                        <InputNumber disabled={locked} size="small" min={0} max={5} step={0.5} controls={false} addonAfter="s" value={clip.fadeIn} style={{ width: 108 }} onChange={(value) => updateClip(projectId, clip.id, { fadeIn: clampNumber(value, 0, 5, clip.fadeIn) })} />
                    </Field>
                    <Field label={t("editor.fadeOut")}>
                        <InputNumber disabled={locked} size="small" min={0} max={10} step={0.5} controls={false} addonAfter="s" value={clip.fadeOut} style={{ width: 108 }} onChange={(value) => updateClip(projectId, clip.id, { fadeOut: clampNumber(value, 0, 10, clip.fadeOut) })} />
                    </Field>
                    <Field label={t("editor.transition")}>
                        <Select
                            disabled={locked}
                            size="small"
                            className="w-[108px]"
                            value={clip.transition || "none"}
                           
                            options={[{ value: "none", label: t("editor.transitionNone") }, ...EDIT_TRANSITIONS.map((value) => ({ value, label: t(`editor.transitions.${value}`) }))]}
                            onChange={(value) => updateClip(projectId, clip.id, { transition: value === "none" ? undefined : value })}
                        />
                    </Field>
                    {clip.transition ? (
                        <Field label={t("editor.transitionDuration")}>
                            <InputNumber disabled={locked} size="small" min={0.2} max={1.5} step={0.1} controls={false} addonAfter="s" value={clip.transitionDuration ?? 0.5} style={{ width: 108 }} onChange={(value) => updateClip(projectId, clip.id, { transitionDuration: clampNumber(value, 0.2, 1.5, clip.transitionDuration ?? 0.5) })} />
                        </Field>
                    ) : null}
                    <div className="flex flex-col gap-1">
                        <span className="text-[10px] text-stone-400 dark:text-zinc-600">{t("editor.subtitle")}</span>
                        <Input disabled={locked} size="small" placeholder={t("editor.subtitlePlaceholder")} value={clip.subtitle ?? ""} onChange={(event) => updateClip(projectId, clip.id, { subtitle: event.target.value || undefined })} />
                    </div>
                    <div className="flex items-center gap-1">
                        <Tooltip title={t("editor.trackLockHint")}>
                            <Button
                                data-edit-clip-lock={clip.id}
                                size="small"
                                type="text"
                                className="self-start"
                                title={t("editor.trackLockHint")}
                                aria-pressed={clip.locked === true}
                                aria-label={clip.locked ? t("editor.trackUnlock") : t("editor.trackLock")}
                                icon={clip.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                                onClick={() => updateClip(projectId, clip.id, { locked: !clip.locked })}
                            >
                                {clip.locked ? t("editor.trackUnlock") : t("editor.trackLock")}
                            </Button>
                        </Tooltip>
                        <Button size="small" type="text" danger className="self-start" icon={<Trash2 className="size-3.5" />} onClick={() => { if (!refuseLocked(Boolean(clip.locked))) removeClip(projectId, clip.id); }}>
                            {t("editor.removeClip")}
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="px-3 py-6 text-[11px] leading-5 text-stone-500 dark:text-zinc-500">{views.length ? t("editor.pickClipHint") : t("editor.emptyClipsHint")}</div>
            )}

            <div className="border-t border-black/[0.07] px-3 py-3 dark:border-white/[0.07]">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-stone-700 dark:text-zinc-300">
                    <Music2 className="size-3.5" />
                    {t("editor.audioTracks")}
                </div>
                {project.audioTracks.length ? (
                    <ul className="mt-2 flex flex-col gap-2">
                        {project.audioTracks.map((track) => (
                            <li key={track.id} data-edit-track-locked={track.locked ? track.id : undefined} className="rounded-[10px] bg-black/[0.025] p-2 dark:bg-white/[0.03]">
                                <div className="flex items-center gap-2">
                                    <span className="min-w-0 flex-1 truncate text-[11px] text-stone-700 dark:text-zinc-300">{project.media.find((item) => item.id === track.mediaId)?.name || t("editor.mediaRemoved")}</span>
                                    {track.muted ? <VolumeX className="size-3.5 shrink-0 text-stone-400 dark:text-zinc-600" /> : null}
                                    {track.locked ? (
                                        <Tooltip title={t("editor.trackLockHint")}>
                                            <Lock className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500/90" />
                                        </Tooltip>
                                    ) : null}
                                    <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={t("editor.removeAudioTrack")} onClick={() => { if (!refuseLocked(Boolean(track.locked))) removeAudioTrack(projectId, track.id); }} />
                                </div>
                                {/* 锁定的轨参数不可改：控件直接禁用（锁定的语义是「只读」），删除与解锁仍可用，所以不会把自己锁死。 */}
                                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-stone-400 dark:text-zinc-600">
                                    <InputNumber disabled={Boolean(track.locked)} size="small" min={0} max={400} step={5} controls={false} addonAfter="%" value={Math.round(track.volume * 100)} style={{ width: 92 }} onChange={(value) => updateAudioTrack(projectId, track.id, { volume: clampNumber(value, 0, 400, track.volume * 100) / 100 })} />
                                    <InputNumber disabled={Boolean(track.locked)} size="small" min={0} max={5} step={0.5} controls={false} addonAfter="s" value={track.fadeIn} style={{ width: 84 }} onChange={(value) => updateAudioTrack(projectId, track.id, { fadeIn: clampNumber(value, 0, 5, track.fadeIn) })} />
                                    <InputNumber disabled={Boolean(track.locked)} size="small" min={0} max={10} step={0.5} controls={false} addonAfter="s" value={track.fadeOut} style={{ width: 84 }} onChange={(value) => updateAudioTrack(projectId, track.id, { fadeOut: clampNumber(value, 0, 10, track.fadeOut) })} />
                                    <span className="inline-flex items-center gap-1">
                                        {t("editor.loop")}
                                        <Switch disabled={Boolean(track.locked)} size="small" checked={track.loop} onChange={(checked) => updateAudioTrack(projectId, track.id, { loop: checked })} />
                                    </span>
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <div className="mt-1.5 text-[10px] leading-4 text-stone-400 dark:text-zinc-600">{t("editor.emptyAudioTracks")}</div>
                )}
            </div>

            <div className="border-t border-black/[0.07] px-3 py-3 dark:border-white/[0.07]">
                <div className="text-[11px] font-medium text-stone-700 dark:text-zinc-300">{t("editor.output")}</div>
                <div className="mt-2 flex flex-col gap-2">
                    <Field label={t("editor.longEdge")}>
                        <Select size="small" className="w-[108px]" value={project.output.longEdge} options={[1080, 720, 480].map((value) => ({ value, label: `${value}P` }))} onChange={(value) => updateOutput(projectId, { longEdge: value })} />
                    </Field>
                    <Field label={t("editor.fps")}>
                        <Select size="small" className="w-[108px]" value={project.output.fps} options={[24, 25, 30, 50, 60].map((value) => ({ value, label: `${value}fps` }))} onChange={(value) => updateOutput(projectId, { fps: value })} />
                    </Field>
                    <Field label={t("editor.outputFadeIn")}>
                        <InputNumber size="small" min={0} max={5} step={0.5} controls={false} addonAfter="s" value={project.output.fadeIn} style={{ width: 108 }} onChange={(value) => updateOutput(projectId, { fadeIn: clampNumber(value, 0, 5, project.output.fadeIn) })} />
                    </Field>
                    <Field label={t("editor.outputFadeOut")}>
                        <InputNumber size="small" min={0} max={10} step={0.5} controls={false} addonAfter="s" value={project.output.fadeOut} style={{ width: 108 }} onChange={(value) => updateOutput(projectId, { fadeOut: clampNumber(value, 0, 10, project.output.fadeOut) })} />
                    </Field>
                    <Field label={t("editor.subtitleStyle")}>
                        <Select size="small" className="w-[108px]" value={project.output.subtitleStyle} options={[{ value: "bottom", label: t("editor.subtitleBottom") }, { value: "center", label: t("editor.subtitleCenter") }]} onChange={(value) => updateOutput(projectId, { subtitleStyle: value })} />
                    </Field>
                    <Field label={t("editor.subtitleSize")}>
                        <Select size="small" className="w-[108px]" value={project.output.subtitleSize} options={["small", "medium", "large"].map((value) => ({ value, label: t(`editor.subtitleSizes.${value}`) }))} onChange={(value) => updateOutput(projectId, { subtitleSize: value })} />
                    </Field>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-stone-500 dark:text-zinc-500">
                    <span className="inline-flex items-center gap-1">
                        <Scissors className="size-3" />
                        {t("editor.outputDuration")}
                    </span>
                    <span className="tabular-nums">{formatEditTime(outputSeconds)}</span>
                </div>

                <Tooltip title={t("editor.exportHint")}>
                    <Button type="primary" className="mt-3 !h-9 w-full" loading={exporting} disabled={!views.length || exporting} onClick={() => void runExport()}>
                        {t("editor.export")}
                    </Button>
                </Tooltip>

                {result ? (
                    <div className="mt-2 rounded-[10px] bg-black/[0.025] p-2 dark:bg-white/[0.03]">
                        <div className="truncate text-[11px] text-stone-700 dark:text-zinc-300" title={result.absolutePath}>
                            {t("editor.exportPath", { name: result.filename })}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-stone-400 dark:text-zinc-600" title={result.absolutePath}>
                            {result.directory}
                        </div>
                        <Button size="small" type="text" className="mt-1" icon={<FolderOpen className="size-3.5" />} onClick={() => void openOutputDirectory(result.directory)}>
                            {t("editor.openFolder")}
                        </Button>
                    </div>
                ) : (
                    <div className="mt-2 text-[10px] leading-4 text-stone-400 dark:text-zinc-600">{t("editor.exportNote")}</div>
                )}
            </div>

            {!project.media.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="px-3 pb-6" description={<span className="text-[11px] text-stone-500 dark:text-zinc-500">{t("editor.emptyMedia")}</span>} /> : null}
        </section>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="flex items-center justify-between gap-2 text-[11px] text-stone-500 dark:text-zinc-500">
            <span className="shrink-0">{label}</span>
            {children}
        </label>
    );
}
