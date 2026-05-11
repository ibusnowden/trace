/**
 * Reasoning Density Heatmap
 *
 * Visualizes which parts of a thinking trace had the most "reasoning effort"
 * using text-density heuristics:
 *   - Logical connector density (therefore, because, if-then, etc.)
 *   - Comparative/exploratory language (however, alternatively, vs)
 *   - Verification signals (check, verify, ensure, double-check)
 *   - Code snippet density
 *   - Revision signals (wait, actually, but, correction)
 *
 * Works with ANY provider — no native thinking blocks needed.
 */
import type { ThinkingTrace } from "./index.ts";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface HeatmapSegment {
	/** Start character index */
	start: number;
	/** End character index */
	end: number;
	/** Reasoning density score (0-1) */
	density: number;
	/** Label for this segment */
	label: string;
	/** What kind of reasoning was happening */
	category: "setup" | "analysis" | "comparison" | "verification" | "code" | "conclusion" | "revision";
}

export interface HeatmapResult {
	/** The trace analyzed */
	traceId: string;
	model: string;
	provider: string;
	/** Total characters */
	totalChars: number;
	/** Segments with density scores */
	segments: HeatmapSegment[];
	/** High-density zones (>0.6) */
	hotZones: HeatmapSegment[];
	/** Overall reasoning density (0-1) */
	overallDensity: number;
	/** Peak density point */
	peakDensity: number;
	/** Category breakdown */
	categoryBreakdown: Record<string, number>;
}

// ──────────────────────────────────────────────────────────────
// Signal Detectors
// ──────────────────────────────────────────────────────────────

interface DensitySignal {
	category: HeatmapSegment["category"];
	patterns: RegExp[];
	weight: number;
}

