import { ExternalLink, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChannelPanel } from "@/components/layout/app-config-modal";
import { APP_VERSION } from "@/constant/env";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { DesktopFfmpegSettings } from "./desktop-ffmpeg-settings";

export default function ConfigPage() {
    const { t } = useTranslation();

    return (
        <WorkspacePage icon={Settings2} title={t("config.title")} description={t("config.description")}>
            <div className="mx-auto grid max-w-[980px] items-start gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
                <aside className="lg:sticky lg:top-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400 dark:text-zinc-600">API</div>
                    <h2 className="mt-3 text-[15px] font-semibold text-stone-900 dark:text-zinc-100">{t("config.channelEditor.title")}</h2>
                    <p className="mt-2 text-[11px] leading-5 text-stone-500 dark:text-zinc-500">{t("config.channels.description")}</p>
                    <div className="mt-6 h-px bg-black/[0.07] dark:bg-white/[0.07]" />
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400 dark:text-zinc-600">FFmpeg</div>
                    <h3 className="mt-3 text-[15px] font-semibold text-stone-900 dark:text-zinc-100">本地 FFmpeg</h3>
                    <p className="mt-2 text-[11px] leading-5 text-stone-500 dark:text-zinc-500">视频合成节点调用本机 FFmpeg；不随安装包分发。</p>
                    <div className="mt-6 h-px bg-black/[0.07] dark:bg-white/[0.07]" />
                    <p className="mt-5 text-[10px] leading-[18px] text-stone-400 dark:text-zinc-600">{t("config.apiKeySecurity")}</p>
                </aside>
                <section className="flex flex-col gap-8 rounded-[18px] border border-black/[0.08] bg-black/[0.015] p-5 dark:border-white/[0.08] dark:bg-white/[0.025] sm:p-7">
                    <ChannelPanel />
                    <div>
                        <div className="mb-3 h-px bg-black/[0.07] dark:bg-white/[0.07]" />
                        <DesktopFfmpegSettings />
                    </div>
                    <div>
                        <div className="mb-3 h-px bg-black/[0.07] dark:bg-white/[0.07]" />
                        <h3 className="text-[15px] font-semibold text-stone-900 dark:text-zinc-100">{t("config.about.title")}</h3>
                        <dl className="mt-4 grid gap-3 text-[11px] leading-5">
                            <div className="flex items-center justify-between gap-4">
                                <dt className="text-stone-400 dark:text-zinc-600">{t("config.about.version")}</dt>
                                <dd className="tabular-nums text-stone-700 dark:text-zinc-300">{APP_VERSION}</dd>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <dt className="text-stone-400 dark:text-zinc-600">{t("config.about.license")}</dt>
                                <dd>
                                    <a
                                        href="https://www.gnu.org/licenses/agpl-3.0.html"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-stone-700 underline underline-offset-2 transition-colors hover:text-stone-950 dark:text-zinc-300 dark:hover:text-zinc-50"
                                    >
                                        AGPL-3.0
                                        <ExternalLink className="size-3" strokeWidth={2} />
                                    </a>
                                </dd>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <dt className="text-stone-400 dark:text-zinc-600">{t("config.about.source")}</dt>
                                <dd>
                                    <a
                                        href="https://github.com/maoge19523-cpu/MGCanvas"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-stone-700 underline underline-offset-2 transition-colors hover:text-stone-950 dark:text-zinc-300 dark:hover:text-zinc-50"
                                    >
                                        GitHub
                                        <ExternalLink className="size-3" strokeWidth={2} />
                                    </a>
                                </dd>
                            </div>
                        </dl>
                        <p className="mt-4 text-[10px] leading-[18px] text-stone-400 dark:text-zinc-600">{t("config.about.credits")}</p>
                    </div>
                </section>
            </div>
        </WorkspacePage>
    );
}
