import React, { useState, useRef } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';

/**
 * Individual interactive link component with hover pop-up action button:
 * "Please provide an AI summary of this page."
 */
function InteractiveHyperlink({ href, title, children, onSummarizeUrl }) {
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimeoutRef = useRef(null);

  const handleMouseEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 250);
  };

  const handleSummarizeClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsHovered(false);
    if (onSummarizeUrl) {
      onSummarizeUrl(href);
    }
  };

  return (
    <span 
      className="hyperlink-hover-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="formatted-hyperlink"
        title={title || href}
      >
        <span>{children}</span>
        <ExternalLink size={11} className="formatted-hyperlink-icon" />
      </a>

      {/* Pop-up button on hover */}
      {isHovered && (
        <span 
          className="hyperlink-summary-popup"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <button
            type="button"
            className="btn-link-ai-summary"
            onClick={handleSummarizeClick}
            title="Generate an AI overview and summary of this web page as a new thread message"
          >
            <Sparkles size={13} className="summary-sparkle-icon" />
            <span>Please provide an AI summary of this page.</span>
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * Parses markdown text into formatted React nodes:
 * - Markdown links: [Title](url) -> InteractiveHyperlink
 * - Raw URLs: http(s)://... -> InteractiveHyperlink
 * - Bold: **text** -> <strong>
 * - Italic: *text* -> <em>
 * - Code inline: `text` -> <code>
 * - Preserves line breaks and formatting
 */
function highlightTextSegments(text, query, keyPrefix) {
  if (!query || !query.trim() || typeof text !== 'string') return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts = [];
  let idx = 0;
  let last = 0;
  let count = 0;
  while ((idx = lowerText.indexOf(lowerQuery, last)) !== -1) {
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(
      <mark key={`${keyPrefix}-hl-${count++}`} className="writer-search-match">
        {text.slice(idx, idx + query.length)}
      </mark>
    );
    last = idx + query.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

export function renderFormattedContent(text, onSummarizeUrl, highlightQuery = '') {
  if (!text) return null;

  const lines = String(text).split('\n');

  return lines.map((line, lineIdx) => (
    <React.Fragment key={lineIdx}>
      {lineIdx > 0 && <br />}
      {parseLineTokens(line, lineIdx, onSummarizeUrl, highlightQuery)}
    </React.Fragment>
  ));
}

function parseLineTokens(line, lineKey, onSummarizeUrl, highlightQuery = '') {
  if (!line) return null;

  // Pattern matches:
  // 1. Markdown link: [text](url)
  // 2. Raw URL: https?://[^\s()<>]+
  // 3. Bold: \*\*([^*]+)\*\*
  // 4. Inline code: `([^`]+)`
  const tokenRegex = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+)|(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;

  const elements = [];
  let lastIndex = 0;
  let match;
  let tokenCounter = 0;

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      elements.push(highlightTextSegments(line.substring(lastIndex, match.index), highlightQuery, `${lineKey}-${tokenCounter++}`));
    }

    const [fullMatch, mdLink, mdText, mdUrl, rawUrl, boldWrap, boldText, codeWrap, codeText] = match;

    if (mdLink) {
      elements.push(
        <InteractiveHyperlink
          key={`${lineKey}-${tokenCounter++}`}
          href={mdUrl}
          title={mdUrl}
          onSummarizeUrl={onSummarizeUrl}
        >
          {mdText}
        </InteractiveHyperlink>
      );
    } else if (rawUrl) {
      let cleanUrl = rawUrl;
      let trailingPunct = '';
      const trailingMatch = cleanUrl.match(/[.,;:)\]]+$/);
      if (trailingMatch) {
        trailingPunct = trailingMatch[0];
        cleanUrl = cleanUrl.slice(0, -trailingPunct.length);
      }

      elements.push(
        <InteractiveHyperlink
          key={`${lineKey}-${tokenCounter++}`}
          href={cleanUrl}
          title={cleanUrl}
          onSummarizeUrl={onSummarizeUrl}
        >
          {cleanUrl}
        </InteractiveHyperlink>
      );
      if (trailingPunct) {
        elements.push(trailingPunct);
      }
    } else if (boldWrap) {
      elements.push(
        <strong key={`${lineKey}-${tokenCounter++}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          {highlightTextSegments(boldText, highlightQuery, `${lineKey}-b-${tokenCounter}`)}
        </strong>
      );
    } else if (codeWrap) {
      elements.push(
        <code
          key={`${lineKey}-${tokenCounter++}`}
          style={{
            background: 'rgba(255, 255, 255, 0.08)',
            padding: '2px 5px',
            borderRadius: '4px',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '0.9em'
          }}
        >
          {highlightTextSegments(codeText, highlightQuery, `${lineKey}-c-${tokenCounter}`)}
        </code>
      );
    }

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < line.length) {
    elements.push(highlightTextSegments(line.substring(lastIndex), highlightQuery, `${lineKey}-end`));
  }

  return elements;
}

export default function FormattedText({ text, className = '', onSummarizeUrl, highlightQuery = '' }) {
  return (
    <span className={className}>
      {renderFormattedContent(text, onSummarizeUrl, highlightQuery)}
    </span>
  );
}
