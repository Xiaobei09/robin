import * as core from "@actions/core";
import * as github from "@actions/github";
import { LLMClient } from "./llm-client";
import {
  buildReasoningFallbackNotice,
  ReasoningFallbackReason,
} from "./reasoning-fallback";
import { GitUtils } from "./git-utils";
import { ReviewParser, StructuredReview } from "./review-parser";
import { shouldRetryStructuredReview } from "./review-retry";
import { GitHubReviewer, ROBIN_SIGNATURE, deletePreviousReviewComments, publishRobinComment } from "./github-reviewer";
import {
  buildFailedStatusBody,
  buildInitialStatusBody,
  decorateStatusCommentBody,
  extractInheritedVerdict,
  findLatestStatusComment,
} from "./status-comment";
import { errorMessage } from "./llm-retry";
import {
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_TIMEOUT_MS,
  parseLLMMaxAttempts,
  parseLLMTemperature,
  parseLLMTimeout,
  parseStrictNumber,
} from "./config";
import { filterDiff, splitDiffIntoFiles } from "./diff-filter";
import { annotateDiffWithLineNumbers } from "./diff-annotate";
import {
  DEFAULT_ACTION_MAX_DIFF_SIZE,
  DEFAULT_CONFIG_FILE,
  DEFAULT_MAX_COMMENTS,
  RepoConfig,
  parseRepoConfigYaml,
  resolveJsonResponseMode,
  resolveMaxComments,
  resolveMaxDiffSize,
  resolveReasoningEffort,
  resolveRequestChanges,
} from "./repo-config";
import { getReviewPrompt, getSummaryPrompt, getHelpMessage } from "./prompts/review-prompts";
import { ReviewerCommand, hasRequiredPermission, parseSlashCommand } from "./commands";
import {
  isGithubActionsToken,
  planRelaunch,
  resolveHeadSha,
  resolveMaxRelaunches,
  resolveRelaunchOnEgressFailure,
} from "./relaunch";

