import { useMemo } from "react";
import { Input } from "antd";
import { useTranslation } from "react-i18next";

import { extractPromptVariables } from "./prompt-variables";

// 提示词变量的填写区：提示词库弹窗与详情弹窗共用，保证两处填值体验一致。
export function PromptVariableFields({ template, values, onChange }: { template: string; values: Record<string, string>; onChange: (values: Record<string, string>) => void }) {
    const { t } = useTranslation();
    const variables = useMemo(() => extractPromptVariables(template), [template]);

    return (
        <div className="thin-scrollbar max-h-[56dvh] overflow-y-auto pr-1" data-canvas-no-zoom>
            {variables.map((name) => (
                <div key={name} className="mb-3 last:mb-0">
                    <div className="mb-1 text-xs font-medium">{name}</div>
                    <Input value={values[name] || ""} placeholder={t("prompts.variablePlaceholder", { name })} onChange={(event) => onChange({ ...values, [name]: event.target.value })} />
                </div>
            ))}
            <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{t("prompts.variableHint")}</p>
        </div>
    );
}
