import type {
  ComfyApiWorkflow,
  ComfyWorkflowDefinition,
} from "../../contracts/src/index.js";

export function materializeComfyWorkflow(
  definition: ComfyWorkflowDefinition,
  values: Record<string, unknown>,
  connectedValues: Record<string, unknown> = {},
): ComfyApiWorkflow {
  const workflow = cloneJson(definition.apiWorkflow);
  // 随机种子模式（默认开启）：每次运行换一个新种子，用户不必理解 seed 的含义。
  const seedRandom = values.__seedRandom !== "0";
  for (const input of definition.inputs) {
    const node = workflow[input.nodeId];
    if (!node)
      throw new Error(
        `工作流输入 ${input.label} 对应的节点 #${input.nodeId} 不存在`,
      );
    const hasConnectedValue = Object.hasOwn(connectedValues, input.id);
    const hasEditedValue = Object.hasOwn(values, input.id);
    const value = hasConnectedValue
      ? connectedValues[input.id]
      : hasEditedValue
        ? values[input.id]
        : input.defaultValue;
    if (
      input.required &&
      (value === undefined || value === null || value === "")
    )
      throw new Error(`工作流输入 ${input.label} 不能为空`);
    const isSeedField = input.field === "seed" || input.field === "noise_seed";
    const resolved =
      seedRandom && isSeedField
        ? Math.floor(Math.random() * 1_000_000_000_000_000)
        : value;
    if (resolved !== undefined) node.inputs[input.field] = cloneJson(resolved);
  }
  stripEmptyReferenceInputs(workflow);
  return workflow;
}

/**
 * 参考音频 / 视频未选择时（LoadAudio 的取值为 "None"），把对应引用从工作流里去掉，
 * 否则空值会被传给采样节点，可能导致校验或运行失败。
 */
function stripEmptyReferenceInputs(workflow: ComfyApiWorkflow) {
  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    for (const key of Object.keys(inputs)) {
      if (!/^ref_(audios|videos|video_audios)\./.test(key)) continue;
      const link = inputs[key];
      const sourceId = Array.isArray(link) ? String(link[0]) : "";
      const source = sourceId ? workflow[sourceId] : undefined;
      const value = source?.inputs?.audio ?? source?.inputs?.file;
      if (source && (value === "None" || value === "" || value === undefined)) delete inputs[key];
    }
  }
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
