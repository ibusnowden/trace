/**
 * Reasoning Pattern Classifier
 *
 * Analyzes thinking traces and classifies them into reasoning strategies:
 * - Deductive: rule-based, top-down reasoning
 * - Inductive: pattern-based, bottom-up reasoning
 * - Abductive: inference to best explanation
 * - Analogical: comparison-based reasoning
 * - Causal: cause-effect reasoning
 * - Computational: step-by-step algorithmic
 * - Exploratory: exploring multiple alternatives
 * - Verification: checking/verifying assumptions
 *
 * Each trace gets scored across all strategies, and the dominant pattern is identified.
 */
import type { ThinkingTrace } from "./index.ts";

// ──────────────────────────────────────────────────────────────
// Pattern Definitions
// ──────────────────────────────────────────────────────────────

export interface PatternScore {
	pattern: ReasoningPattern;
	score: number;
	confidence: "high" | "medium" | "low";
	evidence: string[];
}

export type ReasoningPattern =
	| "deductive"
	| "inductive"
	| "abductive"
	| "analogical"
	| "causal"
	| "computational"
	| "exploratory"
	| "verification";

export interface PatternResult {
	/** The trace this analysis applies to */
	traceId: string;
	/** Model that produced the trace */
	model: string;
	/** Provider */
	provider: string;
	/** Dominant pattern (highest score) */
	dominant: ReasoningPattern;
	/** All pattern scores */
	scores: PatternScore[];
	/** Summary of the reasoning style */
	summary: string;
	/** Steps identified in the thinking */
	steps: string[];
	/** Estimated reasoning depth (number of distinct reasoning hops) */
	depth: number;
}

export interface PatternAggregate {
	/** Total traces analyzed */
	totalTraces: number;
	/** Per-pattern counts */
	patternDistribution: Record<ReasoningPattern, number>;
	/** Per-model pattern breakdown */
	perModel: Record<string, Record<ReasoningPattern, number>>;
	/** Dominant pattern overall */
	overallDominant: ReasoningPattern;
}

const PATTERN_LABELS: Record<ReasoningPattern, string> = {
	deductive: "Deductive",
	inductive: "Inductive",
	abductive: "Abductive",
	analogical: "Analogical",
	causal: "Causal",
	computational: "Computational",
	exploratory: "Exploratory",
	verification: "Verification",
};

const PATTERN_DESCRIPTIONS: Record<ReasoningPattern, string> = {
	deductive: "Rule-based, top-down reasoning from general principles to specific conclusions",
	inductive: "Pattern-based, bottom-up reasoning from observations to general principles",
	abductive: "Inference to the best explanation from available evidence",
	analogical: "Comparison-based reasoning using analogies and parallels",
	causal: "Cause-and-effect reasoning tracing chains of causation",
	computational: "Step-by-step algorithmic or procedural reasoning",
	exploratory: "Exploration of multiple alternatives, hypotheses, or approaches",
	verification: "Verification, checking, validating assumptions or conclusions",
};

// ──────────────────────────────────────────────────────────────
// Pattern Detection Heuristics
// ──────────────────────────────────────────────────────────────

interface PatternDetector {
	pattern: ReasoningPattern;
	keywords: RegExp[];
	weight: number; // weight multiplier for this detector
}

const DETECTORS: PatternDetector[] = [
	{
		pattern: "deductive",
		weight: 1.0,
		keywords: [
			/therefore|thus|hence|consequently|if.*then|by definition|must be|necessarily|follows that|implies that|because.*is a/gi,
			/since.*all|given that|as a rule|in general|principle|axiom|postulate|theorem/gi,
			/from.*we can conclude|this means that|it follows|we deduce|we infer|we conclude/gi,
		],
	},
	{
		pattern: "inductive",
		weight: 1.0,
		keywords: [
			/pattern|trend|generally|typically|often|in most cases|usually|tends to|commonly/gi,
			/based on.*examples|from these examples|observing that|notice that|similar pattern/gi,
			/generalize|generalization|commonality|common theme|recurring/gi,
		],
	},
	{
		pattern: "abductive",
		weight: 1.0,
		keywords: [
			/best explanation|most likely|plausible|hypothesis|account for|explains why/gi,
			/the reason.*is|this suggests that|likely cause|probable|could be explained by/gi,
			/inference to|abductive|abduction|what would explain|why would/gi,
		],
	},
	{
		pattern: "analogical",
		weight: 1.0,
		keywords: [
			/analogy|analogous|similar to|like.*but|compare to|parallel to|metaphor|akin to/gi,
			/just as|in the same way|similarly|likewise|by analogy|comparison/gi,
			/resembles|mirrors|reflects|corresponds to|maps to/gi,
		],
	},
	{
		pattern: "causal",
		weight: 1.0,
		keywords: [
			/causes|caused by|leads to|results in|due to|because of|since.*therefore/gi,
			/effect|impact|influence|trigger|chain of|ripple|cascade|causal/gi,
			/if.*then.*will|would lead to|would cause|affects|contributes to/gi,
		],
	},
	{
		pattern: "computational",
		weight: 1.0,
		keywords: [
			/step \d|first,|second,|third,|next,|finally,|then,|after that/gi,
			/algorithm|procedure|method|approach.*involves|process|pipeline|workflow/gi,
			/iterate|loop|recursive|sequential|ordered|sorted|compute|calculate/gi,
		],
	},
	{
		pattern: "exploratory",
		weight: 1.0,
		keywords: [
			/alternative|option|possibility|could also|another way|maybe|perhaps|alternatively/gi,
			/what if|consider|suppose|let's try|one approach|different angle/gi,
			/explore|investigate|examine|trade.?off|pro.*con|advantage|disadvantage/gi,
		],
	},
	{
		pattern: "verification",
		weight: 1.0,
		keywords: [
			/verify|verify.*check|double.?check|ensure|validate|confirm|cross.?check|spot.?check/gi,
			/check if|check that|make sure|test.*assumption|verify assumption/gi,
			/review|audit|inspect|examine.*carefully|look for.*error|catch.*mistake/gi,
		],
	},
];

