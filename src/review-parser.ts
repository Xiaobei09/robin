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

    const line = this.asNumber(item.line);
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

  private static asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return parseInt(value, 10);
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

    // Fallback: try to find file and line anywhere in the text
    const filePattern = /[`']?([^`\s]+\.(?:[a-zA-Z0-9]+))[`']?/i;
    const linePattern = /:(\d+)/i;

    const fileMatch = itemText.match(filePattern);
    const lineMatch = itemText.match(linePattern);

    return {
      file: fileMatch ? fileMatch[1] : undefined,
      line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
      cleanedText: itemText,
    };
  }
}
