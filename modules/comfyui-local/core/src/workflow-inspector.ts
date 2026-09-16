import { resolveComfyFieldLabel } from "./workflow-field-labels";
import type {
  ComfyApiLink,
  ComfyApiNode,
  ComfyApiWorkflow,
  ComfyInputOptions,
  ComfyInputSpec,
  ComfyInputValueType,
  ComfyInspectedInput,
  ComfyInspectedNode,
  ComfyInspectedOutput,
  ComfyObjectInfo,
  ComfyObjectInfoNode,
  ComfyOutputResourceType,
  ComfyWorkflowInspection,
} from "../../contracts/src/index.js";

export type ComfyWorkflowParseErrorCode =
  | "invalid-json-root"
  | "empty-workflow"
  | "ui-workflow-not-supported"
  | "invalid-api-node";

export class ComfyWorkflowParseError extends Error {
  constructor(
    public readonly code: ComfyWorkflowParseErrorCode,
    message: string,
    public readonly nodeId?: string,
  ) {
    super(message);
    this.name = "ComfyWorkflowParseError";
  }
}

export function parseComfyApiWorkflow(value: unknown): ComfyApiWorkflow {
  if (!isRecord(value))
    throw new ComfyWorkflowParseError(
      "invalid-json-root",
      "工作流 JSON 顶层必须是对象",
    );
  if (Array.isArray(value.nodes) || Array.isArray(value.links)) {
    throw new ComfyWorkflowParseError(
      "ui-workflow-not-supported",
      "当前文件是 ComfyUI UI 工作流，请使用 Save (API Format) 重新导出",
    );
  }
  const entries = Object.entries(value);
  if (!entries.length)
    throw new ComfyWorkflowParseError("empty-workflow", "API 工作流中没有节点");

  const workflow: ComfyApiWorkflow = {};
  for (const [nodeId, rawNode] of entries) {
    if (
      !isRecord(rawNode) ||
      typeof rawNode.class_type !== "string" ||
      !rawNode.class_type.trim() ||
      !isRecord(rawNode.inputs)
    ) {
      throw new ComfyWorkflowParseError(
        "invalid-api-node",
        `节点 ${nodeId} 缺少 class_type 或 inputs`,
        nodeId,
      );
    }
    const meta = isRecord(rawNode._meta)
      ? {
          ...rawNode._meta,
          title:
            typeof rawNode._meta.title === "string"
              ? rawNode._meta.title
              : undefined,
        }
      : undefined;
    workflow[String(nodeId)] = {
      class_type: rawNode.class_type.trim(),
      inputs: { ...rawNode.inputs },
      ...(meta ? { _meta: meta } : {}),
    };
  }
  return workflow;
}

export function inspectComfyWorkflow(
  workflow: ComfyApiWorkflow,
  objectInfo: ComfyObjectInfo,
): ComfyWorkflowInspection {
  const nodeIds = new Set(Object.keys(workflow));
  // 先解析提示词方向，让文本编码器参数直接显示为「正向/负向提示词」。
  const promptRoles = resolvePromptRoles(workflow);
  const nodes = Object.entries(workflow)
    .sort(([left], [right]) => compareNodeIds(left, right))
    .map(([nodeId, node]) =>
      inspectNode(nodeId, node, objectInfo[node.class_type], nodeIds, promptRoles),
    );
  const missingClassTypes = [
    ...new Set(
      nodes.filter((node) => node.missing).map((node) => node.classType),
    ),
  ].sort();
  return {
    workflow,
    nodes,
    inputs: nodes.flatMap((node) => node.inputs).sort((left, right) => promptRank(left) - promptRank(right)),
    outputs: nodes.flatMap((node) => node.outputs),
    missingClassTypes,
    runnable: missingClassTypes.length === 0,
  };
}

export function isComfyApiLink(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): value is ComfyApiLink {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === "string" || typeof value[0] === "number") &&
    Number.isInteger(value[1]) &&
    nodeIds.has(String(value[0]))
  );
}

