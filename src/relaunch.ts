/**
 * 「换出口」= 抛弃当前 CI，另起一个新 CI 继续审查。
 *
 * 为什么必须是新 CI 而不是同一次 run 内换个 baseUrl 重试：审查跑在一个
 * **zengate gateway** 之后（消费方 workflow 的 Install/Start/Smoke-test 三步），
 * gateway 自己被阻断时，同一次 run 里无论换什么 URL 都还是走同一个坏掉的出口。
 * 唯一有效的办法是换一个 runner —— 也就是让 CI 重新跑一次。
 *
 * 怎么让 CI 重新跑：发一条以 `/robin` 开头的 PR 评论。消费方 workflow 的
 * `issue_comment` 触发器会因此起一个**新 run**，而 workflow 上的
 * `concurrency: { group: robin-<pr>, cancel-in-progress: true }` 会把当前这个
 * run 取消掉 —— 正好就是「抛弃原来那个 CI」。
 *
 * 两个约束必须守住，否则这个功能会变成一台绞肉机：
 *
 * 1. **评论正文必须以 `/robin` 或 `/review` 开头**。消费方的 job 守卫用的是
 *    `startsWith(github.event.comment.body, ...)`，所以前面不能有 emoji、
 *    空白或不可见标记。下面的 `RELAUNCH_COMMAND` 独立成常量就是为了让这条
 *    约束在测试里能被钉住。
 * 2. **必须有 hop 上限**。出口持续坏掉时每一轮都会想重启，没有上限就是
 *    无限重启 CI、把维护者的配额烧光。hop 计数通过评论正文本身传递，
 *    不依赖任何外部存储，所以新 run 读回自己的上一跳即可。
 */

import { errorMessage, isTransientEgressFailure } from "./llm-retry";

/** 触发新 CI 的命令前缀。必须是整个正文的开头，见上方约束 1。 */
export const RELAUNCH_COMMAND = "/robin";

/** 机器可读标记：新 run 靠它认出「这是上一次自己发的重启评论」并取回 hop。 */
export const RELAUNCH_MARKER = "<!-- robin:relaunch -->";

/** 一次审查最多因为出口故障重启几次。0 表示彻底关闭这个行为。 */
export const DEFAULT_MAX_RELAUNCHES = 2;

/** 默认开启：出口被阻断时换一个 CI 继续，正是这个 action 存在的意义。 */
export const DEFAULT_RELAUNCH_ON_EGRESS_FAILURE = true;

export interface RelaunchDecision {
  /** 是否该发这条重启评论。false 时调用方应当正常失败。 */
  shouldRelaunch: boolean;
  /** 人类可读的判定理由，会进日志。 */
  reason: string;
  /** 本次发出去的 hop（从 1 开始）。shouldRelaunch 为 true 时才有意义。 */
  hop?: number;
}

export function resolveMaxRelaunches(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_MAX_RELAUNCHES;
  }
  const parsed = Number(String(raw).trim());
  // 非数字（用户笔误）：用文档化默认值，从宽。
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RELAUNCHES;
  // 数字但越界（负数/小数）：**夹到 0**，也就是彻底关掉重启。
  // 这里必须 fail closed 而不是 fail open —— 把 "-1" 悄悄当成"允许重启 2 次"
  // 会让这道护栏朝更松的方向失效，正是它本该防住的事故。
  return Math.max(0, Math.floor(parsed));
}

export function resolveRelaunchOnEgressFailure(
  raw: string | undefined | null,
): boolean {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_RELAUNCH_ON_EGRESS_FAILURE;
  }
  return !/^(false|0|no|off)$/i.test(String(raw).trim());
}

/**
 * 从已发评论里取回上一次重启用掉的 hop 数。
 *
 * 扫**最后**一次出现：一轮接一轮会在正文里叠出多条 `hop=`，取最新的那个才对。
 * 没有标记说明还没重启过（hop 0）。
 */
export function readPreviousHop(commentBodies: readonly (string | null | undefined)[]): number {
  let hop = 0;
  for (const body of commentBodies) {
    if (typeof body !== "string") continue;
    if (!body.includes(RELAUNCH_MARKER)) continue;
    const match = body.match(/hop=(\d+)/);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > hop) hop = parsed;
  }
  return hop;
}

/**
 * 决定这一轮要不要发重启评论。
 *
 * 三个条件同时成立才发：行为开着、错误确属瞬时出口故障、hop 还没用完。
 * 缺任何一个都应当正常失败 —— 静默不重启比盲目重启安全。
 */
export function decideRelaunch(input: {
  enabled: boolean;
  isTransientEgress: boolean;
  previousHop: number;
  maxRelaunches: number;
  errorText: string;
}): RelaunchDecision {
  if (!input.enabled) {
    return { shouldRelaunch: false, reason: "换出口已被输入关闭" };
  }
  if (!input.isTransientEgress) {
    // 永久性错误（域名写错、key 无效、模型不存在）换几次 CI 都不会变好，
    // 必须老老实实失败，否则配错一次配置就会被无限重启。
    return { shouldRelaunch: false, reason: "非瞬时出口故障，换 CI 也不会变好" };
  }
  if (input.previousHop >= input.maxRelaunches) {
    return {
      shouldRelaunch: false,
      reason: `已重启 ${input.previousHop} 次，达到上限 ${input.maxRelaunches}`,
    };
  }
  const hop = input.previousHop + 1;
  return {
    shouldRelaunch: true,
    hop,
    reason: `出口瞬时故障（${input.errorText}），发起第 ${hop}/${input.maxRelaunches} 次换 CI`,
  };
}

/**
 * 重启评论正文。
 *
 * `RELAUNCH_COMMAND` 必须在最前面（消费方守卫用 startsWith），其后才是标记与
 * 人类可读部分。
 */
