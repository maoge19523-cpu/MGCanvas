import { demosForScope } from "./demo-workflows";
import { deleteComfyWorkflowDefinition, listComfyWorkflowDefinitions, saveComfyWorkflowDefinition } from "./workflow-library";
import { importComfyWorkflowPack, parseComfyWorkflowPack } from "./workflow-pack";

/** 历史版本内置示例的名称：需要就地升级为当前随包分发的版本。 */
const LEGACY_DEMO_NAMES = ["示例：基础文生图"];

/**
 * 就地升级历史内置示例。
 *
 * 复用旧条目 ID 覆盖为当前示例，画布上已经引用该工作流的节点会同时生效，
 * 避免用户点到引用旧模型（本机不存在）的示例后运行失败。
 * 返回升级的条目数，0 表示无需处理。
 */
export async function upgradeLegacyDemoWorkflows(scope: "local" | "cloud", environmentId: string) {
    const legacy = (await listComfyWorkflowDefinitions()).find((item) => LEGACY_DEMO_NAMES.includes(item.name));
    if (!legacy) return 0;

    const demo = demosForScope(scope)[0];
    if (!demo) return 0;

    const response = await fetch(`/workflows/${demo.file}`);
    if (!response.ok) return 0;
    const entries = parseComfyWorkflowPack((await response.json()) as unknown);
    if (entries.length === 1 && !entries[0].name) entries[0].name = demo.name;

    const result = await importComfyWorkflowPack(environmentId, entries);
    const created = result.imported[0];
    if (!created) return 0;

    // 用新内容覆盖旧条目（保留旧 ID），再删掉临时创建的那一份。
    await saveComfyWorkflowDefinition({ ...created, id: legacy.id });
    await deleteComfyWorkflowDefinition(created.id);
    return 1;
}