function inspectNode(
  nodeId: string,
  node: ComfyApiNode,
  info: ComfyObjectInfoNode | undefined,
  nodeIds: ReadonlySet<string>,
  promptRoles: ReadonlyMap<string, "positive" | "negative">,
): ComfyInspectedNode {
  const title =
    node._meta?.title || info?.display_name || info?.name || node.class_type;
  return {
    nodeId,
    classType: node.class_type,
    title,
    category: info?.category,
    pythonModule: info?.python_module,
    missing: !info,
    inputs: inspectInputs(nodeId, node, title, info, nodeIds, promptRoles.get(nodeId)),
    outputs: inspectOutputs(nodeId, node, title, info),
  };
}

/** 分析采样器的 positive / negative 连接，判断文本编码器的提示词方向。 */
function resolvePromptRoles(workflow: ComfyApiWorkflow) {
  const roles = new Map<string, "positive" | "negative">();
  for (const node of Object.values(workflow)) {
    const inputs = node?.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const [key, value] of Object.entries(inputs)) {
      if (key !== "positive" && key !== "negative") continue;
      if (!Array.isArray(value) || !value.length) continue;
      const sourceId = String(value[0]);
      if (!roles.has(sourceId)) {
        roles.set(sourceId, key === "positive" ? "positive" : "negative");
      }
    }
  }
  return roles;
}
function inspectInputs(nodeId: string,
  node: ComfyApiNode,
  nodeTitle: string,
  info: ComfyObjectInfoNode | undefined,
  nodeIds: ReadonlySet<string>,
  promptRole?: "positive" | "negative",) {
  const specs = inputSpecs(info);
  const orderedFields = orderedInputFields(node, info);
  return orderedFields.map((field): ComfyInspectedInput => {
    const currentValue = node.inputs[field];
    const spec = specs.get(field);
    const internalLink = isComfyApiLink(currentValue, nodeIds);
    const valueType = inferInputValueType(
      node.class_type,
      field,
      spec?.spec,
      currentValue,
    );
    const options = spec?.spec?.[1] || {};
    const exposable = !internalLink;
    return {
      id: `${nodeId}:${field}`,
      nodeId,
      classType: node.class_type,
      nodeTitle,
      field,
      // 优先给中文标签：英文原始字段名对普通用户不可读。
      label: resolveComfyFieldLabel(node.class_type, field, promptRole, nodeTitle),
      section: spec?.section || "unknown",
      currentValue,
      valueType,
      internalLink,
      exposable,
      recommended:
        exposable &&
        isRecommendedCanvasInput(node.class_type, field, valueType, options),
      options,
      enumValues: resolveEnumValues(node.class_type, field, spec),
    };
  });
}

/** 参数占位节点：值由用户在画布上填写。 */
const PARAMETER_HOLDER_CLASSES = new Set(["PrimitiveFloat", "PrimitiveInt", "PrimitiveNumber", "PrimitiveString", "PrimitiveStringMultiline", "Float", "Int"]);

/**
 * 真正落盘的输出节点。
 * 一些调试 / 可视化节点（例如采样曲线图 SigmasGraph）也会被标记为输出节点，
 * 但它们不是用户想要的结果，存在落盘节点时应忽略它们。
 */
const SAVE_OUTPUT_CLASSES = new Set([
  "SaveImage",
  "SaveAnimatedWEBP",
  "SaveAnimatedPNG",
  "SaveVideo",
  "SaveWEBM",
  "SaveAudio",
  "SaveAudioMP3",
  "SaveAudioOpus",
  "VHS_VideoCombine",
  "VHS_SaveVideo",
  "PreviewImage",
]);

/**
 * 挑选作为画布结果节点的输出：优先真正的落盘节点，
 * 没有落盘节点时才退回到其余输出。
 */
export function selectComfyResultOutputs(outputs: ComfyInspectedOutput[]) {
  const usable = outputs.filter(
    (output) =>
      output.exposable &&
      output.outputNode &&
      output.resourceType !== "json" &&
      output.resourceType !== "text",
  );
  const saved = usable.filter((output) => SAVE_OUTPUT_CLASSES.has(output.classType));
  return saved.length ? saved : usable;
}

/** 画面比例只保留竖屏与宽屏两档，避免新手在 8 个比例里挑花眼。 */
const ASPECT_RATIO_OPTIONS = ["9:16 (Portrait Widescreen)", "16:9 (Widescreen)"];

