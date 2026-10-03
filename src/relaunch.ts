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
import { parseStrictNumber } from "./config";

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

/**
 * 重启次数的硬上限。
 *
 * 这道护栏的作用就是「别让出口故障把维护者的 CI 配额烧光」，所以它自己必须有上界。
 * 修之前**根本没有上界**：`Number("1e3")` 是 1000，于是 `llm-max-relaunches: 1e3`
 * 会让同一次审查重启 1000 次 —— 正是本文件开头明令禁止的「无限重启 CI」。
 * 值取得和 `MAX_LLM_COMPLETION_ATTEMPTS`（同为 10）一致：默认的 5 倍，足够宽裕，
 * 又足以挡住笔误与脚本生成的怪值。
 */
export const MAX_RELAUNCHES = 10;

export function resolveMaxRelaunches(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_MAX_RELAUNCHES;
  }
  const trimmed = String(raw).trim();
  // 负数：夹到 0，也就是彻底关掉重启。这里必须 fail closed 而不是 fail open ——
  // 把 "-1" 悄悄当成"允许重启 2 次"会让这道护栏朝更松的方向失效，
  // 正是它本该防住的事故。
  //
  // 必须**先于** parseStrictNumber 处理：`parseStrictNumber` 按设计只接受纯十进制
  // 写法（连 `+1` / `1.` 都拒，见 config.ts），所以 `-1` 会落到下面的"无效"分支
  // 拿到默认值 2 —— 恰好是本段最要防的那个方向。负号是有意义的语义，不是拼写错误。
  if (trimmed.startsWith("-")) return 0;
  // 走 parseStrictNumber 而不是裸 `Number()`：后者会把十六进制/二进制/科学计数法
  // 「照猜的读」成一个合法数字。实测 `1e1` → 10（静默把上限抬到 5 倍）、
  // `0b11` → 3、`1e3` → 1000，全部外观合法、零告警。
  // 判定「什么算合法数字写法」只应有一处（config.ts 的 parseStrictNumber），
  // 各文件自己写 `Number()` 就是这种漂移的来源。
  const { value: parsed, valid } = parseStrictNumber(trimmed);
  // 非数字**以及**非十进制写法（都是用户笔误）：用文档化默认值，从宽。
  // 这里从宽是安全的 —— 默认值 2 本身有界，而把 `1e3` 当成合法才是危险的。
  if (!valid) return DEFAULT_MAX_RELAUNCHES;
  // 小数（如 "2.9" 次重启）没有意义。向下取整是**保守**方向：不会超过调用方
  // 要求的次数，2.9 次本就该读作 2 次。（不要改成夹到 0 —— 既有测试钉的是
  // `2.9 → 2`，且从宽的这一侧并不放松护栏。原先此处"小数夹到 0"的注释与代码不符。）
  const whole = Math.floor(parsed);
  // 超上限：夹到上限而不是退回默认值 —— 既保住调用方的意图，又保证有界。
  return Math.min(whole, MAX_RELAUNCHES);
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
 * 取被审查的 head commit，用来给 hop 记账划作用域（见 readPreviousHop）。
 *
 * **best-effort，拿不到就返回 undefined**，而 undefined 的含义是「不划作用域＝
 * 全算历史 hop」——也就是老行为、偏保守的一侧。所以这里失败是可以接受的，
 * 不能接受的是「猜一个 sha 填进去」：猜错会让额度算到别的 commit 上，
 * 既可能白烧 CI 分钟，也可能把本次该有的重启误判成超限。
 *
 * `pull_request` 事件的 payload 自带 head sha（免费）；`issue_comment` 事件没有，
 * 才发一次 pulls.get。整条重启路径本来就已经在发 listComments 请求了，
 * 多这一次不影响成本量级。
 *
 * 放在这里而不是 main.ts，是因为它有真正的分支逻辑（payload 优先、API 兜底、
 * 各种失败形态都归一到 undefined），而这些分支正是需要被单测钉住的东西 ——
 * R937 的 M9/M10 两次变异存活，就是因为它当时躺在 main.ts 里、没人能测。
 */
