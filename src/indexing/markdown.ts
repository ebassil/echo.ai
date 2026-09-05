export interface MarkdownSection {
	content: string;
	headingLevel: number | null;
	isCodeFence: boolean;
}

const FRONT_MATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n/;
const ATX_HEADING_RE = /^(#{1,6})\s+/;
const SETEXT_UNDERLINE_RE = /^([=-]{2,})\s*$/;

export function stripFrontMatter(markdown: string): string {
	if (!markdown.startsWith('---')) return markdown;
	const match = markdown.match(FRONT_MATTER_RE);
	if (!match) return markdown;
	return markdown.slice(match[0].length);
}

export function parseMarkdownSections(markdown: string): MarkdownSection[] {
	const withoutFrontMatter = stripFrontMatter(markdown);
	const lines = withoutFrontMatter.split('\n');
	const sections: MarkdownSection[] = [];

	let currentLines: string[] = [];
	let currentHeadingLevel: number | null = null;
	let insideCodeFence = false;
	let fenceMarker: string | null = null;

	function flush(): void {
		if (currentLines.length === 0) return;
		const content = currentLines.join('\n').trim();
		if (content.length > 0) {
			sections.push({
				content,
				headingLevel: currentHeadingLevel,
				isCodeFence: false,
			});
		}
		currentLines = [];
	}

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (!insideCodeFence) {
				flush();
				insideCodeFence = true;
				fenceMarker = marker[0] as string;
				// Include fence lines in code section
				const codeLines: string[] = [line];
				i++;
				while (i < lines.length) {
					const innerLine = lines[i];
					codeLines.push(innerLine);
					if (innerLine.trim().startsWith(fenceMarker)) {
						insideCodeFence = false;
						fenceMarker = null;
						i++;
						break;
					}
					i++;
				}
				const codeContent = codeLines.join('\n').trim();
				if (codeContent.length > 0) {
					sections.push({
						content: codeContent,
						headingLevel: null,
						isCodeFence: true,
					});
				}
				continue;
			}
		}

		if (insideCodeFence) {
			currentLines.push(line);
			i++;
			continue;
		}

		const atxMatch = line.match(ATX_HEADING_RE);
		if (atxMatch) {
			flush();
			currentHeadingLevel = atxMatch[1].length;
			const headingText = line.slice(atxMatch[0].length);
			// Heading line starts a new section with that heading as first line
			currentLines.push(line);
			// If next line looks like content, it stays in same section until next heading
			// We keep heading with following content as one section
			i++;
			continue;
		}

		// Setext heading detection: line + underline
		if (i + 1 < lines.length && lines[i + 1].match(SETEXT_UNDERLINE_RE) && trimmed.length > 0) {
			flush();
			const underline = lines[i + 1].trim();
			currentHeadingLevel = underline[0] === '=' ? 1 : 2;
			currentLines.push(line);
			currentLines.push(lines[i + 1]);
			i += 2;
			continue;
		}

		currentLines.push(line);
		i++;
	}

	flush();

	// If no sections, return whole content as one
	if (sections.length === 0 && withoutFrontMatter.trim().length > 0) {
		sections.push({
			content: withoutFrontMatter.trim(),
			headingLevel: null,
			isCodeFence: false,
		});
	}

	return sections;
}

export function extractPlainText(markdown: string): string {
	return stripFrontMatter(markdown);
}
