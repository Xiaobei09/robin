import * as core from "@actions/core";

export interface ReviewFinding {
  severity: "high" | "medium" | "low" | "suggestion";
  category: string;
  confidence?: "high" | "medium" | "low";
  file?: string;
  line?: number;
  description: string;
  recommendation: string;
  codeSnippet?: string;
}

export interface StructuredReview {
  summary: string;
  high: ReviewFinding[];
  medium: ReviewFinding[];
  low: ReviewFinding[];
  suggestions: ReviewFinding[];
  rawResponse: string;
}

export interface ParsedReview {
  findings: StructuredReview;
  usedJson: boolean;
}

export class ReviewParser {
  static parse(rawText: string): StructuredReview {
    return this.parseDetailed(rawText).findings;
  }

  static parseDetailed(rawText: string): ParsedReview {
    const review: StructuredReview = {
      summary: "",
      high: [],
      medium: [],
      low: [],
      suggestions: [],
      rawResponse: rawText,
    };

    try {
      const jsonReview = this.parseJsonReview(rawText);
      if (jsonReview) {
        core.info(
          `Parsed JSON review: ${jsonReview.high.length} high, ${jsonReview.medium.length} medium, ${jsonReview.low.length} low, ${jsonReview.suggestions.length} suggestions`
        );
        return { findings: jsonReview, usedJson: true };
      }

      const markdownReview = this.parseMarkdownReview(rawText, review);
      review.summary = markdownReview.summary;
      review.high = markdownReview.high;
      review.medium = markdownReview.medium;
      review.low = markdownReview.low;
      review.suggestions = markdownReview.suggestions;

      core.info(`Parsed: ${review.high.length} high, ${review.medium.length} medium, ${review.low.length} low, ${review.suggestions.length} suggestions`);
    } catch (error) {
      core.warning(`Failed to parse structured review: ${error}. Treating entire response as raw summary.`);
      review.summary = rawText;
    }

    return { findings: review, usedJson: false };
  }

