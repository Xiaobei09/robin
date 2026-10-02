export type ReviewerCommand = "review" | "summary" | "help";

export interface SlashCommand {
  /** 用户实际敲的斜杠命令，含前导斜杠。 */
  command: string;
  /** 归一化后的语义命令。别名（`/robin` → `review`）在这里声明，不再靠字符串比较。 */
  mapsTo: ReviewerCommand;
  description: string;
}

/**
 * 权威命令清单。**这里是「有哪些命令」的唯一真相来源。**
 *
 * 以前这个清单谁都不用（0 引用、0 测试），真正生效的是 `parseSlashCommand` 里
 * 另写一份的正则，而 `/help` 的表格又是第三份手工文本。三份各改各的：
 * 加一个命令而忘了改正则，它会静默失效 —— 没人报错、没人发现，
 * 因为唯一相关的测试只测「已知命令的行为」，从不测「清单与实现是否一致」。
 *
 * 所以现在解析用的正则、以及每个命令的归一化映射，都从这里派生。
 * `/help` 的措辞仍由 `prompts/review-prompts.ts` 自己写（那是面向用户的文案，
 * 不该由代码拼），但**它覆盖的命令集合**由测试与本清单钉死。
 */
export const AVAILABLE_COMMANDS: SlashCommand[] = [
  { command: "/review", mapsTo: "review", description: "Posts a full code review of the pull request" },
  { command: "/robin", mapsTo: "review", description: "Alias for /review" },
  { command: "/summary", mapsTo: "summary", description: "Posts a summary of the changes in the pull request" },
  { command: "/help", mapsTo: "help", description: "Shows available commands" },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 命令 token（不含斜杠，小写）→ 语义命令。 */
const COMMAND_LOOKUP: ReadonlyMap<string, ReviewerCommand> = new Map(
  AVAILABLE_COMMANDS.map((entry) => [entry.command.replace(/^\//, "").toLowerCase(), entry.mapsTo])
);

/**
 * 从权威清单派生，而不是手写。
 *
 * 尾部的 `(?:\s|$)` 是刻意的：它让 `/reviewing` 不被当成 `/review`
 * （否则 `review` 后面紧跟 `i`，不满足 terminator，正则回溯后整体不匹配）。
 */
const SLASH_COMMAND_PATTERN = new RegExp(
  `^/(${Array.from(COMMAND_LOOKUP.keys()).map(escapeRegExp).join("|")})(?:\\s|$)`,
  "i"
);

const PERMISSION_RANK: Record<string, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

export function parseSlashCommand(commentBody: string): ReviewerCommand | undefined {
  const firstLine = commentBody
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return undefined;

  const match = firstLine.match(SLASH_COMMAND_PATTERN);
  if (!match) return undefined;

  return COMMAND_LOOKUP.get(match[1].toLowerCase());
}

export function hasRequiredPermission(permission: string, minimumPermission: string): boolean {
  const userRank = PERMISSION_RANK[permission.toLowerCase()] ?? 0;
  const requiredRank = PERMISSION_RANK[minimumPermission.toLowerCase()] ?? PERMISSION_RANK.write;

  return userRank >= requiredRank;
}
