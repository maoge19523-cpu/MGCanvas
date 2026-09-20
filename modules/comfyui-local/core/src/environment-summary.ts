import type {
  ComfyEnvironmentLogEntry,
  ComfyEnvironmentStatus,
  ComfyObjectInfo,
} from "../../contracts/src/index.js";

export type ComfyDeviceSummary = {
  name: string;
  vramTotalGb: number;
  vramFreeGb: number;
};

export type ComfyModelCount = {
  /** i18n 后缀，例如 checkpoints / loras。 */
  key: string;
  count: number;
};

/** 本机模型清单只统计 ComfyUI 自己声明的槽位，避免扫描磁盘造成不一致。 */
const MODEL_SLOTS: Array<{ key: string; classType: string; field: string }> = [
  { key: "checkpoints", classType: "CheckpointLoaderSimple", field: "ckpt_name" },
  { key: "diffusion", classType: "UNETLoader", field: "unet_name" },
  { key: "textEncoders", classType: "CLIPLoader", field: "clip_name" },
  { key: "vaes", classType: "VAELoader", field: "vae_name" },
  { key: "loras", classType: "LoraLoader", field: "lora_name" },
];

/**
 * 从 `/object_info` 统计本机已装模型数量。
 *
 * ComfyUI 会把每个模型槽位的可选值列成文件清单，因此不需要读取磁盘，
 * 也不会和 ComfyUI 自己的认知出现偏差。清单为空的槽位按 0 计。
 */
export function summarizeComfyModelCounts(objectInfo: ComfyObjectInfo): ComfyModelCount[] {
  return MODEL_SLOTS.map(({ key, classType, field }) => {
    const declared = objectInfo[classType]?.input?.required?.[field]?.[0];
    return { key, count: Array.isArray(declared) ? declared.length : 0 };
  });
}

/**
 * 从 `/system_stats` 取第一块计算设备。
 *
 * ComfyUI 的 `name` 形如 `cuda:0 NVIDIA GeForce RTX 4070 : cudaMallocAsync`，
 * 直接展示会很长，这里去掉设备前缀与后端后缀，只留下用户认得的显卡型号。
 */
export function summarizeComfyDevice(stats: Record<string, unknown> | null | undefined): ComfyDeviceSummary | null {
  const devices = stats?.devices;
  if (!Array.isArray(devices) || !devices.length) return null;
  const device = devices[0] as Record<string, unknown>;
  const total = typeof device.vram_total === "number" ? device.vram_total : 0;
  if (!total) return null;
  return {
    name: cleanDeviceName(typeof device.name === "string" ? device.name : ""),
    vramTotalGb: bytesToGb(total),
    vramFreeGb: bytesToGb(typeof device.vram_free === "number" ? device.vram_free : total),
  };
}

function cleanDeviceName(name: string) {
  const withoutPrefix = name.replace(/^[a-z]+:\d+\s+/i, "");
  const [model] = withoutPrefix.split(" : ");
  return model.trim() || name.trim();
}

function bytesToGb(value: number) {
  return Math.round((value / 1024 ** 3) * 10) / 10;
}

export type ComfyStartupStage =
  | "checking"
  | "process"
  | "loading"
  | "endpoint"
  | "ready"
  | "failed";

/** 阶段说明文案的 i18n 后缀与进度百分比：让「转圈等着」变成「知道卡在哪一步」。 */
export const COMFY_STARTUP_STAGES: Array<{ stage: ComfyStartupStage; percent: number }> = [
  { stage: "checking", percent: 16 },
  { stage: "process", percent: 38 },
  { stage: "loading", percent: 68 },
  { stage: "endpoint", percent: 90 },
  { stage: "ready", percent: 100 },
  { stage: "failed", percent: 100 },
];

/** 日志里出现这些字样说明自定义节点与模型目录已经加载完，正在等网页端就绪。 */
const ENDPOINT_LOG = /to see the gui|starting server|prompt server|server started|listening on/i;
/** 启动耗时最长的一步，也是最容易被误认为卡死的一步。 */
const LOADING_LOG = /custom[ _-]?nodes?|loading model|checkpoint|diffusion model|text encoder|vae|lora|import times/i;

/**
 * 从启动日志推断当前阶段。
 *
 * 日志是唯一能反映「卡在哪里」的信号：进程活着不代表能连上，
 * 自定义节点加载又往往占掉大部分时间。推断不出来时保留更靠前的阶段，
 * 不会凭空跳到 endpoint 让用户以为马上就好。
 */
export function inferComfyStartupStage(
  logs: ComfyEnvironmentLogEntry[],
  status: ComfyEnvironmentStatus,
): ComfyStartupStage {
  if (status.phase === "running") return "ready";
  if (status.phase === "failed") return "failed";
  let stage: ComfyStartupStage = status.pid ? "process" : "checking";
  for (const entry of logs) {
    const message = entry.message || "";
    if (ENDPOINT_LOG.test(message)) stage = "endpoint";
    else if (LOADING_LOG.test(message)) stage = "loading";
  }
  return stage;
}