export function buildRelaunchCommentBody(input: {
  hop: number;
  maxRelaunches: number;
  errorText: string;
}): string {
  return [
    RELAUNCH_COMMAND,
    "",
    RELAUNCH_MARKER,
    `hop=${input.hop} of ${input.maxRelaunches}`,
    "",
    `🔁 出口故障，放弃本次 CI 并换一个 CI 继续审查（第 ${input.hop}/${input.maxRelaunches} 次）。`,
    "",
    "**原因**（瞬时出口故障，换一个 runner 有机会恢复）：",
    "",
    "```",
    input.errorText,
    "```",
    "",
    `若连续 ${input.maxRelaunches} 次仍失败，说明不是瞬时问题，需要检查 gateway 与 LLM 出口配置。`,
    "",
    "<sub>本评论由 robin 自动发出，用于触发新的 CI run。上一轮的结论已由状态评论继承。</sub>",
  ].join("\n");
}

export interface RelaunchPlan {
  /** true = 调用方应当把 body 作为评论发出去；false = 应当正常失败。 */
  shouldPost: boolean;
  body?: string;
  reason: string;
  hop?: number;
}

/**
 * 这条重启评论**能不能真的起一个新 CI**？
 *
 * GitHub 有一条防递归规则：用仓库自带的 `GITHUB_TOKEN`（消费方通常写
 * `github-token: ${{ github.token }}`）创建的事件**不会**触发新的 workflow run，
 * 官方列出的例外只有 `workflow_dispatch` 与 `repository_dispatch`。
 * `issue_comment` 不在例外里 ⇒ 一条由 GITHUB_TOKEN 发的 `/robin` 评论
 * **永远不会**产生新 run。
 *
 * 生产实测（SiliconMod/Silicon，全仓 1287 个 run + 6 个 PR 的全部评论，
 * 见账本 R933）：human 评论 64/64 都产生了 `issue_comment` run，
 * `github-actions[bot]` 的评论 0/25；且用「必然被 job-if 拒掉的人类散文评论」
 * 做对照，22/22 都留下了 skipped run —— 证明「没有 run」是因为事件没产生，
 * 而不是被 job-if 拒掉。
 *
 * 所以在发评论**之前**就要认清这一点：识别出 GITHUB_TOKEN 时，
 * 不发评论、不声称换 CI，直接把这个事实连同替代方案报给用户。
 *
 * 识别方式：GITHUB_TOKEN 的值一律以 `ghs_` 开头（GitHub App 安装令牌前缀），
 * 而个人访问令牌是 `ghp_`（classic）或 `github_pat_`（fine-grained）。
 * 判据只做前缀匹配、拿不到 token 时按「未知」处理 —— **未知不等于不能用**，
 * 未知时维持原行为（发评论），因为本函数无权断言别人的 token 一定被抑制。
 */
export function isGithubActionsToken(token: string | undefined | null): boolean {
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("ghp_") || trimmed.startsWith("github_pat_")) return false;
  return trimmed.startsWith("ghs_");
}

/**
 * 把「读历史 hop → 判要不要重启 → 生成正文」串成一步，main.ts 只负责取评论和发评论。
 *
 * 放在这里而不是 main.ts，是因为这一整步是纯函数：没有 octokit、没有 IO，
 * 因此「永久错误不重启」「额度用完不重启」这两条安全约束可以被单测钉住，
 * 而不用去跑整条流水线。
 */
export function planRelaunch(input: {
  enabled: boolean;
  error: unknown;
  commentBodies: readonly (string | null | undefined)[];
  maxRelaunches: number;
  model?: string;
  /** 展示用的错误摘要；不给就用 errorMessage 兜底。 */
  errorText?: string;
  /**
   * 消费方给的 github-token。用来判断这条重启评论到底能不能起新 CI ——
   * 用 GITHUB_TOKEN 发的评论不会触发新 workflow run，发了也是白费。
   * **不给就当作不是 GITHUB_TOKEN**（维持原行为）：本函数无权断言别人的令牌
   * 一定被抑制，把「认不出」当成「不能用」会误杀换 CI 这条唯一有效的通道。
   */
  githubToken?: string;
}): RelaunchPlan {
  const isTransientEgress = isTransientEgressFailure(input.error, { model: input.model });
  const errorText = input.errorText || errorMessage(input.error);
  // 先判「能不能起新 CI」，再判「该不该重启」：前者是物理前提，后者是策略。
  // 顺序反过来的话，在 GITHUB_TOKEN 下会先把 hop 用掉再发现评论发不出去。
  if (isGithubActionsToken(input.githubToken)) {
    return {
      shouldPost: false,
      reason:
        "github-token 是 GITHUB_TOKEN（ghs_ 前缀）：用它发的评论不会触发新的 workflow run" +
        "（GitHub 防递归规则，例外只有 workflow_dispatch / repository_dispatch），" +
        "换 CI 不会发生。要启用请改用 PAT / GitHub App 令牌（ghp_ 或 github_pat_ 前缀）。",
    };
  }
  const decision = decideRelaunch({
    enabled: input.enabled,
    isTransientEgress,
    previousHop: readPreviousHop(input.commentBodies),
    maxRelaunches: input.maxRelaunches,
    errorText,
  });
  if (!decision.shouldRelaunch || decision.hop === undefined) {
    return { shouldPost: false, reason: decision.reason };
  }
  return {
    shouldPost: true,
    hop: decision.hop,
    reason: decision.reason,
    body: buildRelaunchCommentBody({
      hop: decision.hop,
      maxRelaunches: input.maxRelaunches,
      errorText,
    }),
  };
}
