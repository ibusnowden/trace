/**
 * Reasoning Trace Visualizer — main extension
 *
 * Captures thinking/reasoning blocks from assistant messages across model
 * providers and provides tools to visualize, compare, and export them.
 *
 * Commands:
 *   /thinking-log [filter]      Show captured thinking traces (optional text filter)
 *   /thinking-export             Export all traces as structured markdown
 *   /thinking-stats              Show statistics about captured traces
 *   /thinking-compare [a] [b]   Compare traces from two models side-by-side
 *   /thinking-diagram [filter]   Generate Mermaid flowchart from reasoning traces
 *   /thinking-viz                Interactive TUI viewer for browsing traces
 *   /thinking-blog               Generate a blog-ready markdown analysis post
 *   /thinking-clear              Clear all captured traces in current session
 *
 * Install:
 *   pi install /path/to/reasoning-trace-viz
 *   # or copy to .pi/extensions/
 *
 * Reload:
 *   /reload
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import { InteractiveTraceViewer } from "./trace-viewer.ts";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ThinkingTrace {
	/** Unique ID */
	id: string;
	/** The thinking text content */
	thinking: string;
	/** Model that produced this trace */
	model: string;
	/** Provider used (e.g. ds4, anthropic, google) */
	provider: string;
	/** Timestamp when captured */
	timestamp: number;
	/** Turn index within the session */
	turnIndex: number;
	/** Whether this was compacted */
	compacted: boolean;
}

export type { ThinkingTrace };

interface ThinkingStats {
	totalTraces: number;
	totalThinkingTokens: number;
	models: Record<string, number>;
	averageThinkingLength: number;
	averageThinkingTokens: number;
	longestTrace: number;
	all: ThinkingTrace[];
}

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const CUSTOM_TYPE = "thinking-trace";
const TOKEN_EST_RATIO = 4; // ~4 chars per token

