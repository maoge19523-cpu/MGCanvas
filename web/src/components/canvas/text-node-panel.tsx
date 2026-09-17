import { useEffect, useState } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

export type TextNodePanelProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    onChange: (nodeId: string, metadata: Partial<CanvasNodeMetadata>) => void;
};

/**
 * 文本节点专用面板。
 *
 * 文本节点的定位是「内容载体」：直接编辑文字，连线给图片 / 视频 / 音频节点当提示词；
 * 需要模型改写时用节点上的「编辑文字」，因此这里不提供模型选择与生成按钮。
 */
export function TextNodePanel({ node, theme, onChange }: TextNodePanelProps) {
    const stored = node.metadata?.content || "";
    const [draft, setDraft] = useState(stored);

    useEffect(() => {
        setDraft(node.metadata?.content || "");
    }, [node.id, node.metadata?.content]);

    const commit = (value: string) => {
        setDraft(value);
        onChange(node.id, { content: value, status: value.trim() ? "success" : node.metadata?.status });
    };

    return (
        <div className="flex flex-col gap-2" style={{ color: theme.node.text }}>
            <div className="flex items-center gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                <span className="font-medium" style={{ color: theme.node.text }}>
                    文本内容
                </span>
                <span>连线到图片 / 视频节点即可作为提示词；用「编辑文字」让模型按指令改写</span>
            </div>
            <textarea
                data-canvas-no-zoom
                value={draft}
                onChange={(event) => commit(event.target.value)}
                placeholder="在这里写文字，或从别处粘贴"
                spellCheck={false}
                className="min-h-[160px] w-full resize-y rounded-xl border p-3 text-xs leading-5 outline-none transition-colors"
                style={{ background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.node.text }}
            />
            <div className="text-right text-[11px]" style={{ color: theme.node.faint }}>
                {draft.length} 字
            </div>
        </div>
    );
}
