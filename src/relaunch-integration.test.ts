import { readFileSync } from "fs";
import { join } from "path";
import {
  deletePreviousReviewComments,
  publishRobinComment,
  REVIEW_MARKER,
  ROBIN_BOT_LOGIN,
} from "./github-reviewer";
import {
  buildInitialStatusBody,
  decorateStatusCommentBody,
  findLatestStatusComment,
} from "./status-comment";
import { planRelaunch, RELAUNCH_MARKER, resolveHeadSha } from "./relaunch";

/**
 * 跨模块因果链测试（R1079）。
 *
 * **为什么单独开一个文件。** 本会话的每一处修复都是按单元测的：
 * 评论去重在 `github-reviewer.test.ts`，hop 记账在 `relaunch.test.ts`，
 * 状态评论在 `status-comment.test.ts`。每个套件都全绿，但**没有任何一个测试
 * 跑过它们串起来的那条链** —— 而 R1077 的缺陷恰恰只存在于链上：
 * `deletePreviousReviewComments` 单看是对的（它确实只删自己该删的），
 * 错在它被放在 hop 记账的**上游**，于是清理动作会影响下一轮读到的 hop。
 *
 * 单元测试按定义看不见这类缺陷：缺陷不在任何单个单元里，在**顺序**里。
 *
 * **本文件覆盖什么、不覆盖什么（不夸大）。**
 * 覆盖：导出的原语按 `main.ts` 的真实顺序、在同一个共享 store 上组合时的行为。
 * 不覆盖：`main.ts` 内部 `run()` 的完整控制流。
 * 原因：`resolveStatusCommentId` 是 `main.ts` 的模块私有函数，而 `main.ts` 一被
 * import 就整个 `run()` 起来（R941 已记录这个问题，当时为此把状态评论的正文
 * 构造器搬了出去）。所以「接线是否真的这样」改用**源码扫描**钉住 ——
 * 行为测试测组合，扫描钉住组合的前提。两者缺一，结论都不成立。
 */

/** 一个 PR 上的评论存储；行为与 GitHub 的 issue comments 一致。 */
interface Comment {
  id: number;
  user: { login: string };
  body: string;
}

function makeStore(seed: Comment[] = []) {
  const comments: Comment[] = [...seed];
  let nextId = 1000;
  const octokit: any = {
    paginate: async () => comments.map((c) => ({ ...c })),
    rest: {
      issues: {
        listComments: "listComments",
        createComment: jest.fn(async (p: any) => {
          const created = { id: nextId++, user: { login: ROBIN_BOT_LOGIN }, body: p.body };
          comments.push(created);
          return { data: { id: created.id } };
        }),
        updateComment: jest.fn(async (p: any) => {
          const hit = comments.find((c) => c.id === p.comment_id);
          if (!hit) throw new Error(`no comment ${p.comment_id}`);
          hit.body = p.body;
          return { data: { id: hit.id } };
        }),
        deleteComment: jest.fn(async (p: any) => {
          const i = comments.findIndex((c) => c.id === p.comment_id);
          if (i < 0) throw new Error(`no comment ${p.comment_id}`);
          comments.splice(i, 1);
          return { data: {} };
        }),
      },
    },
  };
  return { octokit, comments };
}

const SHA = "b".repeat(40);
const OWNER = "o";
const REPO = "r";
const PR = 68;

function markedRobinComments(comments: Comment[]): Comment[] {
  return comments.filter((c) => c.body.includes(REVIEW_MARKER));
}

function relaunchComments(comments: Comment[]): Comment[] {
  return comments.filter((c) => c.body.includes(RELAUNCH_MARKER));
}

/**
 * 一轮 run 的骨架，**严格照 `main.ts` 的顺序**：
 *   resolveStatusCommentId（认领或新建状态评论 → 清理其它 Robin 评论）
 *   → 干活（这里恒定失败：模拟出口瞬时故障）
 *   → maybeRelaunchOnEgressFailure（读回 hop，决定要不要发重启评论）
 */
async function simulateRun(store: ReturnType<typeof makeStore>, maxRelaunches = 2) {
  const { octokit, comments } = store;

  // --- resolveStatusCommentId ---
  const existing = await findLatestStatusComment(octokit, OWNER, REPO, PR);
  let statusCommentId: number | undefined;
  if (!existing) {
    statusCommentId = await publishRobinComment(
      octokit,
      OWNER,
      REPO,
      PR,
      buildInitialStatusBody("review", "model-x")
    );
  } else {
    await octokit.rest.issues.updateComment({
      owner: OWNER,
      repo: REPO,
      comment_id: existing.id,
      body: decorateStatusCommentBody(buildInitialStatusBody("review", "model-x")),
    });
    statusCommentId = existing.id;
  }
  await deletePreviousReviewComments(octokit, OWNER, REPO, PR, statusCommentId);

  // --- 干活失败：出口瞬时故障 ---
  const plan = await planRelaunch({
    enabled: true,
    error: Object.assign(new Error("fetch failed"), { name: "FetchError" }),
    commentBodies: comments.map((c) => c.body),
    maxRelaunches,
    githubToken: "ghp_pat_token", // PAT：不是 GITHUB_TOKEN，所以不会短路
    headSha: SHA,
  });
  if (plan.shouldPost && plan.body) {
    await octokit.rest.issues.createComment({ owner: OWNER, repo: REPO, issue_number: PR, body: plan.body });
  }
  return plan;
}