/** 分辨率选择器节点：其枚举值本身就是给用户挑的。 */
const RESOLUTION_SELECTOR_CLASSES = new Set(["TTResolutionSelector", "ResolutionSelector"]);

/**
 * 只暴露尺寸、数量与帧率这类「调了不会变差」的参数。
 * 采样步数 / 引导强度 / 重绘幅度等专业参数刻意不暴露，避免用户误调导致结果变差。
 */
const RECOMMENDED_NUMERIC_FIELDS = new Set([
  "width",
  "height",
  "batch_size",
  "length",
  "fps",
  // seed 需要保留在参数列表中，画布上才能绑定「每次生成随机结果」开关；
  // 随机模式下它的输入框会被隐藏，用户不会看到难懂的数字。
  "seed",
  "noise_seed",
]);

/** 画面比例只保留常用两档；其余枚举原样返回。 */
function resolveEnumValues(
  classType: string,
  field: string,
  spec: { spec?: unknown[] } | undefined,
) {
  const declared = (spec as { spec?: [unknown, unknown] } | undefined)?.spec?.[0];
  if (!Array.isArray(declared)) return undefined;
  if (classType === "ResolutionSelector" && field === "aspect_ratio") {
    return ASPECT_RATIO_OPTIONS.filter((option) => declared.includes(option));
  }
  return [...declared];
}

/** 提示词排序：正向在前、负向在最后，其余保持原顺序（Array.sort 稳定）。 */
function promptRank(input: ComfyInspectedInput) {
  if (input.label === "正向提示词") return 0;
  if (input.label === "负向提示词") return 2;
  return 1;
}

function isRecommendedCanvasInput(
  classType: string,
  field: string,
  valueType: ComfyInputValueType,
  options: ComfyInputOptions,
) {
  if (options.forceInput || options.defaultInput) return false;
  // 系统提示词属于技术字段，暴露出来只会和真正的「提示词」重复。
  if (field === "system_prompt") return false;
  if (valueType === "image" || valueType === "video" || valueType === "audio")
    return true;
  // 尺寸、生成数量等数值参数也要能被用户设置，否则示例工作流只能改提示词。
  if (RECOMMENDED_NUMERIC_FIELDS.has(field)) return true;
  // 分辨率选择器的比例 / 分辨率枚举：直接决定出图尺寸，必须可调。
  if (RESOLUTION_SELECTOR_CLASSES.has(classType) && (field === "resolution" || field === "aspect_ratio")) return true;
  // 参数占位节点的数值（例如 PrimitiveFloat 的时长）由运营方命名，应当可调。
  if (field === "value" && PARAMETER_HOLDER_CLASSES.has(classType)) return true;
  // 分辨率档位（百万像素）直接决定清晰度，必须可调。
  if (classType === "ResolutionSelector" && field === "megapixels") return true;
  if (valueType !== "string") return false;
  const signal =
    `${classType} ${field} ${typeof options.label === "string" ? options.label : ""}`.toLowerCase();
  return (
    /(^|[^a-z])(prompt|text|positive|negative|caption|instruction|description|query|lyrics)([^a-z]|$)/.test(
      signal,
    ) || signal.includes("textencode")
  );
}

function inspectOutputs(
  nodeId: string,
  node: ComfyApiNode,
  nodeTitle: string,
  info: ComfyObjectInfoNode | undefined,
): ComfyInspectedOutput[] {
  const outputTypes = Array.isArray(info?.output) ? info.output : [];
  const outputNames = Array.isArray(info?.output_name) ? info.output_name : [];
  const outputNode = Boolean(info?.output_node);

  if (!outputTypes.length && outputNode) {
    const resourceType = inferOutputNodeResource(node.class_type);
    return [
      {
        id: `${nodeId}:result`,
        nodeId,
        classType: node.class_type,
        nodeTitle,
        outputName: "result",
        resourceType,
        outputNode: true,
        exposable: resourceType !== "json",
      },
    ];
  }

  return outputTypes.map((comfyType, outputIndex) => {
    const resourceType = mapOutputResourceType(comfyType, node.class_type);
    return {
      id: `${nodeId}:${outputIndex}`,
      nodeId,
      classType: node.class_type,
      nodeTitle,
      outputIndex,
      outputName:
        outputNames[outputIndex] || comfyType || `output_${outputIndex + 1}`,
      comfyType,
      resourceType,
      outputNode,
      exposable: isSerializableOutput(resourceType, comfyType),
    };
  });
}

