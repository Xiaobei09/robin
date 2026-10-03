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
  resolveStatusCommentId,
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
 * 一轮 run 的骨架，**直接调用真实的 `resolveStatusCommentId`**，不是手写复刻。
 *
 * R1081 之前它住在 `main.ts` 且是模块私有的，于是本文件只能照着源码复刻一遍编排
 * —— 复刻件与真件会漂移（改了一边忘了另一边，测试照样绿）。
 * 现在编排本身是导出的，测试跑的是生产代码。
 */
async function simulateRun(store: ReturnType<typeof makeStore>, maxRelaunches = 2) {
  const { octokit, comments } = store;

  // --- resolveStatusCommentId：认领或新建状态评论 → 清理其它 Robin 评论 ---
  await resolveStatusCommentId(octokit, OWNER, REPO, PR, "review", "model-x");

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
    await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "review", "model-x");

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

describe("resolveStatusCommentId：从源码扫描升级为行为测试（R1081）", () => {
  /**
   * R1081 之前，这个函数是 `main.ts` 的模块私有，而 `main.ts` 一被 import 就整个
   * `run()` 起来 —— 所以关于它只能写**源码扫描**式断言。扫描能防「被改坏」，
   * 防不了「逻辑本来就是错的」：keepId 传错对象、清理早于认领、返回 undefined
   * 这三种错误写法都不会让一行 `toMatch` 变红。
   *
   * 搬成导出之后，下面每一条都是真的调用生产代码。
   */
  it("首次运行新建一条，返回它的 id", async () => {
    const store = makeStore();
    const id = await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "review", "model-x");
    expect(id).toBe(1000);
    expect(markedRobinComments(store.comments)).toHaveLength(1);
  });

  it("再次运行认领同一条（id 不变），不会新建第二条", async () => {
    const store = makeStore();
    const first = await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "review", "model-x");
    const second = await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "review", "model-x");
    expect(second).toBe(first);
    expect(markedRobinComments(store.comments)).toHaveLength(1);
  });

  it("返回的 id 就是它保住的那条 —— 清理不会误删它自己", async () => {
    // 传错 keepId（比如传 undefined）时，这条唯一评论会被删掉 ⇒ 返回的 id 变成死链。
    const store = makeStore();
    const id = await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "review", "model-x");
    expect(store.comments.some((c) => c.id === id)).toBe(true);
    await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "review", "model-x");
    expect(store.comments.filter((c) => c.id === id)).toHaveLength(1);
  });

  it("清理历史重复：老版本留下的另一条带 marker 评论被删，最新的那条被认领保留", async () => {
    const store = makeStore([
      { id: 10, user: { login: ROBIN_BOT_LOGIN }, body: `${REVIEW_MARKER}\n旧的审查结论` },
      { id: 11, user: { login: ROBIN_BOT_LOGIN }, body: `${REVIEW_MARKER}\n另一条旧的` },
    ]);
    const kept = await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "review", "model-x");
    expect(markedRobinComments(store.comments)).toHaveLength(1);
    // 保留的是**最新**那条（被认领、原地改写），不是重建一条新的。
    expect(kept).toBe(11);
    expect(store.comments.some((c) => c.id === 10)).toBe(false);
  });

  it("三条跑下来仍然恰好一条，且最后一条内容是本轮的", async () => {
    const store = makeStore();
    await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "review", "model-x");
    await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "summary", "model-y");
    await resolveStatusCommentId(store.octokit, OWNER, REPO, PR, "review", "model-z");
    expect(markedRobinComments(store.comments)).toHaveLength(1);
    expect(markedRobinComments(store.comments)[0].body).toContain("model-z");
  });
});

