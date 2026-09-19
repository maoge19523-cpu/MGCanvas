import { useEffect, useMemo, useState } from "react";
import { App, Button, Checkbox, Image, Input, InputNumber, Mentions, Modal, Select } from "antd";
import { Clapperboard, Eye, LoaderCircle, Music2, Plus, Sparkles, UploadCloud, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DIRECTOR_MODES, DIRECTOR_TARGETS, type DirectorMode, type DirectorTarget } from "@/lib/director/specs";
import { generateDirectorPrompt, type DirectorReference } from "@/services/api/ai-director";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";

export type DirectorCandidate = { id: string; label: string; url?: string };

const DEFAULT_SHOTS = 3;
const DEFAULT_DURATION = 15;
const ASPECTS = ["16:9", "9:16", "1:1", "21:9", "4:3"];
const IMAGE_LIMIT = 6;
const AUDIO_LIMIT = 3;

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
    const [shots, setShots] = useState(DEFAULT_SHOTS);
    const [duration, setDuration] = useState(DEFAULT_DURATION);
    const [aspect, setAspect] = useState(ASPECTS[0]);
    const [images, setImages] = useState<DirectorReference[]>([]);
    const [audios, setAudios] = useState<DirectorReference[]>([]);
    const [result, setResult] = useState("");
    const [withGeneration, setWithGeneration] = useState(true);
    const [running, setRunning] = useState(false);

    useEffect(() => {
        if (!model && modelOptions.length) setModel(modelOptions[0]);
    }, [model, modelOptions]);

    /** 加入参考素材：按 id 去重，标签重复时补序号，保证 @ 引用唯一。 */
    const addReference = (candidate: DirectorCandidate, kind: "image" | "audio") => {
        const list = kind === "image" ? images : audios;
        const limit = kind === "image" ? IMAGE_LIMIT : AUDIO_LIMIT;
        if (list.length >= limit) {
            message.warning(kind === "image" ? t("canvas.director.imageLimit") : t("canvas.director.audioLimit"));
            return;
        }
        if (list.some((item) => item.id === candidate.id)) return;

        const base = candidate.label.trim() || (kind === "image" ? t("canvas.director.imageLabel", { index: list.length + 1 }) : t("canvas.director.audioLabel", { index: list.length + 1 }));
        let label = base;
        let suffix = 2;
        while (list.some((item) => item.label === label)) label = `${base} ${suffix++}`;

        const next = [...list, { id: candidate.id, label, url: candidate.url }];
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
        try {
            const prompt = await generateDirectorPrompt({ brief, mode, target, modelValue: model, shots, duration, aspect, images, audios });
            setResult(prompt);
            message.success(t("canvas.director.generated"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setRunning(false);
        }
    };

    /** 按「=== 镜头 N ===」分隔符切分；识别不了就整段作为一条。 */
    const splitShots = (text: string): string[] => {
        const blocks = text
            .split(/\n\s*={2,}\s*镜头\s*\d+\s*={2,}\s*\n/)
            .map((item) => item.replace(/^\s*={2,}\s*镜头\s*\d+\s*={2,}\s*$/gm, "").trim())
            .filter(Boolean);
        return blocks.length > 1 ? blocks : [text.trim()];
    };

    // @ 引用候选：面板里已加入的参考素材，插入的文本与送给模型时的标签一致。
    const mentionOptions = useMemo(() => [...images, ...audios].map((item) => ({ value: item.label, label: item.label })), [images, audios]);

    return (
        <Modal
            open={open}
            onCancel={onClose}
            width={960}
            centered
            footer={null}
            title={
                <span className="flex items-center gap-2">
                    <Clapperboard className="size-4" />
                    {t("canvas.director.title")}
                </span>
            }
        >
            <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 pt-1 text-[12px]">
                {/* 素材台：参考图可放大观看，参考音频可直接试听 */}
                <section className="space-y-2">
                    <div className="font-medium">{t("canvas.director.refs")}</div>

                    <div className="rounded-xl border border-black/[0.08] p-3 dark:border-white/[0.08]">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="font-medium">{t("canvas.director.images", { count: images.length })}</span>
                            <span className="text-[11px] opacity-55">{t("canvas.director.imagesHint")}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {images.map((item) => (
                                <div key={item.id} className="group relative size-[76px] overflow-hidden rounded-lg border border-black/[0.08] dark:border-white/[0.1]">
                                    {item.url ? (
                                        <Image src={item.url} width={76} height={76} className="!size-[76px] object-cover" preview={{ mask: <Eye className="size-4" /> }} />
                                    ) : (
                                        <div className="flex size-full items-center justify-center opacity-45">—</div>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => removeReference("image", item.id)}
                                        className="absolute right-0.5 top-0.5 rounded-full bg-black/55 p-0.5 text-white opacity-0 transition group-hover:opacity-100"
                                        title={t("common.delete")}
                                    >
                                        <X className="size-3" />
                                    </button>
                                    <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 text-[10px] leading-4 text-white">{item.label}</span>
                                </div>
                            ))}

                            {imageCandidates.map((candidate) => (
                                <button
                                    key={candidate.id}
                                    type="button"
                                    onClick={() => addReference(candidate, "image")}
                                    className="group relative size-[76px] overflow-hidden rounded-lg border border-dashed border-black/15 transition hover:border-[#2f80ff] dark:border-white/15"
                                    title={`${t("common.add")} ${candidate.label}`}
                                >
                                    {candidate.url ? <img src={candidate.url} alt="" className="size-full object-cover opacity-55 transition group-hover:opacity-80" /> : null}
                                    <span className="absolute inset-0 flex items-center justify-center bg-black/25 text-white opacity-0 transition group-hover:opacity-100">
                                        <Plus className="size-5" />
                                    </span>
                                    <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 text-[10px] leading-4 text-white">{candidate.label}</span>
                                </button>
                            ))}

                            {onUploadMaterial ? (
                                <button
                                    type="button"
                                    onClick={onUploadMaterial}
                                    className="flex size-[76px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-black/15 text-[11px] opacity-70 transition hover:border-[#2f80ff] hover:opacity-100 dark:border-white/15"
                                >
                                    <UploadCloud className="size-4" />
                                    {t("canvas.material.uploadAction")}
                                </button>
                            ) : null}

                            {!images.length && !imageCandidates.length && !onUploadMaterial ? <span className="text-[11px] opacity-45">{t("canvas.director.noCandidate")}</span> : null}
                        </div>
                    </div>

                    <div className="rounded-xl border border-black/[0.08] p-3 dark:border-white/[0.08]">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="font-medium">{t("canvas.director.audios", { count: audios.length })}</span>
                            <span className="text-[11px] opacity-55">{t("canvas.director.audiosHint")}</span>
                        </div>
                        <div className="space-y-2">
                            {audios.map((item) => (
                                <div key={item.id} className="flex items-center gap-2 rounded-lg border border-black/[0.08] px-2 py-1.5 dark:border-white/[0.1]">
                                    <Music2 className="size-4 shrink-0 opacity-55" />
                                    <span className="w-24 shrink-0 truncate text-[11px]">{item.label}</span>
                                    {/* 与音频节点一致：直接播放 metadata.content。 */}
                                    <audio src={item.url} controls className="h-8 min-w-0 flex-1" data-canvas-no-zoom />
                                    <button type="button" onClick={() => removeReference("audio", item.id)} className="shrink-0 rounded p-1 opacity-55 transition hover:opacity-100" title={t("common.delete")}>
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            ))}
                            <div className="flex flex-wrap gap-2">
                                {audioCandidates.map((candidate) => (
                                    <Button key={candidate.id} size="small" icon={<Plus className="size-3" />} onClick={() => addReference(candidate, "audio")}>
                                        {candidate.label}
                                    </Button>
                                ))}
                                {onUploadMaterial ? (
                                    <Button size="small" icon={<UploadCloud className="size-3" />} onClick={onUploadMaterial}>
                                        {t("canvas.material.uploadAction")}
                                    </Button>
                                ) : null}
                                {!audios.length && !audioCandidates.length && !onUploadMaterial ? <span className="text-[11px] opacity-45">{t("canvas.director.noCandidate")}</span> : null}
                            </div>
                        </div>
                    </div>
                </section>

                {/* 创意需求：输入 @ 可引用上面的素材 */}
                <section className="space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="font-medium">{t("canvas.director.brief")}</span>
                        <span className="text-[11px] opacity-55">{mentionOptions.length ? t("canvas.director.briefMentionHint") : t("canvas.director.briefMentionEmpty")}</span>
                    </div>
                    <Mentions
                        rows={3}
                        value={brief}
                        onChange={setBrief}
                        prefix="@"
                        options={mentionOptions}
                        placeholder={t("canvas.director.briefPlaceholder")}
                        className="!text-[12px]"
                    />
                </section>

                {/* 三个选择项 */}
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

                <section className="grid gap-3 sm:grid-cols-3">
                    <label className="space-y-1.5">
                        <span className="block font-medium">{t("canvas.director.shots")}</span>
                        <InputNumber className="w-full" min={1} max={12} value={shots} onChange={(value) => setShots(value || DEFAULT_SHOTS)} />
                    </label>
                    <label className="space-y-1.5">
                        <span className="block font-medium">{t("canvas.director.duration")}</span>
                        <InputNumber className="w-full" min={1} max={120} value={duration} onChange={(value) => setDuration(value || DEFAULT_DURATION)} />
                    </label>
                    <label className="space-y-1.5">
                        <span className="block font-medium">{t("canvas.director.aspect")}</span>
                        <Select className="w-full" value={aspect} onChange={setAspect} options={ASPECTS.map((value) => ({ label: value, value }))} />
                    </label>
                </section>

                <div className="flex justify-end">
                    <Button type="primary" icon={running ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} loading={running} onClick={() => void run()}>
                        {t("canvas.director.generate")}
                    </Button>
                </div>

                {result ? (
                    <section className="space-y-2">
                        <div className="font-medium">{t("canvas.director.result")}</div>
                        <Input.TextArea rows={12} value={result} onChange={(event) => setResult(event.target.value)} className="font-mono text-[11px]" />
                        <Checkbox checked={withGeneration} onChange={(event) => setWithGeneration(event.target.checked)}>
                            {t("canvas.director.withGeneration")}
                        </Checkbox>
                        <div className="flex justify-end gap-2">
                            <Button onClick={() => void navigator.clipboard.writeText(result).then(() => message.success(t("common.copied")))}>{t("common.copy")}</Button>
                            <Button
                                type="primary"
                                onClick={() => {
                                    onApply(splitShots(result), withGeneration);
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
