import { nanoid } from "nanoid";

export type PromptSource = {
    id: string;
    name: string;
    url: string;
    homepage: string;
    enabled: boolean;
    builtIn: boolean;
};

export function createPromptSource(source?: Partial<PromptSource>): PromptSource {
    return {
        id: source?.id?.trim() || nanoid(),
        name: source?.name?.trim() || "",
        url: source?.url?.trim() || "",
        homepage: source?.homepage?.trim() || "",
        enabled: source?.enabled ?? true,
        builtIn: source?.builtIn ?? false,
    };
}

/** 内置源不填地址，运行时直接返回打包在程序里的数据，因此离线也能用。 */
export const BUILTIN_STYLE_SOURCE_ID = "builtin-styles";

export const DEFAULT_PROMPT_SOURCES: PromptSource[] = [createPromptSource({ id: BUILTIN_STYLE_SOURCE_ID, name: "风格馆", enabled: true, builtIn: true })];
