import {
  GitHubReviewer,
  REVIEW_MARKER,
  ROBIN_BOT_LOGIN,
  decorateRobinCommentBody,
  deletePreviousReviewComments,
  findExistingReviewComment,
  publishRobinComment,
} from "./github-reviewer";

/** Minimal stand-in for the octokit surface the comment helpers touch. */
function fakeOctokit(comments: any[], opts: { throwOnPaginate?: boolean } = {}) {
  const calls: Array<{ route: unknown; params: unknown }> = [];
  const createComment = jest.fn().mockResolvedValue({ data: { id: 500 } });
  const updateComment = jest.fn().mockResolvedValue({});
  const deleteComment = jest.fn().mockResolvedValue({});
  return {
    calls,
    createComment,
    updateComment,
    deleteComment,
    rest: { issues: { listComments: {}, createComment, updateComment, deleteComment } },
    paginate: async (route: unknown, params: unknown) => {
      calls.push({ route, params });
      if (opts.throwOnPaginate) throw new Error("boom");
      return comments;
    },
  };
}

const marked = (id: number, login = ROBIN_BOT_LOGIN) => ({
  id,
  user: { login },
  body: `${REVIEW_MARKER}\n## :bow_and_arrow: Robin`,
});

describe("decorateRobinCommentBody", () => {
  it("puts the marker on the first line", () => {
    expect(decorateRobinCommentBody("body")).toBe(`${REVIEW_MARKER}\nbody`);
  });

  it("does not double the marker", () => {
    expect(decorateRobinCommentBody(decorateRobinCommentBody("x")).match(/<!-- robin-ai-review -->/g))
      .toHaveLength(1);
  });
});

describe("findExistingReviewComment", () => {
  it("returns the newest marked bot comment", async () => {
    expect((await findExistingReviewComment(fakeOctokit([marked(1), marked(2)]), "o", "r", 1))?.id).toBe(2);
  });

  it("requests per_page=100 so the marker is found past page 1", async () => {
    const octokit = fakeOctokit([marked(1)]);
    await findExistingReviewComment(octokit, "own", "rep", 42);
    expect(octokit.calls[0].params).toEqual({
      owner: "own",
      repo: "rep",
      issue_number: 42,
      per_page: 100,
    });
  });

  it("finds the marker beyond 100 comments", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, user: { login: "octocat" }, body: "hi" }));
    many.push(marked(999));
    expect((await findExistingReviewComment(fakeOctokit(many), "o", "r", 1))?.id).toBe(999);
  });

  /** 覆盖人类评论不可恢复：只认 marker 不认作者 = 可能覆盖掉人写的话。 */
  it("never adopts a human-authored marked comment", async () => {
    expect(await findExistingReviewComment(fakeOctokit([marked(5, "octocat")]), "o", "r", 1)).toBeUndefined();
  });

  it("degrades to undefined instead of throwing", async () => {
    expect(await findExistingReviewComment(fakeOctokit([], { throwOnPaginate: true }), "o", "r", 1))
      .toBeUndefined();
    expect(await findExistingReviewComment({}, "o", "r", 1)).toBeUndefined();
    expect(await findExistingReviewComment(undefined, "o", "r", 1)).toBeUndefined();
  });
});

describe("publishRobinComment", () => {
  /** 首次运行：没有历史评论 ⇒ POST 新评论，body 带 marker。 */
  it("creates a new marked comment when none exists", async () => {
    const octokit = fakeOctokit([]);
    const id = await publishRobinComment(octokit, "o", "r", 1, "hello");
    expect(id).toBe(500);
    expect(octokit.createComment).toHaveBeenCalledTimes(1);
    expect(octokit.createComment.mock.calls[0][0].body).toBe(`${REVIEW_MARKER}\nhello`);
    expect(octokit.updateComment).not.toHaveBeenCalled();
  });

  /** 重启场景：已有带 marker 的评论 ⇒ PATCH，绝不新建。PR 上永远只有一条。 */
  it("updates the existing marked comment instead of creating a second one", async () => {
    const octokit = fakeOctokit([marked(77)]);
    const id = await publishRobinComment(octokit, "o", "r", 1, "second run");
    expect(id).toBe(77);
    expect(octokit.createComment).not.toHaveBeenCalled();
    expect(octokit.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 77, body: `${REVIEW_MARKER}\nsecond run` })
    );
  });

  /** 三次运行 ⇒ 一条评论。这是整个重启需求的回归锁。 */
  it("converges on one comment across three runs", async () => {
    const store: any[] = [];
    const octokit: any = {
      rest: {
        issues: {
          listComments: {},
          createComment: jest.fn(async (p: any) => {
            const id = store.length + 1;
            store.push({ id, user: { login: ROBIN_BOT_LOGIN }, body: p.body });
            return { data: { id } };
          }),
          updateComment: jest.fn(async (p: any) => {
            store.find((c) => c.id === p.comment_id).body = p.body;
            return {};
          }),
        },
      },
      paginate: async () => store,
    };
    await publishRobinComment(octokit, "o", "r", 1, "run 1");
    await publishRobinComment(octokit, "o", "r", 1, "run 2");
    await publishRobinComment(octokit, "o", "r", 1, "run 3");
    expect(store).toHaveLength(1);
    expect(store[0].body).toBe(`${REVIEW_MARKER}\nrun 3`);
  });

  /** 评论已被删除（404）⇒ 不能把整轮跑挂掉，退回新建。 */
  it("recreates when the existing comment can no longer be updated", async () => {
    const octokit = fakeOctokit([marked(77)]);
    octokit.updateComment.mockRejectedValue(new Error("Not Found"));
    const id = await publishRobinComment(octokit, "o", "r", 1, "recovered");
    expect(id).toBe(500);
    expect(octokit.createComment).toHaveBeenCalledTimes(1);
  });
});