export async function resolveHeadSha(
  octokit: any,
  owner: string,
  repo: string,
  prNumber: number,
  payload?: unknown
): Promise<string | undefined> {
  const fromPayload = (payload as any)?.pull_request?.head?.sha;
  if (typeof fromPayload === "string" && fromPayload.trim()) {
    return fromPayload.trim();
  }
  try {
    const pulls = octokit?.rest?.pulls;
    if (typeof pulls?.get !== "function") return undefined;
    const { data } = await pulls.get({ owner, repo, pull_number: prNumber });
    const head = data?.head?.sha;
    return typeof head === "string" && head.trim() ? head.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 两个 sha 是否指同一个 commit（容忍一边是缩写）。 */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

interface RelaunchMeta {
  hop?: number;
  headSha?: string;
}

/**
 * 解析重启评论的机器可读块：`RELAUNCH_MARKER` 之后、连续形如 `key=value` 的那几行。
 *
 * **只读这一段，不全文搜 `hop=`**。错误摘要是网关/用户给的自由文本，里面完全可能
 * 出现 `hop=99` 或 `sha=<某个 commit>`；全文搜索会让一条普通评论伪装成「已经用掉
 * 99 次额度」，或者把额度算到不相干的 commit 上 —— 而 hop 是**成本护栏**，
 * 被伪造的方向只会是「多重启」，也就是白烧 CI 分钟。
 *
 * 块的结束条件有两个：空行，或出现第一行不含 `=` 的内容（人类可读部分开始）。
 * 块起始前的空行直接跳过 —— 正文里 marker 后面本来就跟着换行。
 */
function parseRelaunchMeta(body: string): RelaunchMeta {
  const start = body.indexOf(RELAUNCH_MARKER);
  if (start < 0) return {};
  const meta: RelaunchMeta = {};
  let started = false;
  for (const line of body.slice(start + RELAUNCH_MARKER.length).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (started) break;
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) break;
    started = true;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "hop") {
      // 正文写的是 `hop=1 of 2`，取第一个 token 才是跳数。
      //
      // 为什么不能用裸 `Number()`（R1075）：`Number("")` 是 0 且 `isFinite(0)`
      // 为真，于是**空值被读成一条合法的「已用 0 次」声明** —— 解析器凭空造出一个
      // 数值，而不是拒绝这份声明。`hop=abc` 反而是对的（NaN → 跳过），所以这个洞
      // 只在「键在、值空」时出现，最容易漏看。
      //
      // 今天它没造成后果，**只是因为聚合是取 max**：造出来的 0 抬不高已有的 hop。
      // 但同一段代码里「后出现的 hop 覆盖先出现的」（下面直接赋值）意味着这条
      // 造值逻辑一旦被单独读到，就是一个会编造事实的解析器。判定「什么算合法数字
      // 写法」只应有一处 ⇒ 复用 `parseStrictNumber`（R1071/R1073 立的规矩）。
      const token = value.split(/\s+/)[0] ?? "";
      if (token) {
        const { value: parsed, valid } = parseStrictNumber(token);
        if (valid) meta.hop = parsed;
      }
    } else if (key === "sha" && /^[0-9a-fA-F]{7,40}$/.test(value)) {
      meta.headSha = value;
    }
  }
  return meta;
}

