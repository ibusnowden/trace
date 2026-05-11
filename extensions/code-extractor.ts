/**
 * Thinking-to-Code Extractor
 *
 * Extracts code snippets, algorithms, data structures, and technical patterns
 * that were reasoned about during the thinking process. Useful for:
 * - Understanding what code the model considered before writing
 * - Comparing code quality between approaches considered vs. chosen
 * - Researching how models reason about code
 */
import type { ThinkingTrace } from "./index.ts";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface ExtractedCode {
	/** Programming language detected */
	language: string;
	/** The code snippet */
	code: string;
	/** Where in the thinking this appeared (line number) */
	lineNumber: number;
	/** What the model was doing with this code */
	context: "writing" | "analyzing" | "debugging" | "comparing" | "proposing" | "rejecting" | "unknown";
	/** Whether this appears to be the final chosen approach */
	isChosen: boolean;
}

export interface CodeExtractionResult {
	/** The trace this was extracted from */
	traceId: string;
	/** Model info */
	model: string;
	provider: string;
	/** All code snippets found */
	snippets: ExtractedCode[];
	/** Languages detected */
	languages: string[];
	/** Total lines of code thought about */
	totalCodeLines: number;
}

// ──────────────────────────────────────────────────────────────
// Language Detection
// ──────────────────────────────────────────────────────────────

interface LangDetector {
	name: string;
	extensions: string[];
	signatures: RegExp[];
	fenceNames: string[];
}

