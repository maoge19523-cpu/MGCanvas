import { useEffect, useMemo, useState } from "react";
import { App, Button, Checkbox, Input, InputNumber, Modal, Select, Tag } from "antd";
import { Clapperboard, LoaderCircle, Plus, Sparkles, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DIRECTOR_MODES, DIRECTOR_TARGETS, type DirectorMode, type DirectorTarget } from "@/lib/director/specs";
import { generateDirectorPrompt, type DirectorReference } from "@/services/api/ai-director";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";

export type DirectorCandidate = { id: string; label: string; url?: string };

const DEFAULT_SHOTS = 3;
const DEFAULT_DURATION = 15;
const ASPECTS = ["16:9", "9:16", "1:1", "21:9", "4:3"];

export function CanvasDirectorDialog({
    open,
    onClose,
    imageCandidates,
    audioCandidates,
    onApply,
}: {
    open: boolean;
    onClose: () => void;
    imageCandidates: DirectorCandidate[];
    audioCandidates: DirectorCandidate[];
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

    /** 把候选素材追加进参考列表，默认标签按序号生成。 */
    const addReference = (candidate: DirectorCandidate, kind: "image" | "audio") => {
        const list = kind === "image" ? images : audios;
        const limit = kind === "image" ? 6 : 3;
        if (list.length >= limit) {
            message.warning(kind === "image" ? t("canvas.director.imageLimit") : t("canvas.director.audioLimit"));
            return;
        }
        if (list.some((item) => item.label === candidate.label)) return;
        const next = [...list, { label: candidate.label, url: candidate.url }];
        if (kind === "image") setImages(next);
        else setAudios(next);
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

    return (
        <Modal
            open={open}
            onCancel={onClose}
            width={880}
            centered
            footer={null}
            title={
                <span className="flex items-center gap-2">
                    <Clapperboard className="size-4" />
                    {t("canvas.director.title")}
                </span>
            }
        >
            <div className="max-h-[68vh] space-y-4 overflow-y-auto pr-1 pt-1 text-[12px]">
                {/* 参考素材 */}
                <section className="space-y-2">
                    <div className="font-medium">{t("canvas.director.refs")}</div>
                    <RefRow
                        title={t("canvas.director.images", { count: images.length })}
                        hint={t("canvas.director.imagesHint")}
                        items={images}
                        candidates={imageCandidates}
                        onChange={setImages}
                        onAdd={(candidate) => addReference(candidate, "image")}
                    />
                    <RefRow
                        title={t("canvas.director.audios", { count: audios.length })}
                        hint={t("canvas.director.audiosHint")}
                        items={audios}
                        candidates={audioCandidates}
                        onChange={setAudios}
                        onAdd={(candidate) => addReference(candidate, "audio")}
                    />
                </section>

                {/* 创意需求 */}
                <section className="space-y-2">
                    <div className="font-medium">{t("canvas.director.brief")}</div>
                    <Input.TextArea rows={2} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder={t("canvas.director.briefPlaceholder")} />
                </section>

                {/* 三个选择项 */}
                <section className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5">
                        <span className="block font-medium">{t("canvas.director.model")}</span>
                        <Select className="w-full" value={model || undefined} onChange={setModel} options={modelOptions.map((value) => ({ label: value, value }))} placeholder={t("canvas.director.modelPlaceholder")} />
                    </label>
                    <label className="space-y-1.5">
                        <span className="block font-medium">{t("canvas.director.target")}</span>
                        <Select
                            className="w-full"
                            value={target}
                            onChange={(value) => setTarget(value)}
                            options={DIRECTOR_TARGETS.map((item) => ({ label: item.zh, value: item.value }))}
                        />
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

                {/* 结果 */}
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

/** 一行参考素材：已选列表 + 从画布候选中添加。 */
function RefRow({
    title,
    hint,
    items,
    candidates,
    onChange,
    onAdd,
}: {
    title: string;
    hint: string;
    items: DirectorReference[];
    candidates: DirectorCandidate[];
    onChange: (value: DirectorReference[]) => void;
    onAdd: (candidate: DirectorCandidate) => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="rounded-xl border border-black/[0.08] p-2.5 dark:border-white/[0.08]">
            <div className="mb-1.5 flex items-center justify-between">
                <span className="font-medium">{title}</span>
                <span className="text-[11px] opacity-55">{hint}</span>
            </div>
            <div className="mb-2 flex flex-wrap gap-1.5">
                {items.length ? (
                    items.map((item, index) => (
                        <Tag
                            key={`${item.label}-${index}`}
                            closable
                            onClose={(event) => {
                                event.preventDefault();
                                onChange(items.filter((_, position) => position !== index));
                            }}
                        >
                            {item.label}
                        </Tag>
                    ))
                ) : (
                    <span className="text-[11px] opacity-45">{t("canvas.director.noneSelected")}</span>
                )}
            </div>
            <div className="flex flex-wrap gap-1.5">
                {candidates.length ? (
                    candidates.map((candidate) => (
                        <Button key={candidate.id} size="small" icon={<Plus className="size-3" />} onClick={() => onAdd(candidate)}>
                            {candidate.label}
                        </Button>
                    ))
                ) : (
                    <span className="text-[11px] opacity-45">{t("canvas.director.noCandidate")}</span>
                )}
                {items.length ? (
                    <Button size="small" danger type="text" icon={<Trash2 className="size-3" />} onClick={() => onChange([])}>
                        {t("common.clear")}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