describe("跨模块：评论去重与 hop 记账串在一条链上", () => {
  it("出口持续坏掉时，Robin 评论恒为一条，hop 严格递增到上限后停", async () => {
    const store = makeStore();

    const hops: number[] = [];
    for (let i = 0; i < 5; i++) {
      const plan = await simulateRun(store);
      // 每轮都必须仍然只有**一条** Robin 评论（状态评论即 review 评论）。
      expect(markedRobinComments(store.comments)).toHaveLength(1);
      if (plan.shouldPost) hops.push(plan.hop!);
    }

    // 上限 2 ⇒ 首发 1 次 + 重启 2 次，共 3 条重启评论，第 4、5 轮不再发。
    expect(hops).toEqual([1, 2]);
    expect(relaunchComments(store.comments)).toHaveLength(2);
    // 护栏成立的核心：计数单调递增到上限，而不是每轮都从 0 重新开始。
    expect(hops).toEqual([...hops].sort((a, b) => a - b));
  });

  it("**清理不会吃掉 hop 的记账载体** —— R1077 缺陷的判别性断言", async () => {
    // 这条是本文件存在的理由。若 deletePreviousReviewComments 少判 marker，
    // 上一轮的 /robin 评论会在下一轮开头被删掉 ⇒ readPreviousHop 读回 0
    // ⇒ 额度每轮重置 ⇒ 上面那个「hops === [1, 2]」会变成 [1, 1, 1, 1, 1]。
    // 换句话说：**hop 护栏是否真的被钉住，取决于一个删除动作不越界。**
    const store = makeStore();
    await simulateRun(store);
    expect(relaunchComments(store.comments)).toHaveLength(1);

    await simulateRun(store);
    // 第二轮开头清理跑过之后，第一轮的记账必须还在。
    expect(relaunchComments(store.comments)).toHaveLength(2);
    expect(relaunchComments(store.comments)[0].body).toContain("hop=1 of 2");
  });

  it("别人用同一个 bot 身份发的评论不会被清理连带删掉", async () => {
    const store = makeStore([
      { id: 42, user: { login: ROBIN_BOT_LOGIN }, body: "coverage: 91.2%" },
      { id: 43, user: { login: "octocat" }, body: "human question" },
    ]);
    await simulateRun(store);
    expect(store.comments.some((c) => c.id === 42)).toBe(true);
    expect(store.comments.some((c) => c.id === 43)).toBe(true);
  });

  it("审查成功的那一轮之后，重启评论仍在（hop 按 commit 记账，不随成功清零）", async () => {
    const store = makeStore();
    await simulateRun(store);
    await simulateRun(store); // 两条重启评论，hop 已到上限
    const before = relaunchComments(store.comments).length;

    // 第三轮：LLM 成功 ⇒ 不发重启评论，但 resolveStatusCommentId 的清理照跑。
    const existing = await findLatestStatusComment(store.octokit, OWNER, REPO, PR);
    await store.octokit.rest.issues.updateComment({
      owner: OWNER,
      repo: REPO,
      comment_id: existing!.id,
      body: decorateStatusCommentBody(buildInitialStatusBody("review", "model-x")),
    });
    await deletePreviousReviewComments(store.octokit, OWNER, REPO, PR, existing!.id);

    // 清理只针对带 marker 的 Robin 评论；重启评论带的是另一种 marker。
    expect(relaunchComments(store.comments)).toHaveLength(before);
    expect(markedRobinComments(store.comments)).toHaveLength(1);
  });

  it("head 变了就是一次新审查，额度重新算（作用域边界）", async () => {
    const store = makeStore();
    await simulateRun(store);
    await simulateRun(store);
    expect(relaunchComments(store.comments)).toHaveLength(2);

    // 换一个 commit：旧的重启评论带着旧 sha，不该占用新 commit 的额度。
    const nextSha = "c".repeat(40);
    const plan = await planRelaunch({
      enabled: true,
      error: new Error("fetch failed"),
      commentBodies: store.comments.map((c) => c.body),
      maxRelaunches: 2,
      githubToken: "ghp_pat_token",
      headSha: nextSha,
    });
    expect(plan.shouldPost).toBe(true);
    expect(plan.hop).toBe(1);
  });

  it("resolveHeadSha 在 issue_comment 载荷下靠 API 兜底（payload 里没有 pull_request）", async () => {
    // 重启是由 /robin 评论触发的 issue_comment run，载荷里只有 issue.pull_request。
    const octokit: any = { rest: { pulls: { get: jest.fn().mockResolvedValue({ data: { head: { sha: SHA } } }) } } };
    await expect(resolveHeadSha(octokit, OWNER, REPO, PR, { issue: { pull_request: { url: "x" } } })).resolves.toBe(SHA);
  });
});

describe("跨模块：接线（源码扫描）", () => {
  const src = readFileSync(join(__dirname, "main.ts"), "utf8");

  it("清理用的 keepId 就是本轮认领/新建的状态评论 id", () => {
    // 若这里传错（比如传 undefined 或别的 id），清理会把唯一那条 Robin 评论删掉。
    expect(src).toMatch(/deletePreviousReviewComments\(\s*octokit,\s*owner,\s*repo,\s*issueNumber,\s*statusCommentId\s*\)/);
  });

  it("清理发生在读 hop 之前 —— 顺序本身就是 R1077 那条链的前提", () => {
    // 不钉住顺序 someday 有人把清理挪到失败路径之后，链就断了而所有单测仍绿。
    const resolveAt = src.indexOf("statusCommentId = await resolveStatusCommentId(");
    const relaunchAt = src.indexOf("maybeRelaunchOnEgressFailure(");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(relaunchAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(relaunchAt);
  });
});