import { Images, LoaderCircle, RotateCcw, Square } from "lucide-react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type Props = {
    missingCount: number;
    total: number;
    done: number;
    failedCount: number;
    running: boolean;
    onRun: () => void;
    onStop: () => void;
    onRetryFailed: () => void;
};

/** 缺图队列入口：扁平无底色无阴影，进度直接写在按钮上。 */
export function CanvasMissingImageQueueButton({ missingCount, total, done, failedCount, running, onRun, onStop, onRetryFailed }: Props) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const idle = !running && !missingCount;

    return (
        <span className="flex items-center gap-0.5">
            <Tooltip title={running ? t("canvas.missingQueue.stopHint") : t("canvas.missingQueue.runHint")} placement="bottom">
                <button
                    type="button"
                    className="flex h-7 items-center gap-1.5 rounded-[9px] px-2 text-xs transition-colors duration-150 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-35 dark:hover:bg-white/10"
                    style={{ color: theme.node.text }}
                    disabled={idle}
                    onClick={running ? onStop : onRun}
                    aria-label={running ? t("canvas.missingQueue.progress", { done, total }) : t("canvas.missingQueue.run", { count: missingCount })}
                >
                    {running ? <LoaderCircle className="size-3.5 animate-spin" /> : <Images className="size-3.5" />}
                    <span className="tabular-nums">{running ? t("canvas.missingQueue.progress", { done, total }) : t("canvas.missingQueue.run", { count: missingCount })}</span>
                    {running ? <Square className="size-2.5 fill-current" /> : null}
                </button>
            </Tooltip>
            {!running && failedCount ? (
                <Tooltip title={t("canvas.missingQueue.retryHint")} placement="bottom">
                    <button
                        type="button"
                        className="flex h-7 items-center gap-1 rounded-[9px] px-2 text-xs transition-colors duration-150 hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ color: theme.node.muted }}
                        onClick={onRetryFailed}
                        aria-label={t("canvas.missingQueue.retryFailed", { count: failedCount })}
                    >
                        <RotateCcw className="size-3.5" />
                        <span className="tabular-nums">{t("canvas.missingQueue.retryFailed", { count: failedCount })}</span>
                    </button>
                </Tooltip>
            ) : null}
        </span>
    );
}
