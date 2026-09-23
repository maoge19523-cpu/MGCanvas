import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clearMissingImageQueue, collectMissingImageNodeIds, restoreMissingImageQueue, writeMissingImageQueue } from "@/lib/canvas/canvas-missing-image-queue";
import type { CanvasNodeData } from "@/types/canvas";

type MissingImageQueueOptions = {
    projectId: string;
    /** 画布数据是否已经载入：载入前 nodes 还是空数组，恢复会读到空集合。 */
    ready: boolean;
    nodes: CanvasNodeData[];
    /** 触发单个节点的图片生成；返回本次是否至少成功一张，undefined 表示这次根本没跑起来。 */
    runNode: (nodeId: string, prompt: string) => Promise<boolean | undefined>;
};

/**
 * 画布级缺图队列：把当前项目里「没有图但有提示词」的图片节点串行补齐。
 *
 * 串行是必须的：单节点的运行锁（runningNodeId）与开始/结束生成都是单实例，并发会互相覆盖。
 */
export function useMissingImageQueue({ projectId, ready, nodes, runNode }: MissingImageQueueOptions) {
    const [total, setTotal] = useState(0);
    const [done, setDone] = useState(0);
    const [failedIds, setFailedIds] = useState<string[]>([]);
    const [running, setRunning] = useState(false);
    // 停止用 ref：循环在下一个节点前 break，正在跑的那一个照常跑完。
    const stopRef = useRef(false);
    const nodesRef = useRef(nodes);
    const runNodeRef = useRef(runNode);

    useEffect(() => {
        nodesRef.current = nodes;
    }, [nodes]);
    useEffect(() => {
        runNodeRef.current = runNode;
    }, [runNode]);

    // 切换项目时恢复上次记录：与当前实际缺图节点取交集，所以已成功的节点会自动出列。
    // 必须等画布数据载入后才是真实节点集合，否则会读到空数组把恢复丢掉。
    useEffect(() => {
        if (!ready) return;
        setFailedIds(restoreMissingImageQueue(projectId, nodesRef.current)?.failedIds || []);
        setTotal(0);
        setDone(0);
        setRunning(false);
        stopRef.current = false;
    }, [projectId, ready]);

    const missingIds = useMemo(() => collectMissingImageNodeIds(nodes), [nodes]);

    const run = useCallback(
        async (ids: string[]) => {
            if (running) return;
            // 跑之前再核一次：没有提示词或已经有图的节点直接跳过，避免重复扣费。
            const pending = ids.filter((id) => {
                const node = nodesRef.current.find((item) => item.id === id);
                return Boolean(node?.metadata?.prompt?.trim()) && !node?.metadata?.content;
            });
            if (!pending.length) return;
            stopRef.current = false;
            setRunning(true);
            setTotal(pending.length);
            setDone(0);
            setFailedIds([]);
            writeMissingImageQueue({ projectId, nodeIds: pending, failedIds: [] });

            const failed: string[] = [];
            let finished = 0;
            for (const nodeId of pending) {
                if (stopRef.current) break;
                const prompt = nodesRef.current.find((item) => item.id === nodeId)?.metadata?.prompt?.trim() || "";
                let result: boolean | undefined;
                try {
                    result = await runNodeRef.current(nodeId, prompt);
                } catch {
                    // 单个节点失败不阻塞后续节点。
                    result = false;
                }
                // undefined 表示这次生成根本没进入生成流程（例如没配模型），继续跑后面只会重复失败。
                if (result === undefined) break;
                finished += 1;
                setDone(finished);
                if (!result) failed.push(nodeId);
            }

            setFailedIds(failed);
            setRunning(false);
            stopRef.current = false;
            // 落盘：没轮到的 + 失败的留给下次「只重试失败项」；全部补齐就清掉记录。
            // 直接按本次结果算，不重新扫 nodes——最后一次 setNodes 这时还没刷新进 ref。
            const remainingIds = Array.from(new Set([...pending.slice(finished), ...failed]));
            if (remainingIds.length) writeMissingImageQueue({ projectId, nodeIds: remainingIds, failedIds: failed });
            else clearMissingImageQueue(projectId);
        },
        [projectId, running],
    );

    const runMissing = useCallback(() => void run(collectMissingImageNodeIds(nodesRef.current)), [run]);
    const retryFailed = useCallback(() => void run(failedIds), [failedIds, run]);
    const stop = useCallback(() => {
        stopRef.current = true;
    }, []);

    return { missingCount: missingIds.length, total, done, failedCount: failedIds.length, running, runMissing, retryFailed, stop };
}