const LANG_DETECTORS: LangDetector[] = [
	{
		name: "TypeScript",
		extensions: [".ts", ".tsx"],
		signatures: [/interface\s+\w+|type\s+\w+\s*=/, /import.*from/, /:\s*(string|number|boolean|void|any)/],
		fenceNames: ["typescript", "ts", "tsx"],
	},
	{
		name: "JavaScript",
		extensions: [".js", ".jsx", ".mjs"],
		signatures: [/const\s+\w+\s*=/, /let\s+\w+\s*=/, /function\s+\w+\s*\(/, /require\(/, /module\.exports/],
		fenceNames: ["javascript", "js", "jsx"],
	},
	{
		name: "Python",
		extensions: [".py"],
		signatures: [/def\s+\w+\s*\(/, /import\s+\w+/, /class\s+\w+/, /print\s*\(/, /if\s+__name__/],
		fenceNames: ["python", "py"],
	},
	{
		name: "Rust",
		extensions: [".rs"],
		signatures: [/fn\s+\w+/, /let\s+mut\s/, /impl\s+\w+/, /pub\s+(fn|struct|enum|trait)/],
		fenceNames: ["rust", "rs"],
	},
	{
		name: "Go",
		extensions: [".go"],
		signatures: [/func\s+\w+/, /package\s+\w+/, /import\s*\(/, /:=/],
		fenceNames: ["go", "golang"],
	},
	{
		name: "Java",
		extensions: [".java"],
		signatures: [/public\s+(class|static|void)/, /private\s+\w+/, /System\.out/, /@Override/],
		fenceNames: ["java"],
	},
	{
		name: "C++",
		extensions: [".cpp", ".hpp", ".cc", ".cxx"],
		signatures: [/#include/, /std::/, /template\s*</, /->/, /::/],
		fenceNames: ["cpp", "c++", "c", "hpp"],
	},
	{
		name: "Bash",
		extensions: [".sh", ".bash"],
		signatures: [/#!/, /export\s+\w+=/, /if\s+\[/, /for\s+\w+\s+in/, /\$\(/],
		fenceNames: ["bash", "sh", "shell"],
	},
	{
		name: "SQL",
		extensions: [".sql"],
		signatures: [/SELECT\s+.*FROM/i, /CREATE\s+TABLE/i, /INSERT\s+INTO/i, /JOIN\s+\w+/i],
		fenceNames: ["sql"],
	},
	{
		name: "HTML",
		extensions: [".html", ".htm"],
		signatures: [/<html|<div|<span|<body|<head/i],
		fenceNames: ["html", "htm"],
	},
	{
		name: "CSS",
		extensions: [".css", ".scss"],
		signatures: [/\.[a-zA-Z-]+\s*\{/, /#\w+\s*\{/, /@media/, /display:\s+\w+/, /flex|grid/],
		fenceNames: ["css", "scss", "less"],
	},
	{
		name: "JSON",
		extensions: [".json"],
		signatures: [/^{/, /^\s*"/, /":\s*"[^"]*"/],
		fenceNames: ["json"],
	},
	{
		name: "YAML",
		extensions: [".yaml", ".yml"],
		signatures: [/^[\w-]+:/, /^\s+[\w-]+:/],
		fenceNames: ["yaml", "yml"],
	},
	{
		name: "Markdown",
		extensions: [".md"],
		signatures: [/^#+ /, /\[.*\]\(.*\)/],
		fenceNames: ["markdown", "md"],
	},
	{
		name: "TOML",
		extensions: [".toml"],
		signatures: [/^\[.*\]$/, /^\w+\s*=\s*"/],
		fenceNames: ["toml"],
	},
	{
		name: "Dockerfile",
		extensions: ["Dockerfile"],
		signatures: [/FROM\s+\w+/, /RUN\s+/, /CMD\s+/, /COPY\s+/, /WORKDIR\s+/],
		fenceNames: ["dockerfile", "docker"],
	},
];

// ──────────────────────────────────────────────────────────────
// Extraction Logic
// ──────────────────────────────────────────────────────────────

function detectLanguage(code: string, fenceName?: string): string {
	if (fenceName) {
		const byFence = LANG_DETECTORS.find((d) =>
			d.fenceNames.includes(fenceName.toLowerCase()),
		);
		if (byFence) return byFence.name;
	}

	// Score each language by signature matches
	let bestLang = "Unknown";
	let bestScore = 0;

	for (const detector of LANG_DETECTORS) {
		let score = 0;
		for (const sig of detector.signatures) {
			const matches = code.match(sig);
			if (matches) score += matches.length * 2;
		}
		if (score > bestScore) {
			bestScore = score;
			bestLang = detector.name;
		}
	}

	return bestLang;
}

function determineContext(code: string, thinking: string, lineNumber: number): ExtractedCode["context"] {
	const beforeText = thinking.slice(Math.max(0, lineNumber - 200), lineNumber).toLowerCase();

	if (/not|wrong|incorrect|issue|bug|error|problem|flaw/.test(beforeText) && /fix|correct|should/.test(beforeText)) {
		return "debugging";
	}
	if (/compare|vs|versus|alternative|instead|rather than/.test(beforeText)) {
		return "comparing";
	}
	if (/propose|suggest|maybe|could|try|attempt/.test(beforeText)) {
		return "proposing";
	}
	if (/reject|not good|bad|wrong|incorrect|no,|avoid/.test(beforeText)) {
		return "rejecting";
	}
	if (/analyze|examine|look at|understand|check|review/.test(beforeText)) {
		return "analyzing";
	}
	if (/write|implement|create|build|add|code/.test(beforeText)) {
		return "writing";
	}

	return "unknown";
}

function isChosen(code: string, thinking: string, lineNumber: number): boolean {
	const afterText = thinking.slice(lineNumber, lineNumber + 300).toLowerCase();

	// Check if the model rejects this code after showing it
	if (/but this|however|actually|instead|better to|wrong|not correct|issue|problem|flaw/.test(afterText)) {
		return false;
	}
	// Check if the model affirms it
	if (/good|correct|this works|this should|this will|we'll use|let's use|we can use/.test(afterText)) {
		return true;
	}

	return true; // Default: assume chosen unless rejected
}

export function extractCodeFromTrace(trace: ThinkingTrace): CodeExtractionResult {
	const lines = trace.thinking.split("\n");
	const snippets: ExtractedCode[] = [];
	let inFence = false;
	let fenceLang = "";
	let fenceStartLine = 0;
	let fenceContent: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fenceMatch = line.match(/^```(\w*)/);

		if (fenceMatch) {
			if (inFence) {
				// Close fence
				const code = fenceContent.join("\n");
				const language = detectLanguage(code, fenceLang);

				snippets.push({
					language,
					code,
					lineNumber: fenceStartLine,
					context: determineContext(code, trace.thinking, fenceStartLine),
					isChosen: isChosen(code, trace.thinking, fenceStartLine),
				});

				inFence = false;
				fenceLang = "";
				fenceContent = [];
			} else {
				// Open fence
				inFence = true;
				fenceLang = fenceMatch[1];
				fenceStartLine = i;
			}
		} else if (inFence) {
			fenceContent.push(line);
		}
	}

	// Also detect inline code (backtick patterns) with significant content
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const inlineMatches = line.match(/`([^`]{20,})`/g);
		if (inlineMatches) {
			for (const match of inlineMatches) {
				const code = match.replace(/`/g, "");
				const language = detectLanguage(code);
				if (language !== "Unknown" || code.includes("(") || code.includes("=")) {
					snippets.push({
						language,
						code,
						lineNumber: i,
						context: determineContext(code, trace.thinking, i),
						isChosen: isChosen(code, trace.thinking, i),
					});
				}
			}
		}
	}

	const languages = [...new Set(snippets.map((s) => s.language))].sort();
	const totalCodeLines = snippets.reduce((s, sn) => s + sn.code.split("\n").length, 0);

	return {
		traceId: trace.id,
		model: trace.model,
		provider: trace.provider,
		snippets,
		languages,
		totalCodeLines,
	};
}

export function extractCodeFromAll(traces: ThinkingTrace[]): CodeExtractionResult[] {
	return traces.map(extractCodeFromTrace);
}

export function formatCodeReport(results: CodeExtractionResult[]): string {
	let output = `# 💻 Thinking-to-Code Extraction\n\n`;
	output += `> Extracted code snippets that were reasoned about during the thinking process.\n\n`;

	// Aggregate stats
	const totalSnippets = results.reduce((s, r) => s + r.snippets.length, 0);
	const totalCodeLines = results.reduce((s, r) => s + r.totalCodeLines, 0);
	const allLangs = [...new Set(results.flatMap((r) => r.languages))].sort();

	output += `## Summary\n\n`;
	output += `| Metric | Value |\n|--------|-------|\n`;
	output += `| Traces analyzed | ${results.length} |\n`;
	output += `| Total code snippets | ${totalSnippets} |\n`;
	output += `| Total lines of code reasoned about | ${totalCodeLines.toLocaleString()} |\n`;
	output += `| Languages detected | ${allLangs.join(", ")} |\n\n`;

	// Per-trace breakdown
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const chosen = r.snippets.filter((s) => s.isChosen);
		const rejected = r.snippets.filter((s) => !s.isChosen);

		output += `## ${i + 1}. ${r.provider}/${r.model}\n\n`;
		output += `- **Total snippets:** ${r.snippets.length}\n`;
		output += `- **Languages:** ${r.languages.join(", ") || "none detected"}\n`;
		output += `- **Lines of code:** ${r.totalCodeLines}\n`;
		output += `- **Chosen approaches:** ${chosen.length}\n`;
		output += `- **Rejected/compared:** ${rejected.length}\n\n`;

		// Group by context
		const byContext = new Map<ExtractedCode["context"], ExtractedCode[]>();
		for (const s of r.snippets) {
			if (!byContext.has(s.context)) byContext.set(s.context, []);
			byContext.get(s.context)!.push(s);
		}

		for (const [context, ctxSnippets] of byContext) {
			const label = context.charAt(0).toUpperCase() + context.slice(1);
			output += `### ${label}\n\n`;

			for (const s of ctxSnippets.slice(0, 5)) {
				const tag = s.isChosen ? "✅" : "❌";
				const codePreview = s.code.split("\n").slice(0, 8).join("\n");
				const more = s.code.split("\n").length > 8 ? `\n   ... +${s.code.split("\n").length - 8} more lines` : "";

				output += `${tag} \`${s.language}\` (line ${s.lineNumber})\n\n`;
				output += "```" + s.language.toLowerCase() + "\n";
				output += codePreview + "\n";
				output += "```" + more + "\n\n";
			}
			if (ctxSnippets.length > 5) {
				output += `   ... and ${ctxSnippets.length - 5} more ${context} snippets\n\n`;
			}
		}
	}

	// Cross-snippet analysis
	const allSnippets = results.flatMap((r) => r.snippets);
	const langCount = new Map<string, number>();
	for (const s of allSnippets) {
		langCount.set(s.language, (langCount.get(s.language) || 0) + 1);
	}

	output += `## Language Distribution\n\n`;
	output += `| Language | Snippets |\n|----------|----------|\n`;
	for (const [lang, count] of [...langCount.entries()].sort((a, b) => b[1] - a[1])) {
		output += `| ${lang} | ${count} |\n`;
	}
	output += "\n";

	// Context distribution
	const ctxCount = new Map<ExtractedCode["context"], number>();
	for (const s of allSnippets) {
		ctxCount.set(s.context, (ctxCount.get(s.context) || 0) + 1);
	}

	output += `## Reasoning Context Distribution\n\n`;
	output += `| Context | Count | Description |\n|---------|-------|-------------|\n`;
	const contextDescriptions: Record<string, string> = {
		writing: "Model is writing/implementing code",
		analyzing: "Model is examining existing or proposed code",
		debugging: "Model is finding/fixing bugs",
		comparing: "Model is comparing approaches",
		proposing: "Model is suggesting alternatives",
		rejecting: "Model is rejecting an approach",
		unknown: "Context could not be determined",
	};
	for (const [ctx, count] of [...ctxCount.entries()].sort((a, b) => b[1] - a[1])) {
		output += `| ${ctx} | ${count} | ${contextDescriptions[ctx] || ""} |\n`;
	}

	return output;
}
