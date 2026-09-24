import { useEffect, useState } from "react";

import { resolveEditMediaUrl } from "@/services/edit-media";
import type { EditMedia } from "@/types/edit";

/**
 * 素材的可播放地址：存储键对应的 blob 会随会话失效，所以打开项目时按当前素材列表重新解析一次。
 * 解析是低频动作（只在素材列表变化时跑一轮），一次性整批提交，不做逐帧写入。
 */
export function useEditMediaUrls(media: EditMedia[]) {
    const [urls, setUrls] = useState<Record<string, string>>({});
    const key = media.map((item) => `${item.id}:${item.storageKey || ""}:${item.url || ""}`).join("|");

    useEffect(() => {
        let active = true;
        void Promise.all(media.map(async (item) => [item.id, await resolveEditMediaUrl(item)] as const)).then((entries) => {
            if (active) setUrls(Object.fromEntries(entries));
        });
        return () => {
            active = false;
        };
    }, [key]);

    return urls;
}
