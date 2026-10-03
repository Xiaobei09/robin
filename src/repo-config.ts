import { parseStrictNumber } from "./config";

export const DEFAULT_CONFIG_FILE = ".github/robin.yml";
export const DEFAULT_ACTION_MAX_DIFF_SIZE = 50000;
/** Single default shared by action.yml and the reusable review.yml workflow. */
export const DEFAULT_MAX_COMMENTS = 15;

export interface RepoConfig {
  maxDiffSize?: number;
  maxComments?: number;
  skipPaths?: string[];
  jsonResponseMode?: boolean;
  requestChanges?: boolean;
  reasoningEffort?: string;
}

/** Strips a trailing ` # comment` only outside quotes, so quoted values keep `#` intact. */
function stripTrailingComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && index > 0 && /\s/.test(line[index - 1])) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line;
}

export function parseRepoConfigYaml(text: string): RepoConfig {
  const config: RepoConfig = {};
  let inSkipPaths = false;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed === "skip-paths:") {
      inSkipPaths = true;
      continue;
    }

    if (inSkipPaths) {
      if (trimmed.startsWith("- ")) {
        const value = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, "");
        if (value) {
          config.skipPaths = config.skipPaths || [];
          config.skipPaths.push(value);
        }
        continue;
      }
      inSkipPaths = false;
    }

    // Scalar settings tolerate the inline comments the shipped examples use
    // (`reasoning-effort: high   # provider note`); a `#` inside a quoted value is kept.
    const setting = stripTrailingComment(trimmed);

    const maxDiffMatch = setting.match(/^max-diff-size:\s*(\d+)\s*$/i);
    if (maxDiffMatch) {
      config.maxDiffSize = parseInt(maxDiffMatch[1], 10);
      continue;
    }

    const maxCommentsMatch = setting.match(/^max-comments:\s*(\d+)\s*$/i);
    if (maxCommentsMatch) {
      config.maxComments = parseInt(maxCommentsMatch[1], 10);
      continue;
    }

    const jsonModeMatch = setting.match(/^json-response-mode:\s*(true|false)\s*$/i);
    if (jsonModeMatch) {
      config.jsonResponseMode = jsonModeMatch[1].toLowerCase() === "true";
      continue;
    }

    const requestChangesMatch = setting.match(/^request-changes:\s*(true|false)\s*$/i);
    if (requestChangesMatch) {
      config.requestChanges = requestChangesMatch[1].toLowerCase() === "true";
      continue;
    }

    const reasoningEffortMatch = setting.match(
      /^reasoning-effort:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(.+))\s*$/i
    );
    if (reasoningEffortMatch) {
      const quotedValue = reasoningEffortMatch[1] ?? reasoningEffortMatch[2];
      const value = (
        quotedValue !== undefined
          ? quotedValue.replace(/\\(.)/g, "$1")
          : reasoningEffortMatch[3] ?? ""
      ).trim();
      if (value) {
        config.reasoningEffort = value;
      }
      continue;
    }
  }

  return config;
}

/**
 * 解析 `max-comments`。
 *
 * 「未设置」的判定是**哨兵**：输入要么没表达出有效意图（空串 / 乱码），要么恰好
 * 等于默认常量（`action.yml` 与 `review.yml` 会把 default 原样透传下来）。只有这
 * 两种情况下 `.github/robin.yml` 才能赢 —— 见 `main.ts` 里那两行兜底的注释。
 *
 * `valid=false` 表示输入不可用、已回落到默认值；调用方**应当**就此告警，
 * 否则用户会拿到一个自己没要求过的值而毫无察觉。
 */
export function resolveMaxComments(
  actionInput: string,
  repoConfig?: RepoConfig,
): { value: number; valid: boolean } {
  const { value: raw, valid: parsedOk } = parseStrictNumber(actionInput);
  // 计数没有小数的意义，Math.floor 会把 "1.9" 这类拼写错误藏起来。
  const valid = parsedOk && Number.isInteger(raw);
  const parsed = valid ? raw : Number.NaN;
  const isUnset = !valid || parsed === DEFAULT_MAX_COMMENTS;
  if (repoConfig?.maxComments !== undefined && isUnset) {
    return { value: repoConfig.maxComments, valid };
  }
  // 0 是合法值（关掉内联评论），所以用区间而不是真值判断。
  if (!valid) return { value: DEFAULT_MAX_COMMENTS, valid: false };
  return { value: parsed >= 0 ? parsed : DEFAULT_MAX_COMMENTS, valid: parsed >= 0 };
}

