import { useState } from "react";
import { Button } from "antd";
import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasPromptLibrary({ onSelect }: { onSelect: (prompt: string) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            {/* 生图时最常用的入口，必须和旁边的模型、画幅按钮一样一眼可见，只放一个图标会被当成装饰。 */}
            <Button
                type="text"
                className="!h-10 shrink-0 !rounded-full !px-3"
                style={{ color: theme.node.text }}
                icon={<BookOpen className="size-3.5" />}
                onClick={() => setOpen(true)}
                aria-label={t("navigation.prompts")}
            >
                {t("navigation.prompts")}
            </Button>
            <PromptSelectDialog open={open} onOpenChange={setOpen} onSelect={onSelect} />
        </>
    );
}