async function run(): Promise<void> {
  let octokit: ReturnType<typeof github.getOctokit> | undefined;
  let statusOwner = "";
  let statusRepo = "";
  let statusCommentId: number | undefined;
  let statusCommand: "review" | "summary" = "review";
  let statusModel = "not configured";
  let onJobCancelled: (() => Promise<void>) | undefined;
  // 「换出口」用得到的东西必须在 try 外面：决定重启的动作恰恰发生在 catch 里，
  // 而 catch 只能看到 run() 作用域的变量。prNumber 原本是 try 内部的 let，
  // 提到这里跟着 statusOwner/statusRepo 走。
  let statusPrNumber: number | undefined;
  let relaunchEnabled = false;
  let maxRelaunches = 0;
  let llmModel = "";
  // 同理：github-token 也是在 catch 里要用到的（判断这条重启评论能不能起新 CI），
  // 必须跟着上面几个变量一起提到 try 外面，否则 catch 里引用不到。
  let relaunchGithubToken = "";

  try {
    const eventName = github.context.eventName;
    const payload = github.context.payload;
    const token = core.getInput("github-token", { required: true });
    octokit = github.getOctokit(token);
    relaunchGithubToken = token;
    const minCommandPermission = core.getInput("min-command-permission") || "write";
    const reviewOnSynchronize = core.getBooleanInput("review-on-synchronize");

    core.info(`Event: ${eventName}`);

    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;
    statusOwner = owner;
    statusRepo = repo;

    let shouldRun = false;
    let prNumber: number | undefined;
    let command: ReviewerCommand = "review"; // default command for PR events

    if (eventName === "pull_request_target") {
      core.warning("pull_request_target is intentionally not supported because it can expose secrets to untrusted PR code. Use pull_request or maintainer-only issue_comment commands instead.");
      return;
    }

    if (eventName === "pull_request") {
      if (payload.action === "synchronize" && !reviewOnSynchronize) {
        core.info("Skipping pull_request synchronize event. Pushes to an existing PR are reviewed manually with /review unless review-on-synchronize is true.");
        return;
      }

      shouldRun = true;
      prNumber = payload.pull_request?.number;
    } else if (eventName === "issue_comment") {      const commentBody: string = payload.comment?.body || "";

      if (!payload.issue?.pull_request) {
        core.info("Issue comment is not on a pull request. Skipping.");
        return;
      }

      if (payload.comment?.user?.type === "Bot") {
        core.info("Ignoring bot comment.");
        return;
      }

      const parsedCommand = parseSlashCommand(commentBody);
      if (!parsedCommand) {
        core.info("No supported slash command found. Skipping.");
        return;
      }

      const commentAuthor = payload.comment?.user?.login;
      const authorized = await isAuthorizedCommenter(
        octokit,
        owner,
        repo,
        commentAuthor,
        minCommandPermission
      );

      if (!authorized) {
        core.warning(
          `Ignoring /${parsedCommand} from ${commentAuthor || "unknown user"}; minimum permission is ${minCommandPermission}.`
        );
        return;
      }

      await addEyesReaction(octokit, owner, repo, payload.comment?.id);

      command = parsedCommand;
      prNumber = payload.issue.number;

      if (command === "help") {
        await postHelpComment(octokit, payload);
        return;
      }

      shouldRun = true;
    }

    if (!shouldRun || !prNumber) {
      core.info("No matching trigger found. Skipping.");
      return;
    }
    statusPrNumber = prNumber;
    // 「换出口」的两个开关在这里读一次：输入可能非法/缺失，解析成确定值后
    // 存到外层，catch 里不必再解析、也不会在错误路径上抛新的异常。
    relaunchEnabled = resolveRelaunchOnEgressFailure(
      core.getInput("llm-relaunch-on-egress-failure")
    );
    maxRelaunches = resolveMaxRelaunches(core.getInput("llm-max-relaunches"));

    const apiKey = core.getInput("llm-api-key") || "ollama";
    const baseUrl = core.getInput("llm-base-url") || "";
    const model = core.getInput("model") || "";
    llmModel = model;
    const failOnHigh = core.getInput("fail-on-high") === "true";
    // 这两个兜底值是**哨兵**，不是「随便一个默认值」：resolveMaxComments /
    // resolveMaxDiffSize 靠「解析结果是否等于默认常量」来判断调用方是否真的没传，
    // 只有这时才让 .github/robin.yml 赢（review.yml 里那句 "omitted must stay
    // unset" 说的就是这件事）。所以它们必须与 action.yml / review.yml 的 default
    // 逐字相等 —— 写成字面量就等于把同一份真相复制一份，改一处忘另一处，哨兵静默
    // 失效：.github/robin.yml 被无声忽略，且没有任何报错。
    const maxDiffSizeInput = core.getInput("max-diff-size") || String(DEFAULT_ACTION_MAX_DIFF_SIZE);
    const maxCommentsInput = core.getInput("max-comments") || String(DEFAULT_MAX_COMMENTS);
    const maxOutputTokensInput = core.getInput("max-output-tokens") || "";
    // 同一个 parseInt 陷阱的第三例：parseInt("1e3") = 1，而 llm-client 只查
    // `> 0`，于是 1 会通过 ⇒ 模型被限到 1 个 token，审查输出几乎必然为空。
    const maxOutputTokensParsed = parseStrictNumber(maxOutputTokensInput);
    const maxOutputTokensValid =
      maxOutputTokensParsed.valid && Number.isInteger(maxOutputTokensParsed.value);
    if (maxOutputTokensInput && !maxOutputTokensValid) {
      core.warning(
        `Invalid max-output-tokens value "${maxOutputTokensInput}", ignoring it`,
      );
    }
    const maxOutputTokens =
      maxOutputTokensInput && maxOutputTokensValid ? maxOutputTokensParsed.value : undefined;
    const reasoningEffortInput = core.getInput("reasoning-effort") || "";
    const llmTimeoutMsInput = core.getInput("llm-timeout-ms") || "";
    const { value: llmTimeoutMs, valid: llmTimeoutValid } = parseLLMTimeout(llmTimeoutMsInput);
    if (!llmTimeoutValid) {
      // 不能在这里写死 DEFAULT_LLM_TIMEOUT_MS：解析失败会退回「未配置」，
      // 而未配置的超时由 resolveLlmTimeoutMs 按模型决定（OpenRouter 路由模型
      // 是 DEFAULT_LLM_ROUTER_TIMEOUT_MS）。文案说 600000 会与实际生效值不符。
      core.warning(`Invalid llm-timeout-ms value "${llmTimeoutMsInput}", using the built-in default`);
    }
    const llmTemperatureInput = core.getInput("llm-temperature") || "";
    const { value: llmTemperature, valid: llmTemperatureValid } =
      parseLLMTemperature(llmTemperatureInput);
    if (!llmTemperatureValid) {
      core.warning(
        `Invalid llm-temperature value "${llmTemperatureInput}", using default ${DEFAULT_LLM_TEMPERATURE}`
      );
    }

    // "Not configured" (empty / unparseable) resolves to undefined so the LLMClient
    // constructor default applies, which keeps getLlmCompletionAttemptCount's
    // OpenRouter free-router exception (5 attempts) intact.
    const llmMaxAttemptsInput = core.getInput("llm-max-attempts") || "";
    const { value: llmMaxAttempts, valid: llmMaxAttemptsValid } =
      parseLLMMaxAttempts(llmMaxAttemptsInput);
    if (!llmMaxAttemptsValid) {
      core.warning(
        `Invalid llm-max-attempts value "${llmMaxAttemptsInput}" ` +
          `(expected an integer 1-10); using the built-in default`
      );
    }
    const inlineReviewInstructions = core.getInput("review-instructions") || "";
    const reviewInstructionsFile = core.getInput("review-instructions-file") || "";
    const configFile = core.getInput("config-file") || DEFAULT_CONFIG_FILE;
    const jsonResponseModeInput = core.getInput("use-json-response-mode") || "";
    const requestChangesInput = core.getInput("request-changes") || "";

    core.info(`Model: ${model || "(not configured)"}`);

    core.info(`Running /${command} on PR #${prNumber} in ${owner}/${repo}`);
    statusCommand = command === "summary" ? "summary" : "review";
    statusModel = model || "not configured";
    statusCommentId = await resolveStatusCommentId(
        octokit,
        owner,
        repo,
        prNumber,
        command,
        statusModel
      );
    onJobCancelled = async () => {
      if (octokit && statusCommentId) {
        // The SIGTERM grace period is short — never let the superseded check
        // delay the status update past it. On timeout the check is abandoned
        // fire-and-forget; its own try/catch swallows any late rejection.
        const superseded = await Promise.race([
          isSupersededByNewerRun(octokit, statusOwner, statusRepo),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000).unref()),
        ]);
        await updateStatusComment(
          octokit,
          statusOwner,
          statusRepo,
          statusCommentId,
          superseded
            ? buildSupersededStatusBody(statusCommand)
            : buildCancelledStatusBody(statusCommand)
        );
      }
    };
    registerJobCancelHandler(async () => {
      if (onJobCancelled) {
        await onJobCancelled();
      }
    });

    if (!baseUrl) {
      throw new Error("Input required and not supplied: llm-base-url");
    }
    if (!model) {
      throw new Error("Input required and not supplied: model");
    }

    const gitUtils = new GitUtils(octokit as any);
    const baseRef = payload.pull_request?.base?.sha;
    const repoConfig = await loadRepoConfig(
      octokit,
      gitUtils,
      owner,
      repo,
      prNumber,
      configFile,
      baseRef
    );
    const { value: maxDiffSize, valid: maxDiffSizeValid } = resolveMaxDiffSize(
      maxDiffSizeInput,
      repoConfig,
    );
    if (!maxDiffSizeValid) {
      core.warning(
        `Invalid max-diff-size value "${maxDiffSizeInput}", using default ${DEFAULT_ACTION_MAX_DIFF_SIZE}`,
      );
    }
    const { value: maxComments, valid: maxCommentsValid } = resolveMaxComments(
      maxCommentsInput,
      repoConfig,
    );
    if (!maxCommentsValid) {
      core.warning(
        `Invalid max-comments value "${maxCommentsInput}", using default ${DEFAULT_MAX_COMMENTS}`,
      );
    }
    const jsonResponseMode = resolveJsonResponseMode(jsonResponseModeInput, repoConfig);
    const requestChanges = resolveRequestChanges(requestChangesInput, repoConfig);
    const reasoningEffort = resolveReasoningEffort(reasoningEffortInput, repoConfig);
    if (reasoningEffort) {
      core.info(`Reasoning effort: ${reasoningEffort}`);
    }

    const diff = await gitUtils.getPullRequestDiff(owner, repo, prNumber);
    
    if (!diff || diff.trim().length === 0) {
      core.warning("No diff found for this PR.");
      await updateStatusComment(
        octokit,
        owner,
        repo,
        statusCommentId,
        buildFailedStatusBody("No diff found for this pull request.", statusCommand)
      );
      return;
    }

    const diffFiles = splitDiffIntoFiles(diff);
    const { filtered: filteredDiff, removedFiles } = filterDiff(diff, repoConfig.skipPaths || []);
    if (removedFiles.length > 0) {
      core.info(`Skipped ${removedFiles.length} file(s) before review: ${removedFiles.join(", ")}`);
    }

    if (diffFiles.length > 0 && !filteredDiff.trim()) {
      core.info("All changed files were skipped by diff filters; no LLM review needed.");
      await updateStatusComment(
        octokit,
        owner,
        repo,
        statusCommentId,
        buildSkippedFilterStatusBody(removedFiles)
      );
      return;
    }

    const reviewDiff = filteredDiff.trim() ? filteredDiff : diff;
    if (!reviewDiff.trim()) {
      core.warning("No reviewable diff remained after filtering skipped paths.");
      await updateStatusComment(
        octokit,
        owner,
        repo,
        statusCommentId,
        buildFailedStatusBody("No reviewable diff remained after filtering skipped paths.", statusCommand)
      );
      return;
    }

    const truncatedDiff = reviewDiff.length > maxDiffSize 
      ? reviewDiff.slice(0, maxDiffSize) + "\n\n[... Diff truncated due to size limit]"
      : reviewDiff;

    core.info(
      `Diff size: ${reviewDiff.length} chars${reviewDiff.length > maxDiffSize ? " (truncated)" : ""}${removedFiles.length > 0 ? ` (${removedFiles.length} file(s) filtered)` : ""}`
    );
    const reviewInstructions = command === "review"
      ? await loadReviewInstructions(
        octokit,
        gitUtils,
        owner,
        repo,
        prNumber,
        inlineReviewInstructions,
        reviewInstructionsFile,
        baseRef
      )
      : "";

    const llm = new LLMClient(
      baseUrl,
      apiKey,
      model,
      maxOutputTokens,
      llmTimeoutMs,
      llmMaxAttempts,
      llmTemperature,
      async (detail) => {
        await updateStatusComment(
          octokit!,
          owner,
          repo,
          statusCommentId,
          buildProgressStatusBody(detail, statusCommand, statusModel)
        );
      },
      reasoningEffort
    );
    const useJsonMode = command === "review" && jsonResponseMode;
    
    let reviewText: string;
    if (command === "summary") {
      reviewText = (await runSummary(llm, truncatedDiff)).content;
    } else {
      reviewText = (await runReview(llm, truncatedDiff, reviewInstructions, useJsonMode)).content;
    }

    if (command === "summary") {
      // Post summary as a regular comment
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: ["## " + ROBIN_SIGNATURE + " · Summary", "", reviewText].join("\n"),
      });
      await updateStatusComment(
        octokit,
        owner,
        repo,
        statusCommentId,
        buildCompletedStatusBody("summary", undefined, llm.getReasoningFallbackReason())
      );
    } else {
      // Full review parsed and posted as a review
      core.info("Parsing review response...");
      let parsedReview = ReviewParser.parseDetailed(reviewText);
      let findings = parsedReview.findings;

      if (shouldRetryStructuredReview(findings, parsedReview.usedJson)) {
        core.warning("Structured review parse was empty; retrying once with JSON-only instructions.");
        await updateStatusComment(
          octokit,
          owner,
          repo,
          statusCommentId,
          buildProgressStatusBody(
            "First pass returned no parseable findings — retrying with JSON-only instructions…",
            statusCommand,
            statusModel
          )
        );
        const retryText = (
          await runReview(
            llm,
            truncatedDiff,
            `${reviewInstructions}\n\nReturn ONLY a single valid JSON object. Do not use markdown.`,
            true
          )
        ).content;
        parsedReview = ReviewParser.parseDetailed(retryText);
        findings = parsedReview.findings;
      }

      // R927：模型解析失败也换 CI（与 egress 瞬时故障同一 hop 上限）。
      // 触发面收窄到「两次都没能产出 JSON」：usedJson==false 且 0 条发现。
      // JSON 合法但 findings 为空（usedJson==true）是干净 PR 的正常形态，绝不能重开。
      {
        const count =
          findings.high.length +
          findings.medium.length +
          findings.low.length +
          findings.suggestions.length;
        if (count === 0 && !parsedReview.usedJson) {
          const parseErr = new Error(
            "empty response from llm: review unparsable after retry (no JSON object found)"
          );
          const msg = parseErr.message;
          await updateStatusComment(
            octokit,
            owner,
            repo,
            statusCommentId,
            buildFailedStatusBody(msg, statusCommand)
          );
          const relaunchedParse =
            octokit && statusPrNumber
              ? await maybeRelaunchOnEgressFailure({
                  octokit,
                  owner: statusOwner,
                  repo: statusRepo,
                  prNumber: statusPrNumber,
                  error: parseErr,
                  enabled: relaunchEnabled,
                  maxRelaunches,
                  model: llmModel,
                  githubToken: relaunchGithubToken,
                })
              : false;
          core.setFailed(msg);
          if (relaunchedParse) {
            core.info("已发起换 CI；本次 run 将被新 run 取代。");
          }
          return;
        }
      }

      core.info(`Found ${findings.high.length} high, ${findings.medium.length} medium, ${findings.low.length} low, ${findings.suggestions.length} suggestions`);

      const reviewer = new GitHubReviewer(octokit as any, maxComments);
      await reviewer.postReview(owner, repo, prNumber, findings, requestChanges);
      await updateStatusComment(
        octokit,
        owner,
        repo,
        statusCommentId,
        buildCompletedStatusBody("review", findings, llm.getReasoningFallbackReason())
      );

      if (findings.high.length > 0 && failOnHigh) {
        core.setFailed(`Found ${findings.high.length} high severity issue(s). Failing check.`);
      }
    }

    onJobCancelled = undefined;
    core.info("Done.");

  } catch (error) {
    // 这里必须走 errorMessage()，不能就地写 `error instanceof Error ? error.message : String(error)`：
    // 那条内联三元对空 message 会原样返回空串，于是失败评论里出现一个空的
    // `Reason:` 行（生产实证 SiliconMod/Silicon#67，run 36585231278）。
    // errorMessage() 兜空、并把 octokit 只写在壳里的原因（response.data.message）取出来。
    //
    // 注意这里只改「给人看的文本」。换 CI 的判定走的是下面传给 maybeRelaunchOnEgressFailure
    // 的原始 `error`（planRelaunch 内部自己分类，不收 errorText），
    // 所以永久性错误的 fail-closed 完全不受影响。
    const message = errorMessage(error);
    if (octokit && statusOwner && statusRepo && statusCommentId) {
      await updateStatusComment(octokit, statusOwner, statusRepo, statusCommentId, buildFailedStatusBody(message, statusCommand));
    }
    // 「换出口」放在失败状态评论之后：先让这一轮的结论落进评论（新 run 会继承），
    // 再决定要不要另起一个 CI。反过来的话，新 run 继承到的就是一条还没写完的评论。
    const relaunched =
      octokit && statusPrNumber
        ? await maybeRelaunchOnEgressFailure({
            octokit,
            owner: statusOwner,
            repo: statusRepo,
            prNumber: statusPrNumber,
            error,
            enabled: relaunchEnabled,
            maxRelaunches,
            model: llmModel,
            githubToken: relaunchGithubToken,
          })
        : false;
    // 已经发起重启的，这次 run 就该以失败告终：新 run 由
    // `concurrency: cancel-in-progress` 把当前 run 取消掉，状态评论
    // 会被认成 superseded，所以这里仍然照常 setFailed。
    core.setFailed(message);
    if (relaunched) {
      core.info("已发起换 CI；本次 run 将被新 run 取代。");
    }
  } finally {
    onJobCancelled = undefined;
  }
}