/**
 * 从已发评论里取回上一次重启用掉的 hop 数。
 *
 * 扫**最后**一次出现：一轮接一轮会在正文里叠出多条 `hop=`，取最新的那个才对。
 * 没有标记说明还没重启过（hop 0）。
 *
 * **作用域（`headSha`）**：hop 额度是「这一次审查」的上限，不是「这个 PR 有史以来」
 * 的上限。早期版本不划作用域，于是同一个 PR 上任何一次历史故障烧掉的 hop 会
 * **永久**钉死这个 PR 的额度 —— 三周后新推一个 commit、出口又坏了，本该有的两次
 * 重启一次都拿不到，而且没有任何日志解释为什么。所以：给了 `headSha` 时，只认
 * 同一 commit 上的重启评论；换了 commit 就是一次新审查，额度重新算。
 *
 * 为什么用 commit 而不是时间窗口：时间窗口一旦短于「一轮级联的实际时长」
 * （`llm-timeout` 可配到很大，一次失败就能耗掉几十分钟），窗口外的重启评论
 * 就不再计数 ⇒ 额度每轮重置 ⇒ **无限重启**，护栏反向失效。commit 作用域没有
 * 这个失效方向：同一个 commit 上 hop 必然单调递增到上限，换 commit 才会重置。
 *
 * **fail closed 的两处，都往「不敢多重启」的方向偏**：
 * - 拿不到当前 head（`headSha` 为空）⇒ 照旧全算，等于老行为，宁可少重启。
 * - 老版本 robin 发的评论没带 `sha=` 行 ⇒ 不计入当前额度，会多给一次机会。
 *   往贵的那侧偏一格，可接受；反方向则会白烧 CI 分钟。
 */
export function readPreviousHop(
  commentBodies: readonly (string | null | undefined)[],
  opts: { headSha?: string | null } = {},
): number {
  const headSha = typeof opts.headSha === "string" ? opts.headSha.trim() : "";
  let hop = 0;
  for (const body of commentBodies) {
    if (typeof body !== "string") continue;
    const meta = parseRelaunchMeta(body);
    if (meta.hop === undefined) continue;
    if (headSha) {
      // 没有 sha 行的旧评论、以及属于别的 commit 的评论，都不占用本次额度。
      if (!meta.headSha || !sameCommit(meta.headSha, headSha)) continue;
    }
    if (meta.hop > hop) hop = meta.hop;
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
 * 把错误文本收拾成能安全放进围栏代码块的一行。
 *
 * **为什么在这里做，而不是指望上游。** `errorMessage()` 会把空白折叠成空格，所以走
 * 默认路径（`main.ts` 调 `planRelaunch` 时不传 `errorText`）时围栏本来就击不穿 ——
 * 这条安全性是**偶然**的：它成立只因为「恰好没有调用方传 `errorText`」，而这是个
 * 没有任何断言看守的前提。一旦有人开始传多行或含围栏的 `errorText`，围栏一破，
 * 剩下的错误文本就以正文 markdown 渲染出来：里面的 `*` / `_` / `[` 会被解析成强调或
 * 链接，而它来自网关的**自由文本** —— 用户会看到一段被渲染坏的、来源不明的内容，
 * 还可能带上一条假链接。
 *
 * 在使用点收敛，代价是几行代码；换来的是「无论调用方传什么都不会击穿」。
 */
function fenceSafe(text: string): string {
  return String(text ?? "")
    // 三个及以上连续反引号就能闭合 ``` 围栏，无论它在行内还是独占一行。
    .replace(/`{3,}/g, "'" + "'" + "'")
    .replace(/\s+/g, " ")
    .trim();
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
  /** 被审查的 head commit；给了就写进正文，用来给 hop 记账划作用域。 */
  headSha?: string | null;
}): string {
  const lines = [
    RELAUNCH_COMMAND,
    "",
    RELAUNCH_MARKER,
    `hop=${input.hop} of ${input.maxRelaunches}`,
  ];
  const headSha = typeof input.headSha === "string" ? input.headSha.trim() : "";
  if (headSha) lines.push(`sha=${headSha}`);
  return [
    ...lines,
    "",
    `🔁 出口故障，放弃本次 CI 并换一个 CI 继续审查（第 ${input.hop}/${input.maxRelaunches} 次）。`,
    "",
    "**原因**（瞬时出口故障，换一个 runner 有机会恢复）：",
    "",
    "```",
    fenceSafe(input.errorText),
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
  /**
   * 被审查的 head commit。给 readPreviousHop 划作用域：换了 commit 就是一次
   * 新审查，hop 额度重新算。不给＝不划作用域（＝老行为，全算），这是安全的一侧。
   */
  headSha?: string | null;
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
    previousHop: readPreviousHop(input.commentBodies, { headSha: input.headSha }),
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
      headSha: input.headSha,
    }),
  };
}
