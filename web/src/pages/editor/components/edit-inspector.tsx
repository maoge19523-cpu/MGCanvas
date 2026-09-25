import { App, Button, Empty, Input, InputNumber, Select, Switch, Tooltip } from "antd";
import { Captions, FolderOpen, Lock, LockOpen, Music2, Scissors, Trash2, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { buildEditClips, editOutputSeconds, formatEditTime } from "@/lib/edit/timeline";
import { editTrackAudibility } from "@/lib/edit/audio-mix";
import { editTrackStartLimit } from "@/lib/edit/timeline-edit";
import { isTauriRuntime } from "@/services/platform/desktop-runtime";
import { useEditState } from "@/stores/use-edit-store";
import { EDIT_TRANSITIONS, type EditSubtitle } from "@/types/edit";
import { exportEditProject, openOutputDirectory, pickOutputDirectory, type EditExportResult } from "../export";

// 项目不存在时用固定引用兜底，避免每次渲染都产生新数组导致 zustand 误判状态变化。
const EMPTY_SUBTITLES: EditSubtitle[] = [];
/** 属性区最多列这么多条字幕：几千条逐条渲染成输入框会把页面拖死；导入与导出都不受这个上限影响。 */
const SUBTITLE_LIST_LIMIT = 50;

function clampNumber(value: number | null, minimum: number, maximum: number, fallback: number) {
    const parsed = Number(value);
    if (value === null || !Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

/**
 * 一条字幕在属性区里的样子。抽出来是因为有**两个**渲染位置：常规列表里的前 50 条，
 * 以及「时间线上选中、但排在 50 条之外」的那一条（选中了却在属性区找不到它，等于选中没生效）。
 * 选中态同时给 data 属性（测试与排查用）与可见的描边（用户用）。
 */
function SubtitleEntry({ cue, number, selected, entryRef, onRemove, onText }: { cue: EditSubtitle; number: number; selected: boolean; entryRef?: RefObject<HTMLLIElement | null>; onRemove: () => void; onText: (text: string) => void }) {
    const { t } = useTranslation();
    return (
        <li ref={entryRef} data-edit-subtitle={cue.id} data-edit-subtitle-selected={selected ? "true" : undefined} className={`rounded-[10px] p-2 ${selected ? "bg-[#756bff]/10 ring-1 ring-[#756bff]" : "bg-black/[0.025] dark:bg-white/[0.03]"}`}>
            <div className="flex items-center gap-2 text-[10px] tabular-nums text-stone-400 dark:text-zinc-600">
                <span className="shrink-0">{number}</span>
                {/* 起止时间在这里是只读的：它按成片时间轴定位，改它在这边没有可信的参照，
                    要改就拖时间线上那个块（拖动 / 拖两端），这里只让用户看清楚。 */}
                <span data-edit-subtitle-time={cue.id}>
                    {formatEditTime(cue.start)} → {formatEditTime(cue.end)}
                </span>
                {selected ? <span className="truncate text-[#756bff]">{t("editor.subtitleSelected")}</span> : null}
                <Button size="small" type="text" danger className="ml-auto" icon={<Trash2 className="size-3.5" />} aria-label={t("editor.removeSubtitle")} onClick={onRemove} />
            </div>
            <Input size="small" className="mt-1" value={cue.text} aria-label={t("editor.subtitle")} onChange={(event) => onText(event.target.value)} />
        </li>
    );
}

/** 属性区（右）：选中片段的参数、附加音轨、输出参数与导出。 */
export function EditInspector({ projectId, clipId, subtitleId = null }: { projectId: string; clipId: string | null; subtitleId?: string | null }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { projects, updateClip, removeClip, updateAudioTrack, removeAudioTrack, updateSubtitle, removeSubtitle, clearSubtitles, updateOutput } = useEditState();
    const project = projects.find((item) => item.id === projectId);
    const [exporting, setExporting] = useState(false);
    const [result, setResult] = useState<EditExportResult | null>(null);
    const selectedRowRef = useRef<HTMLLIElement | null>(null);

    // 在时间线上点中一条字幕时，把它滚进可见区域——这是「选中 → 属性区对应到那一条」的做法：
    // 高亮（上面那个描边）＋ 滚动定位，两样都有。只滚到自己那条，不抢走整页滚动。
    useEffect(() => {
        selectedRowRef.current?.scrollIntoView?.({ block: "nearest" });
    }, [subtitleId]);

    if (!project) return null;
    const views = buildEditClips(project.media, project.clips);
    const clip = project.clips.find((item) => item.id === clipId) || null;
    const view = views.find((item) => item.id === clipId) || null;
    const outputSeconds = editOutputSeconds(views);
    const locked = clip?.locked === true;
    const subtitles = project.subtitles ?? EMPTY_SUBTITLES;
    // 属性区只列前若干条（见 SUBTITLE_LIST_LIMIT）：列表被截断时必须说出来，不能让人以为只有这些。
    const listed = subtitles.slice(0, SUBTITLE_LIST_LIMIT);
    // 时间线上选中的那条排在 50 条之外时，单独再列一条：否则「点中它了、属性区却没有」，
    // 选中态在属性区就完全落空（这里是高亮，不是第二套数据）。
    const selectedIndex = subtitles.findIndex((cue) => cue.id === subtitleId);
    const selectedOutsideList = selectedIndex >= SUBTITLE_LIST_LIMIT ? subtitles[selectedIndex] : undefined;
    // 落在成片末尾之后的字幕导出里一个字都不会出现：在这里常驻提示，别让用户以为它没生效。
    const beyondEnd = outputSeconds > 0 ? subtitles.filter((cue) => cue.start >= outputSeconds).length : 0;
    // 「这条音轨到底出不出声」只有 editTrackAudibility 这一个判定：时间线轨道头与这里的静音 / 独奏
    // 开关都只读它（不在这里另写一套 muted / solo 的优先级），两处显示与导出请求因此不可能漂移。
    const audibility = editTrackAudibility(project.audioTracks);

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
                        {/* 关闭原声：把这一段视频自带的声音整段去掉（画面照旧），预览与成片一起生效。
                            与「音量」是两件事：音量是电平，关闭原声由这个开关说了算（音量调到 0 同样是静音）。 */}
                        <Tooltip title={t("editor.clipMuteHint")}>
                            <Button
                                data-edit-clip-mute={clip.id}
                                disabled={locked}
                                size="small"
                                type="text"
                                className="self-start"
                                title={t("editor.clipMuteHint")}
                                aria-pressed={clip.muted === true}
                                aria-label={clip.muted ? t("editor.clipUnmute") : t("editor.clipMute")}
                                icon={clip.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                                onClick={() => updateClip(projectId, clip.id, { muted: clip.muted ? undefined : true })}
                            >
                                {clip.muted ? t("editor.clipUnmute") : t("editor.clipMute")}
                            </Button>
                        </Tooltip>
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
                    <Captions className="size-3.5" />
                    {t("editor.importedSubtitles")}
                    <span data-edit-subtitle-count={subtitles.length} className="text-[10px] tabular-nums text-stone-400 dark:text-zinc-600">
                        {t("editor.subtitleCount", { count: subtitles.length })}
                    </span>
                    {subtitles.length ? (
                        <Tooltip title={t("editor.clearSubtitlesHint")}>
                            <Button size="small" type="text" className="ml-auto self-start" icon={<Trash2 className="size-3.5" />} aria-label={t("editor.clearSubtitles")} onClick={() => clearSubtitles(projectId)}>
                                {t("editor.clearSubtitles")}
                            </Button>
                        </Tooltip>
                    ) : null}
                </div>
                {beyondEnd ? <div data-edit-subtitle-beyond className="mt-1.5 text-[10px] leading-4 text-amber-600 dark:text-amber-500/90">{t("editor.subtitleBeyondEndNote", { count: beyondEnd })}</div> : null}
                {subtitles.length ? (
                    <ul className="mt-2 flex flex-col gap-2">
                        {listed.map((cue, index) => (
                            <SubtitleEntry key={cue.id} cue={cue} number={index + 1} selected={cue.id === subtitleId} entryRef={cue.id === subtitleId ? selectedRowRef : undefined} onRemove={() => removeSubtitle(projectId, cue.id)} onText={(text) => updateSubtitle(projectId, cue.id, { text })} />
                        ))}
                        {/* 被 50 条上限挡在外面的那一条：只在它正好是时间线上选中的那条时补列出来。 */}
                        {selectedOutsideList ? (
                            <SubtitleEntry key={selectedOutsideList.id} cue={selectedOutsideList} number={selectedIndex + 1} selected entryRef={selectedRowRef} onRemove={() => removeSubtitle(projectId, selectedOutsideList.id)} onText={(text) => updateSubtitle(projectId, selectedOutsideList.id, { text })} />
                        ) : null}
                    </ul>
                ) : (
                    <div className="mt-1.5 text-[10px] leading-4 text-stone-400 dark:text-zinc-600">{t("editor.emptySubtitles")}</div>
                )}
                {listed.length < subtitles.length ? (
                    <div data-edit-subtitle-capped className="mt-1.5 text-[10px] leading-4 text-stone-400 dark:text-zinc-600">
                        {t("editor.subtitleListCapped", { shown: listed.length, count: subtitles.length })}
                    </div>
                ) : null}
            </div>

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
                                    {audibility[track.id] === "muted" ? <VolumeX data-edit-track-muted={track.id} className="size-3.5 shrink-0 text-stone-400 dark:text-zinc-600" /> : null}
                                    {audibility[track.id] === "solo" ? (
                                        <Tooltip title={t("editor.trackSoloHint")}>
                                            <span data-edit-track-solo-excluded={track.id} className="shrink-0 text-[10px] text-stone-400 dark:text-zinc-600">{t("editor.trackSoloExcluded")}</span>
                                        </Tooltip>
                                    ) : null}
                                    {track.locked ? (
                                        <Tooltip title={t("editor.trackLockHint")}>
                                            <Lock className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500/90" />
                                        </Tooltip>
                                    ) : null}
                                    <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={t("editor.removeAudioTrack")} onClick={() => { if (!refuseLocked(Boolean(track.locked))) removeAudioTrack(projectId, track.id); }} />
                                </div>
                                {/* 静音 / 独奏的第二入口：与时间线轨道头上那两个开关是**同一份状态、同一个判定**
                                    （都写 updateAudioTrack 的 muted / solo，都读 editTrackAudibility）。
                                    轨道头按钮万一失效、或者用户根本不知道该去点轨道头时，这里始终有路可走——
                                    曾经因为「静音键点不动」且属性区没有开关，用户完全没有别的办法取消静音。
                                    锁定不拦这两个开关：静音 / 独奏是监听与混音状态（不是被锁保护的那类参数编辑），
                                    轨道头上的静音、独奏、解锁按钮在锁定时同样可用，两个入口的可用性必须一致。 */}
                                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-400 dark:text-zinc-600">
                                    <span data-edit-track-mute-switch={track.id} className="inline-flex items-center gap-1">
                                        <Tooltip title={t("editor.trackMuteHint")}>
                                            <span className="cursor-help">{t("editor.trackMute")}</span>
                                        </Tooltip>
                                        <Switch size="small" checked={track.muted === true} aria-label={t("editor.trackMuteHint")} onChange={(checked) => updateAudioTrack(projectId, track.id, { muted: checked })} />
                                    </span>
                                    <span data-edit-track-solo-switch={track.id} className="inline-flex items-center gap-1">
                                        <Tooltip title={t("editor.trackSoloHint")}>
                                            <span className="cursor-help">{t("editor.trackSolo")}</span>
                                        </Tooltip>
                                        <Switch size="small" checked={track.solo === true} aria-label={t("editor.trackSoloHint")} onChange={(checked) => updateAudioTrack(projectId, track.id, { solo: checked })} />
                                    </span>
                                </div>
                                {/* 锁定的轨参数不可改：控件直接禁用（锁定的语义是「只读」），删除与解锁仍可用，所以不会把自己锁死。 */}
                                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-stone-400 dark:text-zinc-600">
                                    {/* 起点：与时间线上左右拖动波形条是同一件事。这里给的是精确输入与键盘入口——
                                        拖到成片末尾之后波形条会缩成 0 宽，也只有这里能稳妥地改回来。
                                        上界与拖动一致：成片总长（再往后这条轨在成片里就一个字都听不到了）。 */}
                                    <span data-edit-track-start={track.id} className="inline-flex items-center gap-1">
                                        <Tooltip title={t("editor.trackStartHint")}>
                                            <span className="cursor-help" title={t("editor.trackStartHint")}>
                                                {t("editor.trackStart")}
                                            </span>
                                        </Tooltip>
                                        <InputNumber
                                            disabled={Boolean(track.locked)}
                                            size="small"
                                            min={0}
                                            max={editTrackStartLimit(outputSeconds)}
                                            step={0.1}
                                            controls={false}
                                            addonAfter="s"
                                            value={track.start ?? 0}
                                            style={{ width: 84 }}
                                            aria-label={t("editor.trackStartHint")}
                                            onChange={(value) => {
                                                const next = clampNumber(value, 0, editTrackStartLimit(outputSeconds), track.start ?? 0);
                                                updateAudioTrack(projectId, track.id, { start: next > 0 ? next : undefined });
                                            }}
                                        />
                                    </span>
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
