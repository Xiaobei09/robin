import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..");
const retryWorkflow = readFileSync(
  join(repoRoot, "templates", "retry-robin.yml"),
  "utf8",
);

/**
 * `templates/retry-robin.yml` 是给**消费方仓库**复制的自重启工作流。
 * 它不参与本仓库运行，但每一行都直接决定用户的自动重启是否真的发生，
 * 所以用源码扫描把它钉住（同 release-workflow.test.ts 的做法）。
 */
describe("retry-robin consumer workflow template", () => {
  it("triggers on the consumer's Robin workflow completing", () => {
    expect(retryWorkflow).toMatch(/^name:\s*Retry Robin\s*$/m);
    expect(retryWorkflow).toMatch(/workflow_run:/);
    // `workflows:` 必须逐字等于消费方 robin.yml 的 name；写错会静默不触发。
    expect(retryWorkflow).toMatch(/workflows:\s*\["Robin"\]/);
    expect(retryWorkflow).toMatch(/types:\s*\[completed\]/);
  });

  it("only restarts a run that already failed and still has attempts left", () => {
    expect(retryWorkflow).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    // run_attempt 从 1 起，< 3 ⇒ 首次 + 最多 2 次重启，共 3 次，不会无限循环。
    expect(retryWorkflow).toContain("github.event.workflow_run.run_attempt < 3");
  });

  it("grants the token enough permission to rerun a workflow", () => {
    expect(retryWorkflow).toContain("actions: write");
    expect(retryWorkflow).toContain("contents: read");
    expect(retryWorkflow).toContain("issues: write");
    expect(retryWorkflow).toContain("pull-requests: write");
  });

  it("reruns the whole pipeline, never only the failed jobs", () => {
    expect(retryWorkflow).toContain('gh run rerun "$RUN_ID"');
    // 审查失败几乎总是外部原因（LLM 出口/解析），--failed 等于拿同一批坏输入再算。
    expect(retryWorkflow).not.toMatch(/gh run rerun[^\n]*--failed/);
  });

  /**
   * R1096：这个 job 没有 `actions/checkout`，工作区**不是** git 仓库。
   * `gh` 只从 git remote 或 `GH_REPO` 得知仓库，**不读** `GITHUB_REPOSITORY`
   * （实测：非 git 目录里只设 GITHUB_REPOSITORY，gh 报 `failed to determine
   * base repo`）。缺了 GH_REPO，`gh run rerun` 直接失败，自动重启形同虚设。
   */
  it("tells gh which repo to rerun (no checkout, so GH_REPO is required)", () => {
    expect(retryWorkflow).toMatch(
      /GH_REPO:\s*\$\{\{\s*github\.repository\s*\}\}/,
    );
  });
});