/**
 * 出口被 opencode 之类的网关阻断时：放弃当前 run，发一条 `/robin` 评论
 * 让消费方 workflow 起一个新 run（换 runner = 换出口），并把上一轮的
 * 评论继承过去。
 *
 * **永不抛出**。这一步的任何失败（列表评论 403、发评论 429、解析炸了……）
 * 都只记 warning —— 它发生在错误路径上，抛出去会把「真正的失败原因」顶掉，
 * 让人只看到一个无关紧要的 secondary failure。返回 true 表示评论已发出。
 */
async function maybeRelaunchOnEgressFailure(input: {
  octokit: any;
  owner: string;
  repo: string;
  prNumber: number;
  error: unknown;
  enabled: boolean;
  maxRelaunches: number;
  model: string;
  /** 用来判断这条评论到底能不能起新 CI；见 isGithubActionsToken。 */
  githubToken?: string;
}): Promise<boolean> {
  try {
    const commentBodies = await listIssueCommentBodies(
      input.octokit,
      input.owner,
      input.repo,
      input.prNumber
    );
    const headSha = await resolveHeadSha(
      input.octokit,
      input.owner,
      input.repo,
      input.prNumber,
      github.context.payload
    );
    const plan = planRelaunch({
      enabled: input.enabled,
      error: input.error,
      commentBodies,
      maxRelaunches: input.maxRelaunches,
      model: input.model,
      githubToken: input.githubToken,
      headSha,
    });
    if (!plan.shouldPost || !plan.body) {
      // 「发了也起不了新 CI」不是普通的信息，是消费方配错了凭据 ——
      // 用 warning 级别，让它在日志里能被一眼看见（info 会被淹在长日志里）。
      if (isGithubActionsToken(input.githubToken)) {
        core.warning(`不换出口：${plan.reason}`);
      } else {
        core.info(`不换出口：${plan.reason}`);
      }
      return false;
    }
    await input.octokit.rest.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.prNumber,
      body: plan.body,
    });
    core.info(plan.reason);
    return true;
  } catch (relaunchError) {
    core.warning(
      `换出口失败，退回为普通失败：${relaunchError instanceof Error ? relaunchError.message : String(relaunchError)}`
    );
    return false;
  }
}

