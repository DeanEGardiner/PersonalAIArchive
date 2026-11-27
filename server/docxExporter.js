const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle
} = require('docx');

/**
 * Parses inline Markdown tokens (links, bold, italic, strikethrough, inline code)
 * into docx TextRun / ExternalHyperlink children.
 */
function parseInlineRuns(text, baseStyle = {}) {
  if (!text) return [new TextRun({ text: '', ...baseStyle })];

  const tokenRegex = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(_([^_]+)_)|(~~([^~]+)~~)|(`([^`]+)`)/g;
  const children = [];
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      children.push(new TextRun({ text: text.slice(lastIndex, match.index), ...baseStyle }));
    }

    const [
      ,
      mdLink, linkText, linkUrl,
      boldStar, boldStarText,
      boldUnder, boldUnderText,
      italicStar, italicStarText,
      italicUnder, italicUnderText,
      strikeWrap, strikeText,
      codeWrap, codeText
    ] = match;

    if (mdLink) {
      children.push(
        new ExternalHyperlink({
          link: linkUrl,
          children: [
            new TextRun({
              text: linkText,
              style: 'Hyperlink',
              color: '2563EB',
              underline: {},
              ...baseStyle
            })
          ]
        })
      );
    } else if (boldStar || boldUnder) {
      children.push(new TextRun({ text: boldStarText || boldUnderText, bold: true, ...baseStyle }));
    } else if (italicStar || italicUnder) {
      children.push(new TextRun({ text: italicStarText || italicUnderText, italics: true, ...baseStyle }));
    } else if (strikeWrap) {
      children.push(new TextRun({ text: strikeText, strike: true, ...baseStyle }));
    } else if (codeWrap) {
      children.push(
        new TextRun({
          text: codeText,
          font: 'Courier New',
          size: 20,
          ...baseStyle
        })
      );
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    children.push(new TextRun({ text: text.slice(lastIndex), ...baseStyle }));
  }

  return children.length > 0 ? children : [new TextRun({ text: '', ...baseStyle })];
}

function parseTableBlock(tableLines) {
  const rows = [];
  for (let i = 0; i < tableLines.length; i++) {
    const raw = tableLines[i].trim();
    // Skip separator row like | --- | --- |
    if (/^\|?[\s:-]+\|[\s|:-]*$/.test(raw)) continue;

    const cells = raw
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

    const isHeader = rows.length === 0;
    rows.push(
      new TableRow({
        tableHeader: isHeader,
        children: cells.map(
          (cellText) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: parseInlineRuns(cellText, isHeader ? { bold: true } : {}),
                  spacing: { before: 60, after: 60 }
                })
              ]
            })
        )
      })
    );
  }

  if (rows.length === 0) return null;

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows
  });
}

/**
 * Converts a Markdown string + metadata into a .docx Buffer.
 */
async function markdownToDocxBuffer({ contentMd = '' } = {}) {
  const lines = String(contentMd || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block
    if (trimmed.startsWith('```')) {
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        new Paragraph({
          children: [
            new TextRun({
              text: codeLines.join('\n') || ' ',
              font: 'Courier New',
              size: 19
            })
          ],
          shading: { fill: 'F1F5F9' },
          spacing: { before: 120, after: 120 }
        })
      );
      continue;
    }

    // Markdown table block
    if (trimmed.startsWith('|') && trimmed.includes('|', 1)) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const tableNode = parseTableBlock(tableLines);
      if (tableNode) {
        blocks.push(tableNode);
        blocks.push(new Paragraph({ text: '', spacing: { after: 120 } }));
      }
      continue;
    }

    // Empty line
    if (!trimmed) {
      i++;
      continue;
    }

    // Setext headings (e.g. "Title\n===" or "Subtitle\n---")
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('>') &&
      !trimmed.startsWith('|') &&
      !trimmed.startsWith('```') &&
      !/^[-*+]\s+/.test(trimmed) &&
      !/^\d+\.\s+/.test(trimmed) &&
      (/^={3,}$/.test(nextLine) || /^-{3,}$/.test(nextLine))
    ) {
      const headingLevel = nextLine.startsWith('=') ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2;
      blocks.push(
        new Paragraph({
          children: parseInlineRuns(trimmed),
          heading: headingLevel,
          spacing: { before: 220, after: 100 }
        })
      );
      i += 2;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(
        new Paragraph({
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1' }
          },
          spacing: { before: 120, after: 120 }
        })
      );
      i++;
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingMap = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4
      };
      blocks.push(
        new Paragraph({
          children: parseInlineRuns(headingMatch[2]),
          heading: headingMap[level] || HeadingLevel.HEADING_4,
          spacing: { before: 200, after: 100 }
        })
      );
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteText = trimmed.replace(/^>\s?/, '');
      blocks.push(
        new Paragraph({
          children: parseInlineRuns(quoteText, { italics: true, color: '475569' }),
          indent: { left: 480 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: '8B5CF6', space: 10 }
          },
          spacing: { before: 80, after: 80 }
        })
      );
      i++;
      continue;
    }

    // Task list item
    const taskMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      const checked = taskMatch[1].toLowerCase() === 'x';
      blocks.push(
        new Paragraph({
          children: [
            new TextRun({ text: checked ? '☑ ' : '☐ ' }),
            ...parseInlineRuns(taskMatch[2])
          ],
          indent: { left: 360 },
          spacing: { before: 40, after: 60 }
        })
      );
      i++;
      continue;
    }

    // Bullet list item
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const level = Math.min(3, Math.floor(bulletMatch[1].length / 2));
      blocks.push(
        new Paragraph({
          children: parseInlineRuns(bulletMatch[2]),
          bullet: { level },
          spacing: { before: 40, after: 60 }
        })
      );
      i++;
      continue;
    }

    // Numbered list item
    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (orderedMatch) {
      const level = Math.min(3, Math.floor(orderedMatch[1].length / 2));
      blocks.push(
        new Paragraph({
          children: parseInlineRuns(orderedMatch[2]),
          numbering: { reference: 'default-numbering', level },
          spacing: { before: 40, after: 60 }
        })
      );
      i++;
      continue;
    }

    // Standard paragraph
    blocks.push(
      new Paragraph({
        children: parseInlineRuns(trimmed),
        spacing: { before: 40, after: 120 }
      })
    );
    i++;
  }

  if (blocks.length === 0) {
    blocks.push(new Paragraph({ text: '' }));
  }

  const doc = new Document({
    styles: {
      default: {
        heading1: {
          run: {
            size: 42,
            bold: true,
            color: '0F172A'
          },
          paragraph: {
            outlineLevel: 0,
            spacing: { before: 280, after: 120 }
          }
        },
        heading2: {
          run: {
            size: 32,
            bold: true,
            color: '0F172A'
          },
          paragraph: {
            outlineLevel: 1,
            spacing: { before: 240, after: 100 }
          }
        },
        heading3: {
          run: {
            size: 26,
            bold: true,
            color: '1E293B'
          },
          paragraph: {
            outlineLevel: 2,
            spacing: { before: 200, after: 80 }
          }
        },
        heading4: {
          run: {
            size: 23,
            bold: true,
            color: '1E293B'
          },
          paragraph: {
            outlineLevel: 3,
            spacing: { before: 160, after: 60 }
          }
        }
      }
    },
    numbering: {
      config: [
        {
          reference: 'default-numbering',
          levels: [
            { level: 0, format: 'decimal', text: '%1.', alignment: 'start', style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
            { level: 1, format: 'lowerLetter', text: '%2.', alignment: 'start', style: { paragraph: { indent: { left: 1080, hanging: 360 } } } },
            { level: 2, format: 'lowerRoman', text: '%3.', alignment: 'start', style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
            { level: 3, format: 'decimal', text: '%4.', alignment: 'start', style: { paragraph: { indent: { left: 1800, hanging: 360 } } } }
          ]
        }
      ]
    },
    sections: [
      {
        properties: {},
        children: blocks
      }
    ]
  });

  return Packer.toBuffer(doc);
}

module.exports = {
  markdownToDocxBuffer
};
