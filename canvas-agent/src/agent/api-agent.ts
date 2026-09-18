import { AGENT_PROMPT } from "../config.js";
import { toolNames } from "../canvas/schemas.js";
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

/** 工具入参的 JSON Schema：只需要让模型知道字段含义，实际校验仍由 zod 兜底。 */
function toolSchema(name: string) {
    const common = { type: "object", additionalProperties: true, properties: {} as Record<string, unknown> };
    if (name.startsWith("canvas_create_text_nodes")) {
        return { ...common, properties: { items: { type: "array", items: { type: "object" } }, texts: { type: "array", items: { type: "string" } } } };
    }
    if (name === "canvas_create_text_node") return { ...common, properties: { text: { type: "string" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["text"] };
    if (name === "canvas_apply_ops") return { ...common, properties: { ops: { type: "array", items: { type: "object" } } }, required: ["ops"] };
    if (name.startsWith("canvas_generate_")) return { ...common, properties: { nodeId: { type: "string" }, prompt: { type: "string" } } };
    if (name === "canvas_connect_nodes") return { ...common, properties: { fromNodeId: { type: "string" }, toNodeId: { type: "string" } }, required: ["fromNodeId", "toNodeId"] };
    if (name === "canvas_delete_nodes") return { ...common, properties: { id: { type: "string" }, ids: { type: "array", items: { type: "string" } } } };
    if (name === "prompts_search") return { ...common, properties: { keyword: { type: "string" } } };
    return common;
}

function buildTools() {
    return toolNames.map((name) => ({
        type: "function" as const,
        function: { name, description: `MGCanvas 画布工具：${name}`, parameters: toolSchema(name) },
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
        { role: "system", content: AGENT_PROMPT },
        { role: "user", content: prompt },
    ];
    emit("agent_bootstrap", { type: `${agent}.preparing` });

    try {
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
            const response = await callChat(config, messages, input.signal);
            const message = response?.choices?.[0]?.message as { content?: string | null; tool_calls?: ToolCall[] } | undefined;
            if (!message) throw new Error(`模型没有返回内容：${JSON.stringify(response).slice(0, 300)}`);

            if (message.content && message.content.trim()) {
                emit("agent_event", { agent, type: "item.completed", item: { type: "agent_message", text: message.content.trim() } });
            }
            messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls });

            const calls = message.tool_calls || [];
            if (!calls.length) break;

            for (const call of calls) {
                const name = String(field(call, "function") && field(field(call, "function"), "name") ? field(field(call, "function"), "name") : "");
                let parsed: unknown = {};
                try {
                    parsed = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
                } catch {
                    parsed = {};
                }
                emit("agent_event", { agent, type: "item.started", item: { id: call.id, type: "dynamic_tool_call", name, input: parsed } });
                let output: unknown;
                let failed = "";
                try {
                    output = await runner.callTool(name, parsed);
                } catch (error) {
                    failed = errorMessage(error);
                    output = { error: failed };
                }
                emit("agent_event", {
                    agent,
                    type: "item.completed",
                    item: { id: call.id, type: "dynamic_tool_call", name, input: parsed, output, ...(failed ? { error: { message: failed } } : {}) },
                });
                messages.push({ role: "tool", tool_call_id: call.id, content: summarizeToolResult(output) });
            }
        }
        emit("agent_done", { agent, code: 0 });
    } catch (error) {
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