/**
 * 列出 PR 上的全部评论正文，供 readPreviousHop 读回上一跳。
 *
 * 和 findLatestStatusComment 一样是 best-effort：列不出来就当没有历史
 * （hop 0），这是安全的一侧 —— 最坏结果是多重启一次，而不是不重启。
 */
async function listIssueCommentBodies(
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<string[]> {
  const listComments = octokit?.rest?.issues?.listComments;
  if (typeof octokit?.paginate !== "function" || !listComments) return [];
  const comments = await octokit.paginate(listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  if (!Array.isArray(comments)) return [];
  return comments
    .map((comment: any) => comment?.body)
    .filter((body: unknown): body is string => typeof body === "string");
}

async function addEyesReaction(
  octokit: any,
  owner: string,
  repo: string,
  commentId: number | undefined
): Promise<void> {
  if (!commentId) return;

  try {
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: "eyes",
    });
  } catch (error) {
    core.warning(`Could not add eyes reaction to trigger comment: ${error}`);
  }
}

/**
 * Post Robin's single comment for this run — or adopt the one already there.
 *
 * Delegates to `publishRobinComment`, which does the paginated lookup and then either
 * PATCHes the existing marker-carrying comment or POSTs a new one. That is the entire
 * restart story: run 2 rewrites run 1's comment instead of adding a sibling, so a PR
 * whose review workflow failed twice still shows exactly one Robin comment.
 */
