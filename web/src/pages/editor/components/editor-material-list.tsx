import type { ReactNode } from "react";
import { Mic, Music2, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

type EditorMaterialListProps = {
    videoNodes: CanvasNodeData[];
    audioNodes: CanvasNodeData[];
    segmentNodeIds: Set<string>;
    voiceNodeId: string;
    musicNodeId: string;
    disabled: boolean;
    onAddSegment: (node: CanvasNodeData) => void;
    onRemoveSegment: (node: CanvasNodeData) => void;
    onSetTrack: (node: CanvasNodeData, port: "voice" | "music") => void;
};

/** 素材区：当前画布里能当片段的视频节点与能当配音/音乐的音频节点，「加入」即在画布上建立连线。 */
export function EditorMaterialList({ videoNodes, audioNodes, segmentNodeIds, voiceNodeId, musicNodeId, disabled, onAddSegment, onRemoveSegment, onSetTrack }: EditorMaterialListProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const actionClass = "shrink-0 rounded-md px-1.5 py-0.5 text-[11px] transition-colors hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10";

    const row = (node: CanvasNodeData, leading: ReactNode) => (
        <div className="flex min-w-0 items-center gap-2 px-1.5 py-1">
            {leading}
            <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: theme.node.text }} title={node.title}>
                {node.title || t("canvas.node.untitled")}
            </span>
        </div>
    );
    const videoThumb = (node: CanvasNodeData) =>
        node.metadata?.content ? <video src={node.metadata.content} preload="metadata" muted playsInline className="size-9 shrink-0 rounded-md object-cover" style={{ pointerEvents: "none" }} /> : <Video className="size-4 shrink-0 opacity-45" />;

    return (
        <aside className="flex min-h-0 w-[236px] shrink-0 flex-col gap-2 overflow-y-auto border-r p-3 thin-scrollbar" style={{ borderColor: theme.toolbar.border }}>
            <span className="shrink-0 text-[12px] font-medium" style={{ color: theme.node.text }}>
                {t("editor.materials")}
            </span>

            <div className="shrink-0 text-[10px] tracking-wide" style={{ color: theme.node.faint }}>
                {t("editor.videoSection")}
            </div>
            {videoNodes.length === 0 && audioNodes.length === 0 ? (
                <div className="flex flex-col gap-1 px-1">
                    <span className="text-[11px]" style={{ color: theme.node.muted }}>
                        {t("editor.noMedia")}
                    </span>
                    <span className="text-[11px] leading-5" style={{ color: theme.node.faint }}>
                        {t("editor.noMediaHint")}
                    </span>
                </div>
            ) : null}
            {videoNodes.map((node) => {
                const added = segmentNodeIds.has(node.id);
                return (
                    <div key={node.id} className="flex min-w-0 flex-col gap-1">
                        {row(node, videoThumb(node))}
                        <div className="flex items-center gap-1 pl-1.5">
                            {added ? (
                                <>
                                    <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                                        {t("editor.added")}
                                    </span>
                                    <button type="button" className={actionClass} style={{ color: theme.node.muted }} disabled={disabled} onClick={() => onRemoveSegment(node)}>
                                        {t("editor.removeClip")}
                                    </button>
                                </>
                            ) : (
                                <button type="button" className={actionClass} style={{ color: theme.node.text }} disabled={disabled} onClick={() => onAddSegment(node)}>
                                    {t("editor.addToTimeline")}
                                </button>
                            )}
                        </div>
                    </div>
                );
            })}

            <div className="mt-2 shrink-0 border-t pt-2 text-[10px] tracking-wide" style={{ borderColor: theme.toolbar.border, color: theme.node.faint }}>
                {t("editor.audioSection")}
            </div>
            {audioNodes.map((node) => {
                const isVoice = node.id === voiceNodeId;
                const isMusic = node.id === musicNodeId;
                return (
                    <div key={node.id} className="flex min-w-0 flex-col gap-1">
                        {row(node, isVoice ? <Mic className="size-4 shrink-0 opacity-60" /> : <Music2 className="size-4 shrink-0 opacity-45" />)}
                        <div className="flex items-center gap-1 pl-1.5">
                            <button type="button" className={actionClass} style={{ color: isVoice ? theme.toolbar.activeText : theme.node.text }} disabled={disabled} onClick={() => onSetTrack(node, "voice")}>
                                {isVoice ? t("editor.isVoice") : t("editor.asVoice")}
                            </button>
                            <button type="button" className={actionClass} style={{ color: isMusic ? theme.toolbar.activeText : theme.node.text }} disabled={disabled} onClick={() => onSetTrack(node, "music")}>
                                {isMusic ? t("editor.isMusic") : t("editor.asMusic")}
                            </button>
                        </div>
                    </div>
                );
            })}
        </aside>
    );
}