function inputSpecs(info: ComfyObjectInfoNode | undefined) {
  const result = new Map<
    string,
    { section: "required" | "optional"; spec: ComfyInputSpec }
  >();
  for (const section of ["required", "optional"] as const) {
    const values = info?.input?.[section];
    if (!values) continue;
    for (const [field, spec] of Object.entries(values)) {
      if (Array.isArray(spec)) result.set(field, { section, spec });
    }
  }
  return result;
}

function orderedInputFields(
  node: ComfyApiNode,
  info: ComfyObjectInfoNode | undefined,
) {
  const preferred = [
    ...(info?.input_order?.required || []),
    ...(info?.input_order?.optional || []),
    ...Object.keys(info?.input?.required || {}),
    ...Object.keys(info?.input?.optional || {}),
    ...Object.keys(node.inputs),
  ];
  return [...new Set(preferred)].filter((field) =>
    Object.hasOwn(node.inputs, field),
  );
}

function inferInputValueType(
  classType: string,
  field: string,
  spec: ComfyInputSpec | undefined,
  currentValue: unknown,
): ComfyInputValueType {
  const className = classType.toLowerCase();
  const fieldName = field.toLowerCase();
  if (looksLikeMediaLoader(className, fieldName, "image")) return "image";
  if (looksLikeMediaLoader(className, fieldName, "video")) return "video";
  if (looksLikeMediaLoader(className, fieldName, "audio")) return "audio";
  const declared = spec?.[0];
  if (Array.isArray(declared)) return "enum";
  switch (String(declared || "").toUpperCase()) {
    case "STRING":
      return "string";
    case "INT":
      return "integer";
    case "FLOAT":
      return "number";
    case "BOOLEAN":
      return "boolean";
    case "IMAGE":
      return "image";
    case "VIDEO":
      return "video";
    case "AUDIO":
      return "audio";
  }
  if (typeof currentValue === "string") return "string";
  if (typeof currentValue === "boolean") return "boolean";
  if (typeof currentValue === "number")
    return Number.isInteger(currentValue) ? "integer" : "number";
  return "json";
}

function looksLikeMediaLoader(
  className: string,
  fieldName: string,
  media: "image" | "video" | "audio",
) {
  return (
    className.includes(`load${media}`) &&
    (fieldName === media ||
      fieldName.includes(`${media}_file`) ||
      fieldName.includes(`${media}file`))
  );
}

function mapOutputResourceType(
  comfyType: string,
  classType?: string,
): ComfyOutputResourceType {
  const value = comfyType.toUpperCase();
  // VHS_VideoCombine 的输出类型名为 VHS_FILENAMES，但内容其实是视频文件；
  // 若不特判会被当成普通文件，前端拿不到可播放的视频地址。
  if (classType && /video|combine/i.test(classType) && value.includes("FILENAME"))
    return "video";
  if (value.includes("IMAGE")) return "image";
  if (value.includes("VIDEO") || value.includes("GIF")) return "video";
  if (value.includes("AUDIO")) return "audio";
  if (value === "STRING" || value === "TEXT") return "text";
  if (value.includes("FILE")) return "file";
  return "json";
}

function inferOutputNodeResource(classType: string): ComfyOutputResourceType {
  const value = classType.toLowerCase();
  if (value.includes("image")) return "image";
  if (
    value.includes("video") ||
    value.includes("gif") ||
    value.includes("webp")
  )
    return "video";
  if (value.includes("audio")) return "audio";
  if (value.includes("text") || value.includes("string")) return "text";
  if (value.includes("file")) return "file";
  return "json";
}

function isSerializableOutput(
  resourceType: ComfyOutputResourceType,
  comfyType: string,
) {
  if (resourceType !== "json") return true;
  const opaque = new Set([
    "MODEL",
    "LATENT",
    "CONDITIONING",
    "CLIP",
    "VAE",
    "CONTROL_NET",
    "SAMPLER",
    "SIGMAS",
  ]);
  return !opaque.has(comfyType.toUpperCase());
}

function compareNodeIds(left: string, right: string) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber))
    return leftNumber - rightNumber;
  return left.localeCompare(right);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
