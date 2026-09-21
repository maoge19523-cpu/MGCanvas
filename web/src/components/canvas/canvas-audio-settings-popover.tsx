import { useEffect, useRef, useState, type RefObject } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel } from "@/lib/audio-generation";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeAnchoredPopup } from "./canvas-node-popup";

export type CanvasAudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

/** 把面板里选中的音频设置翻译成节点元数据补丁，画布里几处音频入口共用。 */
export function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasAudioSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft" }: CanvasAudioSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel = <AudioSettingsPortal open={open} buttonRef={buttonRef} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} />;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button
                    size="small"
                    type="text"
                    className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"}
                    style={{ background: theme.node.fill, color: theme.node.text }}
                    icon={<Settings2 className="size-3.5" />}
                    onClick={() => setOpen((current) => !current)}
                >
                    <span className="truncate">
                        {audioVoiceLabel(config.audioVoice)} · {audioFormatLabel(config.audioFormat)} · {audioSpeedLabel(config.audioSpeed)}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function AudioSettingsPortal({
    open,
    buttonRef,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
}: {
    open: boolean;
    buttonRef: RefObject<HTMLSpanElement | null>;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasAudioSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
}) {
    return (
        <CanvasNodeAnchoredPopup
            open={open}
            anchorRef={buttonRef}
            panelRef={panelRef}
            placement={placement}
            // 音频面板内容高、会被节点上方的悬浮工具条压住，直接挂到 body 层用固定定位。
            fixed
            className="canvas-image-settings-popover"
            style={{
                background: theme.toolbar.panel,
                borderRadius: 18,
                boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
                padding: 18,
                overflowY: "auto",
                color: theme.node.text,
            }}
        >
            <AudioSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
        </CanvasNodeAnchoredPopup>
    );
}
