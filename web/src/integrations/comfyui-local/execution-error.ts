/**
 * ComfyUI 执行错误的中文化。
 *
 * ComfyUI 在参数校验失败时返回一大段 JSON（HTTP 400），例如模型名不在可用列表里。
 * 直接展示给用户既看不懂也不知道怎么处理，这里把它转成可操作的中文说明。
 */

/** 这些参数名对应"环境里装了什么模型"，缺失时最需要给出可用清单。 */
const MODEL_FIELD_LABELS: Record<string, string> = {
    ckpt_name: "模型",
    unet_name: "模型",
    lora_name: "LoRA 模型",
    vae_name: "VAE 模型",
    clip_name: "文本编码器",
    control_net_name: "ControlNet 模型",
};

/** 从 `ComfyUI 拒绝了工作流（HTTP 400）：{...}` 中提取并解析 JSON 主体。 */
function parseRejection(message: string) {
    const start = message.indexOf("{");
    if (start < 0) return null;
    try {
        return JSON.parse(message.slice(start)) as {
            node_errors?: Record<string, { errors?: { type?: string; message?: string; details?: string; extra_info?: { input_name?: string; input_config?: unknown } }[] }>;
        };
    } catch {
        return null;
    }
}

/** 把 `details: "ckpt_name: 'x' not in ['a', 'b']"` 解析成结构化信息。 */
function parseValueNotInList(details: string) {
    const match = /^(\w+):\s*'([^']*)'\s*not in\s*\[(.*)\]$/s.exec(details.trim());
    if (!match) return null;
    const options = [...match[3].matchAll(/'([^']*)'/g)].map((item) => item[1]);
    return { field: match[1], value: match[2], options };
}

/**
 * 把 ComfyUI 的执行错误转成用户能看懂的中文提示。
 * 无法识别的错误原样返回，避免丢失信息。
 */
export function formatComfyExecutionError(message: string) {
    const parsed = parseRejection(message);
    if (!parsed?.node_errors) return message;

    for (const [nodeId, nodeError] of Object.entries(parsed.node_errors)) {
        for (const item of nodeError.errors ?? []) {
            if (item.type !== "value_not_in_list" || !item.details) continue;
            const info = parseValueNotInList(item.details);
            if (!info) continue;
            const label = MODEL_FIELD_LABELS[info.field] ?? info.field;
            const shown = info.options.slice(0, 6).join("、");
            const more = info.options.length > 6 ? ` 等 ${info.options.length} 个` : "";
            return `节点 #${nodeId} 的${label}「${info.value}」在你的 ComfyUI 里不存在。\n可用${label}：${shown}${more}。\n请在「参数」面板里换成上面已有的${label}后再运行。`;
        }
    }

    // 其它类型：给出节点与简要原因，避免整段 JSON 糊在界面上。
    for (const [nodeId, nodeError] of Object.entries(parsed.node_errors)) {
        const first = nodeError.errors?.[0];
        if (!first) continue;
        const detail = first.details ? `：${first.details}` : "";
        return `工作流校验失败（节点 #${nodeId}）${first.message ?? first.type ?? ""}${detail}`;
    }

    return message;
}
