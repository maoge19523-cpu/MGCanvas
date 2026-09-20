import { createComfyNativeClient } from "../../../../modules/comfyui-local/frontend/src/index";
export { buildComfyWorkflowDefinition, comfyInputControl, comfyWorkflowHash, inspectComfyWorkflow, materializeComfyWorkflow, parseComfyApiWorkflow, selectComfyResultOutputs, ComfyWorkflowParseError } from "../../../../modules/comfyui-local/core/src/index";
export { COMFY_STARTUP_STAGES, inferComfyStartupStage, summarizeComfyDevice, summarizeComfyModelCounts, type ComfyDeviceSummary, type ComfyModelCount, type ComfyStartupStage } from "../../../../modules/comfyui-local/core/src/index";
import { invokeDesktop } from "@/services/platform/desktop-runtime";

export const comfyNativeClient = createComfyNativeClient(invokeDesktop);

export type * from "../../../../modules/comfyui-local/contracts/src/index";