// ──────────────────────────────────────────────────────────────
// Step Detection
// ──────────────────────────────────────────────────────────────

function detectSteps(thinking: string): string[] {
	const stepPatterns = [
		/^(Let me|First,|Second,|Third,|Next,|Then,|Finally,|Step \d+|Now,|Firstly,|Secondly,)/gim,
		/^(\d+\.)\s/gm,
		/^(## .+)$/gm,
	];

	// Try numbered steps
	const numbered = thinking.split(/\n(?=\d+\.\s)/);
	if (numbered.length > 3) return numbered.filter((s) => s.trim().length > 20).slice(0, 15);

	// Try step keywords
	const keywordSteps = thinking.split(/\n(?=(Let me|First[,:]|Second[,:]|Next[,:]|Then[,:]|Finally[,:]|Step ))/g);
	if (keywordSteps.length > 2) return keywordSteps.filter((s) => s.trim().length > 20).slice(0, 15);

	// Try paragraphs
	const paragraphs = thinking.split(/\n\n+/).filter((s) => s.trim().length > 40);
	if (paragraphs.length > 1) return paragraphs.slice(0, 15);

	return [];
}

function estimateDepth(thinking: string, steps: string[]): number {
	const depthMarkers = [
		/because|therefore|since|if|then|implies|leads to|causes/gi,
		/however|but|although|unless|provided that|given that/gi,
		/subsequently|consequently|as a result|this means/gi,
	];

	let depthScore = steps.length;
	for (const marker of depthMarkers) {
		const matches = thinking.match(marker);
		if (matches) depthScore += matches.length;
	}

	return Math.min(Math.round(depthScore / 2), 20);
}

// ──────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────

export function classifyTrace(trace: ThinkingTrace): PatternResult {
	const thinking = trace.thinking;
	const steps = detectSteps(thinking);

	const scores: PatternScore[] = DETECTORS.map((detector) => {
		let matchCount = 0;
		const evidence: string[] = [];

		for (const regex of detector.keywords) {
			const matches = thinking.match(regex);
			if (matches) {
				matchCount += matches.length;
				// Collect first few matches as evidence
				for (const m of matches.slice(0, 2)) {
					const snippet = m.length > 60 ? m.slice(0, 57) + "..." : m;
					if (!evidence.includes(snippet)) evidence.push(snippet);
				}
			}
		}

		// Normalize to length of text
		const normalizedScore = (matchCount * detector.weight) / Math.max(1, thinking.length / 500);
		const score = Math.round(normalizedScore * 100) / 100;

		let confidence: "high" | "medium" | "low" = "low";
		if (score > 3) confidence = "high";
		else if (score > 1) confidence = "medium";

		return {
			pattern: detector.pattern,
			score,
			confidence,
			evidence: evidence.slice(0, 3),
		};
	});

	// Sort by score descending
	scores.sort((a, b) => b.score - a.score);

	const dominant = scores[0].pattern;
	// Build summary
	const topPatterns = scores.filter((s) => s.confidence !== "low").slice(0, 3);
	let summary = `${PATTERN_LABELS[dominant]} reasoning`;
	if (topPatterns.length > 1) {
		const others = topPatterns.slice(1).map((s) => PATTERN_LABELS[s.pattern].toLowerCase());
		summary += ` with ${others.join(" and ")} elements`;
	}
	if (dominant === "computational" && steps.length > 3) {
		summary += ` (${steps.length} steps)`;
	}

	const depth = estimateDepth(thinking, steps);

	return {
		traceId: trace.id,
		model: trace.model,
		provider: trace.provider,
		dominant,
		scores,
		summary,
		steps,
		depth,
	};
}

export function classifyAll(traces: ThinkingTrace[]): PatternResult[] {
	return traces.map(classifyTrace);
}

// ──────────────────────────────────────────────────────────────
// Aggregation
// ──────────────────────────────────────────────────────────────

export function aggregatePatterns(results: PatternResult[]): PatternAggregate {
	const totalTraces = results.length;
	const patternDistribution: Record<ReasoningPattern, number> = {
		deductive: 0, inductive: 0, abductive: 0, analogical: 0,
		causal: 0, computational: 0, exploratory: 0, verification: 0,
	};
	const perModel: Record<string, Record<ReasoningPattern, number>> = {};

	for (const r of results) {
		patternDistribution[r.dominant]++;

		const modelKey = `${r.provider}/${r.model}`;
		if (!perModel[modelKey]) {
			perModel[modelKey] = {
				deductive: 0, inductive: 0, abductive: 0, analogical: 0,
				causal: 0, computational: 0, exploratory: 0, verification: 0,
			};
		}
		perModel[modelKey][r.dominant]++;
	}

	const overallDominant = (Object.entries(patternDistribution) as [ReasoningPattern, number][])
		.sort((a, b) => b[1] - a[1])[0][0];

	return {
		totalTraces,
		patternDistribution,
		perModel,
		overallDominant,
	};
}

export function formatPatternReport(results: PatternResult[], aggregate: PatternAggregate): string {
	let output = `# 🧠 Reasoning Pattern Analysis\n\n`;

	output += `## Aggregate Summary\n\n`;
	output += `| Metric | Value |\n|--------|-------|\n`;
	output += `| Total traces analyzed | ${aggregate.totalTraces} |\n`;
	output += `| Overall dominant pattern | ${PATTERN_LABELS[aggregate.overallDominant]} |\n\n`;

	output += `### Pattern Distribution\n\n`;
	output += `| Pattern | Count | % | Description |\n|---------|-------|---|-------------|\n`;
	const total = aggregate.totalTraces;
	for (const [pattern, count] of Object.entries(aggregate.patternDistribution).sort((a, b) => b[1] - a[1])) {
		const pct = ((count / total) * 100).toFixed(1);
		output += `| ${PATTERN_LABELS[pattern as ReasoningPattern]} | ${count} | ${pct}% | ${PATTERN_DESCRIPTIONS[pattern as ReasoningPattern]} |\n`;
	}
	output += "\n";

	// Per-model breakdown
	if (Object.keys(aggregate.perModel).length > 0) {
		output += `### Per-Model Pattern Breakdown\n\n`;
		for (const [model, patterns] of Object.entries(aggregate.perModel)) {
			const modelTotal = Object.values(patterns).reduce((s, c) => s + c, 0);
			output += `**${model}** (${modelTotal} traces)\n\n`;
			output += `| Pattern | Count | % |\n|---------|-------|---|\n`;
			for (const [pattern, count] of Object.entries(patterns).sort((a, b) => b[1] - a[1])) {
				if (count > 0) {
					const pct = ((count / modelTotal) * 100).toFixed(1);
					output += `| ${PATTERN_LABELS[pattern as ReasoningPattern]} | ${count} | ${pct}% |\n`;
				}
			}
			output += "\n";
		}
	}

	// Trace-by-trace breakdown
	output += `## Per-Trace Analysis\n\n`;
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		output += `### ${i + 1}. ${r.provider}/${r.model} (Turn ${r.traceId.slice(-6)})\n\n`;
		output += `- **Dominant pattern:** ${PATTERN_LABELS[r.dominant]}\n`;
		output += `- **Summary:** ${r.summary}\n`;
		output += `- **Reasoning depth:** ${r.depth}/20\n`;
		output += `- **Steps detected:** ${r.steps.length}\n\n`;

		output += `| Pattern | Score | Confidence | Evidence |\n|---------|-------|------------|----------|\n`;
		for (const s of r.scores) {
			if (s.score > 0) {
				const ev = s.evidence.length > 0 ? `\`${s.evidence[0]}\`` : "-";
				output += `| ${PATTERN_LABELS[s.pattern]} | ${s.score.toFixed(2)} | ${s.confidence} | ${ev} |\n`;
			}
		}
		output += "\n";

		if (r.steps.length > 0) {
			output += `**Reasoning steps:**\n\n`;
			for (let s = 0; s < Math.min(r.steps.length, 8); s++) {
				const step = r.steps[s].trim().slice(0, 120);
				output += `${s + 1}. ${step}\n`;
			}
			if (r.steps.length > 8) output += `  ... ${r.steps.length - 8} more steps\n`;
			output += "\n";
		}
	}

	return output;
}