async function postStatusComment(
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number,
  command: ReviewerCommand,
  model: string,
  inheritedVerdict?: string
): Promise<number | undefined> {
  return publishRobinComment(
    octokit,
    owner,
    repo,
    issueNumber,
    buildInitialStatusBody(
      command === "summary" ? "summary" : "review",
      model,
      inheritedVerdict
    )
  );
}

async function updateStatusComment(
  octokit: any,
  owner: string,
  repo: string,
  commentId: number | undefined,
  body: string
): Promise<void> {
  if (!commentId) return;

  try {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body: decorateStatusCommentBody(body),
    });
  } catch (error) {
    core.warning(`Could not update status comment: ${error}`);
  }
}

/**
 * Reuse the previous run's status comment when there is one.
 *
 * Every run used to create a fresh comment, so a PR reviewed several times carried several
 * "On it" comments and the newest could scroll out of view. A retried run now updates the
 * existing comment in place and carries the previous verdict forward, so the evaluation the
 * reader could already see is inherited instead of vanishing the moment a retry starts.
 *
 * Whichever branch it takes, it then drops Robin's *other* marked comments. Those only exist
 * on PRs reviewed before the marker was unified, but leaving them behind is exactly the
 * pile-up this function exists to remove. The cleanup requires all three of "carries the
 * marker", "authored by `github-actions[bot]`" and "is not the comment we just kept" —
 * the author check alone would reach unrelated comments from any other tool in the consumer
 * repo that comments as the default token (R1077).
 */
