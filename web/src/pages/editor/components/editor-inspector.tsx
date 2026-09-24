import { useTranslation } from "react-i18next";
import { Input, InputNumber, Select, Switch } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { COMPOSITE_TRANSITION_OPTIONS, type CompositePreviewClip } from "@/lib/canvas/composite-editing";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasCompositeSegmentSettings, CanvasCompositeSettings, CanvasNodeData } from "@/types/canvas";

type EditorInspectorProps = {
    clip: CompositePreviewClip | null;
    clipIndex: number;
    settings: CanvasCompositeSettings;
    voice: CanvasNodeData | null;
    music: CanvasNodeData | null;
    disabled: boolean;
    onUpdateSegment: (sourceNodeId: string, patch: Partial<CanvasCompositeSegmentSettings>) => void;
    onUpdateSettings: (patch: Partial<CanvasCompositeSettings>) => void;
};

function clampPercent(value: number | string | null | undefined, fallback: number) {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (parsed === null || parsed === undefined || Number.isNaN(parsed)) return fallback;
    return Math.min(400, Math.max(0, parsed));
}

function clamp(value: number | string | null | undefined, min: number, max: number, fallback: number) {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (parsed === null || parsed === undefined || !Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

/** 属性区：上面是选中片段的入出点/音量/淡入淡出/转场/字幕，下面是输出参数与两条音轨。 */
export function EditorInspector({ clip, clipIndex, settings, voice, music, disabled, onUpdateSegment, onUpdateSettings }: EditorInspectorProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const item = clip ? settings.segments?.[clip.id] || {} : {};
    const labelStyle = { color: theme.node.muted };
    const rowClass = "flex min-w-0 items-center gap-2 text-[11px]";
    const transitionOptions = COMPOSITE_TRANSITION_OPTIONS.map((option) => ({ value: option.value, label: t(`editor.transition${option.value.charAt(0).toUpperCase()}${option.value.slice(1)}`) }));

    return (
        <aside className="flex min-h-0 w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-l p-3 thin-scrollbar" style={{ borderColor: theme.toolbar.border }}>
            <span className="shrink-0 text-[12px] font-medium" style={{ color: theme.node.text }}>
                {t("editor.inspector")}
            </span>

            {clip ? (
                <div className="flex flex-col gap-2 border-b pb-3" style={{ borderColor: theme.toolbar.border }}>
                    <div className={rowClass}>
                        <span className="shrink-0" style={labelStyle}>
                            {t("editor.clipIndex", { index: clipIndex + 1 })}
                        </span>
                        <span className="min-w-0 flex-1 truncate" style={{ color: theme.node.text }} title={clip.title}>
                            {clip.title}
                        </span>
                    </div>
                    <div className={rowClass}>
                        <span className="w-10 shrink-0" style={labelStyle}>
                            {t("editor.start")}
                        </span>
                        <InputNumber size="small" min={0} max={clip.source || undefined} step={0.1} controls={false} className="!w-[92px]" value={typeof item.start === "number" && Number.isFinite(item.start) ? item.start : undefined} placeholder={clip.source ? "0.0" : "—"} disabled={disabled} onChange={(value) => onUpdateSegment(clip.id, { start: value === null || !Number.isFinite(Number(value)) ? undefined : Number(value) })} />
                        <span className="w-10 shrink-0" style={labelStyle}>
                            {t("editor.end")}
                        </span>
                        <InputNumber size="small" min={0} max={clip.source || undefined} step={0.1} controls={false} className="!w-[92px]" value={typeof item.end === "number" && Number.isFinite(item.end) ? item.end : undefined} placeholder={clip.source ? clip.source.toFixed(1) : "—"} disabled={disabled} onChange={(value) => onUpdateSegment(clip.id, { end: value === null || !Number.isFinite(Number(value)) ? undefined : Number(value) })} />
                    </div>
                    <div className={rowClass}>
                        <span className="w-10 shrink-0" style={labelStyle}>
                            {t("editor.volume")}
                        </span>
                        <InputNumber size="small" min={0} max={400} step={5} addonAfter="%" controls={false} className="!w-[104px]" value={Math.round((item.volume ?? 1) * 100)} disabled={disabled} onChange={(value) => onUpdateSegment(clip.id, { volume: clampPercent(value, 100) / 100 })} />
                        <span className="w-10 shrink-0" style={labelStyle}>
                            {t("editor.fadeIn")}
                        </span>
                        <InputNumber size="small" min={0} max={5} step={0.5} addonAfter="s" controls={false} className="!w-[92px]" value={item.fadeIn ?? 0} disabled={disabled} onChange={(value) => onUpdateSegment(clip.id, { fadeIn: !value ? undefined : clamp(value, 0, 5, 0) })} />
                    </div>
                    <div className={rowClass}>
                        <span className="w-10 shrink-0" style={labelStyle}>
                            {t("editor.fadeOut")}
                        </span>
                        <InputNumber size="small" min={0} max={10} step={0.5} addonAfter="s" controls={false} className="!w-[92px]" value={item.fadeOut ?? 0} disabled={disabled} onChange={(value) => onUpdateSegment(clip.id, { fadeOut: !value ? undefined : clamp(value, 0, 10, 0) })} />
                    </div>
                    <div className={rowClass}>
                        <span className="w-10 shrink-0" style={labelStyle}>
                            {t("editor.transition")}
                        </span>
                        <Select size="small" className="w-[104px]" value={item.transition ?? "none"} disabled={disabled} options={transitionOptions} onChange={(value) => onUpdateSegment(clip.id, { transition: value === "none" ? undefined : value })} />
                        {item.transition ? <InputNumber size="small" min={0.2} max={1.5} step={0.1} addonAfter="s" controls={false} className="!w-[88px]" value={item.transitionDuration ?? 0.5} disabled={disabled} onChange={(value) => onUpdateSegment(clip.id, { transitionDuration: clamp(value, 0.2, 1.5, 0.5) })} /> : null}
                    </div>
                    <Input size="small" placeholder={t("editor.subtitlePlaceholder")} value={item.subtitle ?? ""} disabled={disabled} onChange={(event) => onUpdateSegment(clip.id, { subtitle: event.target.value || undefined })} />
                </div>
            ) : (
                <div className="border-b pb-3 text-[11px] leading-5" style={{ borderColor: theme.toolbar.border, color: theme.node.faint }}>
                    {t("editor.noSelection")}
                </div>
            )}

            <div className="shrink-0 text-[11px] font-medium" style={{ color: theme.node.muted }}>
                {t("editor.output")}
            </div>
            <div className="text-[10px] leading-5" style={{ color: theme.node.faint }}>
                {t("editor.outputHint")}
            </div>
            <div className={rowClass}>
                <span className="w-14 shrink-0" style={labelStyle}>
                    {t("editor.longEdge")}
                </span>
                <Select
                    size="small"
                    className="w-[104px]"
                    value={settings.longEdge ?? 1080}
                    disabled={disabled}
                    options={[
                        { value: 1080, label: "1080P" },
                        { value: 720, label: "720P" },
                        { value: 480, label: "480P" },
                    ]}
                    onChange={(value) => onUpdateSettings({ longEdge: value })}
                />
                <Select
                    size="small"
                    className="w-[88px]"
                    value={settings.fps ?? 30}
                    disabled={disabled}
                    options={[
                        { value: 24, label: "24fps" },
                        { value: 25, label: "25fps" },
                        { value: 30, label: "30fps" },
                        { value: 50, label: "50fps" },
                        { value: 60, label: "60fps" },
                    ]}
                    onChange={(value) => onUpdateSettings({ fps: value })}
                />
            </div>
            <div className={rowClass}>
                <span className="w-14 shrink-0" style={labelStyle}>
                    {t("editor.outputFadeIn")}
                </span>
                <InputNumber size="small" min={0} max={5} step={0.5} addonAfter="s" controls={false} className="!w-[92px]" value={settings.fadeIn ?? 0.5} disabled={disabled} onChange={(value) => onUpdateSettings({ fadeIn: clamp(value, 0, 5, 0.5) })} />
                <InputNumber size="small" min={0} max={10} step={0.5} addonAfter="s" controls={false} className="!w-[92px]" value={settings.fadeOut ?? 0.5} disabled={disabled} onChange={(value) => onUpdateSettings({ fadeOut: clamp(value, 0, 10, 0.5) })} />
            </div>
            <div className={rowClass}>
                <span className="w-14 shrink-0" style={labelStyle}>
                    {t("editor.subtitleStyle")}
                </span>
                <Select
                    size="small"
                    className="w-[104px]"
                    value={settings.subtitleStyle ?? "bottom"}
                    disabled={disabled}
                    options={[
                        { value: "bottom", label: t("editor.subtitleBottom") },
                        { value: "center", label: t("editor.subtitleCenter") },
                    ]}
                    onChange={(value) => onUpdateSettings({ subtitleStyle: value })}
                />
                <Select
                    size="small"
                    className="w-[88px]"
                    value={settings.subtitleSize ?? "medium"}
                    disabled={disabled}
                    options={[
                        { value: "small", label: t("editor.sizeSmall") },
                        { value: "medium", label: t("editor.sizeMedium") },
                        { value: "large", label: t("editor.sizeLarge") },
                    ]}
                    onChange={(value) => onUpdateSettings({ subtitleSize: value })}
                />
            </div>

            {voice ? (
                <div className={rowClass}>
                    <span className="w-14 shrink-0 truncate" style={labelStyle}>
                        {t("editor.voiceTrack")}
                    </span>
                    <InputNumber size="small" min={0} max={400} step={5} addonAfter="%" controls={false} className="!w-[100px]" value={Math.round((settings.voiceVolume ?? 1) * 100)} disabled={disabled} onChange={(value) => onUpdateSettings({ voiceVolume: clampPercent(value, 100) / 100 })} />
                    <span style={labelStyle}>
                        {t("editor.loop")}
                        <Switch size="small" className="ml-1" checked={settings.voiceLoop ?? false} disabled={disabled} onChange={(checked) => onUpdateSettings({ voiceLoop: checked })} />
                    </span>
                    <InputNumber size="small" min={0} max={30} step={0.5} addonAfter="s" controls={false} className="!w-[88px]" value={settings.voiceFadeOut ?? 0} disabled={disabled} onChange={(value) => onUpdateSettings({ voiceFadeOut: clamp(value, 0, 30, 0) })} />
                </div>
            ) : null}
            {music ? (
                <div className={rowClass}>
                    <span className="w-14 shrink-0 truncate" style={labelStyle}>
                        {t("editor.musicTrack")}
                    </span>
                    <InputNumber size="small" min={0} max={400} step={5} addonAfter="%" controls={false} className="!w-[100px]" value={Math.round((settings.musicVolume ?? 1) * 100)} disabled={disabled} onChange={(value) => onUpdateSettings({ musicVolume: clampPercent(value, 100) / 100 })} />
                    <span style={labelStyle}>
                        {t("editor.loop")}
                        <Switch size="small" className="ml-1" checked={settings.musicLoop ?? false} disabled={disabled} onChange={(checked) => onUpdateSettings({ musicLoop: checked })} />
                    </span>
                    <InputNumber size="small" min={0} max={30} step={0.5} addonAfter="s" controls={false} className="!w-[88px]" value={settings.musicFadeOut ?? 1.5} disabled={disabled} onChange={(value) => onUpdateSettings({ musicFadeOut: clamp(value, 0, 30, 1.5) })} />
                </div>
            ) : null}
            {!voice && !music ? (
                <div className="text-[10px] leading-5" style={{ color: theme.node.faint }}>
                    {t("editor.trackEmpty")}
                </div>
            ) : null}
        </aside>
    );
}