// ──────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let traces: ThinkingTrace[] = [];
	let turnCounter = 0;

	// ── Utilities ──

	function loadTraces(ctx: ExtensionContext) {
		traces = [];
		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (
				entry.type === "custom" &&
				entry.customType === CUSTOM_TYPE &&
				entry.data
			) {
				traces.push(entry.data as ThinkingTrace);
			}
		}
	}

	function saveTrace(trace: ThinkingTrace, ctx: ExtensionContext) {
		traces.push(trace);
		pi.appendEntry(CUSTOM_TYPE, trace);
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext) {
		const count = traces.length;
		if (count > 0) {
			ctx.ui.setStatus("thinking-traces", `🧠 ${count} traces`);
		} else {
			ctx.ui.setStatus("thinking-traces", undefined);
		}
	}

	function estTokens(text: string): number {
		return Math.ceil(text.length / TOKEN_EST_RATIO);
	}

	function fmtTime(ts: number): string {
		return new Date(ts).toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	function fmtDuration(ts1: number, ts2: number): string {
		const diff = Math.abs(ts2 - ts1);
		const sec = Math.floor(diff / 1000);
		if (sec < 60) return `${sec}s`;
		const min = Math.floor(sec / 60);
		return `${min}m ${sec % 60}s`;
	}

	/** Split a reasoning trace into logical "steps" based on common patterns */
	function splitIntoSteps(thinking: string): string[] {
		const stepMarkers = [
			/^(Let me|First|Second|Third|Next|Then|Finally|Step \d+|1\.|2\.|3\.)/gim,
			/^## /gm,
			/^\d+\.\s/gm,
			/^- /gm,
		];

		// Try splitting by numbered steps first
		const numbered = thinking.split(/\n(?=\d+\.\s)/);
		if (numbered.length > 1) return numbered.filter((s) => s.trim().length > 20);

		// Try splitting by markdown headings
		const headings = thinking.split(/\n(?=## )/);
		if (headings.length > 1) return headings.filter((s) => s.trim().length > 20);

		// Try splitting by step keywords
		const steps = thinking.split(/\n(?=(Let me|First,|Second,|Next,|Then,|Finally,|Step ))/g);
		if (steps.length > 1) return steps.filter((s) => s.trim().length > 20);

		// Fallback: split into equal chunks
		if (thinking.length > 500) {
			const chunkSize = Math.ceil(thinking.length / Math.ceil(thinking.length / 500));
			const chunks: string[] = [];
			for (let i = 0; i < thinking.length; i += chunkSize) {
				chunks.push(thinking.slice(i, i + chunkSize));
			}
			return chunks;
		}

		return [thinking];
	}

	/** Extract keywords from a thinking trace for diagram labels */
	function extractKeywords(text: string, count: number = 5): string[] {
		// Simple extraction: find capitalized multi-word phrases and single important words
		const words = text
			.replace(/[^a-zA-Z0-9\s-]/g, "")
			.split(/\s+/)
			.filter((w) => w.length > 4 && !["this", "that", "with", "from", "have", "been", "were", "will", "would", "could", "should", "their", "there", "which", "about", "first", "second", "third", "then", "next", "just", "also", "very", "what", "when", "where", "how"].includes(w.toLowerCase()));

		// Get most frequent words
		const freq: Record<string, number> = {};
		for (const w of words) {
			freq[w.toLowerCase()] = (freq[w.toLowerCase()] || 0) + 1;
		}

		return Object.entries(freq)
			.sort((a, b) => b[1] - a[1])
			.slice(0, count)
			.map(([w]) => w);
	}

	function getStats(): ThinkingStats {
		let totalTokens = 0;
		const models: Record<string, number> = {};
		let longest = 0;

		for (const t of traces) {
			const key = `${t.provider}/${t.model}`;
			models[key] = (models[key] || 0) + 1;
			totalTokens += estTokens(t.thinking);
			if (t.thinking.length > longest) longest = t.thinking.length;
		}

		const avgLength = traces.length > 0 ? longest / traces.length : 0;
		const avgTokens = traces.length > 0 ? totalTokens / traces.length : 0;

		return {
			totalTraces: traces.length,
			totalThinkingTokens: totalTokens,
			models,
			averageThinkingLength: avgLength,
			averageThinkingTokens: avgTokens,
			longestTrace: longest,
			all: [...traces],
		};
	}

	// ── Events ──

	pi.on("session_start", async (_event, ctx) => {
		turnCounter = 0;
		loadTraces(ctx);
		updateStatus(ctx);
	});

	pi.on("turn_start", async () => {
		turnCounter++;
	});

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;

		const content = msg.content;
		if (!content || !Array.isArray(content)) return;

		const thinkingBlocks = content.filter(
			(c): c is { type: "thinking"; thinking: string } =>
				c.type === "thinking" && typeof c.thinking === "string",
		);

		if (thinkingBlocks.length === 0) return;

		const model = msg.model || "unknown";
		const provider = msg.provider || "unknown";

		for (const block of thinkingBlocks) {
			const trace: ThinkingTrace = {
				id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				thinking: block.thinking,
				model,
				provider,
				timestamp: Date.now(),
				turnIndex: turnCounter,
				compacted: false,
			};
			saveTrace(trace, ctx);
		}
	});

	// ── Command: /thinking-log ──

	pi.registerCommand("thinking-log", {
		description:
			"Show captured thinking traces. Use /thinking-log <filter> to search.",
		handler: async (args, ctx) => {
			if (traces.length === 0) {
				ctx.ui.notify("No thinking traces captured yet. Ask a complex question first!", "info");
				return;
			}

			const filterText = args.trim().toLowerCase();
			const filtered = filterText
				? traces.filter(
						(t) =>
							t.thinking.toLowerCase().includes(filterText) ||
							t.model.toLowerCase().includes(filterText) ||
							t.provider.toLowerCase().includes(filterText),
					)
				: traces;

			if (filtered.length === 0) {
				ctx.ui.notify(`No traces matching "${filterText}"`, "warning");
				return;
			}

			let output = `# 🧠 Thinking Traces (${filtered.length})\n\n`;
			if (filterText) output += `Filter: \`${filterText}\`\n\n`;

			for (let i = 0; i < filtered.length; i++) {
				const t = filtered[i];
				output += `## ${i + 1}. ${t.provider}/${t.model} (Turn ${t.turnIndex})\n\n`;
				output += `- **Time:** ${fmtTime(t.timestamp)}\n`;
				output += `- **Est. tokens:** ${estTokens(t.thinking).toLocaleString()}\n`;
				output += `- **Length:** ${t.thinking.length.toLocaleString()} chars\n`;
				if (t.compacted) output += `- **Status:** compacted\n`;
				output += "\n```\n";
				output += t.thinking;
				output += "\n```\n\n";
			}

			ctx.ui.setEditorText(output);
			ctx.ui.notify(`Showing ${filtered.length} trace(s) in editor`, "success");
		},
	});

	// ── Command: /thinking-export ──

	pi.registerCommand("thinking-export", {
		description: "Export all thinking traces as structured markdown.",
		handler: async (_args, ctx) => {
			if (traces.length === 0) {
				ctx.ui.notify("No thinking traces to export.", "info");
				return;
			}

			const stats = getStats();
			let output = `# Reasoning Trace Export\n\n`;
			output += `> Exported: ${new Date().toISOString()}\n`;
			output += `> Traces: ${stats.totalTraces}\n`;
			output += `> Est. total tokens: ${stats.totalThinkingTokens.toLocaleString()}\n\n`;

			output += `## Models\n\n`;
			for (const [model, count] of Object.entries(stats.models)) {
				output += `- **${model}**: ${count} traces\n`;
			}
			output += "\n---\n\n";

			for (let i = 0; i < traces.length; i++) {
				const t = traces[i];
				output += `## Trace ${i + 1}: ${t.provider}/${t.model}\n\n`;
				output += `| Field | Value |\n|-------|-------|\n`;
				output += `| Model | \`${t.provider}/${t.model}\` |\n`;
				output += `| Time | ${new Date(t.timestamp).toISOString()} |\n`;
				output += `| Turn | ${t.turnIndex} |\n`;
				output += `| Length | ${t.thinking.length.toLocaleString()} chars |\n`;
				output += `| Est. tokens | ${estTokens(t.thinking).toLocaleString()} |\n`;
				output += `| Compacted | ${t.compacted} |\n\n`;
				output += "### Content\n\n```\n";
				output += t.thinking;
				output += "\n```\n\n";
				if (i < traces.length - 1) output += "---\n\n";
			}

			ctx.ui.setEditorText(output);
			ctx.ui.notify(`Exported ${traces.length} traces to editor`, "success");
		},
	});

	// ── Command: /thinking-stats ──

	pi.registerCommand("thinking-stats", {
		description: "Show summary statistics about captured thinking traces.",
		handler: async (_args, ctx) => {
			if (traces.length === 0) {
				ctx.ui.notify("No thinking traces captured yet.", "info");
				return;
			}

			const stats = getStats();

			const timeRange = traces.length > 1
				? fmtDuration(traces[0].timestamp, traces[traces.length - 1].timestamp)
				: "N/A";

			let output = `# 🧠 Thinking Trace Statistics\n\n`;
			output += `| Metric | Value |\n|--------|-------|\n`;
			output += `| Total traces | ${stats.totalTraces} |\n`;
			output += `| Session span | ${timeRange} |\n`;
			output += `| Total est. thinking tokens | ${stats.totalThinkingTokens.toLocaleString()} |\n`;
			output += `| Avg trace length | ${stats.averageThinkingLength.toFixed(0)} chars |\n`;
			output += `| Avg est. tokens/trace | ${stats.averageThinkingTokens.toFixed(0)} |\n`;
			output += `| Longest trace | ${stats.longestTrace.toLocaleString()} chars (${estTokens("x".repeat(stats.longestTrace)).toLocaleString()} tok) |\n`;
			output += `| Unique models | ${Object.keys(stats.models).length} |\n\n`;

			output += `## Per Model\n\n`;
			output += `| Model | Traces | % |\n|-------|--------|---|\n`;
			for (const [model, count] of Object.entries(stats.models).sort((a, b) => b[1] - a[1])) {
				const pct = ((count / stats.totalTraces) * 100).toFixed(1);
				output += `| ${model} | ${count} | ${pct}% |\n`;
			}

			ctx.ui.setEditorText(output);
			ctx.ui.notify("Statistics written to editor", "success");
		},
	});

	// ── Command: /thinking-compare ──

	pi.registerCommand("thinking-compare", {
		description:
			"Compare thinking patterns between two models. Usage: /thinking-compare <model-a> [model-b]. " +
			"Omitting models shows all model comparisons.",
		handler: async (args, ctx) => {
			if (traces.length < 2) {
				ctx.ui.notify("Need at least 2 traces from different models to compare.", "warning");
				return;
			}

			const parts = args.trim().split(/\s+/).filter(Boolean);
			const modelA = parts[0] || null;
			const modelB = parts[1] || null;

			// Group traces by model
			const byModel: Record<string, ThinkingTrace[]> = {};
			for (const t of traces) {
				const key = `${t.provider}/${t.model}`;
				if (!byModel[key]) byModel[key] = [];
				byModel[key].push(t);
			}

			const modelKeys = Object.keys(byModel).sort();

			// Filter by requested models
			let selectedModels = modelKeys;
			if (modelA) {
				selectedModels = modelKeys.filter(
					(k) => k.toLowerCase().includes(modelA.toLowerCase()),
				);
			}
			if (modelB && selectedModels.length > 1) {
				selectedModels = selectedModels.filter(
					(k) =>
						k.toLowerCase().includes(modelA!.toLowerCase()) ||
						k.toLowerCase().includes(modelB.toLowerCase()),
				);
			}

			if (selectedModels.length < 2) {
				ctx.ui.notify(
					`Need at least 2 models to compare. Found models: ${modelKeys.join(", ")}`,
					"warning",
				);
				return;
			}

			let output = `# 🔄 Cross-Model Reasoning Comparison\n\n`;

			for (let i = 0; i < selectedModels.length; i++) {
				for (let j = i + 1; j < selectedModels.length; j++) {
					const m1 = selectedModels[i];
					const m2 = selectedModels[j];
					const t1 = byModel[m1];
					const t2 = byModel[m2];

					output += `## ${m1} vs ${m2}\n\n`;

					// Basic comparison
					const avgLen1 = t1.reduce((s, t) => s + t.thinking.length, 0) / t1.length;
					const avgLen2 = t2.reduce((s, t) => s + t.thinking.length, 0) / t2.length;
					const avgTok1 = t1.reduce((s, t) => s + estTokens(t.thinking), 0) / t1.length;
					const avgTok2 = t2.reduce((s, t) => s + estTokens(t.thinking), 0) / t2.length;

					output += `### Length & Token Comparison\n\n`;
					output += `| Metric | ${m1} | ${m2} |\n|--------|------|------|\n`;
					output += `| Traces | ${t1.length} | ${t2.length} |\n`;
					output += `| Avg chars | ${avgLen1.toFixed(0)} | ${avgLen2.toFixed(0)} |\n`;
					output += `| Avg est. tokens | ${avgTok1.toFixed(0)} | ${avgTok2.toFixed(0)} |\n`;
					output += `| Total chars | ${t1.reduce((s, t) => s + t.thinking.length, 0).toLocaleString()} | ${t2.reduce((s, t) => s + t.thinking.length, 0).toLocaleString()} |\n\n`;

					// Step count comparison
					const steps1 = t1.flatMap((t) => splitIntoSteps(t.thinking));
					const steps2 = t2.flatMap((t) => splitIntoSteps(t.thinking));
					output += `### Reasoning Structure\n\n`;
					output += `- **${m1}** → ${steps1.length} reasoning steps across ${t1.length} trace(s)\n`;
					output += `- **${m2}** → ${steps2.length} reasoning steps across ${t2.length} trace(s)\n\n`;

					// Keyword comparison (what each model focused on)
					const kw1 = new Set(extractKeywords(t1.map((t) => t.thinking).join(" "), 10));
					const kw2 = new Set(extractKeywords(t2.map((t) => t.thinking).join(" "), 10));
					const shared = [...kw1].filter((k) => kw2.has(k));
					const uniqueM1 = [...kw1].filter((k) => !kw2.has(k));
					const uniqueM2 = [...kw2].filter((k) => !kw1.has(k));

					output += `### Focus Keywords\n\n`;
					if (shared.length > 0) output += `- **Shared focus:** ${shared.join(", ")}\n`;
					if (uniqueM1.length > 0) output += `- **${m1} unique:** ${uniqueM1.join(", ")}\n`;
					if (uniqueM2.length > 0) output += `- **${m2} unique:** ${uniqueM2.join(", ")}\n`;
					output += "\n";

					// Show first trace from each side by side
					if (t1[0] && t2[0]) {
						output += `### Sample Thinking\n\n`;
						output += `<details>\n<summary>${m1} — first ${Math.min(300, t1[0].thinking.length)} chars</summary>\n\n`;
						output += "```\n";
						output += t1[0].thinking.slice(0, 600);
						output += "\n```\n\n";
						output += `</details>\n\n`;

						output += `<details>\n<summary>${m2} — first ${Math.min(300, t2[0].thinking.length)} chars</summary>\n\n`;
						output += "```\n";
						output += t2[0].thinking.slice(0, 600);
						output += "\n```\n\n";
						output += `</details>\n\n`;
					}

					if (i < selectedModels.length - 1 || j < selectedModels.length - 1) {
						output += "---\n\n";
					}
				}
			}

			ctx.ui.setEditorText(output);
			ctx.ui.notify(`Comparison of ${selectedModels.join(", ")} written to editor`, "success");
		},
	});

	// ── Command: /thinking-diagram ──

	pi.registerCommand("thinking-diagram", {
		description:
			"Generate Mermaid flowchart from reasoning traces. " +
			"Use /thinking-diagram <filter> to include only matching traces.",
		handler: async (args, ctx) => {
			if (traces.length === 0) {
				ctx.ui.notify("No thinking traces to diagram.", "info");
				return;
			}

			const filterText = args.trim().toLowerCase();
			const filtered = filterText
				? traces.filter(
						(t) =>
							t.thinking.toLowerCase().includes(filterText) ||
							t.model.toLowerCase().includes(filterText),
					)
				: traces;

			if (filtered.length === 0) {
				ctx.ui.notify(`No traces matching "${filterText}"`, "warning");
				return;
			}

			let output = `# 🧠 Reasoning Diagram — Mermaid Flowchart\n\n`;
			output += `\`\`\`mermaid\n`;
			output += `flowchart TD\n`;
			output += `    %% Auto-generated from ${filtered.length} thinking trace(s)\n`;
			output += `    %% Generated: ${new Date().toISOString()}\n\n`;

			let nodeId = 0;
			const modelColors: Record<string, string> = {
				"ds4/deepseek-v4-flash": "#4FC3F7",
				"anthropic": "#D4A574",
				"google": "#81C784",
				"openai": "#74AA9C",
			};

			function nextNode(): string {
				return `N${nodeId++}`;
			}

			function sanitize(text: string): string {
				return text
					.replace(/[^a-zA-Z0-9\s\-_.,;:!?()\[\]{}"'`\/@#$%^&*+=<>]/g, "")
					.replace(/"/g, "#quot;")
					.slice(0, 80);
			}

			for (let i = 0; i < filtered.length; i++) {
				const t = filtered[i];
				const modelKey = Object.keys(modelColors).find((k) =>
					t.provider.toLowerCase().includes(k.split("/")[0]),
				) || t.provider;
				const color = modelColors[modelKey] || "#90A4AE";

				// Trace header node
				const headerNode = nextNode();
				output += `    ${headerNode}["${t.provider}/${t.model} — Turn ${t.turnIndex}"]\n`;
				output += `    style ${headerNode} fill:${color},color:#fff,stroke:#333,stroke-width:2px\n\n`;

				// Split into steps
				const steps = splitIntoSteps(t.thinking);

				let prevNode = headerNode;

				for (let s = 0; s < Math.min(steps.length, 12); s++) {
					const stepText = sanitize(steps[s].trim());
					const stepLabel = stepText.length > 50
						? stepText.slice(0, 47) + "..."
						: stepText;
					const stepNode = nextNode();
					const label = `Step ${s + 1}: ${stepLabel}`;
					output += `    ${stepNode}["${label}"]\n`;
					output += `    ${prevNode} --> ${stepNode}\n`;

					if (s < Math.min(steps.length, 12) - 1) {
						// Extract subs-steps for longer thinking
						const subLines = steps[s].split("\n").filter((l) => {
							const t = l.trim();
							return t.length > 10 && t.length < 100 && /^[A-Z]/.test(t);
						});

						if (subLines.length > 0 && subLines.length <= 4) {
							for (const line of subLines.slice(0, 3)) {
								const subLabel = sanitize(line.trim());
								if (subLabel.length < 5) continue;
								const subNode = nextNode();
								const shortLabel = subLabel.length > 40
									? subLabel.slice(0, 37) + "..."
									: subLabel;
								output += `    ${subNode}["${shortLabel}"]\n`;
								output += `    ${stepNode} -.-> ${subNode}\n`;
							}
						}
					}

					prevNode = stepNode;
				}

				output += "\n";
			}

			output += "```\n\n";
			output += `> Paste this into a [Mermaid live editor](https://mermaid.live) to render the diagram.\n`;
			output += `> Or use \`npx @mermaid-js/mermaid-cli -i diagram.md -o diagram.png\`\n`;

			ctx.ui.setEditorText(output);
			ctx.ui.notify(`Generated mermaid diagram from ${filtered.length} trace(s)`, "success");
		},
	});

	// ── Command: /thinking-viz (interactive TUI viewer) ──

	pi.registerCommand("thinking-viz", {
		description:
			"Interactive TUI viewer for browsing thinking traces. " +
			"↑↓ pgUp/Dn Home/End navigate, / to search, Enter to view, Esc to close.",
		handler: async (args, ctx) => {
			if (traces.length === 0) {
				ctx.ui.notify("No thinking traces to view.", "info");
				return;
			}

			const filterText = args.trim().toLowerCase();
			const filtered = filterText
				? traces.filter(
						(t) =>
							t.thinking.toLowerCase().includes(filterText) ||
							t.model.toLowerCase().includes(filterText),
					)
				: traces;

			if (filtered.length === 0) {
				ctx.ui.notify(`No traces matching "${filterText}"`, "warning");
				return;
			}

			await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const viewer = new InteractiveTraceViewer({
					filtered,
					theme,
					onSelect: (trace) => {
						ctx.ui.setEditorText(
							`# Trace: ${trace.provider}/${trace.model} (Turn ${trace.turnIndex})\n\n` +
							"```\n" + trace.thinking + "\n```",
						);
						done(null);
					},
					onClose: () => done(null),
				});

				tui.requestRender();
				return viewer;
			});
		},
	});

	// ── Command: /thinking-blog ──

	pi.registerCommand("thinking-blog", {
		description:
			"Generate a blog-ready markdown analysis post comparing reasoning patterns " +
			"across all captured models.",
		handler: async (_args, ctx) => {
			if (traces.length === 0) {
				ctx.ui.notify("No thinking traces to analyze. Ask some complex questions first!", "info");
				return;
			}

			const stats = getStats();
			const modelKeys = Object.keys(stats.models).sort();

			let output = `# 🧠 Inside the Black Box: A Cross-Model Reasoning Analysis\n\n`;
			output += `> *Generated automatically from ${stats.totalTraces} thinking traces across ${modelKeys.length} model(s)*\n`;
			output += `> *Date: ${new Date().toISOString().split("T")[0]}*\n\n`;

			output += `## Overview\n\n`;
			output += `This analysis examines the internal reasoning patterns of `;
			output += modelKeys.join(" and ");
			output += `, captured using the [Reasoning Trace Visualizer](https://github.com/inniang/reasoning-trace-viz).\n\n`;

			output += `| Metric | Value |\n|--------|-------|\n`;
			output += `| Total reasoning traces | ${stats.totalTraces} |\n`;
			output += `| Total estimated thinking tokens | ${stats.totalThinkingTokens.toLocaleString()} |\n`;
			output += `| Models compared | ${modelKeys.length} |\n`;
			output += `| Avg tokens per trace | ${stats.averageThinkingTokens.toFixed(0)} |\n\n`;

			output += `## Per-Model Summary\n\n`;
			for (const model of modelKeys) {
				const modelTraces = traces.filter((t) => `${t.provider}/${t.model}` === model);
				const avgLen = modelTraces.reduce((s, t) => s + estTokens(t.thinking), 0) / modelTraces.length;
				const totalLen = modelTraces.reduce((s, t) => s + estTokens(t.thinking), 0);
				output += `### ${model}\n\n`;
				output += `- **Traces:** ${modelTraces.length}\n`;
				output += `- **Total thinking tokens:** ${totalLen.toLocaleString()}\n`;
				output += `- **Average per trace:** ${avgLen.toFixed(0)} tokens\n`;
				output += `- **Thinking style:** ${describeThinkingStyle(modelTraces)}\n\n`;
			}

			output += `## Reasoning Pattern Analysis\n\n`;

			if (modelKeys.length >= 2) {
				output += `### Key Differences\n\n`;
				for (let i = 0; i < modelKeys.length; i++) {
					for (let j = i + 1; j < modelKeys.length; j++) {
						const m1 = modelKeys[i];
						const m2 = modelKeys[j];
						const t1 = traces.filter((t) => `${t.provider}/${t.model}` === m1);
						const t2 = traces.filter((t) => `${t.provider}/${t.model}` === m2);

						const kw1 = extractKeywords(t1.map((t) => t.thinking).join(" "), 8);
						const kw2 = extractKeywords(t2.map((t) => t.thinking).join(" "), 8);
						const shared = kw1.filter((k) => kw2.includes(k));

						output += `**${m1}** tends to focus on: ${kw1.join(", ")}\n\n`;
						output += `**${m2}** tends to focus on: ${kw2.join(", ")}\n\n`;
						if (shared.length > 0) {
							output += `Both models share focus on: ${shared.join(", ")}\n\n`;
						}
					}
				}
			}

			output += `### Sample Traces\n\n`;
			for (let i = 0; i < Math.min(traces.length, 4); i++) {
				const t = traces[i];
				output += `<details>\n<summary>${t.provider}/${t.model} (Turn ${t.turnIndex})</summary>\n\n`;
				output += "```\n";
				output += t.thinking.slice(0, 500);
				if (t.thinking.length > 500) output += "\n...";
				output += "\n```\n\n";
				output += `</details>\n\n`;
			}

			output += `## Methodology\n\n`;
			output += `Thinking traces were captured using [pi](https://pi.dev) with the `;
			output += `[Reasoning Trace Visualizer](https://github.com/inniang/reasoning-trace-viz) extension. `;
			output += `The extension hooks into \`message_end\` events and extracts \`thinking\` content blocks `;
			output += `from assistant messages. All traces are stored persistently in session files.\n\n`;
			output += `Token counts are estimated at ~4 characters per token. Actual token counts may vary by tokenizer.\n\n`;

			output += `---\n\n`;
			output += `*This post was auto-generated. For the full raw data, use \`/thinking-export\` in pi.*\n`;

			ctx.ui.setEditorText(output);
			ctx.ui.notify("Blog post generated in editor!", "success");
		},
	});

	// ── Command: /thinking-clear ──

	pi.registerCommand("thinking-clear", {
		description: "Clear all captured thinking traces in the current session.",
		handler: async (_args, ctx) => {
			if (traces.length === 0) {
				ctx.ui.notify("No traces to clear.", "info");
				return;
			}

			const ok = await ctx.ui.confirm(
				"Clear traces?",
				`Delete all ${traces.length} captured thinking traces? This cannot be undone.`,
			);

			if (!ok) {
				ctx.ui.notify("Clear cancelled.", "info");
				return;
			}

			traces = [];
			updateStatus(ctx);
			ctx.ui.notify("All thinking traces cleared.", "success");
		},
	});

	// ── Command: /thinking-sessions ──

	pi.registerCommand("thinking-sessions", {
		description:
			"List all sessions that have thinking traces, with trace counts per session.",
		handler: async (_args, ctx) => {
			const sessionDir = ctx.sessionManager.getSessionDir();
			if (!sessionDir || !existsSync(sessionDir)) {
				ctx.ui.notify("No session directory found.", "warning");
				return;
			}

			const sessionFiles: string[] = [];
			const traverseDir = (dir: string) => {
				try {
					const entries = readdirSync(dir, { withFileTypes: true });
					for (const entry of entries) {
						const fullPath = join(dir, entry.name);
						if (entry.isDirectory()) {
							traverseDir(fullPath);
						} else if (entry.name.endsWith(".jsonl")) {
							sessionFiles.push(fullPath);
						}
					}
				} catch { /* skip unreadable */ }
			};
			traverseDir(sessionDir);

			ctx.ui.notify(`Scanning ${sessionFiles.length} session file(s)...`, "info");

			const sessionTraces: Array<{ file: string; count: number; models: Set<string> }> = [];

			for (const file of sessionFiles) {
				try {
					const content = readFileSync(file, "utf8");
					const tracesInFile: ThinkingTrace[] = [];
					for (const line of content.split("\n").filter(Boolean)) {
						try {
							const entry = JSON.parse(line);
							if (
								entry.type === "custom" &&
								entry.customType === CUSTOM_TYPE &&
								entry.data
							) {
								tracesInFile.push(entry.data as ThinkingTrace);
							}
						} catch { /* skip malformed lines */ }
					}
					if (tracesInFile.length > 0) {
						const models = new Set(tracesInFile.map((t) => `${t.provider}/${t.model}`));
						sessionTraces.push({ file, count: tracesInFile.length, models });
					}
				} catch { /* skip unreadable */ }
			}

			if (sessionTraces.length === 0) {
				ctx.ui.notify("No thinking traces found across any session.", "info");
				return;
			}

			const totalAll = sessionTraces.reduce((s, st) => s + st.count, 0);
			const allModels = new Set<string>();
			sessionTraces.forEach((st) => st.models.forEach((m) => allModels.add(m)));

			let output = `# 🧠 Cross-Session Trace Summary\n\n`;
			output += `| Metric | Value |\n|--------|-------|\n`;
			output += `| Sessions with traces | ${sessionTraces.length} |\n`;
			output += `| Total traces | ${totalAll} |\n`;
			output += `| Unique models | ${allModels.size} |\n\n`;

			output += `## Sessions\n\n`;
			output += `| # | Traces | Models | File |\n|---|--------|--------|------|\n`;
			const sorted = [...sessionTraces].sort((a, b) => b.count - a.count);
			for (let i = 0; i < sorted.length; i++) {
				const st = sorted[i];
				const shortName = st.file.split("/").pop() || st.file;
				output += `| ${i + 1} | ${st.count} | ${[...st.models].join(", ")} | \`${shortName}\` |\n`;
			}

			ctx.ui.setEditorText(output);
			ctx.ui.notify(`Found ${totalAll} traces across ${sessionTraces.length} session(s)`, "success");
		},
	});

	// ── Command: /thinking-aggregate ──

	pi.registerCommand("thinking-aggregate", {
		description:
			"Aggregate thinking traces from ALL sessions and produce cross-session " +
			"statistics, model comparison, and timeline analysis.",
		handler: async (_args, ctx) => {
			const sessionDir = ctx.sessionManager.getSessionDir();
			if (!sessionDir || !existsSync(sessionDir)) {
				ctx.ui.notify("No session directory found.", "warning");
				return;
			}

			const sessionFiles: string[] = [];
			const traverseDir = (dir: string) => {
				try {
					const entries = readdirSync(dir, { withFileTypes: true });
					for (const entry of entries) {
						const fullPath = join(dir, entry.name);
						if (entry.isDirectory()) {
							traverseDir(fullPath);
						} else if (entry.name.endsWith(".jsonl")) {
							sessionFiles.push(fullPath);
						}
					}
				} catch { /* skip unreadable */ }
			};
			traverseDir(sessionDir);

			ctx.ui.notify(`Scanning ${sessionFiles.length} session(s) for traces...`, "info");

			// Collect all traces across all sessions
			const allTraces: ThinkingTrace[] = [];
			for (const file of sessionFiles) {
				try {
					const content = readFileSync(file, "utf8");
					for (const line of content.split("\n").filter(Boolean)) {
						try {
							const entry = JSON.parse(line);
							if (
								entry.type === "custom" &&
								entry.customType === CUSTOM_TYPE &&
								entry.data
							) {
								allTraces.push(entry.data as ThinkingTrace);
							}
						} catch { /* skip */ }
					}
				} catch { /* skip */ }
			}

			if (allTraces.length === 0) {
				ctx.ui.notify("No thinking traces found across any session.", "info");
				return;
			}

			// Deduplicate by content hash (thinking text)
			const seen = new Set<string>();
			const uniqueTraces: ThinkingTrace[] = [];
			for (const t of allTraces) {
				const key = t.thinking.slice(0, 100) + t.model + t.provider;
				if (!seen.has(key)) {
					seen.add(key);
					uniqueTraces.push(t);
				}
			}

			// Per-model stats
			const byModel: Record<string, ThinkingTrace[]> = {};
			for (const t of uniqueTraces) {
				const key = `${t.provider}/${t.model}`;
				if (!byModel[key]) byModel[key] = [];
				byModel[key].push(t);
			}

			// Per-session stats (using the raw list)
			const perSession = new Map<string, number>();
			for (const file of sessionFiles) {
				try {
					const content = readFileSync(file, "utf8");
					let count = 0;
					for (const line of content.split("\n").filter(Boolean)) {
						try {
							const entry = JSON.parse(line);
							if (
								entry.type === "custom" &&
								entry.customType === CUSTOM_TYPE &&
								entry.data
							) {
								count++;
							}
						} catch { /* skip */ }
					}
					if (count > 0) {
						perSession.set(file.split("/").pop() || file, count);
					}
				} catch { /* skip */ }
			}

			const totalTraces = uniqueTraces.length;
			const totalTokens = uniqueTraces.reduce((s, t) => s + estTokens(t.thinking), 0);
			const avgTokens = totalTraces > 0 ? totalTokens / totalTraces : 0;
			const longestTrace = uniqueTraces.reduce((max, t) => Math.max(max, t.thinking.length), 0);
			const sortedByTime = [...uniqueTraces].sort((a, b) => a.timestamp - b.timestamp);

			let output = `# 🧠 Cross-Session Aggregated Analysis\n\n`;
			output += `> Generated: ${new Date().toISOString()}\n`;
			output += `> Source: ${perSession.size} session(s), ${sessionFiles.length} file(s) scanned\n\n`;

			output += `## Summary\n\n`;
			output += `| Metric | Value |\n|--------|-------|\n`;
			output += `| Total unique traces | ${totalTraces} |\n`;
			output += `| Total est. thinking tokens | ${totalTokens.toLocaleString()} |\n`;
			output += `| Avg tokens per trace | ${avgTokens.toFixed(0)} |\n`;
			output += `| Longest trace | ${longestTrace.toLocaleString()} chars (${estTokens("x".repeat(longestTrace)).toLocaleString()} tok) |\n`;
			output += `| Unique models | ${Object.keys(byModel).length} |\n\n`;

			output += `## Per-Model Breakdown\n\n`;
			output += `| Model | Traces | Total Tokens | Avg Tokens |\n|-------|--------|-------------|------------|\n`;
			for (const [model, traces] of Object.entries(byModel).sort((a, b) => b[1].length - a[1].length)) {
				const tTok = traces.reduce((s, t) => s + estTokens(t.thinking), 0);
				const aTok = (tTok / traces.length).toFixed(0);
				output += `| ${model} | ${traces.length} | ${tTok.toLocaleString()} | ${aTok} |\n`;
			}
			output += "\n";

			// Timeline (time range)
			if (sortedByTime.length > 1) {
				const first = new Date(sortedByTime[0].timestamp);
				const last = new Date(sortedByTime[sortedByTime.length - 1].timestamp);
				const days = Math.round((last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24));
				output += `## Timeline\n\n`;
				output += `- **First trace:** ${first.toLocaleString()}\n`;
				output += `- **Last trace:** ${last.toLocaleString()}\n`;
				output += `- **Span:** ${days} day(s)\n`;
				output += `- **Density:** ${(totalTraces / Math.max(1, days)).toFixed(1)} traces/day\n\n`;
			}

			// Word cloud (top keywords across all traces)
			const allText = uniqueTraces.map((t) => t.thinking).join(" ");
			const keywords = extractKeywords(allText, 20);
			output += `## Top Keywords Across All Sessions\n\n`;
			output += `${keywords.join(", ")}\n\n`;

			// Cross-model comparison if multiple models
			if (Object.keys(byModel).length >= 2) {
				output += `## Cross-Model Comparison\n\n`;
				const modelKeys = Object.keys(byModel).sort();
				for (let i = 0; i < modelKeys.length; i++) {
					for (let j = i + 1; j < modelKeys.length; j++) {
						const m1 = modelKeys[i];
						const m2 = modelKeys[j];
						const t1 = byModel[m1];
						const t2 = byModel[m2];

						const avg1 = t1.reduce((s, t) => s + estTokens(t.thinking), 0) / t1.length;
						const avg2 = t2.reduce((s, t) => s + estTokens(t.thinking), 0) / t2.length;
						const kw1 = extractKeywords(t1.map((t) => t.thinking).join(" "), 8);
						const kw2 = extractKeywords(t2.map((t) => t.thinking).join(" "), 8);

						output += `### ${m1} vs ${m2}\n\n`;
						output += `| Metric | ${m1} | ${m2} |\n|--------|------|------|\n`;
						output += `| Traces | ${t1.length} | ${t2.length} |\n`;
						output += `| Avg tokens | ${avg1.toFixed(0)} | ${avg2.toFixed(0)} |\n`;
						output += `| Focus | ${kw1.slice(0, 5).join(", ")} | ${kw2.slice(0, 5).join(", ")} |\n\n`;
					}
				}
			}

			// Distribution analysis
			output += `## Thinking Length Distribution\n\n`;
			const buckets = [0, 200, 500, 1000, 2000, 5000, 10000, Infinity];
			const bucketLabels = ["0-200", "200-500", "500-1K", "1K-2K", "2K-5K", "5K-10K", "10K+"];
			const bucketCounts = new Array(buckets.length - 1).fill(0);
			for (const t of uniqueTraces) {
				const len = t.thinking.length;
				for (let b = 0; b < buckets.length - 1; b++) {
					if (len >= buckets[b] && len < buckets[b + 1]) {
						bucketCounts[b]++;
						break;
					}
				}
			}
			output += `| Length (chars) | Count | % |\n|----------------|-------|---|\n`;
			for (let b = 0; b < bucketLabels.length; b++) {
				const pct = ((bucketCounts[b] / totalTraces) * 100).toFixed(1);
				output += `| ${bucketLabels[b]} | ${bucketCounts[b]} | ${pct}% |\n`;
			}
			output += "\n";

			// Per-session breakdown
			output += `## Per-Session Breakdown\n\n`;
			output += `| File | Traces |\n|------|--------|\n`;
			for (const [file, count] of [...perSession.entries()].sort((a, b) => b[1] - a[1])) {
				const shortName = file.length > 50 ? "..." + file.slice(-47) : file;
				output += `| \`${shortName}\` | ${count} |\n`;
			}

			ctx.ui.setEditorText(output);
			ctx.ui.notify(`Aggregated ${totalTraces} unique traces across ${perSession.size} session(s)`, "success");
		},
	});

	// ── Command: /thinking-dashboard ──

	pi.registerCommand("thinking-dashboard", {
		description:
			"Generate a standalone HTML dashboard with search, charts, timeline, " +
			"and model comparison. Opens in browser automatically.",
		handler: async (_args, ctx) => {
			if (traces.length === 0) {
				ctx.ui.notify("No thinking traces to dashboard. Ask some complex questions first!", "info");
				return;
			}

			ctx.ui.notify(`Generating dashboard from ${traces.length} traces...`, "info");

			const { generateDashboardHtml } = await import("./dashboard.ts");
			const html = generateDashboardHtml(traces);

			// Write to temp file
			const { writeFileSync, mkdtempSync } = await import("node:fs");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const dir = mkdtempSync(join(tmpdir(), "thinking-dash-"));
			const filePath = join(dir, "index.html");
			writeFileSync(filePath, html, "utf8");

			ctx.ui.notify(`Dashboard written to ${filePath}`, "success");

			// Open in browser
			const { exec } = await import("node:child_process");
			const platform = process.platform;
			const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
			exec(`${cmd} "${filePath}"`, (err) => {
				if (err) {
					ctx.ui.notify(`Could not open browser. Open manually: ${filePath}`, "warning");
				}
			});
		},
	});

	// ── Inner helpers ──

	function describeThinkingStyle(traces: ThinkingTrace[]): string {
		if (traces.length === 0) return "Unknown";

		const allText = traces.map((t) => t.thinking).join(" ");
		const avgLen = allText.length / traces.length;
		const steps = traces.flatMap((t) => splitIntoSteps(t.thinking));

		let description = "";

		if (avgLen > 2000) {
			description += "verbose, thorough reasoning";
		} else if (avgLen > 800) {
			description += "moderate, balanced reasoning";
		} else {
			description += "concise, direct reasoning";
		}

		if (steps.length / traces.length > 5) {
			description += " with many discrete steps";
		} else if (steps.length / traces.length > 2) {
			description += " with clear step-by-step breakdown";
		}

		// Check for code presence
		if (allText.includes("```") || allText.includes("def ") || allText.includes("function")) {
			description += ", often includes code snippets";
		}
		if (allText.includes("?") || allText.includes("what if")) {
			description += ", explores alternative approaches";
		}
		if (allText.includes("Let me check") || allText.includes("verify") || allText.includes("confirm")) {
			description += ", verifies assumptions before concluding";
		}

		return description;
	}

	// matchesKey and Key are imported at top of file.
}
