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
    /** 上次因为「没进入生成流程」（例如没配模型）提前停下。 */
    skipped?: boolean;
    onRun: () => void;
    onStop: () => void;
    onRetryFailed: () => void;
};

/** 缺图队列入口：扁平无底色无阴影，进度直接写在按钮上。 */
export function CanvasMissingImageQueueButton({ missingCount, total, done, failedCount, running, skipped, onRun, onStop, onRetryFailed }: Props) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const idle = !running && !missingCount;
    // 提前停下时保留上次的 已完成/总数，不然进度会因为按钮回到待机文案而消失。
    const stoppedEarly = !running && Boolean(skipped) && total > done;
    const label = running ? t("canvas.missingQueue.progress", { done, total }) : stoppedEarly ? t("canvas.missingQueue.stopped", { done, total }) : t("canvas.missingQueue.run", { count: missingCount });
    const hint = running ? t("canvas.missingQueue.stopHint") : stoppedEarly ? t("canvas.missingQueue.skippedHint") : t("canvas.missingQueue.runHint");

    return (
        <span className="flex items-center gap-0.5">
            <Tooltip title={hint} placement="bottom">
                <button
                    type="button"
                    className="flex h-7 items-center gap-1.5 rounded-[9px] px-2 text-xs transition-colors duration-150 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-35 dark:hover:bg-white/10"
                    style={{ color: theme.node.text }}
                    disabled={idle}
                    onClick={running ? onStop : onRun}
                    aria-label={label}
                >
                    {running ? <LoaderCircle className="size-3.5 animate-spin" /> : <Images className="size-3.5" />}
                    <span className="tabular-nums">{label}</span>
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