const SIGNALS: DensitySignal[] = [
	{
		category: "analysis",
		weight: 1.0,
		patterns: [
			/Let me (think|reason|consider|analyze|break down|work through)/gi,
			/I need to (determine|find|figure|understand|check)/gi,
			/The (key|main|core) (idea|insight|concept|principle)/gi,
			/This means|what this tells us|the reason is|the key is/gi,
			/First,|Second,|Third,|Next,|Then,|Finally,/gi,
			/Step \d|One approach|Another approach/gi,
		],
	},
	{
		category: "comparison",
		weight: 1.5,
		patterns: [
			/On the (one|other) hand|compared to|by contrast|in contrast/gi,
			/vs\.|versus|whereas|while|although|however|but/gi,
			/alternative|option|instead|rather than|either|or/gi,
			/similar|differ|trade.?off|pro.*con|advantage|disadvantage/gi,
			/better|worse|faster|slower|simpler|more.*than|less.*than/gi,
		],
	},
	{
		category: "verification",
		weight: 1.3,
		patterns: [
			/verify|double.?check|validate|confirm|ensure|guarantee/gi,
			/check if|check that|make sure|test.*assumption|verify assumption/gi,
			/but wait|actually|hold on|let me re|let me check|let me verify/gi,
			/correct|wrong|incorrect|mistake|error|bug|issue/gi,
			/edge case|boundary|corner case|null|empty|overflow/gi,
		],
	},
	{
		category: "code",
		weight: 1.2,
		patterns: [
			/def |class |function |import |from .* import/gi,
			/if .*:|for .* in|while .*:|with .*:|try:|except/gi,
			/return |yield |raise |assert /gi,
			/```\w*\n[\s\S]*?\n```/g,
			/`[^`]{10,}`/g,
		],
	},
	{
		category: "revision",
		weight: 1.8,
		patterns: [
			/wait,|actually,|hold on|let me rephr|let me correct/gi,
			/no, that|not quite|on second thought|upon reflection/gi,
			/correction|revise|reconsider|scratch that|i meant/gi,
			/but this (isn't|doesn't|won't|could also|could be)/gi,
		],
	},
	{
		category: "conclusion",
		weight: 0.7,
		patterns: [
			/in conclusion|to summarize|in summary|overall|my recommendation/gi,
			/so (the|in|for)|therefore|thus|hence|consequently/gi,
			/the answer is|the result is|we get|this gives us|solving/gi,
		],
	},
	{
		category: "setup",
		weight: 0.3,
		patterns: [
			/Lets start|let me begin|first, let|introduc|background|context/gi,
			/we have|given|suppose|assume|consider a|imagine/gi,
			/the (question|problem|task|goal) is|we need to/gi,
		],
	},
];

// ──────────────────────────────────────────────────────────────
// Heatmap Generation
// ──────────────────────────────────────────────────────────────

const WINDOW_SIZE = 200; // chars per sliding window
const STEP_SIZE = 50;    // step between windows
const MIN_SEGMENT_LENGTH = 100;

export function generateHeatmap(trace: ThinkingTrace): HeatmapResult {
	const text = trace.thinking;
	const totalChars = text.length;

	// Step 1: Score each window
	type WindowScore = { start: number; score: number; categories: Record<string, number> };
	const windows: WindowScore[] = [];

	for (let i = 0; i < totalChars; i += STEP_SIZE) {
		const end = Math.min(i + WINDOW_SIZE, totalChars);
		const segment = text.slice(i, end);
		let score = 0;
		const catScores: Record<string, number> = {};

		for (const signal of SIGNALS) {
			let signalScore = 0;
			for (const pattern of signal.patterns) {
				const matches = segment.match(pattern);
				if (matches) {
					signalScore += matches.length * signal.weight;
				}
			}
			// Also count code fence blocks specially
			if (signal.category === "code") {
				const fences = segment.match(/```/g);
				if (fences) signalScore += fences.length * 0.5;
			}
			if (signalScore > 0) {
				score += signalScore;
				catScores[signal.category] = (catScores[signal.category] || 0) + signalScore;
			}
		}

		// Normalize by window length
		const normalizedScore = score / (segment.length / 100);
		windows.push({ start: i, score: normalizedScore, categories: catScores });
	}

	// Step 2: Normalize scores to 0-1 range
	const maxScore = Math.max(...windows.map((w) => w.score), 0.01);
	const normalized = windows.map((w) => ({
		...w,
		score: Math.min(1, w.score / maxScore),
	}));

	// Step 3: Merge consecutive windows into segments
	const segments: HeatmapSegment[] = [];
	let currentStart = 0;
	let currentScores: number[] = [];
	let currentCats: Record<string, number> = {};

	for (let i = 0; i < normalized.length; i++) {
		const w = normalized[i];
		currentScores.push(w.score);
		for (const [cat, sc] of Object.entries(w.categories)) {
			currentCats[cat] = (currentCats[cat] || 0) + sc;
		}

		// Check if we should break (score change or end of windows)
		const shouldBreak = i === normalized.length - 1 ||
			Math.abs(w.score - (normalized[i + 1]?.score ?? w.score)) > 0.3;

		if (shouldBreak && currentScores.length > 0) {
			const avgDensity = currentScores.reduce((a, b) => a + b, 0) / currentScores.length;
			const end = Math.min(currentStart + currentScores.length * STEP_SIZE + WINDOW_SIZE, totalChars);
			const dominantCat = Object.entries(currentCats)
				.sort((a, b) => b[1] - a[1])[0]?.[0] as HeatmapSegment["category"] || "analysis";

			// Generate label from content
			const content = text.slice(currentStart, end);
			const label = generateLabel(content, dominantCat);

			if (end - currentStart >= MIN_SEGMENT_LENGTH) {
				segments.push({
					start: currentStart,
					end,
					density: Math.round(avgDensity * 100) / 100,
					label,
					category: dominantCat,
				});
			}

			currentStart = end;
			currentScores = [];
			currentCats = {};
		}
	}

	// Step 4: Compute aggregates
	const hotZones = segments.filter((s) => s.density > 0.6);
	const overallDensity = segments.reduce((s, seg) => s + seg.density * (seg.end - seg.start), 0) /
		Math.max(1, segments.reduce((s, seg) => s + (seg.end - seg.start), 0));
	const peakDensity = Math.max(...segments.map((s) => s.density), 0);

	const categoryBreakdown: Record<string, number> = {};
	for (const s of segments) {
		const len = s.end - s.start;
		categoryBreakdown[s.category] = (categoryBreakdown[s.category] || 0) + len;
	}

	return {
		traceId: trace.id,
		model: trace.model,
		provider: trace.provider,
		totalChars,
		segments,
		hotZones,
		overallDensity: Math.round(overallDensity * 100) / 100,
		peakDensity: Math.round(peakDensity * 100) / 100,
		categoryBreakdown,
	};
}

// ──────────────────────────────────────────────────────────────
// Formatting
// ──────────────────────────────────────────────────────────────

function generateLabel(content: string, category: HeatmapSegment["category"]): string {
	// Try to find the first meaningful sentence
	const sentences = content.split(/[.!?]\s+/);
	for (const s of sentences) {
		const trimmed = s.trim();
		if (trimmed.length > 15 && trimmed.length < 80) {
			return trimmed;
		}
	}
	// Fallback: first non-empty line
	const lines = content.split("\n").filter((l) => l.trim().length > 10);
	if (lines.length > 0) {
		const l = lines[0].trim();
		return l.length > 70 ? l.slice(0, 67) + "..." : l;
	}
	return category;
}

const CATEGORY_COLORS: Record<string, { bar: string; label: string }> = {
	setup: { bar: "░", label: "Setup" },
	analysis: { bar: "▒", label: "Analysis" },
	comparison: { bar: "▓", label: "Comparison" },
	verification: { bar: "█", label: "Verification" },
	code: { bar: "▋", label: "Code" },
	conclusion: { bar: "▌", label: "Conclusion" },
	revision: { bar: "▊", label: "Revision" },
};

