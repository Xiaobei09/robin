import {
  buildRelaunchCommentBody,
  decideRelaunch,
  isGithubActionsToken,
  planRelaunch,
  readPreviousHop,
  RELAUNCH_COMMAND,
  RELAUNCH_MARKER,
  resolveMaxRelaunches,
  resolveRelaunchOnEgressFailure,
  DEFAULT_MAX_RELAUNCHES,
} from "./relaunch";

describe("换出口 = 抛弃当前 CI，另起一个新 CI（R922）", () => {
  it("默认开启，且默认最多重启 2 次", () => {
    expect(resolveRelaunchOnEgressFailure(undefined)).toBe(true);
    expect(resolveRelaunchOnEgressFailure("")).toBe(true);
    expect(resolveMaxRelaunches(undefined)).toBe(DEFAULT_MAX_RELAUNCHES);
    expect(DEFAULT_MAX_RELAUNCHES).toBe(2);
  });

  it("可显式关闭（false/0/no/off 都认，其余为开）", () => {
    for (const v of ["false", "FALSE", "0", "no", "off"]) {
      expect(resolveRelaunchOnEgressFailure(v)).toBe(false);
    }
    for (const v of ["true", "1", "yes", "on"]) {
      expect(resolveRelaunchOnEgressFailure(v)).toBe(true);
    }
  });

  it("重启次数上限可配，非法值回落到默认，负数当 0（彻底关掉）", () => {
    expect(resolveMaxRelaunches("5")).toBe(5);
    expect(resolveMaxRelaunches(" 3 ")).toBe(3);
    expect(resolveMaxRelaunches("abc")).toBe(DEFAULT_MAX_RELAUNCHES);
    expect(resolveMaxRelaunches("-1")).toBe(0);
    expect(resolveMaxRelaunches("2.9")).toBe(2);
  });

  describe("决定要不要发重启评论", () => {
    const base = { enabled: true, isTransientEgress: true, previousHop: 0, maxRelaunches: 2, errorText: "fetch failed" };

    it("瞬时故障且没用过额度 → 发，hop 从 1 开始", () => {
      const d = decideRelaunch(base);
      expect(d.shouldRelaunch).toBe(true);
      expect(d.hop).toBe(1);
    });

    it("行为被关掉 → 不发", () => {
      const d = decideRelaunch({ ...base, enabled: false });
      expect(d.shouldRelaunch).toBe(false);
      expect(d.hop).toBeUndefined();
    });

    it("永久性错误（域名写错/key 无效）→ 不发，必须老实失败", () => {
      // 这是防止「配错一次 base-url 就无限重启 CI」的关键断言。
      const d = decideRelaunch({ ...base, isTransientEgress: false });
      expect(d.shouldRelaunch).toBe(false);
    });

    it("hop 用满 → 不发（防止出口长期坏掉时无限重启）", () => {
      expect(decideRelaunch({ ...base, previousHop: 1 }).shouldRelaunch).toBe(true);
      expect(decideRelaunch({ ...base, previousHop: 2 }).shouldRelaunch).toBe(false);
      expect(decideRelaunch({ ...base, previousHop: 9 }).shouldRelaunch).toBe(false);
    });

    it("上限为 0 时一次都不发", () => {
      expect(decideRelaunch({ ...base, maxRelaunches: 0 }).shouldRelaunch).toBe(false);
    });

    it("判定理由可读，便于在日志里排查", () => {
      expect(decideRelaunch(base).reason).toContain("瞬时");
      expect(decideRelaunch({ ...base, enabled: false }).reason).toContain("关闭");
      expect(decideRelaunch({ ...base, isTransientEgress: false }).reason).toContain("非瞬时");
      expect(decideRelaunch({ ...base, previousHop: 5 }).reason).toContain("上限");
    });
  });

  describe("hop 从评论正文里传递（不依赖任何外部存储）", () => {
    it("没有标记时视为没重启过", () => {
      expect(readPreviousHop([])).toBe(0);
      expect(readPreviousHop([null, undefined, "普通评论", "```hop=9```"])).toBe(0);
    });

    it("取最后一次出现的 hop（最新那跳才对）", () => {
      const b1 = buildRelaunchCommentBody({ hop: 1, maxRelaunches: 2, errorText: "x" });
      const b2 = buildRelaunchCommentBody({ hop: 2, maxRelaunches: 2, errorText: "x" });
      expect(readPreviousHop([b1, b2])).toBe(2);
      // 顺序颠倒也必须取最大值而不是「最后一条」以外的东西
      expect(readPreviousHop([b2, b1])).toBe(2);
    });

    it("一轮接一轮能正确续上额度：hop1 → 发 hop2 → 到顶不发", () => {
      const max = 2;
      let hop = 0;
      const bodies: string[] = [];
      for (let i = 0; i < 4; i++) {
        const d = decideRelaunch({ enabled: true, isTransientEgress: true, previousHop: hop, maxRelaunches: max, errorText: "fetch failed" });
        if (!d.shouldRelaunch) break;
        hop = d.hop!;
        bodies.push(buildRelaunchCommentBody({ hop, maxRelaunches: max, errorText: "fetch failed" }));
        hop = readPreviousHop(bodies);
      }
      expect(bodies.length).toBe(2);
      expect(hop).toBe(2);
    });
  });

  describe("评论正文必须能被消费方的 startsWith 守卫认出", () => {
    const body = buildRelaunchCommentBody({ hop: 1, maxRelaunches: 2, errorText: "fetch failed" });

    it("第一行就是命令前缀，前面不能有任何东西", () => {
      // 消费方 job 守卫：startsWith(github.event.comment.body, '/review' | '/robin')
      expect(body.startsWith(RELAUNCH_COMMAND)).toBe(true);
      expect(body.startsWith("/robin")).toBe(true);
      // 不能有前导空白/换行/emoji 之类会把 startsWith 打破的东西
      expect(body[0]).toBe("/");
    });

    it("带机器可读标记与 hop，供下一轮取回", () => {
      expect(body).toContain(RELAUNCH_MARKER);
      expect(body).toContain("hop=1 of 2");
      expect(readPreviousHop([body])).toBe(1);
    });

    it("带上原因原文，便于人工判断该不该继续重启", () => {
      expect(body).toContain("fetch failed");
    });
  });

  // planRelaunch 是 main.ts 真正调用的那一步：把「读 hop → 分类 → 造正文」串起来。
  // 下面四条各钉一个方向的行为，改错任何一个都会被抓住。
  describe("planRelaunch（main.ts 实际调用的那一步）", () => {
    const transient = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    const permanent = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), {
      code: "ENOTFOUND",
    });

    it("瞬时故障 + 首次：发评论，hop=1，正文以 /robin 开头", () => {
      const plan = planRelaunch({
        enabled: true,
        error: transient,
        commentBodies: [],
        maxRelaunches: 2,
        model: "gpt-4o",
      });
      expect(plan.shouldPost).toBe(true);
      expect(plan.hop).toBe(1);
      expect(plan.body?.startsWith(RELAUNCH_COMMAND)).toBe(true);
    });

    it("永久故障：绝不重启（否则配错 base-url 就会无限重启 CI）", () => {
      const plan = planRelaunch({
        enabled: true,
        error: permanent,
        commentBodies: [],
        maxRelaunches: 2,
      });
      expect(plan.shouldPost).toBe(false);
      expect(plan.body).toBeUndefined();
      expect(plan.reason).toContain("非瞬时");
    });

    it("已用完额度：绝不重启（出口长期坏掉时的护栏）", () => {
      const first = planRelaunch({
        enabled: true,
        error: transient,
        commentBodies: [],
        maxRelaunches: 2,
      });
      const second = planRelaunch({
        enabled: true,
        error: transient,
        commentBodies: [first.body],
        maxRelaunches: 2,
      });
      expect(second.shouldPost).toBe(true);
      expect(second.hop).toBe(2);

      const third = planRelaunch({
        enabled: true,
        error: transient,
        commentBodies: [first.body, second.body],
        maxRelaunches: 2,
      });
      expect(third.shouldPost).toBe(false);
      expect(third.body).toBeUndefined();
    });

    it("显式关闭：连瞬时故障也不重启", () => {
      const plan = planRelaunch({
        enabled: false,
        error: transient,
        commentBodies: [],
        maxRelaunches: 2,
      });
      expect(plan.shouldPost).toBe(false);
      expect(plan.reason).toContain("已被输入关闭");
    });

    it("R927：模型解析失败（两次无 JSON）同样触发换 CI", () => {
      const parseErr = new Error(
        "empty response from llm: review unparsable after retry (no JSON object found)"
      );
      const plan = planRelaunch({
        enabled: true,
        error: parseErr,
        commentBodies: [],
        maxRelaunches: 2,
        model: "big-pickle",
      });
      expect(plan.shouldPost).toBe(true);
      expect(plan.hop).toBe(1);
      expect(plan.body?.startsWith(RELAUNCH_COMMAND)).toBe(true);
    });
  });

  // R933：GITHUB_TOKEN 发的评论不会触发新 workflow run ⇒ 换 CI 根本不会发生。
  // 判据必须钉住「前缀」这件事本身，否则把 startsWith 换成 includes 也能过。
  describe("isGithubActionsToken（这条评论到底能不能起新 CI）", () => {
    it("ghs_ 前缀（GITHUB_TOKEN / GitHub App 安装令牌）= 发出去也白发", () => {
      expect(isGithubActionsToken("ghs_abcdefghijklmnop")).toBe(true);
      expect(isGithubActionsToken("  ghs_abcdefghijklmnop  ")).toBe(true);
    });

    it("PAT 前缀 = 真的会起新 run，必须放行", () => {
      expect(isGithubActionsToken("ghp_classicPATvalue1234567")).toBe(false);
      expect(isGithubActionsToken("github_pat_11ABCDEFG0fineGrained")).toBe(false);
      // 判别性用例：PAT 字符串里同时含有 "ghs_"（经典 PAT 随机段完全可能撞上
      // 这三个字符）。没有这行的话，把 PAT 豁免整行删掉测试仍然全绿（M2 变异
      // 存活），而生产上会把所有 PAT 误判成 GITHUB_TOKEN、把关掉换 CI ——
      // 也就是恰好把「唯一能用的那批用户」杀掉。
      expect(isGithubActionsToken("ghp_aaaSECREThs_zzz1234567")).toBe(false);
    });

    it("拿不到 / 认不出的 token 一律按「不是 GITHUB_TOKEN」处理（未知不等于不能用）", () => {
      expect(isGithubActionsToken(undefined)).toBe(false);
      expect(isGithubActionsToken(null)).toBe(false);
      expect(isGithubActionsToken("")).toBe(false);
      expect(isGithubActionsToken("   ")).toBe(false);
      expect(isGithubActionsToken("some-opaque-token")).toBe(false);
    });

    it("反向：不能说 ghp_/github_pat_ 也被当成 GITHUB_TOKEN（否则换 CI 被误杀）", () => {
      // 这条与上面两条是同一判据的两面：startsWith 换成 includes 会让
      // isGithubActionsToken("prefix_ghs_xxx") 变 true 而仍然「看起来合理」，
      // 所以额外钉一条「含 ghs_ 但不是前缀」必须是 false。
      expect(isGithubActionsToken("prefix_ghs_notarealtoken")).toBe(false);
      expect(isGithubActionsToken("xghs_leading")).toBe(false);
    });

    // R933 的关键一条：**判据必须落在真正被调用的那条路径上**。
    // 只测 isGithubActionsToken 而不测 planRelaunch 是不够的 —— M5 变异
    // （把 main.ts 里的守卫短路掉）全绿，说明闸门建在了一条没人走的路上。
    // 所以这里钉的是 planRelaunch 本身：给定 GITHUB_TOKEN 就不该产出评论。
    it("接线：planRelaunch 拿到 GITHUB_TOKEN 时**不发评论**（M5 变异要能抓住）", () => {
      const transient = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
      const plan = planRelaunch({
        enabled: true,
        error: transient,
        commentBodies: [],
        maxRelaunches: 2,
        model: "big-pickle",
        githubToken: "ghs_abcdefghijklmnop",
      });
      expect(plan.shouldPost).toBe(false);
      expect(plan.body).toBeUndefined();
      expect(plan.reason).toContain("GITHUB_TOKEN");
      expect(plan.reason).toContain("workflow_dispatch");
    });

    it("接线：PAT 时照常发评论（别把唯一有效的通道一起关掉）", () => {
      const transient = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
      const plan = planRelaunch({
        enabled: true,
        error: transient,
        commentBodies: [],
        maxRelaunches: 2,
        githubToken: "ghp_classicPATvalue1234567",
      });
      expect(plan.shouldPost).toBe(true);
      expect(plan.hop).toBe(1);
      expect(plan.body?.startsWith(RELAUNCH_COMMAND)).toBe(true);
    });

    it("接线：不传 githubToken 时维持原行为（不能因为新增参数就静默关功能）", () => {
      const transient = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
      const plan = planRelaunch({
        enabled: true,
        error: transient,
        commentBodies: [],
        maxRelaunches: 2,
      });
      expect(plan.shouldPost).toBe(true);
    });
  });
});
