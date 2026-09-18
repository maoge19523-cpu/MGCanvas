import { Select, Tooltip, message } from "antd";
import { LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { DEFAULT_TEXT_PROMPT_STYLE, TEXT_PROMPT_STYLE_GROUPS, rewriteImagePrompt, type TextPromptStyle } from "@/services/api/text-rewrite";
import { modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

export type TextNodePanelProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    onChange: (nodeId: string, metadata: Partial<CanvasNodeMetadata>) => void;
};

/**
 * 文本节点 = 提示词优化器。
 *
 * 下方填一句简单想法并选好画风，模型把它扩写成可直接用于生图的专业提示词，
 * 结果写回节点内容（节点上方显示），之后连线给图片 / 视频节点即可直接用。
 */
export function TextNodePanel({ node, theme, onChange }: TextNodePanelProps) {
    const config = useConfigStore((state) => state.config);
    const models = selectableModelsByCapability(config, "text");
    const [model, setModel] = useState(node.metadata?.model && models.includes(node.metadata.model) ? node.metadata.model : models[0] || "");
    const [idea, setIdea] = useState(node.metadata?.prompt || "");
    const [style, setStyle] = useState<string>(node.metadata?.style || DEFAULT_TEXT_PROMPT_STYLE);
    const [count, setCount] = useState(Number(node.metadata?.textVariants) > 0 ? Number(node.metadata?.textVariants) : 1);
    const [english, setEnglish] = useState(node.metadata?.textEnglish === true);
    const [running, setRunning] = useState(false);

    useEffect(() => {
        if (!models.includes(model)) setModel(models[0] || "");
    }, [models, model]);

    const content = node.metadata?.content || "";

    const run = async () => {
        const trimmed = idea.trim();
        if (!trimmed) {
            void message.warning("先写一句想要画什么。");
            return;
        }
        if (!model) {
            void message.warning("还没有可用的文本模型，请到「配置」里添加一个 capabilities 为 text 的模型。");
            return;
        }
        setRunning(true);
        try {
            const variants = await rewriteImagePrompt(trimmed, style as TextPromptStyle, model, { count, english });
            const nextContent = variants.length > 1 ? variants.map((item, index) => `${index + 1}. ${item}`).join("\n") : variants[0];
            onChange(node.id, { content: nextContent, prompt: trimmed, style, model, textVariants: count, textEnglish: english, status: "success", errorDetails: undefined });
            void message.success(variants.length > 1 ? `已生成 ${variants.length} 组，保留需要的那条即可。` : "提示词已生成，可直接连线给图片 / 视频节点。");
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            onChange(node.id, { status: "error", errorDetails: detail });
            void message.error(detail);
        } finally {
            setRunning(false);
        }
    };

    return (
        // 参数栏承载表单，必须用不透明底色：半透明时会透出下层节点的文字造成重叠。
        <div className="flex flex-col gap-2 rounded-2xl p-3 text-xs" style={{ background: theme.node.panelSolid, color: theme.node.text }}>
            <label className="block">
                <span className="mb-1 block text-[11px] font-medium" style={{ color: theme.node.muted }}>
                    想画什么（一句话就够）
                </span>
                <textarea
                    data-canvas-no-zoom
                    value={idea}
                    onChange={(event) => {
                        setIdea(event.target.value);
                        onChange(node.id, { prompt: event.target.value });
                    }}
                    placeholder="例如：一只小猫"
                    spellCheck={false}
                    className="min-h-[56px] w-full resize-y rounded-xl border p-2.5 leading-5 outline-none"
                    style={{ background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.node.text }}
                />
            </label>

            <div className="flex items-center gap-2">
                <Select
                    className="w-[104px] shrink-0"
                    size="small"
                    value={style}
                    options={TEXT_PROMPT_STYLE_GROUPS.map((group) => ({ label: group.label, options: group.options.map((item) => ({ label: item.label, value: item.label })) }))}
                    onChange={(value) => {
                        setStyle(value);
                        onChange(node.id, { style: value });
                    }}
                />
                <Select
                    className="w-[76px] shrink-0"
                    size="small"
                    value={count}
                    options={[1, 2, 3, 4].map((item) => ({ label: `${item} 组`, value: item }))}
                    onChange={(value) => {
                        setCount(value);
                        onChange(node.id, { textVariants: value });
                    }}
                />
                <Select
                    className="w-[78px] shrink-0"
                    size="small"
                    value={english ? "en" : "zh"}
                    options={[
                        { label: "中文", value: "zh" },
                        { label: "English", value: "en" },
                    ]}
                    onChange={(value) => {
                        const next = value === "en";
                        setEnglish(next);
                        onChange(node.id, { textEnglish: next });
                    }}
                />
                <Select
                    className="min-w-[200px] flex-1"
                    size="small"
                    value={model || undefined}
                    placeholder="请选择模型"
                    options={models.map((item) => ({ label: modelOptionLabel(config, item), value: item }))}
                    onChange={(value) => {
                        setModel(value);
                        onChange(node.id, { model: value });
                    }}
                />
                <Tooltip title="用模型把这句话扩写成专业生图提示词">
                    <button
                        type="button"
                        onClick={() => void run()}
                        disabled={running || !model}
                        className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                        style={{ background: theme.toolbar.activeBg, color: theme.node.text }}
                    >
                        {running ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                    </button>
                </Tooltip>
            </div>

            <label className="block">
                <span className="mb-1 block text-[11px] font-medium" style={{ color: theme.node.muted }}>
                    优化后的提示词（可直接编辑，连线给下游即用）
                </span>
                <textarea
                    data-canvas-no-zoom
                    value={content}
                    onChange={(event) => onChange(node.id, { content: event.target.value })}
                    placeholder="点右侧按钮后，这里会出现专业提示词（多组时每条一行，保留需要的那条即可）"
                    spellCheck={false}
                    className="min-h-[120px] w-full resize-y rounded-xl border p-2.5 leading-5 outline-none"
                    style={{ background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.node.text }}
                />
            </label>
        </div>
    );
}
