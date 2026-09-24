import { Button, Tooltip } from "antd";
import { Info, Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatTimelineTime } from "@/lib/canvas/composite-editing";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CompositePreview } from "../use-composite-preview";

type EditorPreviewProps = {
    preview: CompositePreview;
    totalSeconds: number;
    hasClips: boolean;
};

/** 预览区：浏览器直接顺序播放各段原始素材，用于对时；成片效果以导出为准。 */
export function EditorPreview({ preview, totalSeconds, hasClips }: EditorPreviewProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-3">
            <div className="flex min-w-0 items-center gap-2 text-[12px]" style={{ color: theme.node.text }}>
                <span className="font-medium">{t("editor.preview")}</span>
                <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: theme.node.faint }} ref={preview.clipRef} />
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }}>
                {hasClips ? (
                    // 可见的播放器：与浮层时代的引擎一致（同一元素按顺序换 src），只是不再藏起来。
                    <video ref={preview.attachVideo} onTimeUpdate={preview.step} className="h-full w-full object-contain" playsInline preload="metadata" data-editor-preview />
                ) : (
                    <div className="flex flex-col items-center gap-1 px-6 text-center">
                        <span className="text-[12px]" style={{ color: theme.node.muted }}>
                            {t("editor.noClips")}
                        </span>
                        <span className="text-[11px] leading-5" style={{ color: theme.node.faint }}>
                            {t("editor.noClipsHint")}
                        </span>
                    </div>
                )}
            </div>

            <div className="flex min-w-0 items-center gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !p-0" disabled={!hasClips} icon={preview.playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />} aria-label={preview.playing ? t("editor.pause") : t("editor.play")} onClick={preview.toggle} />
                <span className="shrink-0 tabular-nums">
                    <span ref={preview.timeRef} />
                    <span style={{ color: theme.node.faint }}> / {formatTimelineTime(totalSeconds)}</span>
                </span>
                <Tooltip title={t("editor.previewHintDetail")}>
                    <span className="ml-auto inline-flex shrink-0 cursor-help items-center gap-1 text-[11px]" style={{ color: theme.node.faint }}>
                        <Info className="size-3" />
                        {t("editor.previewHint")}
                    </span>
                </Tooltip>
            </div>
        </section>
    );
}