async function resolveStatusCommentId(
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number,
  command: ReviewerCommand,
  model: string
): Promise<number | undefined> {
  const existing = await findLatestStatusComment(octokit, owner, repo, issueNumber);

  let statusCommentId: number | undefined;
  if (!existing) {
    statusCommentId = await postStatusComment(octokit, owner, repo, issueNumber, command, model);
  } else {
    const inheritedVerdict = extractInheritedVerdict(existing.body);
    core.info(
      `Adopting Robin status comment #${existing.id} from a previous run` +
        (inheritedVerdict ? ` (carrying over: ${inheritedVerdict})` : "")
    );
    await updateStatusComment(
      octokit,
      owner,
      repo,
      existing.id,
      buildInitialStatusBody(command === "summary" ? "summary" : "review", model, inheritedVerdict)
    );
    statusCommentId = existing.id;
  }

  const removed = await deletePreviousReviewComments(octokit, owner, repo, issueNumber, statusCommentId);
  if (removed > 0) {
    core.info(`Removed ${removed} duplicate Robin comment(s) from earlier runs.`);
  }
  return statusCommentId;
}

function buildCompletedStatusBody(
  command: "review" | "summary",
  findings?: StructuredReview,
  reasoningFallbackReason?: ReasoningFallbackReason
): string {
  const fallbackNotice = buildReasoningFallbackNotice(reasoningFallbackReason);
  if (command === "summary") {
    return [
      "## " + ROBIN_SIGNATURE,
      "",
      ":white_check_mark: Summary's ready above.",
      ...(fallbackNotice ? ["", fallbackNotice] : []),
      "",
      "Want the full review? Comment `/robin`.",
    ].join("\n");
  }

  const totalFindings = findings
    ? findings.high.length + findings.medium.length + findings.low.length + findings.suggestions.length
    : 0;
  const result = totalFindings === 0
    ? "Nothing worth flagging — looks clean to me."
    : `I flagged ${totalFindings} thing${totalFindings === 1 ? "" : "s"} worth a look.`;

  return [
    "## " + ROBIN_SIGNATURE,
    "",
    `:white_check_mark: Review done. ${result}`,
    ...(fallbackNotice ? ["", fallbackNotice] : []),
    "",
    "Push fixes whenever you like, then comment `/robin` for another pass.",
  ].join("\n");
}

