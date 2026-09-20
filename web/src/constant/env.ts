export const APP_VERSION = __APP_VERSION__ || "dev";

// 正式版与测试版共用一份源码，靠构建渠道区分；测试版使用独立的应用标识与数据目录。
export const APP_CHANNEL = __APP_CHANNEL__;
export const IS_BETA_CHANNEL = APP_CHANNEL === "beta";
export const APP_WINDOW_TITLE = IS_BETA_CHANNEL ? "猫歌映画 测试版" : "猫歌映画";

export const DOCS_URL = import.meta.env.VITE_DOC_URL?.trim() || "";

export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL?.trim() || "";
export const VERSION_URL = import.meta.env.VITE_VERSION_URL?.trim() || "";
export const CHANGELOG_URL = import.meta.env.VITE_CHANGELOG_URL?.trim() || "";

// Enabled only by the signed desktop release packaging flow. Development and
// ordinary web builds keep using the lightweight release-information view.
export const DESKTOP_UPDATER_ENABLED = import.meta.env.VITE_DESKTOP_UPDATER_ENABLED === "1";
