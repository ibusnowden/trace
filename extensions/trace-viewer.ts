/**
 * Interactive TUI Viewer for thinking traces.
 *
 * Full-screen component with:
 * - Scrollable trace list (↑↓, PageUp/PageDown, Home/End)
 * - Inline preview pane showing selected trace content
 * - Search/filter mode (/ toggles)
 * - Close with Esc
 *
 * Imported by the main extension (index.ts).
 */
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { ThinkingTrace } from "./index.ts";

// ──────────────────────────────────────────────────────────────
// UI Constants
// ──────────────────────────────────────────────────────────────

const PREVIEW_HEIGHT = 10; // lines of preview
const ITEMS_PER_PAGE_DEFAULT = 5;

// ──────────────────────────────────────────────────────────────
// Interactive Trace Viewer Component
// ──────────────────────────────────────────────────────────────

export interface TraceViewerOptions {
	filtered: ThinkingTrace[];
	theme: any;
	onSelect: (trace: ThinkingTrace) => void;
	onClose: () => void;
}

export class InteractiveTraceViewer implements Component {
	private filtered: ThinkingTrace[];
	private theme: any;
	private onSelect: (trace: ThinkingTrace) => void;
	private onClose: () => void;

	private selectedIndex = 0;
	private scrollOffset = 0;
	private searchMode = false;
	private searchBuffer = "";
	private cachedWidth?: number;
	private cachedLines?: string[];
	private visibleItems: number;

	constructor(opts: TraceViewerOptions) {
		this.filtered = opts.filtered;
		this.theme = opts.theme;
		this.onSelect = opts.onSelect;
		this.onClose = opts.onClose;
		this.visibleItems = Math.max(3, ITEMS_PER_PAGE_DEFAULT);
	}

	handleInput(data: string): void {
		if (this.searchMode) {
			if (matchesKey(data, Key.enter)) {
				this.searchMode = false;
				this.filterToSearch();
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace)) {
				this.searchMode = false;
				this.searchBuffer = "";
				this.invalidate();
				return;
			}
			// Append character to search buffer
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.searchBuffer += data;
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, Key.up)) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.ensureVisible();
				this.invalidate();
			}
		} else if (matchesKey(data, Key.down)) {
			if (this.selectedIndex < this.filtered.length - 1) {
				this.selectedIndex++;
				this.ensureVisible();
				this.invalidate();
			}
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, "ctrl+u" as any)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.visibleItems);
			this.ensureVisible();
			this.invalidate();
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, "ctrl+d" as any)) {
			this.selectedIndex = Math.min(
				this.filtered.length - 1,
				this.selectedIndex + this.visibleItems,
			);
			this.ensureVisible();
			this.invalidate();
		} else if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.invalidate();
		} else if (matchesKey(data, Key.end)) {
			this.selectedIndex = this.filtered.length - 1;
			this.scrollOffset = Math.max(0, this.filtered.length - this.visibleItems);
			this.invalidate();
		} else if (matchesKey(data, Key.enter)) {
			const trace = this.filtered[this.selectedIndex];
			if (trace) this.onSelect(trace);
		} else if (matchesKey(data, Key.escape)) {
			this.onClose();
		} else if (data === "/" || matchesKey(data, "ctrl+f" as any)) {
			this.searchMode = true;
			this.searchBuffer = "";
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const t = this.theme;
		const lines: string[] = [];

		// ── Header bar ──
		const title = ` 🧠 Thinking Traces (${this.filtered.length}) `;
		const navHint = " ↑↓ pgUp/Dn Home/End /search Enter-view Esc-close ";
		const headerPad = width - visibleWidth(title) - visibleWidth(navHint) - 4;
		const headerSep = " ".repeat(Math.max(1, headerPad));
		lines.push(
			t.bg("selectedBg", t.fg("accent", title + headerSep + t.fg("dim", navHint))),
		);

		// ── Search bar (if active) ──
		if (this.searchMode) {
			const searchBar = ` Search: ${this.searchBuffer}█`;
			lines.push(t.fg("warning", searchBar));
		} else {
			lines.push(t.fg("border", "─".repeat(width - 1)));
		}

		// ── Trace list ──
		this.visibleItems = Math.max(3, PREVIEW_HEIGHT);

		const endIdx = Math.min(this.scrollOffset + this.visibleItems, this.filtered.length);

		for (let i = this.scrollOffset; i < Math.min(this.filtered.length, this.scrollOffset + this.visibleItems); i++) {
			const trace = this.filtered[i];
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? "▸ " : "  ";
			const modelTag = `${trace.provider}/${trace.model}`;
			const chars = trace.thinking.length.toLocaleString();
			const line = `${prefix}${truncateToWidth(modelTag, 30).padEnd(30)} ${chars.padStart(8)} chars  Turn ${String(trace.turnIndex).padStart(2)}`;

			if (isSelected) {
				lines.push(t.bg("selectedBg", t.fg("accent", line.padEnd(width - 1))));
			} else {
				lines.push(line.padEnd(width - 1));
			}
		}

		// ── Fill remaining list space ──
		const listEnd = this.scrollOffset + this.visibleItems;
		const renderedCount = Math.min(this.filtered.length, listEnd) - this.scrollOffset;
		for (let i = renderedCount; i < this.visibleItems; i++) {
			lines.push(" ".repeat(width - 1));
		}

		// ── Preview pane ──
		const selected = this.filtered[this.selectedIndex];
		if (selected) {
			lines.push(t.fg("border", "─".repeat(width - 1)));
			lines.push(
				t.fg("muted", ` Preview — ${selected.provider}/${selected.model} (${selected.thinking.length.toLocaleString()} chars, ~${Math.ceil(selected.thinking.length / 4).toLocaleString()} tok)`),
			);

			const previewLines = selected.thinking.split("\n");
			const maxPreviewLines = PREVIEW_HEIGHT;
			const truncated = previewLines.slice(0, maxPreviewLines);
			for (const pl of truncated) {
				const safe = pl.length > width - 2 ? pl.slice(0, width - 5) + "..." : pl;
				lines.push(t.fg("dim", ` ${safe}`));
			}
			if (previewLines.length > maxPreviewLines) {
				lines.push(t.fg("warning", ` ... ${previewLines.length - maxPreviewLines} more lines`));
			}
		}

		// ── Scroll indicator ──
		if (this.filtered.length > this.visibleItems) {
			const scrollPct = Math.round(
				(this.selectedIndex / (this.filtered.length - 1)) * 100,
			);
			lines.push(
				t.fg("dim", ` Position ${this.selectedIndex + 1}/${this.filtered.length} (${scrollPct}%)`),
			);
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	// ── Private ──

	private ensureVisible(): void {
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + this.visibleItems) {
			this.scrollOffset = this.selectedIndex - this.visibleItems + 1;
		}
	}

	private filterToSearch(): void {
		const query = this.searchBuffer.toLowerCase();
		if (!query) return;
		const idx = this.filtered.findIndex(
			(t) =>
				t.thinking.toLowerCase().includes(query) ||
				t.model.toLowerCase().includes(query) ||
				t.provider.toLowerCase().includes(query),
		);
		if (idx >= 0) {
			this.selectedIndex = idx;
			this.ensureVisible();
		}
	}
}

// ── Width utility (internal, avoids full pi-tui import) ──

function visibleWidth(str: string): number {
	// Strip ANSI codes and count visible characters
	let visible = 0;
	let inEscape = false;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (c === "\x1b") {
			inEscape = true;
		} else if (inEscape) {
			if (c === "m" || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) {
				inEscape = false;
			}
		} else {
			visible++;
		}
	}
	return visible;
}