function buildSkippedFilterStatusBody(removedFiles: string[]): string {
  const preview = removedFiles.slice(0, 8).join(", ");
  const suffix = removedFiles.length > 8 ? `, and ${removedFiles.length - 8} more` : "";

  return [
    "## " + ROBIN_SIGNATURE,
    "",
    ":white_check_mark: Nothing to review here — only ignored paths changed.",
    "",
    `Skipped: ${preview}${suffix}`,
    "",
    "Add `skip-paths` in `.github/robin.yml` if that's not what you expected.",
  ].join("\n");
}

function buildProgressStatusBody(
  detail: string,
  command: "review" | "summary",
  model: string
): string {
  return [
    "## " + ROBIN_SIGNATURE,
    "",
    ":hourglass_flowing_sand: Still working on this pull request.",
    "",
    detail,
    "",
    `Mode: ${command === "summary" ? "summary" : "code review"}`,
    `Model: ${model}`,
  ].join("\n");
}

/**
 * True when a newer run of this same workflow exists — i.e. this run was
 * cancelled by concurrency `cancel-in-progress`, not by a human or a timeout.
 * Note: runs are matched per workflow, not per PR — a newer run on a different
 * PR can also count. Acceptable: this only softens the cancel-notice wording.
 * Best-effort: any API failure returns false.
 */
async function isSupersededByNewerRun(octokit: any, owner: string, repo: string): Promise<boolean> {
  try {
    const runId = Number(process.env.GITHUB_RUN_ID);
    const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
    if (!runId || !runNumber) return false;

    const { data: currentRun } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });

    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: currentRun.workflow_id,
      per_page: 10,
    });

    const superseded = data.workflow_runs.some(
      (run: { id: number; run_number: number }) => run.id !== runId && run.run_number > runNumber
    );
    core.info(
      superseded
        ? `Superseded by a newer workflow run (this is #${runNumber})`
        : `No newer workflow run found (this is #${runNumber})`
    );
    return superseded;
  } catch (error) {
    core.warning(`Could not check for a superseding run: ${error}`);
  }
  return false;
}

function buildSupersededStatusBody(command: "review" | "summary"): string {
  return [
    "## " + ROBIN_SIGNATURE,
    "",
    `:arrows_counterclockwise: This ${command === "summary" ? "summary" : "review"} run was replaced by a newer Robin run.`,
    "",
    "No action needed — the newer run posts its own result when it finishes.",
  ].join("\n");
}

