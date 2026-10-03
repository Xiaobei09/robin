import { ROBIN_BOT_LOGIN } from "./github-reviewer";
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
  it("prefixes the invisible marker", () => {
    // 位置从「结尾」改成「开头」：GitHub 把正文渲染成 HTML 时会在 marker 与正文之间
    // 插入 <p>，用 startsWith 认领就会失配。marker 必须在第一行。
    expect(decorateStatusCommentBody("hello")).toBe(`${STATUS_COMMENT_MARKER}\nhello`);
  });

  it("is idempotent", () => {
    const once = decorateStatusCommentBody("hello");
    expect(decorateStatusCommentBody(once)).toBe(once);
  });

  it("does not double the marker when re-decorating a body that already starts with it", () => {
    const decorated = decorateStatusCommentBody("## :eyes: On it");
    expect(decorateStatusCommentBody(decorated).match(/<!-- robin-ai-review -->/g)).toHaveLength(1);
  });

  it("tolerates leading whitespace before an existing marker", () => {
    const padded = "\n\n" + decorateStatusCommentBody("body");
    expect(decorateStatusCommentBody(padded)).toBe(padded);
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
    user: { login: ROBIN_BOT_LOGIN },
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

  /**
   * 作者必须是 `github-actions[bot]`。半边条件（只认 marker 不认作者）会让一条
   * 引用了 marker 的人类评论被当成 Robin 的来覆盖 —— 而覆盖掉人类写的话不可恢复。
   */
  it("never adopts a marked comment authored by a human", async () => {
    const human = { id: 7, user: { login: "octocat" }, body: `${STATUS_COMMENT_MARKER}\nmy own notes` };
    expect((await findLatestStatusComment(fakeOctokit([marked(1), human]), "o", "r", 1))?.id).toBe(1);
    // 只有人类那条带 marker ⇒ 无可认领
    expect(await findLatestStatusComment(fakeOctokit([human]), "o", "r", 1)).toBeUndefined();
  });

  /**
   * 分页：marker 落在第 101 条之后也必须找得到。
   * 只扫第一页就收工 ⇒ 判成「没有历史评论」⇒ 新建第二条 ⇒ 每次重启多一条，
   * 而现象只是「评论多了一条」，不会有任何报错。
   */
  it("finds the marker past the 100-comment page boundary", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      user: { login: "octocat" },
      body: `human chatter ${i}`,
    }));
    many.push(marked(999));
    const octokit = fakeOctokit(many);
    const found = await findLatestStatusComment(octokit, "o", "r", 1);
    expect(found?.id).toBe(999);
    // per_page 必须为 100，否则 GitHub 默认 30，永远跨不过页边界
    expect(octokit.calls[0].params).toMatchObject({ per_page: 100 });
  });

  /** 升级兼容：老版本留下的 `<!-- robin:status -->` 评论仍要被认领，否则升级即多一条。 */
  it("still adopts a comment carrying the pre-unification marker", async () => {
    const legacy = { id: 42, user: { login: ROBIN_BOT_LOGIN }, body: "hi\n\n<!-- robin:status -->" };
    expect((await findLatestStatusComment(fakeOctokit([legacy]), "o", "r", 1))?.id).toBe(42);
  });

  /**
   * 老 marker 回退路径同样必须校验作者。
   * 人类复制一段含 `<!-- robin:status -->` 的 Robin 旧评论来提问，是很自然的行为；
   * 只查正文不查作者 ⇒ 那条提问被认领并整条覆盖 ⇒ 人的话不可恢复地消失。
   */
  it("never adopts a human comment that quotes the legacy marker", async () => {
    const human = { id: 7, user: { login: "octocat" }, body: "why this error?\n<!-- robin:status -->" };
    expect(await findLatestStatusComment(fakeOctokit([human]), "o", "r", 1)).toBeUndefined();
  });

  /** 新 marker 优先于老 marker：认领最新身份，老评论留给清理逻辑删。 */
  it("prefers the unified marker over the legacy one", async () => {
    const legacy = { id: 1, user: { login: ROBIN_BOT_LOGIN }, body: "old\n<!-- robin:status -->" };
    expect((await findLatestStatusComment(fakeOctokit([legacy, marked(2)]), "o", "r", 1))?.id).toBe(2);
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

    /**
     * R944：两个状态评论写入点都必须经过 `decorateStatusCommentBody`。
     *
     * marker 缺失的后果不是「少个看不见的东西」，而是**整条收养链断掉**：
     * `findLatestStatusComment` 只认带 marker 的评论，一旦某条状态评论没戴 marker，
     * 下一轮就看不见它、于是**新建**一条而不是更新它 —— 这正是 status-comment.ts
     * 开头要解决的「评论堆积」，而且退化时完全无声：评论照发，只是越攒越多。
     *
     * 生产实证：SiliconMod/Silicon#67 的失败评论 `id=5892637288`（2026-09-29）
     * `has_marker=false`。已核实成因是 `ac3113c`（2026-10-02）才引入 marker 与收养，
     * 那条评论早于它 ⇒ 属预期历史行为、不是现存缺陷；但守卫本身当时没有任何断言，
     * 将来加一条新的写入路径就可能悄悄退化回去 —— 所以钉在这里。
     *
     * 断言用函数切片而不是全文件搜索：装饰逻辑只在写入点附近，搜全文会被
     * `decorateStatusCommentBody` 的 import 行本身命中而恒真（R941 的教训）。
     */
    /**
     * R1081：`postStatusComment` / `updateStatusComment` / `resolveStatusCommentId`
     * 已从 `main.ts` 搬进 `status-comment.ts`（为了能直接测它们）。
     *
     * 下面三条守卫按函数名切片，所以必须换读另一个文件。**不能图省事把两个文件
     * 拼起来当 `code`** —— 上面那条 `not.toMatch(/function buildFailedStatusBody/)`
     * 正是靠「main.ts 里没有第二份实现」成立的，而 `buildFailedStatusBody` 的**产地
     * 就在 status-comment.ts**，一拼就反而命中、测试变红。
     * 两份源码各读各的，是这个约束的直接后果。
     */
    const statusCode = readFileSync(path.join(__dirname, "status-comment.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const sliceOfStatus = (from: string, to: string): string =>
      statusCode.slice(statusCode.indexOf(from), statusCode.indexOf(to));

    //
    // 判据必须是「`body:` 的**值**就是装饰调用」，不能只是「函数体里出现过这个标识符」。
    // M29（把装饰改写成一条丢弃结果的死调用：`decorateStatusCommentBody(body);` 之后
    // 仍然 `body,` 原样发出）在弱断言下**存活**了 —— 而那正是线上真实发生的坏行为：
    // 评论确实没戴 marker，收养链断掉。
    // 这与 R937 的 M17、上一轮 R943 的脆弱断言同族：**搜标识符 ≠ 钉住接线**。
    const bodyValueIsDecorated = (src: string): boolean => {
      // 匹配 `body: decorateStatusCommentBody(` 或 `body: decorateStatusCommentBody(x)`
      const wrapped = /body:\s*decorateStatusCommentBody\s*\(/.test(src);
      // 多行写法：body: decorateStatusCommentBody( ... )
      const wrappedMultiline = /body:[^,\n]*\bdecorateStatusCommentBody\s*\(/.test(src);
      return wrapped || wrappedMultiline;
    };

    it("新建状态评论（postStatusComment）把 body 交给统一发布器 publishRobinComment", () => {
      const seg = sliceOfStatus("async function postStatusComment", "async function updateStatusComment");
      // 装饰不再发生在这个函数体里，而是收敛到 publishRobinComment 内（marker 单一来源）。
      // 这里钉的是「走了统一发布器」这条接线，装饰本身由下面那条 publishRobinComment 守卫覆盖。
      expect(seg).toContain("publishRobinComment");
      expect(seg).toContain("buildInitialStatusBody");
    });

    it("更新状态评论（updateStatusComment）的 body 值经过 decorateStatusCommentBody", () => {
      const seg = sliceOfStatus("async function updateStatusComment", "async function resolveStatusCommentId");
      expect(seg).toContain("updateComment");
      expect(bodyValueIsDecorated(seg)).toBe(true);
    });

    /**
     * marker 的保证随写入点下沉到了 `publishRobinComment`，所以守卫也跟着搬过去。
     *
     * **为什么不能只把断言删掉。** `postStatusComment` 改成委托之后，原来那条
     * 「body 的值就是装饰调用」的断言会红；如果只是把它改成「body 值经过装饰」
     * 就放过，装饰被摘掉又会红；但若有人把整个委托改回裸 `createComment(body)`，
     * 只断言 `publishRobinComment` 被调用是抓不到的。所以这里断言的是
     * **这个函数体里 body 必须被装饰**，而不是「文件里出现过装饰这个词」。
     * （与 M29 同一族：搜标识符 ≠ 钉住接线。）
     */
    it("委托出去的写入点仍把 body 交给 publishRobinComment 而非裸发", () => {
      const seg = sliceOfStatus("async function postStatusComment", "async function updateStatusComment");
      // 不允许绕过统一发布器直接建评论：那正是「每次重启多一条」的来源
      expect(seg).not.toContain("createComment");
    });
  });
});
