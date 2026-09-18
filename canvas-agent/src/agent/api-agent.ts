import { AGENT_PROMPT } from "../config.js";
import { toolDescriptions, toolNames } from "../canvas/schemas.js";
import { logger } from "../utils/logger.js";
import { errorMessage, field } from "../utils/value.js";
import type { AgentEmit } from "./types.js";

/**
 * 直接用 API Key 驱动的 Agent 后端（DeepSeek / 豆包等兼容 OpenAI 的接口）。
 *
 * 与 Codex / Claude 后端不同，这里没有本地 CLI，所以由本进程自己完成
 * 「模型 → 工具调用 → 回填结果 → 继续」的循环，并直接调用画布会话的工具。
 * 事件按网页侧已支持的 Codex 风格格式发出，前端无需改动即可渲染。
 */

export type ApiBackendConfig = {
    /** 例如 DeepSeek 的 https://api.deepseek.com，方舟的 https://ark.cn-beijing.volces.com/api/v3 */
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 展示用名称，用于事件里的 agent 字段。 */
    label: string;
};

/** 后端需要的最小会话能力：执行画布工具。 */
export type ToolRunner = { callTool: (name: unknown, input: unknown) => Promise<unknown> };

type ChatMessage =
    | { role: "system" | "user"; content: string }
    | { role: "assistant"; content?: string | null; tool_calls?: ToolCall[] }
    | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = { id: string; type?: string; function?: { name?: string; arguments?: string } };

const MAX_ROUNDS = 24;

/**
 * 工具说明表。
 *
 * 模型只会调用「看得懂」的工具，所以每个工具都必须有明确的中文说明和参数定义；
 * 只给名字的话模型会当作无关能力而完全不用（实测确认）。
 */