describe("接线（源码扫描）：main.ts 里无法单测的契约", () => {
  const src = readFileSync(join(__dirname, "main.ts"), "utf8");

  /**
   * 按**下一个函数声明**切片，而不是按固定字符数 —— 固定字符数够不到函数末尾时
   * 会让「锚点存在但片段不够长」伪装成一条莫名其妙的断言失败（R1087 踩过）。
   */
  function fnSegment(name: string): string {
    const start = src.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = src.slice(start + 1);
    const next = rest.search(/\n(?:async )?function [A-Za-z]/);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("清理发生在读 hop 之前 —— 顺序本身就是 R1077 那条链的前提", () => {
    // keepId 传什么已经由上面的行为测试覆盖了（升级后的部分）；
    // 但「先清理、后读 hop」这个**跨函数顺序**仍是 main.ts 的内部事实，只能扫描。
    // 不钉住顺序 someday 有人把 resolveStatusCommentId 挪到失败路径之后，链就断了。
    const resolveAt = src.indexOf("statusCommentId = await resolveStatusCommentId(");
    const relaunchAt = src.indexOf("maybeRelaunchOnEgressFailure(");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(relaunchAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(relaunchAt);
  });

  it("编排函数已从 main.ts 搬出，不再是模块私有的", () => {
    // 防回退：这三段代码一旦被搬回 main.ts，上面那些行为测试就又变成测不到生产代码了。
    expect(src).not.toMatch(/^async function (postStatusComment|updateStatusComment|resolveStatusCommentId)\(/m);
    expect(src).toMatch(/resolveStatusCommentId,/);
  });

  /**
   * R1088：`listIssueCommentBodies` 的注释承诺「列不出来就当没有历史 ⇒ 最坏是多重启
   * 一次」，但**没有 try/catch** ⇒ `paginate` 抛错时整条重启评论都不发。
   *
   * 这条只能扫描：`listIssueCommentBodies` 是 main.ts 的模块私有函数，import 即执行。
   * 而它确实是本轮的核心契约（链的"降级方向"），不是可有可无的接线。
   */
  it("读历史失败要降级（当没有历史），不能把整条重启放弃", () => {
    const seg = fnSegment("listIssueCommentBodies");

    const paginateAt = seg.indexOf("await octokit.paginate(");
    expect(paginateAt).toBeGreaterThan(-1);
    // paginate 必须在 try 里。用 lastIndexOf 找它之前最近的 try {。
    const tryAt = seg.lastIndexOf("try {", paginateAt);
    expect(tryAt).toBeGreaterThan(-1);
    expect(tryAt).toBeLessThan(paginateAt);

    // catch 必须在 paginate 之后。**只取花括号内的 catch 体**：
    // 用固定字符窗口会被后面**另一处** `return [];`
    // （`if (!Array.isArray(comments)) return [];`）满足 —— R1088 的 T2 变异
    // （把 catch 里的 return [] 改成 throw）就是这样**存活**下来的。
    // 判据固化：扫描一段代码要按结构边界取，不能按字符数取。
    const catchAt = seg.indexOf("} catch (error) {", paginateAt);
    expect(catchAt).toBeGreaterThan(paginateAt);
    const open = seg.indexOf("{", catchAt);
    let depth = 0;
    let end = -1;
    for (let i = open; i < seg.length; i++) {
      if (seg[i] === "{") depth++;
      else if (seg[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(open);
    const body = seg.slice(open + 1, end);

    // 必须 return []（= hop 0），而不是继续往上抛 ⇒ 整条重启被放弃
    expect(body).toContain("return [];");
    // 降级要留痕，否则一次持续的 403 会让"为什么不重启"完全不可见
    expect(body).toContain("core.warning");
  });

  it("它与兄弟实现 findExistingReviewComment 不再差一个 catch（R1088）", () => {
    // 两份实现逐行相同（paginate + listComments + per_page 100 + Array.isArray），
    // 修之前只有 github-reviewer 那份有 try/catch。钉住"都有"。
    const reviewer = readFileSync(join(__dirname, "github-reviewer.ts"), "utf8");
    const gSeg = reviewer.slice(
      reviewer.indexOf("export async function findExistingReviewComment(")
    );
    const gBody = gSeg.slice(0, gSeg.indexOf("\nexport "));
    expect(gBody).toMatch(/try \{[\s\S]*await paginate\.call\(/);
    expect(fnSegment("listIssueCommentBodies")).toMatch(/try \{[\s\S]*await octokit\.paginate\(/);
  });

  it("min-command-permission 必经解析器且对非法值告警，不得静默回退（R1090）", () => {
    // 曾经是 `core.getInput("min-command-permission") || "write"`：非法值
    // （尾随空格 / 拼错）会静默降级成 write，把授权门禁**放宽**。
    expect(src).not.toMatch(/getInput\("min-command-permission"\)\s*\|\|\s*"write"/);

    const anchor = src.indexOf('getInput("min-command-permission")');
    expect(anchor).toBeGreaterThan(-1);
    // 按**下一个语句的锚点**切，不用固定字符窗 —— 窗宽够不到时会把
    // "锚点存在但片段不够长"伪装成断言失败（R1087/R1088 踩过）。
    const boundary = src.indexOf('getBooleanInput("review-on-synchronize")', anchor);
    expect(boundary).toBeGreaterThan(anchor);
    const seg = src.slice(anchor, boundary);

    // 取到的值要交给解析器，且非法时要告警（不能只解析、不吭声）。
    expect(seg).toMatch(/resolveMinCommandPermission\(/);
    expect(seg).toMatch(/core\.warning\(/);
    expect(seg).toMatch(/minCommandPermissionValid/);
  });

  it("解析失败的重启必须以「真的重试过」为前提（R1091）", () => {
    // 旧代码：`if (count === 0 && !parsedReview.usedJson)` —— 未重试也会重启，
    // 丢弃被块 A 判定为真实 markdown 审查的长 summary 响应。
    expect(src).not.toMatch(/count === 0 && !parsedReview\.usedJson/);

    const anchor = src.indexOf("shouldRelaunchEmptyReview(");
    expect(anchor).toBeGreaterThan(-1);
    // 按行取（结构边界），不用固定字符窗。
    const callLine = src.slice(anchor).split("\n")[0];
    expect(callLine).toContain("attemptedJsonRetry");

    // 门禁要真的被打开过，否则该重启时永不重启：重试块里必须置 true。
    expect(src).toMatch(/let attemptedJsonRetry = false;/);
    expect(src).toMatch(/attemptedJsonRetry = true;/);
  });
});