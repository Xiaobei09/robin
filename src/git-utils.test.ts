import { Octokit } from "@octokit/rest";
import { readFileSync } from "fs";
import { join } from "path";
import { GitUtils, isMissingFileError } from "./git-utils";

/**
 * R1087。`git-utils.ts` 在此之前是本仓**唯一没有配套测试的源文件**
 * （全仓没有任何测试 mock 过 `repos.getContent`）—— 缺陷就藏在那个没人看的
 * `catch { return "" }` 里。
 */

/** 造一个只会返回固定内容或抛固定错误的 octokit 替身。 */
function fakeOctokit(opts: {
  content?: string;
  throwStatus?: number;
  /** 直接给一个没有 `content` 字段的响应（path 指向目录时 GitHub 返回数组） */
  rawData?: unknown;
}) {
  const getContent = { name: "getContent" };
  const calls: unknown[] = [];
  return {
    calls,
    rest: {
      repos: {
        getContent: async (params: unknown) => {
          calls.push(params);
          if (opts.throwStatus !== undefined) {
            const e = new Error(`API error ${opts.throwStatus}`) as Error & { status: number };
            e.status = opts.throwStatus;
            throw e;
          }
          if (opts.rawData !== undefined) return { data: opts.rawData };
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(opts.content ?? "", "utf-8").toString("base64"),
            },
          };
        },
      },
    },
  };
}

describe("GitUtils.getFileContent", () => {
  it("解码 base64 内容", async () => {
    const g = new GitUtils(fakeOctokit({ content: "# roboin\nmax-comments: 3\n" }) as unknown as Octokit);
    expect(await g.getFileContent("o", "r", ".github/robin.yml", "sha1")).toBe(
      "# roboin\nmax-comments: 3\n",
    );
  });

  it("按 owner/repo/path/ref 传参（ref 是 base sha，不是分支名）", async () => {
    const octo = fakeOctokit({ content: "x" });
    await new GitUtils(octo as unknown as Octokit).getFileContent("o", "r", "a/b.md", "deadbeef");
    expect(octo.calls[0]).toEqual({ owner: "o", repo: "r", path: "a/b.md", ref: "deadbeef" });
  });

  /**
   * R1087 的核心。修之前这里是 `catch { return "" }`，401/403/404/5xx/网络抖动
   * **全部压成同一个 `""`**，于是 `loadRepoConfig` 与 `loadReviewInstructions`
   * 各自的 catch 对「取文件」这一步永远进不去：用户的 `.github/robin.yml`
   * 或 instructions-file 被静默忽略，审出来的意见按默认规则走，看起来"正常"。
   */
  it.each([401, 403, 404, 422, 500, 502])(
    "状态 %i 必须抛出去，不能被吞成空串",
    async (status) => {
      const g = new GitUtils(fakeOctokit({ throwStatus: status }) as unknown as Octokit);
      await expect(g.getFileContent("o", "r", ".github/robin.yml", "sha")).rejects.toThrow(
        `API error ${status}`,
      );
    },
  );

  it("抛出的错误要保留 status —— 调用方靠它区分 404 与 403", async () => {
    const g = new GitUtils(fakeOctokit({ throwStatus: 403 }) as unknown as Octokit);
    await g.getFileContent("o", "r", "f", "sha").catch((e: unknown) => {
      expect((e as { status?: number }).status).toBe(403);
    });
    expect.assertions(1);
  });

  /**
   * 这条**不是错误**：path 指向目录时 GitHub 返回数组、没有 `content` 字段。
   * 保持安静是对的，别顺手把它也改成抛异常。
   */
  it("响应里没有 content 字段（path 指向目录）⇒ 返回空串且不抛", async () => {
    const g = new GitUtils(fakeOctokit({ rawData: [{ type: "file" }] }) as unknown as Octokit);
    expect(await g.getFileContent("o", "r", "some/dir", "sha")).toBe("");
  });

  it("内容恰好为空的文件 ⇒ 空串，且与上面那种情况无法区分（已知取舍）", async () => {
    const g = new GitUtils(fakeOctokit({ content: "" }) as unknown as Octokit);
    expect(await g.getFileContent("o", "r", "empty.md", "sha")).toBe("");
  });
});

describe("GitUtils.getPullRequestDiff", () => {
  it("用 diff media type 取回原始 diff", async () => {
    const calls: Array<{ route: unknown; params: unknown }> = [];
    const octo = {
      request: async (route: unknown, params: unknown) => {
        calls.push({ route, params });
        return { data: "diff --git a/x b/x\n" };
      },
    } as unknown as Octokit;
    const g = new GitUtils(octo);
    expect(await g.getPullRequestDiff("o", "r", 7)).toBe("diff --git a/x b/x\n");
    expect(calls[0].route).toBe("GET /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(calls[0].params).toMatchObject({
      owner: "o",
      repo: "r",
      pull_number: 7,
      headers: { accept: "application/vnd.github.v3.diff" },
    });
  });

  /**
   * 与 `getFileContent` 的不对称是**故意的**：diff 取不到就是这次审不了，
   * `main.ts` 靠它抛出走到失败状态；不像配置文件那样"取不到就退回默认"。
   * 这里钉住它确实会抛，避免"顺手统一风格"把它也吞掉。
   */
  it("请求失败要抛出去（main.ts 靠它标记这次审不了）", async () => {
    const octo = {
      request: async () => {
        throw new Error("boom");
      },
    } as unknown as Octokit;
    await expect(new GitUtils(octo).getPullRequestDiff("o", "r", 7)).rejects.toThrow("boom");
  });
});

