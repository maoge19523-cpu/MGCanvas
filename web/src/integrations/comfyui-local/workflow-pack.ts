import { nanoid } from "nanoid";

import { buildComfyWorkflowDefinition, comfyNativeClient, inspectComfyWorkflow, parseComfyApiWorkflow, type ComfyWorkflowDefinition } from "./index";
import { saveComfyWorkflowDefinition } from "./workflow-library";
import { defaultComfyPortIds, smartDefaultComfyInputIds } from "./workflow-selection";

/** 工作流包中的单个条目：name 可选，workflow 为 ComfyUI 的 API 格式 JSON。 */
export type ComfyWorkflowPackEntry = { name?: string; workflow: unknown };

export type ComfyWorkflowPackResult = {
    imported: ComfyWorkflowDefinition[];
    failed: { name: string; reason: string }[];
};

/**
 * 解析工作流包内容，兼容三种常见形态：
 * 1) 单个 ComfyUI API 工作流对象；
 * 2) 工作流数组 `[ {...}, {...} ]`；
 * 3) 带元信息的 `{ workflows: [ {...} ] }`。
 */
export function parseComfyWorkflowPack(raw: unknown): ComfyWorkflowPackEntry[] {
    if (Array.isArray(raw)) return raw.map((workflow) => ({ workflow }));
    if (raw && typeof raw === "object") {
        const record = raw as Record<string, unknown>;
        if (Array.isArray(record.workflows)) return record.workflows.map(readEntry);
        return [{ workflow: raw }];
    }
    throw new Error("工作流包不是有效的 JSON 内容");
}

function readEntry(item: unknown): ComfyWorkflowPackEntry {
    if (item && typeof item === "object" && "workflow" in (item as Record<string, unknown>)) {
        const record = item as { name?: unknown; workflow?: unknown };
        return { name: typeof record.name === "string" ? record.name : undefined, workflow: record.workflow };
    }
    return { workflow: item };
}

/** 从文件名推断工作流名称。 */
export function comfyWorkflowPackName(fileName: string) {
    return fileName.replace(/\.(json|mgpack)$/i, "");
}

/**
 * 批量导入工作流包：跳过逐步配置，直接按智能默认值落库，适合「一键导入」场景。
 * 单个工作流失败不影响其余条目，最终返回成功与失败明细。
 */
export async function importComfyWorkflowPack(environmentId: string, entries: ComfyWorkflowPackEntry[]): Promise<ComfyWorkflowPackResult> {
    const objectInfo = await comfyNativeClient.objectInfo();
    const imported: ComfyWorkflowDefinition[] = [];
    const failed: { name: string; reason: string }[] = [];

    for (const [index, entry] of entries.entries()) {
        const label = entry.name?.trim() || `工作流 ${index + 1}`;
        try {
            const workflow = parseComfyApiWorkflow(entry.workflow);
            const inspection = inspectComfyWorkflow(workflow, objectInfo);
            // 只保留可视媒体输出：SaveImage 之类的节点还会暴露 image_urls 等 json 输出，
            // 对普通用户没有意义，批量导入时直接跳过。
            const outputs = inspection.outputs.filter(
                (output) => output.exposable && output.outputNode && output.resourceType !== "json" && output.resourceType !== "text",
            );
            if (!outputs.length) throw new Error("没有可作为输出的节点");
            const outputIds = outputs.map((output) => output.id);
            const inputIds = new Set(smartDefaultComfyInputIds(inspection.inputs));
            const portIds = new Set(defaultComfyPortIds(inspection.inputs, outputIds));
            const definition = buildComfyWorkflowDefinition({
                id: nanoid(),
                name: label,
                description: "",
                environmentId,
                inspection,
                inputs: inspection.inputs.filter((input) => inputIds.has(input.id)).map((source) => ({ source, label: source.label, canvasPort: false })),
                outputs: outputs.map((source) => ({ source, label: source.outputName, canvasPort: portIds.has(source.id), preview: true })),
            });
            await saveComfyWorkflowDefinition(definition);
            imported.push(definition);
        } catch (error) {
            failed.push({ name: label, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    return { imported, failed };
}
