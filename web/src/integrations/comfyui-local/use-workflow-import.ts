import { useCallback, useRef, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { comfyNativeClient } from "./index";
import { comfyWorkflowPackName, importComfyWorkflowPack, parseComfyWorkflowPack, type ComfyWorkflowPackEntry } from "./workflow-pack";
import { demosForScope, type ComfyDemoWorkflow } from "./demo-workflows";
import { deleteComfyWorkflowDefinition, listComfyWorkflowDefinitions } from "./workflow-library";

/** 云端环境没有本地 profile，统一用固定标识绑定工作流。 */
export const CLOUD_ENVIRONMENT_ID = "cloud-remote";

export type ComfyWorkflowImportTarget = {
    /** 本地环境 ID；为空时视为尚未准备环境。 */
    localEnvironmentId?: string | null;
    /** 声明调用方所在场景：云端页面必须传 "cloud"，避免未连接时回退到本地环境。 */
    scope?: "local" | "cloud";
    /** 导入成功后刷新列表。 */
    onImported?: () => void | Promise<void>;
};

/**
 * 共用的工作流导入能力：批量导入 JSON 与安装内置示例工作流。
 * 已连接云端时自动使用云端环境标识，无需本地 profile。
 */
export function useComfyWorkflowImport({ localEnvironmentId, scope, onImported }: ComfyWorkflowImportTarget = {}) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const packInputRef = useRef<HTMLInputElement | null>(null);
    const [importing, setImporting] = useState(false);

    /** 解析当前可用的导入环境；返回空字符串表示还没准备环境。 */
    const resolveEnvironmentId = useCallback(async () => {
        if (localEnvironmentId) return localEnvironmentId;
        try {
            const status = await comfyNativeClient.status();
            if (status.remoteBaseUrl) return CLOUD_ENVIRONMENT_ID;
            // 云端场景下不能用本地环境顶替：否则云端页会装成本地示例。
            if (scope === "cloud") return "";
            // 本地环境：取当前保存的活动环境，首页没有页面上下文时也要能解析出来。
            const saved = await comfyNativeClient.savedEnvironments();
            return saved.activeProfileId || saved.profiles[0]?.id || "";
        } catch {
            return "";
        }
    }, [localEnvironmentId, scope]);

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

    /** 安装指定的示例工作流；成功时返回导入的定义，便于调用方直接打开画布。 */
    const installDemo = useCallback(
        async (demo?: ComfyDemoWorkflow) => {
            const environmentId = await resolveEnvironmentId();
            if (!environmentId) {
                // 云端未连接时明确提示填地址，而不是沿用本地环境的「尚未启动」。
                message.warning(t(scope === "cloud" ? "comfyuiCloud.needEndpoint" : "comfyuiLocal.pack.needsEnvironment"));
                return null;
            }
            // 按当前环境挑选示例：本地一个通用示例，云端按用途分类。
            const resolvedScope = scope ?? (environmentId === CLOUD_ENVIRONMENT_ID ? "cloud" : "local");
            const target = demo ?? demosForScope(resolvedScope)[0];
            if (!target) {
                message.warning(t("comfyuiLocal.pack.noDemo"));
                return null;
            }
            setImporting(true);
            try {
                // 先清掉同名与历史版本的示例，避免列表里同时存在新旧示例、
                // 用户点到引用旧模型的那一份而报错。
                const stale = (await listComfyWorkflowDefinitions()).filter(
                    (item) => item.name === target.name || item.name === t("comfyuiLocal.pack.demoName"),
                );
                for (const item of stale) await deleteComfyWorkflowDefinition(item.id);
                const response = await fetch(`/workflows/${target.file}`);
                if (!response.ok) throw new Error(`读取示例工作流失败（HTTP ${response.status}）`);
                const parsed = parseComfyWorkflowPack((await response.json()) as unknown);
                if (parsed.length === 1 && !parsed[0].name) parsed[0].name = target.name;
                const result = await importComfyWorkflowPack(environmentId, parsed);
                if (result.imported.length) message.success(t("comfyuiLocal.pack.demoInstalled"));
                for (const item of result.failed) message.warning(t("comfyuiLocal.pack.failed", { name: item.name, reason: item.reason }));
                if (result.imported.length) await onImported?.();
                return result.imported[0] ?? null;
            } catch (error) {
                message.error(error instanceof Error ? error.message : String(error));
                return null;
            } finally {
                setImporting(false);
            }
        },
        [message, onImported, resolveEnvironmentId, t],
    );

    /** 加载工作流列表（供调用方同步 UI）。 */
    const reload = useCallback(async () => listComfyWorkflowDefinitions(), []);

    /** 当前环境下可用的示例清单（供 UI 决定按钮或列表）。 */
    const availableDemos = useCallback(async () => {
        const environmentId = await resolveEnvironmentId();
        if (!environmentId) return [];
        return demosForScope(scope ?? (environmentId === CLOUD_ENVIRONMENT_ID ? "cloud" : "local"));
    }, [resolveEnvironmentId, scope]);

    return { packInputRef, importing, openPicker, importFiles, installDemo, availableDemos, resolveEnvironmentId, reload };
}
