/**
 * ComfyUI 字段名 → 中文标签映射。
 *
 * ComfyUI 工作流的参数名来自节点定义，多为英文（text / seed / cfg…），
 * 对不熟悉英文的用户不友好。这里按字段名给出中文标签，
 * 让画布上的「工作流参数」面板直接可读。
 */

/** 常见字段名的中文标签；未收录的字段回退为原名。 */
const FIELD_LABELS: Record<string, string> = {
  // 文本与提示词
  text: "提示词",
  prompt: "提示词",
  positive: "正向提示词",
  negative: "负向提示词",
  caption: "描述文字",
  instruction: "指令",
  description: "描述",
  lyrics: "歌词",
  query: "问题",

  // 采样相关
  seed: "随机种子",
  noise_seed: "随机种子",
  steps: "采样步数",
  cfg: "提示词引导强度",
  denoise: "重绘幅度",
  sampler_name: "采样器",
  scheduler: "调度器",
  start_at_step: "起始步数",
  end_at_step: "结束步数",
  add_noise: "添加噪声",
  return_with_leftover_noise: "保留剩余噪声",

  // 尺寸与数量
  width: "宽度",
  height: "高度",
  batch_size: "生成数量",
  length: "帧数",
  fps: "帧率",

  // 模型
  ckpt_name: "模型",
  unet_name: "模型",
  vae_name: "VAE 模型",
  clip_name: "文本编码器",
  lora_name: "LoRA 模型",
  control_net_name: "ControlNet 模型",
  strength: "权重",
  strength_model: "模型权重",
  strength_clip: "文本编码器权重",
  strength_type: "权重类型",
  model: "模型",
  clip: "文本编码器",
  vae: "VAE",

  // 素材
  image: "图片",
  images: "图片",
  video: "视频",
  audio: "音频",
  mask: "蒙版",
  latents: "潜空间数据",
  samples: "采样结果",
  pixels: "像素数据",

  // 输出
  filename_prefix: "文件名前缀",
  output_path: "输出路径",
  format: "格式",
  quality: "质量",

  // 通用
  value: "数值",
  enabled: "启用",
  scale: "缩放",
  upscale_method: "放大算法",
  crop: "裁剪",
  resize: "调整尺寸",
  interpolation: "插值方式",
  threshold: "阈值",
  temperature: "温度",
  max_tokens: "最大长度",
};

/** 节点类型 + 字段名的组合特例，优先级高于字段名映射。 */
const CLASS_FIELD_LABELS: Record<string, string> = {
  "KSampler.seed": "随机种子",
  "KSampler.steps": "采样步数",
  "KSampler.cfg": "提示词引导强度",
  "KSampler.denoise": "重绘幅度",
  "KSampler.sampler_name": "采样器",
  "KSampler.scheduler": "调度器",
  "EmptyLatentImage.width": "宽度",
  "EmptyLatentImage.height": "高度",
  "EmptyLatentImage.batch_size": "生成数量",
  "CheckpointLoaderSimple.ckpt_name": "模型",
  "CLIPTextEncode.text": "提示词",
  "SaveImage.filename_prefix": "文件名前缀",
  "TTResolutionSelector.resolution": "分辨率",
  "ResolutionSelector.aspect_ratio": "画面比例",
  "ResolutionSelector.megapixels": "分辨率档位",
};

/**
 * 解析字段的中文标签。
 *
 * @param classType ComfyUI 节点类型，例如 `KSampler`
 * @param field 字段名，例如 `cfg`
 * @param promptRole 该节点被采样器引用为正向 / 负向提示词时传入
 */
export function resolveComfyFieldLabel(
  classType: string,
  field: string,
  promptRole?: "positive" | "negative",
  nodeTitle?: string,
) {
  // value 这类字段本身没有语义（PrimitiveFloat 等参数节点），
  // 直接用节点标题，运营方在工作流里把标题写成中文即可。
  if (field === "value" && nodeTitle) return nodeTitle;
  // 素材加载节点（LoadImage / LoadAudio / LoadVideo）同样用节点标题，
  // 这样一个工作流里的多张参考图能各自命名（图片一、图片二…）。
  if (nodeTitle && /^load(image|audio|video)$/i.test(classType)) return nodeTitle;

  // 文本编码器被采样器引用时，直接按方向命名，比字段名更直观。
  if (promptRole === "positive" && (field === "text" || field === "prompt")) return "正向提示词";
  if (promptRole === "negative" && (field === "text" || field === "prompt")) return "负向提示词";

  const specific = CLASS_FIELD_LABELS[`${classType}.${field}`];
  if (specific) return specific;

  return FIELD_LABELS[field] ?? field;
}
