import { readFileSync } from "fs";
import * as path from "path";
import {
  LAST_RESULT_PREFIX,
  STATUS_COMMENT_MARKER,
  buildFailedStatusBody,
  buildInitialStatusBody,
  decorateStatusCommentBody,
  extractInheritedVerdict,
  findLatestStatusComment,
} from "./status-comment";
import { errorMessage } from "./llm-retry";

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

/**
 * R941：失败评论的 `Reason:` 为什么在生产上是空的。
 *
 * 上一轮（R939）的教训写在这里，因为它比任何断言都重要：
 * 那轮在 `errorMessage()` 上加了 8 条断言、跑了 3 个变异，全绿，
 * 而 `main.ts` 的 catch 一直在用**内联三元** `error instanceof Error ? error.message : String(error)`
 * —— 生产上那条空 `Reason:` 评论正是从这行产生的，也就是说
 * `errorMessage()` 从来没被这条路径调用过。**helper 被测过 ≠ 调用点用上了。**
 * （同一族教训第 6 次现身：R926 / R934 / R937 / R939。）
 */
describe("失败评论的 Reason：绝不为空，也必须说清真正原因", () => {
  const extractReason = (body: string): string => {
    const line = body.split("\n").find((l) => l.startsWith("Reason:"));
    return line === undefined ? "" : line.slice("Reason:".length);
  };

  it("渲染点兜底：直接传空串也不产出空的 Reason 行", () => {
    // 生产回归：comment id 5892637288 的正文是 `Reason: ` 后面什么都没有。
    for (const bad of ["", "   ", "\n\t "]) {
      const reason = extractReason(buildFailedStatusBody(bad, "review"));
      expect(reason.trim()).not.toBe("");
    }
  });

  it("生产路径整体：errorMessage() 接到 buildFailedStatusBody() 上不产出空 Reason", () => {
    // 这条断言模拟 main.ts 的真实组合，而不是分别测两个零件。
    const err = new Error("");
    const body = buildFailedStatusBody(errorMessage(err), "review");
    expect(extractReason(body).trim()).not.toBe("");
  });

  it("octokit 那句真正有用的原因要能到得了评论里", () => {
    const err = Object.assign(new Error("Request failed due to error response: 403"), {
      name: "HttpError",
      response: { status: 403, data: { message: "Resource not accessible by integration" } },
    });
    const reason = extractReason(buildFailedStatusBody(errorMessage(err), "review"));
    expect(reason).toContain("Resource not accessible by integration");
    expect(reason).toContain("403");
  });

  it("评论里绝不出现凭据（这条评论是公开的，且自称不含 secret）", () => {
    const err = Object.assign(new Error("Bad credentials"), {
      response: {
        data: {
          client_secret: "cs_SUPERSECRET",
          access_token: "at_SUPERSECRET",
          message: "Bad credentials",
        },
      },
    });
    const body = buildFailedStatusBody(errorMessage(err), "review");
    expect(body).not.toContain("SUPERSECRET");
    expect(body).not.toContain("client_secret");
    expect(body).not.toContain("access_token");
  });

  it("Reason 必须单行：换行会折断那一行的可读性", () => {
    const err = new Error("line one\nline two\r\nline three");
    const reason = extractReason(buildFailedStatusBody(errorMessage(err), "review"));
    expect(reason).not.toMatch(/[\r\n]/);
  });

  it("summary 命令的措辞正确，且同样不为空", () => {
    const body = buildFailedStatusBody("", "summary");
    expect(body).toContain("couldn't finish the summary");
    expect(extractReason(body).trim()).not.toBe("");
  });

  /**
   * 接线断言。
   *
   * 上一轮缺的正是这一条：**行为测试全绿，线上照样是空 Reason。**
   * 断言必须剥掉注释再比对 —— 因为解释这次 bug 的注释本身就写着那个内联三元，
   * 朴素的「源码里不许出现」会因为注释而恒真失败。
   */
  describe("main.ts 接线（剥注释后比对）", () => {
    const src = readFileSync(path.join(__dirname, "main.ts"), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

    it("catch 里走的是 errorMessage(error)，不是内联三元", () => {
      expect(code).toContain("const message = errorMessage(error);");
    });

    it("代码里（不含注释）不再有那条内联三元", () => {
      expect(code).not.toContain("error instanceof Error ? error.message : String(error)");
    });

    it("buildFailedStatusBody 来自 status-comment（单一产地）", () => {
      expect(code).toContain("buildFailedStatusBody,");
      // main.ts 里不该再有第二份实现，否则会漂移
      expect(code).not.toMatch(/function buildFailedStatusBody/);
    });

    it("换 CI 的判定仍然收原始 error，不被人类可读文本污染", () => {
      // planRelaunch 自己分类；main.ts 不得把 errorText 传进去，
      // 否则 errorMessage() 追加的 response.data.message 会影响
      // 瞬时/永久判定 —— 那会让 fail-closed 出现新的可动变量。
      //
      // 断言必须匹配 `error:` 的**属性值**，不能只搜 "error,"：
      // M17（把 `error,` 换成 `error: new Error(message),`）在粗搜下存活过，
      // 因为切片里别处也有 "error,"。
      const callSite = code.slice(code.indexOf("maybeRelaunchOnEgressFailure"));
      // 接受 shorthand `error,` 或显式 `error: error,`；但不能是别的表达式。
      // （第一版只写 `error:\s*error\s*,`，而 main.ts 用的是 shorthand，
      //  结果**基线自己就红** —— 变异验证时基线必须先绿，否则报红毫无意义。）
      expect(callSite).toMatch(/\berror\s*,|\berror:\s*error\s*,/);
      expect(callSite).not.toContain("errorText");
      // 也不该把人类可读文本重包成新 Error 再传（那正是 M17 干的事）
      expect(callSite).not.toMatch(/new Error\(\s*message\s*\)/);
    });
  });
});