/**
 * 解析 `max-diff-size`。
 *
 * 哨兵语义与 `resolveMaxComments` 相同，外加一条：即使输入等于默认常量，
 * repo config 自己也等于默认常量时不算「repo 显式配置过」，不必返回。
 */
export function resolveMaxDiffSize(
  actionInput: string,
  repoConfig?: RepoConfig,
): { value: number; valid: boolean } {
  const { value: raw, valid: parsedOk } = parseStrictNumber(actionInput);
  const valid = parsedOk && Number.isInteger(raw);
  const parsed = valid ? raw : Number.NaN;
  const isUnset =
    !valid ||
    (parsed === DEFAULT_ACTION_MAX_DIFF_SIZE &&
      repoConfig?.maxDiffSize !== DEFAULT_ACTION_MAX_DIFF_SIZE);
  if (repoConfig?.maxDiffSize !== undefined && isUnset) {
    return { value: repoConfig.maxDiffSize, valid };
  }
  if (!valid) return { value: DEFAULT_ACTION_MAX_DIFF_SIZE, valid: false };
  return {
    value: parsed > 0 ? parsed : DEFAULT_ACTION_MAX_DIFF_SIZE,
    valid: parsed > 0,
  };
}

/**
 * 解析布尔输入，供 `resolveJsonResponseMode` / `resolveRequestChanges` 共用。
 *
 * **归一化：trim + 小写。** 原先是精确比较 `actionInput === "true"`，于是
 * `False` / `FALSE` / `" false"`（前后带空白）**一律落空**，静默退回默认 ——
 * 而默认是 `true`。后果是**用户明确写了要关，实际没关**，且没有任何告警。
 * 实测（probe）下列拼写全部静默失效：`False` `FALSE` ` false` `false ` `no` `off` `0`。
 *
 * 这在两个输入上的**真实风险并不相同**，所以两类拼写要分开看：
 * - `request-changes` 在 `review.yml` 里声明为 `type: boolean`，GitHub 会归一化成
 *   `"true"` / `"false"`，精确比较本来就不会漏；
 * - `use-json-response-mode` 声明为 **`type: string`、`default: ""`**，
 *   GitHub **不做任何归一化**、原样透传 —— 大小写与空白问题真实可达。
 *
 * `no` / `off` / `0` 归一化后仍不是 true/false。这类**故意不认**：把它们猜成
 * false 会在用户写 `no` 时关掉一个他可能只是想"确认默认"的东西。正确做法是
 * **如实告警**，而不是替用户猜。
 *
 * 返回 `valid` 就是为了让调用方能告警 —— 与 `resolveMaxComments` /
 * `resolveMaxDiffSize` 同一套契约（见上面那段注释：「调用方**应当**就此告警，
 * 否则用户会拿到一个自己没要求过的值而毫无察觉」）。
 *
 * 空串是**正常的"未设置"**，不是错误 ⇒ `valid: true`，不该告警。
 */
function resolveBooleanInput(
  actionInput: string,
  repoValue: boolean | undefined,
  fallback: boolean,
): { value: boolean; valid: boolean } {
  const normalized = actionInput.trim().toLowerCase();
  if (normalized === "true") return { value: true, valid: true };
  if (normalized === "false") return { value: false, valid: true };
  if (normalized === "") return { value: repoValue ?? fallback, valid: true };
  return { value: repoValue ?? fallback, valid: false };
}

export function resolveJsonResponseMode(
  actionInput: string,
  repoConfig?: RepoConfig,
): { value: boolean; valid: boolean } {
  return resolveBooleanInput(actionInput, repoConfig?.jsonResponseMode, true);
}

/** Whether a High finding submits a blocking REQUEST_CHANGES review. Default true (gatekeeper). */
export function resolveRequestChanges(
  actionInput: string,
  repoConfig?: RepoConfig,
): { value: boolean; valid: boolean } {
  return resolveBooleanInput(actionInput, repoConfig?.requestChanges, true);
}

/** Reasoning effort is provider configuration: explicit input first, then `.github/robin.yml`, else unset. */
export function resolveReasoningEffort(
  actionInput: string,
  repoConfig?: RepoConfig
): string | undefined {
  const trimmed = actionInput.trim();
  if (trimmed) return trimmed;
  return repoConfig?.reasoningEffort;
}