function buildCancelledStatusBody(command: "review" | "summary"): string {
  return [
    "## " + ROBIN_SIGNATURE,
    "",
    `:warning: The ${command === "summary" ? "summary" : "review"} was interrupted before it finished.`,
    "",
    "This usually means the GitHub Actions job was cancelled or hit its time limit while waiting on the model.",
    "",
    "Comment `/robin` to run again.",
  ].join("\n");
}

function registerJobCancelHandler(onCancel: () => Promise<void>): void {
  let handled = false;
  const run = () => {
    if (handled) return;
    handled = true;
    void onCancel().finally(() => process.exit(143));
  };
  process.once("SIGTERM", run);
  process.once("SIGINT", run);
}

async function loadRepoConfig(
  octokit: any,
  gitUtils: GitUtils,
  owner: string,
  repo: string,
  prNumber: number,
  configFile: string,
  baseRef?: string
): Promise<RepoConfig> {
  const filePath = configFile.trim();
  if (!filePath) return {};

  try {
    let ref = baseRef;
    if (!ref) {
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      ref = pullRequest.base.sha;
    }

    if (!ref) return {};

    const fileContent = await gitUtils.getFileContent(owner, repo, filePath, ref);
    if (!fileContent.trim()) return {};

    core.info(`Loaded repo config from ${filePath}`);
    return parseRepoConfigYaml(fileContent);
  } catch (error) {
    core.info(`No repo config at ${filePath} (${error})`);
    return {};
  }
}

async function loadReviewInstructions(
  octokit: any,
  gitUtils: GitUtils,
  owner: string,
  repo: string,
  prNumber: number,
  inlineInstructions: string,
  instructionsFile: string,
  baseRef?: string
): Promise<string> {
  const instructions = inlineInstructions.trim() ? [inlineInstructions.trim()] : [];
  const filePath = instructionsFile.trim();

  if (!filePath) {
    return instructions.join("\n\n");
  }

  try {
    let ref: string;
    if (baseRef) {
      ref = baseRef;
    } else {
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      ref = pullRequest.base.sha;
    }

    const fileInstructions = await gitUtils.getFileContent(owner, repo, filePath, ref);
    if (fileInstructions.trim()) {
      core.info(`Loaded reviewer instructions from ${filePath}`);
      instructions.push(`Instructions from ${filePath}:\n${fileInstructions.trim()}`);
    }
  } catch (error) {
    core.warning(`Could not load review instructions from ${filePath}: ${error}`);
  }

  return instructions.join("\n\n");
}

async function isAuthorizedCommenter(
  octokit: any,
  owner: string,
  repo: string,
  username: string | undefined,
  minCommandPermission: string
): Promise<boolean> {
  if (!username) return false;

  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });

    return hasRequiredPermission(data.permission, minCommandPermission);
  } catch (error) {
    core.warning(`Could not verify permissions for ${username}: ${error}`);
    return false;
  }
}

async function postHelpComment(octokit: any, payload: any): Promise<void> {
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const issueNumber = payload.issue?.number;

  if (!issueNumber) return;

  const helpBody = getHelpMessage();
  
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: helpBody,
  });

  core.info("Posted help comment.");
}

async function runReview(
  llm: LLMClient,
  diff: string,
  reviewInstructions: string,
  jsonResponseMode: boolean
) {
  const systemPrompt = getReviewPrompt(reviewInstructions);
  const userContent = buildReviewInput(diff);
  core.info("Getting full code review...");
  return await llm.chatCompletion(systemPrompt, userContent, jsonResponseMode);
}

async function runSummary(llm: LLMClient, diff: string) {
  const systemPrompt = getSummaryPrompt();
  const userContent = buildSummaryInput(diff);
  core.info("Getting PR summary...");
  return await llm.chatCompletion(systemPrompt, userContent, false);
}

function buildReviewInput(diff: string): string {
  const annotated = annotateDiffWithLineNumbers(diff);
  return [
    "Review the following code diff and return only the strict JSON object described in the system prompt.",
    "Each line is prefixed with its line number in the NEW file (blank for removed lines and headers).",
    "For any line-specific finding, copy that exact number into the `line` field. Do not guess or recount.",
    "---",
    "CODE DIFF:",
    "```diff",
    annotated,
    "```",
  ].join("\n");
}

function buildSummaryInput(diff: string): string {
  return [
    "Summarize the following pull request diff. Provide:",
    "1. High-level overview of what changed",
    "2. Key files affected",
    "3. Any notable patterns or patterns that could be improved",
    "Be concise but informative.",
    "---",
    "CODE DIFF:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

run();