  private static parseJsonReview(rawText: string): StructuredReview | null {
    const jsonText = this.extractJsonObject(rawText);
    if (!jsonText) return null;

    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;

      return {
        summary: this.asString(parsed.summary),
        high: this.normalizeFindings(parsed.high ?? parsed.critical, "high"),
        medium: this.normalizeFindings(parsed.medium ?? parsed.important, "medium"),
        low: this.normalizeFindings(parsed.low, "low"),
        suggestions: this.normalizeFindings(parsed.suggestions, "suggestion"),
        rawResponse: rawText,
      };
    } catch {
      return null;
    }
  }

  /**
   * 从每个 `{` 出发按**配对**花括号取候选，而不是从第一个 `{` 贪心切到最后一个 `}`。
   *
   * 花括号在散文里极常见（"the {id} field"）。旧的贪心切片会把这些括号和真正的
   * JSON 粘成一个字符串，`JSON.parse` 必然失败 ⇒ `usedJson` 变 false。而 `main.ts`
   * 的重开判定是 `count === 0 && !usedJson` ⇒ 一个 JSON **完全合法**的干净 PR，
   * 只要模型散文里提到过 `{...}`，就会被判成「模型没给出 JSON」，白白重开一个 CI
   * （还先浪费一次 llm 重试）。实测：前置/后置/两端带花括号三种包装都会触发。
   *
   * 取**最长**的合法候选，而不是第一个：散文里完全可能出现
   * `Consider {"k": 1} shape.` 这种合法 JSON 片段，「第一个能 parse 就用」会把它
   * 当成 review JSON —— `summary` 取不到、findings 全空，于是**静默漏审**
   * （fail-closed 被破成 fail-open），那比「白重开一次」严重得多。真正的 review
   * JSON 总是最长的那个。
   *
   * 配对扫描顺带解决两个对象的情形（`{"a":1}` + 散文 + `{"b":2}`）：贪心切片必然
   * 失败，配对扫描能分别取到它们。
   *
   * fail-closed 语义不变：真的没有 JSON 时仍返回 null，`usedJson` 仍是 false。
   * 复杂度最坏 O(n²)（每个 `{` 一次扫描），但输出长度受 `max-output-tokens` 约束，
   * 实测量级在毫秒，不需要为此再加魔数上限（那会引入新的可动变量）。
   */
  private static extractJsonObject(rawText: string): string | null {
    const fencedJson = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedJson) return fencedJson[1].trim();

    let best: string | null = null;
    for (
      let start = rawText.indexOf("{");
      start !== -1;
      start = rawText.indexOf("{", start + 1)
    ) {
      const candidate = this.sliceBalanced(rawText, start);
      if (candidate === null) continue;
      try {
        JSON.parse(candidate);
      } catch {
        continue;
      }
      if (best === null || candidate.length > best.length) best = candidate;
    }

    return best;
  }

  /**
   * 从 `start`（必须指向 `{`）起按配对花括号截出一个对象。
   * 字符串字面量里的括号不算，转义引号也不算。
   */
  private static sliceBalanced(text: string, start: number): string | null {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1).trim();
      }
    }
    return null;
  }

  private static normalizeFindings(value: unknown, severity: ReviewFinding["severity"]): ReviewFinding[] {
    if (!Array.isArray(value)) return [];

    return value
      .map((item) => this.normalizeFinding(item, severity))
      .filter((item): item is ReviewFinding => item !== null);
  }

  private static normalizeFinding(value: unknown, severity: ReviewFinding["severity"]): ReviewFinding | null {
    if (!value || typeof value !== "object") return null;

    const item = value as Record<string, unknown>;
    const description = this.asString(item.description).trim();
    if (!description) return null;

    const line = this.asLineNumber(item.line);
    const file = this.asString(item.file).trim() || undefined;

    return {
      severity,
      category: this.asString(item.category),
      confidence: this.asConfidence(item.confidence),
      file,
      line,
      description,
      recommendation: this.asString(item.recommendation),
      codeSnippet: this.asString(item.codeSnippet) || undefined,
    };
  }

  private static asString(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private static asConfidence(value: unknown): ReviewFinding["confidence"] {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return normalized === "high" || normalized === "medium" || normalized === "low"
      ? normalized
      : undefined;
  }

  /**
   * 行号必须是 **1 起的整数**：0 与负数在文件里不存在，小数也不是行号。
   *
   * 旧的 `asNumber` 只判 `Number.isFinite`，而 `/^\d+$/` 只管字符串分支 ——
   * number 分支直接放行，于是 `line: 0` / `line: -5` / `line: 1.5` /
   * `line: 99999999` 全被原样接受（实测四项都出现在解析结果里）。
   *
   * 下游目前**恰好**挡得住：`github-reviewer` 的 `!finding.line` 丢掉 0，
   * `isLineInNewDiff` 丢掉其余。但那是两道「恰好挡下」的护栏，不是「本来就合法」，
   * 有人改下游就会退化。与其指望下游兜底，不如在这里就不产出非法行号。
   *
   * 改名 `asLineNumber` 是因为它**只**服务 `line` 字段（confidence 走独立的
   * `asConfidence`，需要 0..1 的小数）。名字应当说明契约，否则将来有人拿它去解析
   * 置信度就会踩坑。
   */
  private static asLineNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const parsed = parseInt(value, 10);
      if (parsed >= 1) return parsed;
    }
    return undefined;
  }

  private static parseMarkdownReview(rawText: string, review: StructuredReview): StructuredReview {
    const summaryMatch = rawText.match(/#{2,3}\s*Summary[\s\S]*?(?=(?:#{2,3}\s*(?:High|Medium|Low|Critical|Important|Suggestion)|$))/i);
    if (summaryMatch) {
      review.summary = summaryMatch[0].replace(/#{2,3}\s*Summary\s*/i, "").trim();
    }

    const highSection = this.extractSection(rawText, "High|Critical");
    const mediumSection = this.extractSection(rawText, "Medium|Important");
    const lowSection = this.extractSection(rawText, "Low");
    const suggestionSection = this.extractSection(rawText, "Suggestion");

    review.high = this.parseFindings(highSection, "high");
    review.medium = this.parseFindings(mediumSection, "medium");
    review.low = this.parseFindings(lowSection, "low");
    review.suggestions = this.parseFindings(suggestionSection, "suggestion");

    return review;
  }

  private static extractSection(text: string, sectionName: string): string {
    const regex = new RegExp(
      `#{2,3}\\s*(?:${sectionName})[^\\n]*(?::|\\s*\\(.*?\\))?\\s*\\n([\\s\\S]*?)(?=(?:#{2,3}\\s*(?:High|Medium|Low|Critical|Important|Suggestion|Summary)|$))`,
      "i"
    );
    const match = text.match(regex);
    return match ? match[1].trim() : "";
  }

  private static parseFindings(section: string, severity: ReviewFinding["severity"]): ReviewFinding[] {
    if (!section) return [];

    const lines = section.split("\n");
    const findings: ReviewFinding[] = [];
    let currentFinding: Partial<ReviewFinding> | null = null;
    let descriptionLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const itemText = trimmed.replace(/^[-*•·]\s+/, "").replace(/^\d+\.\s+/, "");
      if (/^(none|n\/a|no issues?)\.?$/i.test(itemText)) continue;

      const isNewItem = /^[-*•·]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed);

      if (isNewItem) {
        if (currentFinding) {
          currentFinding.description = descriptionLines.join("\n").trim();
          if (currentFinding.description) {
            findings.push(currentFinding as ReviewFinding);
          }
        }

        const fileLine = this.extractFileAndLine(trimmed);
        currentFinding = {
          severity,
          category: "",
          description: "",
          recommendation: "",
          file: fileLine.file,
          line: fileLine.line,
        };

        // Use cleaned text (without file:line prefix) as first description line
        descriptionLines = [fileLine.cleanedText];
      } else if (trimmed.startsWith("  ") || trimmed.startsWith("\t")) {
        if (this.looksLikeCode(trimmed)) {
          if (currentFinding) {
            currentFinding.codeSnippet = (currentFinding.codeSnippet || "") + trimmed + "\n";
          }
        } else {
          descriptionLines.push(trimmed);
        }
      } else {
        descriptionLines.push(trimmed);
      }
    }

    if (currentFinding) {
      currentFinding.description = descriptionLines.join("\n").trim();
      if (currentFinding.description) {
        findings.push(currentFinding as ReviewFinding);
      }
    }

    return findings;
  }

  private static looksLikeCode(text: string): boolean {
    const codeIndicators = [
      /^\s*(def|class|function|const|let|var|import|export|if|for|while|return)/,
      /^\s*[/].*[/]/,
      /^\s*[`"']/,
      /^\s*[{\[(]/,
    ];
    return codeIndicators.some((pattern) => pattern.test(text));
  }

  private static extractFileAndLine(text: string): { file?: string; line?: number; cleanedText: string } {
    // Match pattern like `src/auth.ts:42 — description` or `src/auth.ts:42 - description`
    const itemText = text.replace(/^[-*•·]\s+/, "").replace(/^\d+\.\s+/, "");
    const fullPattern = /^[`']?([^`\s]+\.(?:[a-zA-Z0-9]+))[`']?\s*:\s*(\d+)\s*(?:--|[\-\u2013\u2014])\s*(.+)$/i;
    const match = itemText.match(fullPattern);

    if (match) {
      return {
        file: match[1],
        line: parseInt(match[2], 10),
        cleanedText: match[3].trim(),
      };
    }

    // Fallback: 行号必须**紧跟**文件名，而不是在整句里各找各的。
    //
    // 旧实现分别跑两个正则：filePattern 取整句里**第一个** `xxx.ext`，linePattern 取
    // 整句里**第一个** `:数字`。散文里的东西于是全被当成定位信息（以下走真
    // ReviewParser.parseDetailed 实测）：
    //
    //   "- At 09:05 the code in src/auth.ts:42 ran."       => file=src/auth.ts  line=5
    //   "- It runs at 10:30 and e.g. retries twice in src/auth.ts:42."
    //                                                          => file="e.g"      line=30
    //   "- Version 1.5 introduced this, see src/auth.ts:42." => file="1.5"      line=42
    //   "- Endpoint https://example.com:8080/v1 fails, see src/auth.ts:42."
    //                                                          => file=https://… line=8080
    //
    // 第一条最毒：**文件名对了、行号错了**。`GitHubReviewer.isLineInNewDiff` 只检查
    // 行号是否落在该文件的 diff 范围内，5 行若在 diff 里就会**放行** ⇒ 评论发到
    // `src/auth.ts:5`，而模型写的是 `:42`。这是会误导审查者的错位评论。
    //
    // 其余几条后果稍轻：`files.find(f => f.filename === finding.file)` 找不到就
    // warning 后整条丢弃，所以不会污染 GitHub review；但模型给出的真实发现就此
    // **静默消失**，只在日志里留一条 warning。
    //
    // 改成「文件紧跟 `:行号`」的配对匹配之后：
    // - `e.g.` / `1.5` 后面没有 `:数字`，天然不会被当成定位；
    // - 行号不再可能来自散文别处的 `:数字`（时间 `09:05`、端口 `:8080`）。
    //
    // URL 仍然满足这个形态（`example.com:8080`），所以候选还要过 `looksLikeFilePath`。
    const pairPattern = /[`']?([^\s`'():]+\.[a-zA-Z0-9]+)[`']?\s*:\s*(\d+)/g;
    let pair: RegExpExecArray | null;
    while ((pair = pairPattern.exec(itemText)) !== null) {
      if (!this.looksLikeFilePath(pair[1])) continue;
      return {
        file: pair[1],
        line: parseInt(pair[2], 10),
        cleanedText: itemText,
      };
    }

    // 没有行号时仍保留文件名：`GitHubReviewer` 会跳过内联评论（`!finding.line`），
    // 但 location 文案里还会显示文件名，这个能力要留住。
    const filePattern = /[`']?([^\s`'():]+\.[a-zA-Z0-9]+)[`']?/g;
    let fileMatch: RegExpExecArray | null;
    while ((fileMatch = filePattern.exec(itemText)) !== null) {
      if (!this.looksLikeFilePath(fileMatch[1])) continue;
      return { file: fileMatch[1], line: undefined, cleanedText: itemText };
    }

    // 「只有行号」这条路径是**故意删掉**的：没有文件定位的行号本来就发不出评论，
    // 而它恰恰是散文里时间、端口、`"a":1` 这类片段的来源。
    return { file: undefined, line: undefined, cleanedText: itemText };
  }

  /**
   * 候选像不像仓库里的文件路径 —— 用来把散文里的 `e.g` / `1.5` / URL 挡在门外。
   *
   * 判据刻意保守，宁可漏（丢掉一条评论）也不误判（把评论发到错误的行上）：
   * - 含 `//` ⇒ URL（`https://example.com`、`//example.com`）；
   * - 含 `/` ⇒ 有目录前缀，直接认；
   - 否则只看扩展名：`e.g` / `i.e` 的扩展名只有一个字母，而 `README.md` / `a.ts` /
   *   `Makefile` 的都够长。
   *
   * 已知残余：`www.example.com:8080` 这种不带 `//` 的形式仍会通过（有目录前缀的
   * 规则兜不住它，扩展名 `com` 也够长）。后果只是被下游 `files.find` 丢弃 ——
   * 丢发现，不会错位 —— 比原先严格。
   *
   * 之所以抽成方法而不是内联，是因为**两个匹配路径（配对、仅文件名）都要用**；
   * 内联复制的话，变异「只在一处加判据」不会被任何测试抓到。
   */
  private static looksLikeFilePath(candidate: string): boolean {
    if (candidate.includes("//")) return false;
    if (candidate.includes("/")) return true;
    const dot = candidate.lastIndexOf(".");
    if (dot === -1) return false;
    return /^[a-zA-Z]{2,}$/.test(candidate.slice(dot + 1));
  }
}
