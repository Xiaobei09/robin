import {
  AVAILABLE_COMMANDS,
  hasRequiredPermission,
  parseSlashCommand,
  resolveMinCommandPermission,
} from "./commands";
import { getHelpMessage } from "./prompts/review-prompts";

describe("parseSlashCommand", () => {
  it("parses supported commands from the first non-empty line", () => {
    expect(parseSlashCommand("\n  /review please")).toBe("review");
    expect(parseSlashCommand("/robin")).toBe("review");
    expect(parseSlashCommand("/ROBIN please")).toBe("review");
    expect(parseSlashCommand("/summary")).toBe("summary");
    expect(parseSlashCommand("/help")).toBe("help");
  });

  it("does not parse inline mentions or command prefixes", () => {
    expect(parseSlashCommand("please /review this")).toBeUndefined();
    expect(parseSlashCommand("/reviewing this")).toBeUndefined();
    expect(parseSlashCommand("Looks good\n/review")).toBeUndefined();
  });
});

describe("hasRequiredPermission", () => {
  it("allows permissions at or above the configured minimum", () => {
    expect(hasRequiredPermission("admin", "write")).toBe(true);
    expect(hasRequiredPermission("maintain", "write")).toBe(true);
    expect(hasRequiredPermission("write", "write")).toBe(true);
  });

  it("rejects lower permissions", () => {
    expect(hasRequiredPermission("triage", "write")).toBe(false);
    expect(hasRequiredPermission("read", "triage")).toBe(false);
    expect(hasRequiredPermission("none", "read")).toBe(false);
  });

  // R1090：授权门禁必须 fail-closed。此前 minimum 未知时兜底是 `write`，
  // 于是 `"admin "`（尾随空格）或 `admim`（拼错）会把只该 admin 触发的仓库
  // **静默放开给 write 用户** —— 方向刚好反了。这条是当时的探针，留作回归钉子。
  it("未知 minimum 不得把门槛放宽（fail-closed 到最严）", () => {
    expect(hasRequiredPermission("write", "admin ")).toBe(false);
    expect(hasRequiredPermission("write", "admim")).toBe(false);
    expect(hasRequiredPermission("maintain", "admim")).toBe(false);
    // 最严的 admin 仍然可以通过 —— 门禁只收紧、不误伤最高权限。
    expect(hasRequiredPermission("admin", "admim")).toBe(true);
  });

  it("未知的用户权限一律拒绝（fail-closed）", () => {
    // 未知用户 → 按 none(0) 计；只要 minimum 比 none 严就拒绝。
    expect(hasRequiredPermission("", "read")).toBe(false);
    expect(hasRequiredPermission("owner", "read")).toBe(false);
    expect(hasRequiredPermission("WRITE", "write")).toBe(true); // 大小写不敏感
    // `minimum: none` 的语义就是「谁都能触发」，此时放行未知用户并不违反
    // fail-closed —— 门禁本来就是开着的。这条把该语义钉住，免得日后误删。
    expect(hasRequiredPermission("", "none")).toBe(true);
    expect(hasRequiredPermission("owner", "none")).toBe(true);
  });
});

describe("resolveMinCommandPermission", () => {
  it("空 / 纯空白 = 没配：用文档默认 write，且不告警", () => {
    expect(resolveMinCommandPermission("")).toEqual({ value: "write", valid: true });
    expect(resolveMinCommandPermission("   ")).toEqual({ value: "write", valid: true });
  });

  it("已知等级归一化大小写与首尾空白", () => {
    expect(resolveMinCommandPermission("ADMIN")).toEqual({ value: "admin", valid: true });
    expect(resolveMinCommandPermission(" maintain ")).toEqual({ value: "maintain", valid: true });
    expect(resolveMinCommandPermission("none")).toEqual({ value: "none", valid: true });
    // 尾随空格是 YAML 里极常见的手滑：**trim 之后它是合法的 admin**，
    // 不能因为空格被当成未知值而降级成 write（旧实现就是那样）。
    expect(resolveMinCommandPermission("admin ")).toEqual({ value: "admin", valid: true });
  });

  it("未知值 → 最严的 admin + valid:false（让调用方能告警）", () => {
    expect(resolveMinCommandPermission("admim")).toEqual({ value: "admin", valid: false });
    expect(resolveMinCommandPermission("owner")).toEqual({ value: "admin", valid: false });
    // 原型链上的键不能被当成合法等级（`in` 会中招，所以用 hasOwnProperty）。
    expect(resolveMinCommandPermission("constructor")).toEqual({ value: "admin", valid: false });
    expect(resolveMinCommandPermission("toString")).toEqual({ value: "admin", valid: false });
  });
});

/**
 * R943：命令集曾经有三份互不相干的副本。
 *
 * `AVAILABLE_COMMANDS` 谁都不用（0 引用 0 测试），真正生效的是 `parseSlashCommand`
 * 里另写的一份正则，`/help` 的表格是第三份手工文本。加一个命令而忘了改正则，
 * 它会**静默失效**：没有报错、没有异常，因为唯一相关的测试只测「已知命令的行为」，
 * 从不测「清单与实现是否一致」。
 */
describe("命令清单是唯一真相来源", () => {
  it("清单里每个命令都真的能被解析（没有死条目）", () => {
    for (const entry of AVAILABLE_COMMANDS) {
      expect(parseSlashCommand(entry.command)).toBe(entry.mapsTo);
      // 带参数、纯大小写混排也要认
      expect(parseSlashCommand(`${entry.command} please`)).toBe(entry.mapsTo);
      expect(parseSlashCommand(entry.command.toUpperCase())).toBe(entry.mapsTo);
    }
  });

  it("别名的归一化由清单声明，不再靠字符串比较", () => {
    const robin = AVAILABLE_COMMANDS.find((c) => c.command === "/robin");
    expect(robin?.mapsTo).toBe("review");
    expect(parseSlashCommand("/robin")).toBe("review");
  });

  it("结构上不匹配的输入一律不认（前缀、空格分隔、后缀）", () => {
    // 刻意只断言**结构**非法，不把某个具体命令名写死成「非法」。
    // 第一版把 `/deploy` 写在这里，结果「只改一半」的那个变异（M19，往清单里
    // 合法加一条 /deploy）反倒让这条断言红了 —— 报红出于错误理由，
    // 那不是防漂移，是给未来加命令的人埋雷。
    for (const bogus of [
      "/reviewing",   // 前缀：不能被当成 /review
      "/summarying",  // 同理
      "/revi ew",     // 命令与参数之间断了
      "/ summary",    // 斜杠后有空格
      "/review/",     // 结尾是斜杠
    ]) {
      expect(parseSlashCommand(bogus)).toBeUndefined();
    }
  });

  it("/help 覆盖的命令集合与清单完全一致（双向）", () => {
    // help 的措辞是面向用户的文案，由 review-prompts.ts 自己写；
    // 但「它提到哪些命令」不能与实现分叉，否则用户敲了没反应。
    const fromHelp = new Set(
      (getHelpMessage().match(/\/[a-z][a-z0-9-]*/g) ?? []).map((t) => t.slice(1))
    );
    const fromList = new Set(AVAILABLE_COMMANDS.map((c) => c.command.replace(/^\//, "")));
    expect([...fromHelp].sort()).toEqual([...fromList].sort());
  });

  it("/help 里出现的命令逐个都能被解析", () => {
    for (const token of getHelpMessage().match(/\/[a-z][a-z0-9-]*/g) ?? []) {
      expect(parseSlashCommand(token)).toBeDefined();
    }
  });
});
