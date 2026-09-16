import { createComfyWorkflowCanvasNode } from "./canvas-node";
import { createComfyResultNodes } from "./result-nodes";
import type { ComfyWorkflowDefinition } from "./index";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/**
 * 在一个全新画布中放置该工作流的节点与结果节点，返回新画布 ID。
 *
 * 总是新建画布：避免把工作流节点混进用户正在使用的画布；
 * 调用方拿到 ID 后自行决定是否跳转。
 */
export function openWorkflowInNewCanvas(definition: ComfyWorkflowDefinition) {
    const projectId = useCanvasStore.getState().createProject(definition.name);
    const target = useCanvasStore.getState().openProject(projectId);
    if (!target) return projectId;

    // 新画布视口为默认值，把节点放在可视区域中心。
    const viewport = target.viewport;
    const position = {
        x: (Math.max(900, window.innerWidth) / 2 - viewport.x) / viewport.k,
        y: (Math.max(640, window.innerHeight) / 2 - viewport.y) / viewport.k,
    };
    const workflowNode = createComfyWorkflowCanvasNode(definition, position);
    const resultGraph = createComfyResultNodes(workflowNode, definition);
    useCanvasStore.getState().updateProject(projectId, {
        nodes: [...target.nodes, workflowNode, ...resultGraph.nodes],
        connections: [...target.connections, ...resultGraph.connections],
    });
    return projectId;
}
