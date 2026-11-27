import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const searchHighlightPluginKey = new PluginKey('searchHighlight');

/**
 * Finds all case-insensitive occurrences of `query` across ProseMirror text nodes.
 */
export function findMatchesInDoc(doc, query) {
  const matches = [];
  if (!doc || !query || !query.trim()) return matches;
  const lowerQuery = query.toLowerCase();

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const lowerText = node.text.toLowerCase();
    let idx = 0;
    while ((idx = lowerText.indexOf(lowerQuery, idx)) !== -1) {
      matches.push({
        from: pos + idx,
        to: pos + idx + query.length
      });
      idx += Math.max(1, query.length);
    }
  });

  return matches;
}

export const SearchHighlight = Extension.create({
  name: 'searchHighlight',

  addStorage() {
    return {
      query: '',
      activeIndex: 0
    };
  },

  addCommands() {
    return {
      setSearchHighlight:
        (query, activeIndex = 0) =>
        ({ tr, dispatch }) => {
          this.storage.query = query || '';
          this.storage.activeIndex = activeIndex || 0;
          if (dispatch) {
            tr.setMeta(searchHighlightPluginKey, { query: this.storage.query, activeIndex: this.storage.activeIndex });
            dispatch(tr);
          }
          return true;
        },
      clearSearchHighlight:
        () =>
        ({ tr, dispatch }) => {
          this.storage.query = '';
          this.storage.activeIndex = 0;
          if (dispatch) {
            tr.setMeta(searchHighlightPluginKey, { query: '', activeIndex: 0 });
            dispatch(tr);
          }
          return true;
        }
    };
  },

  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: searchHighlightPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, oldSet, oldState, newState) => {
            const meta = tr.getMeta(searchHighlightPluginKey);
            const query = meta ? meta.query : extension.storage.query;
            const activeIndex = meta ? meta.activeIndex : extension.storage.activeIndex;

            if (!query || !query.trim()) {
              return DecorationSet.empty;
            }
            if (!meta && !tr.docChanged) {
              return oldSet;
            }

            const matches = findMatchesInDoc(newState.doc, query);
            const decorations = matches.map((m, idx) =>
              Decoration.inline(m.from, m.to, {
                class: idx === activeIndex ? 'writer-search-match writer-search-match-active' : 'writer-search-match'
              })
            );
            return DecorationSet.create(newState.doc, decorations);
          }
        },
        props: {
          decorations(state) {
            return this.getState(state);
          }
        }
      })
    ];
  }
});

export default SearchHighlight;
