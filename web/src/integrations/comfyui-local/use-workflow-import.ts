import { useCallback, useRef, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { comfyNativeClient } from "./index";
import { comfyWorkflowPackName, importComfyWorkflowPack, parseComfyWorkflowPack, type ComfyWorkflowPackEntry } from "./workflow-pack";
import { listComfyWorkflowDefinitions } from "./workflow-library";

/** 云端环境没有本地 profile，统一用固定标识绑定工作流。 */
export const CLOUD_ENVIRONMENT_ID = "cloud-remote";

export type ComfyWorkflowImportTarget = {
    /** 本地环境 ID；为空时视为尚未准备环境。 */
    localEnvironmentId?: string | null;
    /** 导入成功后刷新列表。 */
    onImported?: () => void | Promise<void>;
};

/**
 * 共用的工作流导入能力：批量导入 JSON 与安装内置示例工作流。
 * 已连接云端时自动使用云端环境标识，无需本地 profile。
 */
export function useComfyWorkflowImport({ localEnvironmentId, onImported }: ComfyWorkflowImportTarget = {}) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const packInputRef = useRef<HTMLInputElement | null>(null);
    const [importing, setImporting] = useState(false);

    /** 解析当前可用的导入环境；返回空字符串表示还没准备环境。 */
    const resolveEnvironmentId = useCallback(async () => {
        if (localEnvironmentId) return localEnvironmentId;
        try {
            const status = await comfyNativeClient.status();
            return status.remoteBaseUrl ? CLOUD_ENVIRONMENT_ID : "";
        } catch {
            return "";
        }
    }, [localEnvironmentId]);

    const openPicker = useCallback(() => packInputRef.current?.click(), []);

    const finish = useCallback(
        async (imported: number, failed: { name: string; reason: string }[]) => {
            if (imported) message.success(t("comfyuiLocal.pack.imported", { count: imported }));
            for (const item of failed) message.warning(t("comfyuiLocal.pack.failed", { name: item.name, reason: item.reason }));
            if (imported) await onImported?.();
        },
        [message, onImported, t],
    );

    const importFiles = useCallback(
        async (files: FileList | null) => {
            if (!files?.length) return;
            const environmentId = await resolveEnvironmentId();
            if (!environmentId) {
                message.warning(t("comfyuiLocal.pack.needsEnvironment"));
                return;
            }
            setImporting(true);
            try {
                const entries: ComfyWorkflowPackEntry[] = [];
                for (const file of Array.from(files)) {
                    try {
                        const parsed = parseComfyWorkflowPack(JSON.parse(await file.text()) as unknown);
                        // 单文件仅含一个工作流时，用文件名作为工作流名称。
                        if (parsed.length === 1 && !parsed[0].name) parsed[0].name = comfyWorkflowPackName(file.name);
                        entries.push(...parsed);
                    } catch (error) {
                        message.error(`${file.name}：${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                if (!entries.length) return;
                const result = await importComfyWorkflowPack(environmentId, entries);
                await finish(result.imported.length, result.failed);
            } catch (error) {
                message.error(error instanceof Error ? error.message : String(error));
            } finally {
                setImporting(false);
                if (packInputRef.current) packInputRef.current.value = "";
            }
        },
        [finish, message, resolveEnvironmentId, t],
    );

    const installDemo = useCallback(async () => {
        const environmentId = await resolveEnvironmentId();
        if (!environmentId) {
            message.warning(t("comfyuiLocal.pack.needsEnvironment"));
            return;
        }
        setImporting(true);
        try {
            const response = await fetch("/workflows/demo-text-to-image.json");
            if (!response.ok) throw new Error(`读取示例工作流失败（HTTP ${response.status}）`);
            const parsed = parseComfyWorkflowPack((await response.json()) as unknown);
            if (parsed.length === 1 && !parsed[0].name) parsed[0].name = t("comfyuiLocal.pack.demoName");
            const result = await importComfyWorkflowPack(environmentId, parsed);
            if (result.imported.length) message.success(t("comfyuiLocal.pack.demoInstalled"));
            for (const item of result.failed) message.warning(t("comfyuiLocal.pack.failed", { name: item.name, reason: item.reason }));
            if (result.imported.length) await onImported?.();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setImporting(false);
        }
    }, [message, onImported, resolveEnvironmentId, t]);

    /** 加载工作流列表（供调用方同步 UI）。 */
    const reload = useCallback(async () => listComfyWorkflowDefinitions(), []);

    return { packInputRef, importing, openPicker, importFiles, installDemo, resolveEnvironmentId, reload };
}