describe("deletePreviousReviewComments", () => {
  it("removes other bot comments and keeps the kept one", async () => {
    const octokit = fakeOctokit([marked(1), marked(2), marked(3)]);
    expect(await deletePreviousReviewComments(octokit, "o", "r", 1, 2)).toBe(2);
    expect(octokit.deleteComment.mock.calls.map((c: any[]) => c[0].comment_id)).toEqual([1, 3]);
  });

  it("never deletes a human comment", async () => {
    const octokit = fakeOctokit([marked(1, "octocat"), marked(2)]);
    expect(await deletePreviousReviewComments(octokit, "o", "r", 1, 2)).toBe(0);
    expect(octokit.deleteComment).not.toHaveBeenCalled();
  });

  it("is a no-op when listing fails", async () => {
    const octokit = fakeOctokit([], { throwOnPaginate: true });
    expect(await deletePreviousReviewComments(octokit, "o", "r", 1, 2)).toBe(0);
  });
});

describe("GitHubReviewer", () => {
  it("resolves review event from high findings and request-changes mode", () => {
    expect(GitHubReviewer.resolveReviewEvent(true, true)).toBe("REQUEST_CHANGES");
    expect(GitHubReviewer.resolveReviewEvent(true, false)).toBe("COMMENT");
    expect(GitHubReviewer.resolveReviewEvent(false, true)).toBe("COMMENT");
    expect(GitHubReviewer.resolveReviewEvent(false, false)).toBe("COMMENT");
  });

  it("identifies stale Robin CHANGES_REQUESTED reviews to dismiss", () => {
    const robinBody = "## :bow_and_arrow: Robin\n\nfindings…";
    const bot = { type: "Bot" };
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, 2)
    ).toBe(true);
    // the review just posted
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 2, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, 2)
    ).toBe(false);
    // non-blocking Robin review
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "COMMENTED", body: robinBody, user: bot }, 2)
    ).toBe(false);
    // human review must never be dismissed — even one quoting Robin's signature
    expect(
      GitHubReviewer.isStaleRobinReview(
        { id: 1, state: "CHANGES_REQUESTED", body: robinBody, user: { type: "User" } },
        2
      )
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: "LGTM-ish", user: bot }, 2)
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: null, user: bot }, 2)
    ).toBe(false);
  });

  it("dismisses only stale Robin CHANGES_REQUESTED reviews after posting", async () => {
    const robinBody = "## :bow_and_arrow: Robin\n\nfindings…";
    const bot = { type: "Bot" };
    const reviews = [
      { id: 10, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, // stale — dismiss
      { id: 11, state: "COMMENTED", body: robinBody, user: bot }, // non-blocking — keep
      { id: 12, state: "CHANGES_REQUESTED", body: "human review", user: { type: "User" } }, // human — keep
      { id: 20, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, // the new review itself
    ];
    const dismissReview = jest.fn().mockResolvedValue({});
    const octokit = {
      paginate: jest.fn().mockResolvedValue(reviews),
      rest: { pulls: { listReviews: {}, dismissReview } },
    };

    const reviewer = new GitHubReviewer(octokit as any);
    await (reviewer as any).dismissStaleRobinReviews("o", "r", 1, 20);

    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 10, pull_number: 1 })
    );
  });

  it("detects new-file line numbers present in the diff", () => {
    const reviewer = new GitHubReviewer({} as any);
    const isLineInNewDiff = (reviewer as any).isLineInNewDiff.bind(reviewer) as (
      patch: string,
      targetLine: number
    ) => boolean;

    const patch = [
      "@@ -1,3 +1,4 @@",
      " import value from './value';",
      "-const oldName = value;",
      "+const newName = value;",
      "+const enabled = true;",
      " export { newName };",
    ].join("\n");

    expect(isLineInNewDiff(patch, 2)).toBe(true);
    expect(isLineInNewDiff(patch, 3)).toBe(true);
    expect(isLineInNewDiff(patch, 4)).toBe(true);
    expect(isLineInNewDiff(patch, 99)).toBe(false);
  });

  it("uses line and side for inline review comments", () => {
    const reviewer = new GitHubReviewer({} as any);
    const buildReviewComments = (reviewer as any).buildReviewComments.bind(reviewer);

    const findings = {
      summary: "Summary",
      high: [],
      medium: [
        {
          severity: "medium",
          file: "src/example.ts",
          line: 3,
          description: "Finding",
        },
      ],
      low: [],
      suggestions: [],
    };

    const files = [
      {
        filename: "src/example.ts",
        patch: [
          "@@ -1,2 +1,3 @@",
          " const first = true;",
          "+const second = true;",
          "+const third = true;",
        ].join("\n"),
      },
    ];

    const { comments } = buildReviewComments(findings, files);

    expect(comments).toEqual([
      expect.objectContaining({
        path: "src/example.ts",
        line: 3,
        side: "RIGHT",
      }),
    ]);
    expect(comments[0]).not.toHaveProperty("position");
  });

  it("retries inline comment coordinate errors using response details", () => {
    const reviewer = new GitHubReviewer({} as any);
    const shouldRetryWithoutInlineComments = (
      reviewer as any
    ).shouldRetryWithoutInlineComments.bind(reviewer) as (error: unknown) => boolean;

    expect(shouldRetryWithoutInlineComments({
      status: 422,
      response: {
        data: {
          errors: [{ field: "comments.line", code: "invalid" }],
        },
      },
    })).toBe(true);

    expect(shouldRetryWithoutInlineComments({ status: 403, message: "Forbidden" })).toBe(false);
  });
});
