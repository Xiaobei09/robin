import { Octokit } from "@octokit/rest";

/**
 * 判定一个 GitHub API 错误是不是「这个文件不存在」（R1087）。
 *
 * **为什么值得单独抽成函数**：`.github/robin.yml` 这类文件**大部分仓库本来就没有**，
 * 所以 404 是**正常**的、不该告警；而 401（token 无效）、403（限流/权限不足）、
 * 5xx、网络抖动**同样是「拿不到文件」，却意味着用户的配置被静默忽略了** ——
 * 后者必须让用户看见。两者在 `getFileContent` 里原本**完全同形**（都变成 `""`），
 * 分不开，所以谁也告警不了。
 *
 * 抽成纯函数是为了能穷举测试这些分支：`main.ts` 里的 `loadRepoConfig` /
 * `loadReviewInstructions` 是模块私有的、import 即执行，没法单测。
 *
 * `status` 按本仓既有惯用法用 `Number(...)` 取（`llm-retry.ts` / `llm-client.ts`
 * 都是这么写的）：octokit 给的是数字，但测试替身/包装层可能给字符串。
 * 取不到数字时 `Number(undefined)` 是 `NaN`，`NaN === 404` 为 false ⇒
 * **不确定的一律当「不是 404」**，宁可多告警也不静默吞掉真实故障。
 */
export function isMissingFileError(error: unknown): boolean {
  const status = Number((error as { status?: unknown })?.status);
  return status === 404;
}

export class GitUtils {
  private octokit: Octokit;

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  async getPullRequestDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
    const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: pullNumber,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    });

    return String(response.data);
  }

  /**
   * 读仓库里某个文件的内容（相对 `ref`，通常是 PR 的 base sha）。
   *
   * **失败就让异常抛出去**（R1087）。这里原本是 `catch { return "" }`，
   * 把 401/403/5xx/网络抖动和「文件不存在」全部压成同一个 `""`，于是：
   * - `loadRepoConfig` 的 `catch`（本来会给出诊断）对取文件这一步**永远进不去**；
   * - `loadReviewInstructions` 里 `pulls.get` 失败会 `core.warning`，
   *   而取 instructions 文件失败**一个字都不说** —— 同一个函数里两种失败
   *   一种报一种不报，看起来像随机行为。
   *
   * 用户明确配置了 `instructions-file` / 依赖 `.github/robin.yml`，
   * 静默降级（审出来的意见按默认规则走，看起来"正常"）比报错更糟。
   * 调用方现在用 `isMissingFileError` 把「本来就没有」和「取不到」分开处理。
   *
   * 注意仍有一处**不是错误**的 `return ""`：path 指向目录时 GitHub 返回数组、
   * 没有 `content` 字段，那不是失败，保持安静是对的。
   */
  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const { data } = await this.octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if ("content" in data) {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }

    return "";
  }
}
