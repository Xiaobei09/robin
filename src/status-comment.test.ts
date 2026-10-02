import {
  LAST_RESULT_PREFIX,
  STATUS_COMMENT_MARKER,
  buildInitialStatusBody,
  decorateStatusCommentBody,
  extractInheritedVerdict,
  findLatestStatusComment,
} from "./status-comment";

/** Minimal stand-in for the parts of octokit that findLatestStatusComment touches. */
function fakeOctokit(comments: unknown[], opts: { throwOnPaginate?: boolean } = {}) {
  const listComments = { name: "listComments" };
  const calls: Array<{ route: unknown; params: unknown }> = [];
  return {
    calls,
    rest: { issues: { listComments } },
    paginate: async (route: unknown, params: unknown) => {
      calls.push({ route, params });
      if (opts.throwOnPaginate) throw new Error("boom");
      return comments;
    },
  };
}

describe("decorateStatusCommentBody", () => {
  it("appends the invisible marker", () => {
    expect(decorateStatusCommentBody("hello")).toBe(`hello\n\n${STATUS_COMMENT_MARKER}`);
  });

  it("is idempotent", () => {
    const once = decorateStatusCommentBody("hello");
    expect(decorateStatusCommentBody(once)).toBe(once);
  });

  it("keeps the original text", () => {
    expect(decorateStatusCommentBody(":eyes: On it")).toContain(":eyes: On it");
  });
});

describe("extractInheritedVerdict", () => {
  it("returns undefined for non-strings", () => {
    expect(extractInheritedVerdict(undefined)).toBeUndefined();
    expect(extractInheritedVerdict(null)).toBeUndefined();
    expect(extractInheritedVerdict(42 as unknown as string)).toBeUndefined();
  });

  it("returns undefined when no verdict line exists", () => {
    expect(extractInheritedVerdict(":eyes: On it — taking a look.")).toBeUndefined();
  });

  it("ignores an empty verdict line", () => {
    expect(extractInheritedVerdict(LAST_RESULT_PREFIX)).toBeUndefined();
  });

  it("reads a recorded verdict", () => {
    const body = `${LAST_RESULT_PREFIX}Review done. I flagged 3 things worth a look.`;
    expect(extractInheritedVerdict(body)).toBe("Review done. I flagged 3 things worth a look.");
  });

  it("returns the last occurrence so a third run keeps the original verdict", () => {
    const first = "Run one said A";
    const second = "Run two said B";
    const body = [
      `${LAST_RESULT_PREFIX}${first}`,
      ":eyes: On it — taking a look at this pull request.",
      `${LAST_RESULT_PREFIX}${second}`,
    ].join("\n");
    expect(extractInheritedVerdict(body)).toBe(second);
  });
});

describe("buildInitialStatusBody", () => {
  it("omits the carried-over line when there is nothing to carry", () => {
    const body = buildInitialStatusBody("review", "gpt-x");
    expect(body).toContain(":eyes: On it");
    expect(body).toContain("Mode: code review");
    expect(body).toContain("Model: gpt-x");
    expect(body).not.toContain(LAST_RESULT_PREFIX);
  });

  it("maps the summary command", () => {
    expect(buildInitialStatusBody("summary", "m")).toContain("Mode: summary");
  });

  it("carries a previous verdict forward", () => {
    const body = buildInitialStatusBody("review", "m", "Review done. All clear.");
    expect(body).toContain(`${LAST_RESULT_PREFIX}Review done. All clear.`);
    expect(extractInheritedVerdict(decorateStatusCommentBody(body))).toBe(
      "Review done. All clear."
    );
  });

  it("keeps the verdict extractable after repeated adoption", () => {
    const run2 = decorateStatusCommentBody(buildInitialStatusBody("review", "m", "V1"));
    const run3 = decorateStatusCommentBody(
      buildInitialStatusBody("review", "m", extractInheritedVerdict(run2))
    );
    expect(extractInheritedVerdict(run3)).toBe("V1");
  });
});

describe("findLatestStatusComment", () => {
  const marked = (id: number, extra = "") => ({
    id,
    body: `## :bow_and_arrow: Robin\n\n:eyes: On it\n${extra}\n${STATUS_COMMENT_MARKER}`,
  });

  it("returns the newest marked comment", async () => {
    const found = await findLatestStatusComment(
      fakeOctokit([marked(1), marked(2)]),
      "o",
      "r",
      1
    );
    expect(found?.id).toBe(2);
  });

  it("ignores the summary comment, which is not a status comment", async () => {
    const summary = { id: 9, body: "## :bow_and_arrow: Robin · Summary\n\nall good" };
    const found = await findLatestStatusComment(
      fakeOctokit([marked(1), summary]),
      "o",
      "r",
      1
    );
    expect(found?.id).toBe(1);
  });

  it("returns undefined when nothing is marked", async () => {
    expect(await findLatestStatusComment(fakeOctokit([{ id: 1, body: "hi" }]), "o", "r", 1))
      .toBeUndefined();
  });

  it("returns undefined for an empty comment list", async () => {
    expect(await findLatestStatusComment(fakeOctokit([]), "o", "r", 1)).toBeUndefined();
  });

  it("skips entries with a non-numeric id", async () => {
    const found = await findLatestStatusComment(
      fakeOctokit([marked(1), { id: "nope", body: `x\n${STATUS_COMMENT_MARKER}` }]),
      "o",
      "r",
      1
    );
    expect(found?.id).toBe(1);
  });

  it("skips entries with a non-string body", async () => {
    const found = await findLatestStatusComment(
      fakeOctokit([marked(1), { id: 5, body: null }]),
      "o",
      "r",
      1
    );
    expect(found?.id).toBe(1);
  });

  it("passes the listComments route and PR coordinates", async () => {
    const octokit = fakeOctokit([marked(1)]);
    await findLatestStatusComment(octokit, "own", "rep", 42);
    expect(octokit.calls[0].route).toBe(octokit.rest.issues.listComments);
    expect(octokit.calls[0].params).toEqual({
      owner: "own",
      repo: "rep",
      issue_number: 42,
      per_page: 100,
    });
  });

  it("degrades to undefined when the API call fails", async () => {
    const octokit = fakeOctokit([], { throwOnPaginate: true });
    expect(await findLatestStatusComment(octokit, "o", "r", 1)).toBeUndefined();
  });

  it("degrades to undefined when paginate is unavailable", async () => {
    expect(await findLatestStatusComment({}, "o", "r", 1)).toBeUndefined();
    expect(await findLatestStatusComment(undefined, "o", "r", 1)).toBeUndefined();
  });

  it("degrades to undefined when the API returns a non-array", async () => {
    expect(await findLatestStatusComment(fakeOctokit("nope" as unknown as unknown[]), "o", "r", 1))
      .toBeUndefined();
  });
});
