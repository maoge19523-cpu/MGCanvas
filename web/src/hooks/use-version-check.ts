import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";
import { isTauri } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { useTranslation } from "react-i18next";
import { APP_VERSION, CHANGELOG_URL, DESKTOP_UPDATER_ENABLED, VERSION_URL } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";

export type DesktopUpdateStatus = "idle" | "available" | "downloading" | "ready" | "installing" | "error";

/** 版本检查仓库：无需自建服务器，直接读 GitHub Releases。 */
const UPDATE_REPOSITORY = "maoge19523-cpu/MGCanvas";
const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

function describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function useVersionCheck() {
    const { t } = useTranslation();
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const pendingUpdateRef = useRef<Update | null>(null);
    const desktopUpdaterEnabled = DESKTOP_UPDATER_ENABLED && isTauri();
    const releaseInfoEnabled = Boolean(VERSION_URL && CHANGELOG_URL);
    // 未配置签名更新器与自建版本源时，回退到 GitHub Releases。
    const githubReleasesEnabled = !desktopUpdaterEnabled && !releaseInfoEnabled;
    const canCheckUpdates = desktopUpdaterEnabled || releaseInfoEnabled || githubReleasesEnabled;
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus>("idle");
    const [downloadedBytes, setDownloadedBytes] = useState(0);
    const [totalBytes, setTotalBytes] = useState<number | null>(null);
    const [updateError, setUpdateError] = useState("");
    const [updateNotes, setUpdateNotes] = useState("");
    const [releasePageUrl, setReleasePageUrl] = useState(UPDATE_RELEASES_URL);
    const hasNativeUpdate = ["available", "downloading", "ready", "installing"].includes(updateStatus);
    const hasNewVersion = hasNativeUpdate || isNewerVersion(latestVersion, currentVersion);
    const downloadProgress = totalBytes && totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null;

    const loadReleaseNotes = useCallback(async () => {
        if (!CHANGELOG_URL) return;
        const response = await fetch(CHANGELOG_URL);
        if (!response.ok) throw new Error(t("version.changelogFailed"));
        const changelog = await response.text();
        if (changelog.trim()) setReleases(parseChangelog(changelog));
    }, [t]);

    const checkDesktopUpdate = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            setUpdateError("");
            try {
                const { check } = await import("@tauri-apps/plugin-updater");
                const update = await check({ timeout: 30_000 });
                const previous = pendingUpdateRef.current;
                pendingUpdateRef.current = update;
                if (previous && previous !== update) void previous.close().catch(() => undefined);

                if (update) {
                    setLatestVersion(update.version);
                    setUpdateNotes(update.body?.trim() || "");
                    setUpdateStatus("available");
                    setDownloadedBytes(0);
                    setTotalBytes(null);
                    if (showMessage) message.success(t("version.availableMessage", { version: update.version }));
                } else {
                    setLatestVersion(currentVersion);
                    setUpdateNotes("");
                    setUpdateStatus("idle");
                    if (showMessage) message.success(t("version.alreadyLatest"));
                }
                await loadReleaseNotes().catch(() => undefined);
                return true;
            } catch (error) {
                setUpdateStatus("error");
                setUpdateError(describeError(error));
                if (showMessage) message.error(t("version.updateFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [currentVersion, loadReleaseNotes, message, t],
    );

    const checkReleaseInformation = useCallback(
        async (showMessage = false) => {
            if (!releaseInfoEnabled) {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                return false;
            }
            setChecking(true);
            try {
                const [versionResponse, changelogResponse] = await Promise.all([fetch(VERSION_URL), fetch(CHANGELOG_URL)]);
                if (!versionResponse.ok) throw new Error(t("version.readFailed"));
                if (!changelogResponse.ok) throw new Error(t("version.changelogFailed"));
                const [version, changelog] = await Promise.all([versionResponse.text(), changelogResponse.text()]);
                setLatestVersion(version.trim() || currentVersion);
                if (changelog.trim()) setReleases(parseChangelog(changelog));
                if (showMessage) message.success(t("version.updated"));
                return true;
            } catch {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                if (showMessage) message.error(t("version.updateFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [currentVersion, localReleases, message, releaseInfoEnabled, t],
    );

    const checkGithubRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                const response = await fetch(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`, {
                    headers: { Accept: "application/vnd.github+json" },
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = (await response.json()) as { tag_name?: string; body?: string; html_url?: string };
                const tag = (data.tag_name || "").trim();
                setLatestVersion(tag || currentVersion);
                setUpdateNotes((data.body || "").trim());
                setReleasePageUrl(data.html_url || UPDATE_RELEASES_URL);
                if (showMessage) {
                    const newer = Boolean(tag) && isNewerVersion(tag, currentVersion);
                    if (newer) message.success(t("version.availableMessage", { version: tag }));
                    else message.success(t("version.alreadyLatest"));
                }
                return true;
            } catch {
                setLatestVersion(currentVersion);
                if (showMessage) message.error(t("version.updateFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [currentVersion, message, t],
    );

    /** 在系统默认浏览器中打开 Releases 页面下载新版本。 */
    const openReleasePage = useCallback(async () => {
        try {
            const { invokeDesktop } = await import("@/services/platform/desktop-runtime");
            await invokeDesktop("open_external_url", { url: releasePageUrl });
        } catch {
            window.open(releasePageUrl, "_blank", "noreferrer");
        }
    }, [releasePageUrl]);
    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            if (desktopUpdaterEnabled) return checkDesktopUpdate(showMessage);
            if (releaseInfoEnabled) return checkReleaseInformation(showMessage);
            return checkGithubRelease(showMessage);
        },
        [checkDesktopUpdate, checkGithubRelease, checkReleaseInformation, desktopUpdaterEnabled, releaseInfoEnabled],
    );

    const downloadUpdate = useCallback(async () => {
        const update = pendingUpdateRef.current;
        if (!update) return false;
        setUpdateStatus("downloading");
        setDownloadedBytes(0);
        setTotalBytes(null);
        setUpdateError("");
        try {
            await update.download((event) => {
                if (event.event === "Started") {
                    setTotalBytes(event.data.contentLength ?? null);
                    return;
                }
                if (event.event === "Progress") {
                    setDownloadedBytes((value) => value + event.data.chunkLength);
                    return;
                }
                setUpdateStatus("ready");
            });
            setUpdateStatus("ready");
            return true;
        } catch (error) {
            setUpdateStatus("error");
            setUpdateError(describeError(error));
            message.error(t("version.downloadFailed"));
            return false;
        }
    }, [message, t]);

    const restartAndInstall = useCallback(async () => {
        const update = pendingUpdateRef.current;
        if (!update) return false;
        setUpdateStatus("installing");
        setUpdateError("");
        try {
            await update.install({ restartAfterInstall: true });
            const { relaunch } = await import("@tauri-apps/plugin-process");
            await relaunch();
            return true;
        } catch (error) {
            setUpdateStatus("error");
            setUpdateError(describeError(error));
            message.error(t("version.installFailed"));
            return false;
        }
    }, [message, t]);

    // 首次版本检查只跑一次：App.useApp() 的 message 每次渲染都是新身份，会让下面几个
    // useCallback 每次渲染都重建，effect 随之反复执行并再次写入 state（releases 每次都是
    // 新数组），形成渲染风暴（React #185）。用一次性守卫断开这条链。
    const initialCheckDoneRef = useRef(false);
    useEffect(() => {
        if (initialCheckDoneRef.current) return;
        initialCheckDoneRef.current = true;
        if (desktopUpdaterEnabled) {
            void checkDesktopUpdate(false);
            return;
        }
        if (releaseInfoEnabled) {
            void checkReleaseInformation(false);
            return;
        }
        void checkGithubRelease(false);
    }, [checkDesktopUpdate, checkGithubRelease, checkReleaseInformation, desktopUpdaterEnabled, releaseInfoEnabled]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        const updateInProgress = ["downloading", "ready", "installing"].includes(updateStatus);
        if (canCheckUpdates && !checking && !updateInProgress) void checkLatestRelease(false);
    }, [canCheckUpdates, checkLatestRelease, checking, updateStatus]);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        canCheckUpdates,
        hasNewVersion,
        checkLatestRelease,
        desktopUpdaterEnabled,
        updateStatus,
        updateError,
        updateNotes,
        downloadProgress,
        downloadedBytes,
        totalBytes,
        downloadUpdate,
        restartAndInstall,
        releasePageUrl,
        openReleasePage,
        githubReleasesEnabled,
    };
}
