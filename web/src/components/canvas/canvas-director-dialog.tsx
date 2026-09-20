import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Checkbox, Image, Input, InputNumber, Mentions, Modal, Progress, Select, Tag, Tooltip } from "antd";
import { CircleAlert, Clapperboard, Eye, LoaderCircle, Music2, Plus, Sparkles, UploadCloud, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { lintDirectorOutput, splitDirectorShots } from "@/lib/director/prompt-lint";
import { DIRECTOR_MODES, DIRECTOR_TARGETS, type DirectorMode, type DirectorTarget } from "@/lib/director/specs";
import { generateDirectorPrompt, type DirectorReference } from "@/services/api/ai-director";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";

export type DirectorCandidate = { id: string; label: string; url?: string };

/** 已加入素材台的素材；标签按位置生成，保证重排后编号与提示词一致。 */
type RefItem = { id: string; url?: string; title?: string };

const DEFAULT_DURATION = 15;
const ASPECTS = ["16:9", "9:16", "1:1", "21:9", "4:3"];
const IMAGE_LIMIT = 6;
const AUDIO_LIMIT = 3;

/** 把素材从 from 移到 to；越界时原样返回。 */
function move<T>(list: T[], from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
    const next = list.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

export function CanvasDirectorDialog({
    open,
    onClose,
    imageCandidates,
    audioCandidates,
    onUploadMaterial,
    onApply,
}: {
    open: boolean;
    onClose: () => void;
    imageCandidates: DirectorCandidate[];
    audioCandidates: DirectorCandidate[];
    /** 直接从面板触发上传；上传完成后画布新增节点会作为新材料出现在候选里。 */
    onUploadMaterial?: () => void;
    /** 把生成结果落到画布：每个镜头一个文本节点，可选同时创建视频生成节点并连线。 */
    onApply: (shots: string[], withGeneration: boolean) => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const modelOptions = useMemo(() => selectableModelsByCapability(config, "text"), [config]);

    const [model, setModel] = useState("");
    const [mode, setMode] = useState<DirectorMode>("i2v");
    const [target, setTarget] = useState<DirectorTarget>("h3");
    const [brief, setBrief] = useState("");
    const [duration, setDuration] = useState(DEFAULT_DURATION);
    const [aspect, setAspect] = useState(ASPECTS[0]);
    const [images, setImages] = useState<RefItem[]>([]);
    const [audios, setAudios] = useState<RefItem[]>([]);
    const [result, setResult] = useState("");
    const [withGeneration, setWithGeneration] = useState(true);
    const [running, setRunning] = useState(false);
    const [stage, setStage] = useState<"images" | "request" | "retry">("images");
    const [elapsed, setElapsed] = useState(0);
    // 候选里被手动隐藏的素材 id：只是不在面板里显示，画布上的节点不受影响。
    const [hidden, setHidden] = useState<string[]>([]);
    const dragImageIndex = useRef<number | null>(null);
    const dragAudioIndex = useRef<number | null>(null);

    useEffect(() => {
        if (!model && modelOptions.length) setModel(modelOptions[0]);
    }, [model, modelOptions]);

    // 生成期间走秒，让用户知道还在跑。
    useEffect(() => {
        if (!running) return undefined;
        const started = Date.now();
        setElapsed(0);
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
        return () => clearInterval(timer);
    }, [running]);

    const visibleImageCandidates = useMemo(() => imageCandidates.filter((item) => !hidden.includes(item.id)), [imageCandidates, hidden]);
    const visibleAudioCandidates = useMemo(() => audioCandidates.filter((item) => !hidden.includes(item.id)), [audioCandidates, hidden]);

    const stageText = stage === "images" ? t("canvas.director.stageImages") : stage === "retry" ? t("canvas.director.stageRetry") : t("canvas.director.stageRequest");
    const progressPercent = !running ? 0 : stage === "images" ? 12 : stage === "retry" ? 20 : Math.min(92, 30 + Math.round(elapsed * 1.1));

    /** 标签按位置生成，@ 引用和送给模型的素材名始终一致。 */
    const imageRefs = useMemo<DirectorReference[]>(
        () => images.map((item, index) => ({ id: item.id, label: t("canvas.director.imageLabel", { index: index + 1 }), url: item.url })),
        [images, t],
    );
    const audioRefs = useMemo<DirectorReference[]>(
        () => audios.map((item, index) => ({ id: item.id, label: t("canvas.director.audioLabel", { index: index + 1 }), url: item.url })),
        [audios, t],
    );

    const addReference = (candidate: DirectorCandidate, kind: "image" | "audio") => {
        const list = kind === "image" ? images : audios;
        const limit = kind === "image" ? IMAGE_LIMIT : AUDIO_LIMIT;
        if (list.length >= limit) {
            message.warning(kind === "image" ? t("canvas.director.imageLimit") : t("canvas.director.audioLimit"));
            return;
        }
        if (list.some((item) => item.id === candidate.id)) return;
        const next = [...list, { id: candidate.id, url: candidate.url, title: candidate.label }];
        if (kind === "image") setImages(next);
        else setAudios(next);
    };

    const removeReference = (kind: "image" | "audio", id: string) => {
        if (kind === "image") setImages((prev) => prev.filter((item) => item.id !== id));
        else setAudios((prev) => prev.filter((item) => item.id !== id));
    };

    const run = async () => {
        if (!model) {
            message.warning(t("canvas.director.modelRequired"));
            return;
        }
        setRunning(true);
        setStage("images");
        try {
            const outcome = await generateDirectorPrompt({
                brief,
                mode,
                target,
                modelValue: model,
                duration,
                aspect,
                images: imageRefs,
                audios: audioRefs,
                onStage: setStage,
            });
            setResult(outcome.prompt);
            if (outcome.fallback) message.warning(outcome.fallback);
            message.success(t("canvas.director.generated"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setRunning(false);
        }
    };

    /** 规范自检：跟着结果一起算，用户手改文本后也会即时更新。 */
    const lintReport = useMemo(() => (result.trim() ? lintDirectorOutput(result, { mode, target, duration }) : null), [result, mode, target, duration]);

    const mentionOptions = useMemo(() => [...imageRefs, ...audioRefs].map((item) => ({ value: item.label, label: item.label })), [imageRefs, audioRefs]);

    return (
        <Modal
            open={open}
            onCancel={onClose}
            width={980}
            centered
            footer={null}
            title={
                <span className="flex items-center gap-2">
                    <Clapperboard className="size-4" />
                    {t("canvas.director.title")}
                </span>
            }
        >
            <div className="max-h-[72vh] space-y-4 overflow-y-auto pr-1 pt-1 text-[12px]">
                <section className="space-y-2">
                    <div className="font-medium">{t("canvas.director.refs")}</div>

                    {/* 参考图：已加入的带序号角标、可拖拽排序；候选缩略图点击加入。 */}
                    <div className="rounded-xl border border-black/[0.08] p-3 dark:border-white/[0.08]">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="font-medium">{t("canvas.director.images", { count: images.length })}</span>
                            <span className="text-[11px] opacity-55">{t("canvas.director.imagesHint")}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {images.map((item, index) => (
                                <div
                                    key={item.id}
                                    draggable
                                    onDragStart={() => {
                                        dragImageIndex.current = index;
                                    }}
                                    onDragOver={(event) => event.preventDefault()}
                                    onDrop={() => {
                                        if (dragImageIndex.current !== null) setImages((prev) => move(prev, dragImageIndex.current as number, index));
                                        dragImageIndex.current = null;
                                    }}
                                    className="group relative size-[88px] cursor-grab overflow-hidden rounded-lg border-2 border-[#2f80ff] active:cursor-grabbing"
                                >
                                    {item.url ? (
                                        <Image src={item.url} width={88} height={88} className="!size-[88px] object-cover" preview={{ mask: <Eye className="size-4" /> }} />
                                    ) : (
                                        <div className="flex size-full items-center justify-center opacity-45">—</div>
                                    )}
                                    <span className="pointer-events-none absolute left-0 top-0 rounded-br bg-[#2f80ff] px-1 text-[10px] font-semibold leading-4 text-white">{index + 1}</span>
                                    <button
                                        type="button"
                                        onClick={() => removeReference("image", item.id)}
                                        className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white transition hover:bg-red-500"
                                        title={t("common.delete")}
                                    >
                                        <X className="size-3" />
                                    </button>
                                    <Tooltip title={item.title}>
                                        <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[10px] leading-4 text-white">{item.title || `#${index + 1}`}</span>
                                    </Tooltip>
                                </div>
                            ))}

                            {visibleImageCandidates.map((candidate) => (
                                <div key={candidate.id} className="group relative size-[88px]">
                                    <button
                                        type="button"
                                        onClick={() => addReference(candidate, "image")}
                                        className="size-full overflow-hidden rounded-lg border-2 border-dashed border-black/20 transition hover:border-[#2f80ff] dark:border-white/20"
                                        title={`${t("canvas.director.clickToAdd")}：${candidate.label}`}
                                    >
                                        {candidate.url ? <img src={candidate.url} alt="" className="size-full object-cover opacity-45" /> : null}
                                        <span className="absolute inset-0 flex items-center justify-center">
                                            <span className="rounded-full bg-white/90 p-1 text-[#2f80ff] shadow-sm">
                                                <Plus className="size-4" />
                                            </span>
                                        </span>
                                        <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[10px] leading-4 text-white">{candidate.label}</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setHidden((prev) => [...prev, candidate.id])}
                                        className="absolute right-0.5 top-0.5 z-10 rounded-full bg-black/60 p-0.5 text-white transition hover:bg-red-500"
                                        title={t("canvas.director.hideCandidate")}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </div>
                            ))}

                            {onUploadMaterial ? (
                                <button
                                    type="button"
                                    onClick={onUploadMaterial}
                                    className="flex size-[88px] flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-black/20 text-[11px] opacity-70 transition hover:border-[#2f80ff] hover:opacity-100 dark:border-white/20"
                                >
                                    <UploadCloud className="size-4" />
                                    {t("canvas.material.uploadAction")}
                                </button>
                            ) : null}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 text-[11px] opacity-55">
                            <span>{t("canvas.director.candidateHint")}</span>
                            {images.length > 1 ? <span>{t("canvas.director.reorderHint")}</span> : null}
                            {hidden.length ? (
                                <button type="button" className="underline" onClick={() => setHidden([])}>
                                    {t("canvas.director.showHidden", { count: hidden.length })}
                                </button>
                            ) : null}
                        </div>
                    </div>

                    {/* 参考音频：已加入的可直接试听并拖拽排序；候选也能先试听再加入。 */}
                    <div className="rounded-xl border border-black/[0.08] p-3 dark:border-white/[0.08]">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="font-medium">{t("canvas.director.audios", { count: audios.length })}</span>
                            <span className="text-[11px] opacity-55">{t("canvas.director.audiosHint")}</span>
                        </div>
                        <div className="space-y-2">
                            {audios.map((item, index) => (
                                <div
                                    key={item.id}
                                    draggable
                                    onDragStart={() => {
                                        dragAudioIndex.current = index;
                                    }}
                                    onDragOver={(event) => event.preventDefault()}
                                    onDrop={() => {
                                        if (dragAudioIndex.current !== null) setAudios((prev) => move(prev, dragAudioIndex.current as number, index));
                                        dragAudioIndex.current = null;
                                    }}
                                    className="flex cursor-grab items-center gap-2 rounded-lg border-2 border-[#2f80ff] px-2 py-1.5 active:cursor-grabbing"
                                >
                                    <span className="shrink-0 rounded bg-[#2f80ff] px-1 text-[10px] font-semibold text-white">{index + 1}</span>
                                    <Music2 className="size-4 shrink-0 opacity-55" />
                                    <Tooltip title={item.title}>
                                        <span className="w-28 shrink-0 truncate text-[11px]">{t("canvas.director.audioLabel", { index: index + 1 })}</span>
                                    </Tooltip>
                                    <audio src={item.url} controls className="h-8 min-w-0 flex-1" data-canvas-no-zoom />
                                    <button type="button" onClick={() => removeReference("audio", item.id)} className="shrink-0 rounded p-1 opacity-60 transition hover:text-red-500 hover:opacity-100" title={t("common.delete")}>
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            ))}

                            {visibleAudioCandidates.map((candidate) => (
                                <div key={candidate.id} className="flex items-center gap-2 rounded-lg border border-dashed border-black/20 px-2 py-1.5 dark:border-white/20">
                                    <Music2 className="size-4 shrink-0 opacity-45" />
                                    <span className="w-28 shrink-0 truncate text-[11px] opacity-70">{candidate.label}</span>
                                    <audio src={candidate.url} controls className="h-8 min-w-0 flex-1" data-canvas-no-zoom />
                                    <Button size="small" type="text" icon={<Plus className="size-3.5" />} onClick={() => addReference(candidate, "audio")} title={t("canvas.director.clickToAdd")} />
                                    <button type="button" onClick={() => setHidden((prev) => [...prev, candidate.id])} className="shrink-0 rounded p-1 opacity-60 transition hover:text-red-500 hover:opacity-100" title={t("canvas.director.hideCandidate")}>
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            ))}

                            {onUploadMaterial ? (
                                <Button size="small" icon={<UploadCloud className="size-3" />} onClick={onUploadMaterial}>
                                    {t("canvas.material.uploadAction")}
                                </Button>
                            ) : null}
                            {!audios.length && !audioCandidates.length && !onUploadMaterial ? <span className="text-[11px] opacity-45">{t("canvas.director.noCandidate")}</span> : null}
                        </div>
                    </div>
                </section>

                {/* 创意需求：输入 @ 引用已加入的素材 */}
                <section className="space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="font-medium">{t("canvas.director.brief")}</span>
                        <span className="text-[11px] opacity-55">{mentionOptions.length ? t("canvas.director.briefMentionHint") : t("canvas.director.briefMentionEmpty")}</span>
                    </div>
                    <Mentions rows={3} value={brief} onChange={setBrief} prefix="@" options={mentionOptions} placeholder={t("canvas.director.briefPlaceholder")} className="!text-[12px]" />
                </section>

                <section className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5">
                        <span className="block font-medium">{t("canvas.director.model")}</span>
                        <Select className="w-full" value={model || undefined} onChange={setModel} options={modelOptions.map((value) => ({ label: value, value }))} placeholder={t("canvas.director.modelPlaceholder")} />
                    </label>
                    <label className="space-y-1.5">
                        <span className="block font-medium">{t("canvas.director.target")}</span>
                        <Select className="w-full" value={target} onChange={(value) => setTarget(value)} options={DIRECTOR_TARGETS.map((item) => ({ label: item.zh, value: item.value }))} />
                    </label>
                </section>

                <section className="space-y-1.5">
                    <span className="block font-medium">{t("canvas.director.mode")}</span>
                    <div className="flex flex-wrap gap-2">
                        {DIRECTOR_MODES.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                onClick={() => setMode(item.value)}
                                className={`rounded-lg border px-3 py-1.5 text-left transition ${mode === item.value ? "border-[#2f80ff] bg-[#2f80ff]/10 font-medium" : "hover:bg-black/[0.04]"}`}
                                title={item.hint}
                            >
                                {item.zh}
                                <span className="ml-1.5 opacity-55">{item.h3}</span>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5">
                        <span className="block font-medium">{t("canvas.director.duration")}</span>
                        <InputNumber className="w-full" min={1} max={120} value={duration} onChange={(value) => setDuration(value || DEFAULT_DURATION)} />
                    </label>
                    <label className="space-y-1.5">
                        <span className="block font-medium">{t("canvas.director.aspect")}</span>
                        <Select className="w-full" value={aspect} onChange={setAspect} options={ASPECTS.map((value) => ({ label: value, value }))} />
                    </label>
                </section>

                <div className="space-y-2">
                    <div className="flex justify-end">
                        <Button type="primary" icon={running ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} loading={running} onClick={() => void run()}>
                            {running ? t("canvas.director.generating") : t("canvas.director.generate")}
                        </Button>
                    </div>
                    {/* 生成中：给出阶段说明、已等待时长与进度条，避免用户干等。 */}
                    {running ? (
                        <div className="rounded-xl border border-black/[0.08] px-3 py-2.5 dark:border-white/[0.08]">
                            <div className="mb-1.5 flex items-center justify-between text-[11px]">
                                <span>{stageText}</span>
                                <span className="opacity-60">{t("canvas.director.waiting", { seconds: elapsed })}</span>
                            </div>
                            <Progress percent={progressPercent} status="active" showInfo={false} size="small" />
                            <div className="mt-1.5 text-[11px] opacity-50">{t("canvas.director.waitingHint")}</div>
                        </div>
                    ) : null}
                </div>

                {result ? (
                    <section className="space-y-2">
                        <div className="font-medium">{t("canvas.director.result")}</div>
                        <Input.TextArea rows={12} value={result} onChange={(event) => setResult(event.target.value)} className="font-mono text-[11px]" />
                        {/* 规范自检：把 specs 里注入的硬性要求逐条核对结果摊开给用户看。 */}
                        {lintReport ? (
                            <div className="rounded-xl border border-black/[0.08] px-3 py-2.5 dark:border-white/[0.08]">
                                <div className="flex items-center gap-2">
                                    {lintReport.ok ? (
                                        <Tag color="success">{t("canvas.director.lintPass")}</Tag>
                                    ) : (
                                        <Tag color="error">
                                            <CircleAlert className="mr-1 inline size-3 align-[-2px]" />
                                            {t("canvas.director.lintErrors", { count: lintReport.errors })}
                                        </Tag>
                                    )}
                                    {lintReport.warnings ? <Tag color="warning">{t("canvas.director.lintWarnings", { count: lintReport.warnings })}</Tag> : null}
                                    <span className="text-[11px] opacity-55">{t("canvas.director.lintShots", { count: lintReport.shots })}</span>
                                </div>
                                {lintReport.issues.length ? (
                                    <ul className="mt-2 space-y-1 text-[11px]">
                                        {lintReport.issues.map((issue, index) => (
                                            <li key={`${issue.shot}-${issue.code}-${index}`} className="flex gap-1.5">
                                                <span className="shrink-0 opacity-55">{t("canvas.director.lintShot", { index: issue.shot })}</span>
                                                <span className={issue.severity === "error" ? "text-[#d4380d] dark:text-[#ff7875]" : "text-[#ad6800] dark:text-[#ffc069]"}>{issue.message}</span>
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}
                            </div>
                        ) : null}
                        <Checkbox checked={withGeneration} onChange={(event) => setWithGeneration(event.target.checked)}>
                            {t("canvas.director.withGeneration")}
                        </Checkbox>
                        <div className="flex justify-end gap-2">
                            <Button onClick={() => void navigator.clipboard.writeText(result).then(() => message.success(t("common.copied")))}>{t("common.copy")}</Button>
                            <Button
                                type="primary"
                                onClick={() => {
                                    onApply(splitDirectorShots(result), withGeneration);
                                    onClose();
                                }}
                            >
                                {t("canvas.director.applyToCanvas")}
                            </Button>
                        </div>
                    </section>
                ) : null}
            </div>
        </Modal>
    );
}