export function formatHeatmap(result: HeatmapResult): string {
	const WIDTH = 60; // width of the heatmap bar

	let output = `# 🧠 Reasoning Density Heatmap\n\n`;
	output += `> **${result.provider}/${result.model}** — ${result.totalChars.toLocaleString()} chars\n`;
	output += `> Overall density: ${(result.overallDensity * 100).toFixed(0)}%  |  Peak: ${(result.peakDensity * 100).toFixed(0)}%\n\n`;

	// ── ASCII heatmap bar ──
	output += `## Density Timeline\n\n`;
	output += `0%${" ".repeat(WIDTH - 6)}100%\n`;

	const bar = result.segments.map((s) => {
		const intensity = Math.round(s.density * 8);
		const chars = Math.max(1, Math.round(((s.end - s.start) / result.totalChars) * WIDTH));
		if (s.density > 0.8) return "█".repeat(chars);
		if (s.density > 0.6) return "▓".repeat(chars);
		if (s.density > 0.4) return "▒".repeat(chars);
		if (s.density > 0.2) return "░".repeat(chars);
		return " ".repeat(chars);
	}).join("");

	output += `│${bar.padEnd(WIDTH, " ")}│\n\n`;

	// ── Legend ──
	const catKeys = Object.keys(result.categoryBreakdown).sort();
	const sortedCats = catKeys.sort((a, b) => result.categoryBreakdown[b] - result.categoryBreakdown[a]);

	output += `**Legend:** `;
	for (const cat of sortedCats) {
		const c = CATEGORY_COLORS[cat] || { bar: "?", label: cat };
		output += `${c.bar}=${c.label}  `;
	}
	output += "\n\n";
	output += `| Bar | Density | Meaning |\n`;
	output += `|-----|---------|--------|\n`;
	output += `| █ | 80-100% | High reasoning effort (comparisons, verification, revision) |\n`;
	output += `| ▓ | 60-80%  | Active reasoning |\n`;
	output += `| ▒ | 40-60%  | Moderate reasoning |\n`;
	output += `| ░ | 20-40%  | Light reasoning (description, setup) |\n`;
	output += `|   | 0-20%   | Low reasoning (code output, transitions) |\n\n`;

	// ── Segments ──
	output += `## Segment Breakdown\n\n`;
	output += `| Zone | Range | Density | Category | Content |\n`;
	output += `|------|-------|---------|----------|--------|\n`;
	for (let i = 0; i < result.segments.length; i++) {
		const s = result.segments[i];
		const pct = `${(s.start / result.totalChars * 100).toFixed(0)}%-${(s.end / result.totalChars * 100).toFixed(0)}%`;
		const densityPct = `${(s.density * 100).toFixed(0)}%`;
		const icon = s.density > 0.6 ? "🔥" : s.density > 0.4 ? "⚡" : "·";
		const cat = CATEGORY_COLORS[s.category]?.label || s.category;
		output += `| ${icon} ${i + 1} | ${pct} | ${densityPct} | ${cat} | ${s.label.slice(0, 60)} |\n`;
	}
	output += "\n";

	// ── Hot zones ──
	if (result.hotZones.length > 0) {
		output += `## 🔥 Hot Zones (Highest Reasoning Effort)\n\n`;
		const sorted = [...result.hotZones].sort((a, b) => b.density - a.density);
		for (let i = 0; i < Math.min(sorted.length, 5); i++) {
			const z = sorted[i];
			const pct = `${(z.start / result.totalChars * 100).toFixed(0)}%`;
			const barLen = Math.round(z.density * 20);
			output += `| ${"█".repeat(barLen)}${" ".repeat(20 - barLen)} | ${(z.density * 100).toFixed(0)}% | ${z.label.slice(0, 50)} |\n`;
		}
		output += "\n";
	}

	// ── Category distribution ──
	const totalLen = Object.values(result.categoryBreakdown).reduce((a, b) => a + b, 0);
	output += `## Reasoning Category Distribution\n\n`;
	output += `| Category | % of Trace |\n|----------|------------|\n`;
	for (const [cat, len] of Object.entries(result.categoryBreakdown).sort((a, b) => b[1] - a[1])) {
		const pct = ((len / totalLen) * 100).toFixed(1);
		const barLen = Math.round((len / totalLen) * 30);
		output += `| ${CATEGORY_COLORS[cat]?.label || cat} | ${"█".repeat(barLen)}${" ".repeat(30 - barLen)} ${pct}% |\n`;
	}

	return output;
}

export function generateAllHeatmaps(traces: ThinkingTrace[]): HeatmapResult[] {
	return traces.map(generateHeatmap);
}