describe("isMissingFileError（R1087 的分流判据）", () => {
  it("404 ⇒ 是「文件不存在」，不该告警", () => {
    expect(isMissingFileError({ status: 404 })).toBe(true);
    expect(isMissingFileError(Object.assign(new Error("Not Found"), { status: 404 }))).toBe(true);
  });

  /** status 可能是字符串（包装层/测试替身），Number() 归一 —— 与 llm-retry 同惯例。 */
  it("字符串 \"404\" 也算 404", () => {
    expect(isMissingFileError({ status: "404" })).toBe(true);
  });

  it.each([400, 401, 403, 409, 422, 500, 502, 503])(
    "状态 %i ⇒ 不是「不存在」，是真故障，必须告警",
    (status) => {
      expect(isMissingFileError({ status })).toBe(false);
    },
  );

  /**
   * 取不到数字时 `Number(undefined)` 是 NaN，`NaN === 404` 为 false
   * ⇒ **不确定的一律当「不是 404」**，宁可多告警也不静默吞掉真实故障。
   * 这条判据的方向很重要：反过来会把所有故障当"文件不存在"静默掉。
   */
  it("拿不到 status 时一律当「不是 404」（宁可多告警）", () => {
    for (const e of [undefined, null, {}, new Error("x"), "404" as unknown, { status: "nope" }]) {
      expect(isMissingFileError(e)).toBe(false);
    }
  });

  it("0 / NaN 之类不是 404", () => {
    expect(isMissingFileError({ status: 0 })).toBe(false);
    expect(isMissingFileError({ status: NaN })).toBe(false);
    expect(isMissingFileError({ status: 4041 })).toBe(false);
    expect(isMissingFileError({ status: "404abc" })).toBe(false);
  });
});

/**
 * `loadRepoConfig` / `loadReviewInstructions` 是 `main.ts` 的模块私有函数，
 * import 即执行，没法单测 ⇒ 只能用源码扫描钉住接线。
 *
 * **为什么扫描是必需的而不是凑数**：`git-utils.test.ts` 测的是
 * `isMissingFileError` 这个**判据**；调用方如果根本不调它、或者调了但两条分支
 * 都发 `core.info`，上面 12 条全绿、用户照样什么都看不到。
 * （`tsconfig` 只开 `strict`、未开 `noUnusedLocals`，删掉调用连 `tsc` 都抓不到。）
 */
describe("main.ts 接上了这个分流（R1087，源码扫描）", () => {
  const src = readFileSync(join(__dirname, "main.ts"), "utf-8");

  /**
   * 按**下一个函数声明**切片，而不是按固定字符数。
   * 固定字符数会让「锚点存在但片段不够长」变成一句莫名其妙的断言失败；
   * 而且代码一挪位置就得重调那个数字。
   */
  function fnSegment(name: string): string {
    const start = src.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = src.slice(start + 1);
    const next = rest.search(/\n(?:async )?function [A-Za-z]/);
    return next === -1 ? rest : rest.slice(0, next);
  }

  /**
   * 取子片段。**下标必须守卫**：`slice(-1)` 会返回**最后一个字符**，
   * 于是「没找到」会伪装成一条莫名其妙的断言失败（本次就见到了
   * `Received string: "e"`）。查不到就直接把锚点名报出来。
   */
  function sliceFrom(seg: string, anchor: string, span = 900): string {
    const i = seg.indexOf(anchor);
    expect({ anchor, found: i >= 0 }).toEqual({ anchor, found: true });
    return seg.slice(i, i + span);
  }

  it("loadRepoConfig 用 isMissingFileError 把 404 与真故障分开", () => {
    const seg = fnSegment("loadRepoConfig");
    expect(seg).toContain("isMissingFileError(error)");
    expect(seg).toContain("core.warning");
  });

  it("404 走 core.info（多数仓库本来就没有 robin.yml，不该刷告警）", () => {
    const seg = fnSegment("loadRepoConfig");
    const branch = sliceFrom(seg, "if (isMissingFileError(error))", 400);
    expect(branch).toMatch(/if\s*\(isMissingFileError\(error\)\)\s*\{\s*core\.info/);
  });

  it("真故障走 core.warning，且说清是「用默认值继续」", () => {
    const seg = fnSegment("loadRepoConfig");
    const warn = sliceFrom(seg, "core.warning", 500);
    expect(warn).toContain("using defaults");
  });

  it("instructions 的 catch 现在用 errorMessage（原先 ${error} 可能印出 [object Object]）", () => {
    const cat = sliceFrom(fnSegment("loadReviewInstructions"), "} catch (error) {", 700);
    expect(cat).toContain("core.warning");
    expect(cat).toContain("errorMessage(error)");
    expect(cat).not.toContain("${error}");
  });

  it("git-utils.ts 里那个吞异常的 catch 已经不在了", () => {
    const gu = readFileSync(join(__dirname, "git-utils.ts"), "utf-8");
    const body = gu.slice(gu.indexOf("async getFileContent"));
    expect(body).not.toMatch(/catch\s*\{\s*return\s*"";\s*\}/);
  });
});