const TOOL_META: Record<string, { description: string; properties?: Record<string, unknown>; required?: string[] }> = {
    site_navigate: { description: "跳转到站内某个页面，例如画布列表或某个画布。", properties: { path: { type: "string", description: "站内路径，例如 /canvas" } } },
    canvas_list_projects: { description: "列出当前用户的所有画布（项目）及其 id、名称、节点数量。" },
    canvas_get_state: { description: "读取当前打开画布的全部节点与连线。需要知道画布现状时先用它。", properties: { projectId: { type: "string", description: "可选，指定画布 id；省略则用当前打开的" } } },
    canvas_get_selection: { description: "读取当前画布中被选中的节点。" },
    canvas_export_snapshot: { description: "导出当前画布的快照数据（节点、连线、视口）。" },
    canvas_apply_ops: { description: "对画布批量执行一组操作（最常用的工具）。ops 是操作数组，每一项都必须带 type 字段，且 type 只能是以下八种之一：add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、select_nodes、run_generation。各类型的字段：add_node={nodeType(必填，image/text/video/audio/config), title, x, y, width, height, metadata}；update_node={id(必填), patch, metadata}；delete_node={id 或 ids}；connect_nodes={fromNodeId(必填), toNodeId(必填)}；set_viewport={viewport:{x,y,k}}；select_nodes={ids}；run_generation={nodeId(必填), mode, prompt}。", properties: { ops: { type: "array", description: "操作数组，每项都要有 type 字段，取值见工具说明", items: { type: "object", properties: { type: { type: "string", description: "操作类型：add_node / update_node / delete_node / delete_connections / connect_nodes / set_viewport / select_nodes / run_generation" } }, required: ["type"] } }, projectId: { type: "string" } }, required: ["ops"] },
    canvas_create_node: { description: "在画布上创建一个节点。", properties: { nodeType: { type: "string", description: "节点类型，必须是 image / text / video / audio / config 之一" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, metadata: { type: "object" } }, required: ["nodeType"] },
    canvas_create_attachment_nodes: { description: "把用户上传的图片附件创建为画布图片节点。", properties: { attachmentIds: { type: "array", description: "本轮附件清单里的 ID", items: { type: "string" } } }, required: ["attachmentIds"] },
    canvas_create_text_node: { description: "在画布上创建一个文本节点，内容为 text。用户说「加一个文本节点/写一段字」时用它。", properties: { text: { type: "string", description: "节点里的文字内容" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["text"] },
    canvas_create_text_nodes: { description: "一次创建多个文本节点。", properties: { items: { type: "array", description: "文本节点数组，每项含 text（必填）与可选 title/x/y", items: { type: "object", properties: { text: { type: "string" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["text"] } } }, required: ["items"] },
    canvas_create_config_node: { description: "创建一个配置节点（把一组生成参数集中管理）。" },
    canvas_create_image_prompt_flow: { description: "创建「文本提示词 + 图片节点」的成对结构，常用于从提示词直接出图。" },
    canvas_create_generation_flow: { description: "创建一条生成流程（提示词节点 + 生成节点 + 连线）。注意：它会连带创建配套占位节点，画布上已有文本提示词或只需要单个生成节点时不要用它，改用 canvas_create_text_node 加 canvas_create_node，避免多出空白节点。" },
    canvas_generate_text: { description: "创建文本生成流程并立即触发生成。", properties: { prompt: { type: "string", description: "生成用的提示词（必填）" }, title: { type: "string" }, model: { type: "string" }, referenceNodeIds: { type: "array", items: { type: "string" } } }, required: ["prompt"] },
    canvas_generate_image: { description: "创建图片生成流程并立即触发生图。", properties: { prompt: { type: "string", description: "生成用的提示词（必填）" }, title: { type: "string" }, model: { type: "string" }, size: { type: "string" }, referenceNodeIds: { type: "array", items: { type: "string" } } }, required: ["prompt"] },
    canvas_generate_video: { description: "创建视频生成流程并立即触发生成。", properties: { prompt: { type: "string", description: "生成用的提示词（必填）" }, title: { type: "string" }, model: { type: "string" }, seconds: { type: "string" }, referenceNodeIds: { type: "array", items: { type: "string" } } }, required: ["prompt"] },
    canvas_generate_audio: { description: "创建音频生成流程并立即触发配音。", properties: { prompt: { type: "string", description: "生成用的提示词（必填）" }, title: { type: "string" }, model: { type: "string" }, audioVoice: { type: "string" } }, required: ["prompt"] },
    canvas_update_node: { description: "修改节点的属性或 metadata（例如改名、改提示词、换模型）。", properties: { id: { type: "string" }, patch: { type: "object" }, metadata: { type: "object" } }, required: ["id"] },
    canvas_update_node_text: { description: "直接改写某个文本节点的文字内容。", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
    canvas_move_nodes: { description: "移动节点。", properties: { items: { type: "array", description: "每项含 id 与 x/y 或 dx/dy", items: { type: "object", properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" }, dx: { type: "number" }, dy: { type: "number" } }, required: ["id"] } } }, required: ["items"] },
    canvas_resize_node: { description: "调整节点尺寸。", properties: { id: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, required: ["id"] },
    canvas_delete_nodes: { description: "删除节点。", properties: { ids: { type: "array", description: "要删除的节点 id 数组", items: { type: "string" } } }, required: ["ids"] },
    canvas_connect_nodes: { description: "用连线连接节点（数据流向 from → to）。", properties: { connections: { type: "array", description: "连线数组，每项含 fromNodeId 与 toNodeId", items: { type: "object", properties: { fromNodeId: { type: "string" }, toNodeId: { type: "string" } }, required: ["fromNodeId", "toNodeId"] } } }, required: ["connections"] },
    canvas_select_nodes: { description: "选中指定节点。", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
    canvas_set_viewport: { description: "设置画布视口（缩放与平移）。", properties: { viewport: { type: "object" } }, required: ["viewport"] },
    canvas_run_generation: { description: "运行某个节点的生成任务。", properties: { nodeId: { type: "string" }, mode: { type: "string" }, prompt: { type: "string" } }, required: ["nodeId"] },
    generation_get_status: { description: "查询生成任务的状态。" },
    prompts_search: { description: "在提示词库里搜索提示词。", properties: { keyword: { type: "string" } } },
    assets_list: { description: "列出用户素材库里的素材。" },
    assets_add: { description: "把内容加入素材库。" },
};

/** 工具入参的 JSON Schema：只需要让模型知道字段含义，实际校验仍由 zod 兜底。 */
function toolSchema(name: string) {
    const meta = TOOL_META[name];
    return { type: "object", additionalProperties: true, properties: meta?.properties || {}, ...(meta?.required ? { required: meta.required } : {}) };
}

/**
 * API 后端只暴露画布操作类工具。
 *
 * 实测：把 canvas_list_projects / site_navigate 一起给模型时，它会先去「列画布」，
 * 拿到空列表就停手，反而不去改当前画布。这里只保留真正能操作当前画布的工具。
 */
const API_TOOL_EXCLUDED = new Set(["site_navigate", "canvas_list_projects", "canvas_export_snapshot"]);

function buildTools() {
    return toolNames
        .filter((name) => !API_TOOL_EXCLUDED.has(name))
        .map((name) => ({
            type: "function" as const,
            function: { name, description: toolDescriptions[name] || TOOL_META[name]?.description || `MGCanvas 画布工具：${name}`, parameters: toolSchema(name) },
        }));
}

/** 把工具执行结果压成一段短文本，避免上下文被撑爆。 */
function summarizeToolResult(result: unknown) {
    try {
        const text = JSON.stringify(result);
        if (!text) return "已完成";
        return text.length > 2000 ? `${text.slice(0, 2000)}…（已截断）` : text;
    } catch {
        return "已完成";
    }
}

/**
 * 执行一次对话：模型决定调用哪些画布工具，由本进程代为执行并回填，直到模型给出最终回答。
 */
export async function runApiAgentTurn(input: {
    prompt: string;
    config: ApiBackendConfig;
    runner: ToolRunner;
    emit: AgentEmit;
    signal?: AbortSignal;
}) {
    const { prompt, config, runner, emit } = input;
    const agent = config.label;
    if (!prompt.trim()) return;
    if (!config.apiKey.trim() || !config.model.trim()) {
        emit("agent_error", { message: `${agent} 还缺少 API Key 或模型名，请在设置里补全。` });
        emit("agent_done", { agent, code: 1 });
        return;
    }

    const messages: ChatMessage[] = [
        {
            role: "system",
            content: [
                AGENT_PROMPT,
                "",
                "补充要求（API 模式）：",
                "- 用户说的「画布」就是网页当前打开的那一个，直接用画布工具操作，不要去找项目列表。",
                "- 需要了解现状时调用 canvas_get_state；要落笔就直接调用 canvas_create_text_node 等工具。",
                "- 任务完成后用一两句中文说明你做了什么，不要罗列工具名。",
                "- 生成类节点一次只能接一个提示词：不要把多个不同镜头的提示词接到同一个生成节点上，",
                "  那样只会产出其中一个镜头的画面。用户要多个镜头/多段画面时，走两条路之一：",
                "  (1) 把这些镜头写成一段连续描述放进同一个提示词；",
                "  (2) 每个镜头各建一个文本节点和一个生成节点，生成完成后用合成节点把片段拼起来。",
                "  用户要求多镜头短片时优先用 (2)，并明确告诉用户需要逐个生成再合成。",
                "- 节点要克制：每个镜头只建「一个文本提示词节点 + 一个生成节点」并连线，",
                "  不要再附带配置节点、素材节点或其它占位节点，节点总数越少越好。",
                "- 多个生成任务必须串行：一次只触发一个节点的生成，等它结束后再触发下一个。",
                "  同时触发多个会撞上服务商限流（HTTP 429 速率限制），反而全部失败。",
                "- 尽量做最小改动：只需要生成节点就只建生成节点（可用 canvas_create_node 或 canvas_apply_ops 的 add_node），",
                "  需要提示词就再单独建一个文本节点并连线；不要创建用不到的空节点（例如空白素材节点）。",
                "- 写生成用的提示词时避开内容审核风险：不要使用暴力、战斗、血腥、武器，",
                "  也不要直接使用知名影视/动漫角色名（例如奥特曼、皮卡丘）。用户这么要求时，",
                "  改写成不含风险词但观感相近的描述：用体型、装甲质感、光源、能量特效、",
                "  环境氛围、镜头运动来表达，例如「巨大的银色装甲身影矗立在城市天际线上，",
                "  胸口能量核心亮起，镜头缓慢环绕」。",
            ].join("\n"),
        },
        { role: "user", content: prompt },
    ];
    emit("agent_bootstrap", { type: `${agent}.preparing` });
    logger.info("API agent turn started", { label: agent, model: config.model, baseUrl: config.baseUrl, promptLength: prompt.length });

    try {
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
            logger.info("API agent calling model", { round, messageCount: messages.length });
            const response = await callChat(config, messages, input.signal);
            const message = response?.choices?.[0]?.message as { content?: string | null; tool_calls?: ToolCall[] } | undefined;
            if (!message) throw new Error(`模型没有返回内容：${JSON.stringify(response).slice(0, 300)}`);

            if (message.content && message.content.trim()) {
                emit("agent_event", { agent, type: "item.completed", item: { type: "agent_message", text: message.content.trim() } });
            }
            messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls });

            const calls = message.tool_calls || [];
            logger.info("API agent model replied", { round, contentLength: (message.content || "").length, toolCallCount: calls.length });
            if (!calls.length) break;

            for (const call of calls) {
                const name = String(field(call, "function") && field(field(call, "function"), "name") ? field(field(call, "function"), "name") : "");
                let parsed: unknown = {};
                try {
                    parsed = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
                } catch {
                    parsed = {};
                }
                logger.info("API agent will call tool", { name, input: JSON.stringify(parsed).slice(0, 200) });
                let output: unknown;
                let failed = "";
                try {
                    output = await runner.callTool(name, parsed);
                } catch (error) {
                    failed = errorMessage(error);
                    output = { error: failed };
                }
                logger.info("API agent tool finished", { name, failed: failed || undefined });
                // 失败只写日志、不往对话框推红色卡片：模型仍能从工具结果里看到失败原因并自行重试，
                // 而用户看到的对话保持干净。
                if (failed) {
                    emit("agent_log", { text: `工具 ${name} 失败：${failed}` });
                } else {
                    emit("agent_event", { agent, type: "item.started", item: { id: call.id, type: "dynamic_tool_call", name, input: parsed } });
                    emit("agent_event", { agent, type: "item.completed", item: { id: call.id, type: "dynamic_tool_call", name, input: parsed, output } });
                }
                messages.push({ role: "tool", tool_call_id: call.id, content: summarizeToolResult(output) });
            }
        }
        logger.info("API agent turn finished", { label: agent });
        emit("agent_done", { agent, code: 0 });
    } catch (error) {
        logger.error("API agent turn failed", { label: agent, error: errorMessage(error) });
        emit("agent_error", { message: `${agent} 调用失败：${errorMessage(error)}` });
        emit("agent_done", { agent, code: 1 });
    }
}

/** 调用一次兼容 OpenAI 的对话接口。 */
async function callChat(config: ApiBackendConfig, messages: ChatMessage[], signal?: AbortSignal) {
    const base = config.baseUrl.trim().replace(/\/+$/, "");
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey.trim()}` },
        body: JSON.stringify({ model: config.model.trim(), messages, tools: buildTools(), tool_choice: "auto", stream: false }),
        signal,
    });
    const text = await response.text();
    let payload: unknown = text;
    try {
        payload = JSON.parse(text);
    } catch {
        // 保持原文，下面统一报错。
    }
    if (!response.ok) {
        const detail = typeof payload === "string" ? payload.slice(0, 300) : JSON.stringify(payload).slice(0, 300);
        throw new Error(`HTTP ${response.status}：${detail}`);
    }
    return payload as { choices?: Array<{ message?: unknown }> };
}

/** 常用后端预设，供设置界面直接选用。 */
export const API_BACKEND_PRESETS: readonly ApiBackendConfig[] = [
    { label: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat" },
    { label: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "", model: "" },
];
