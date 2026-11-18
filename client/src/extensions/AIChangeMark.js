import { Mark, mergeAttributes } from '@tiptap/core';

/**
 * Custom TipTap Mark for highlighting AI-authored edits in a distinct color
 * inside the Word-like editor while serializing to 100% clean Markdown.
 */
export const AIChangeMark = Mark.create({
  name: 'aiChange',

  inclusive: false,

  addAttributes() {
    return {
      changeId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-change-id'),
        renderHTML: (attributes) => (attributes.changeId ? { 'data-change-id': attributes.changeId } : {}),
      },
      provider: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-ai-provider'),
        renderHTML: (attributes) => (attributes.provider ? { 'data-ai-provider': attributes.provider } : {}),
      },
      model: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-ai-model'),
        renderHTML: (attributes) => (attributes.model ? { 'data-ai-model': attributes.model } : {}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-ai-change="true"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'ai-change-highlight',
        'data-ai-change': 'true',
      }),
      0,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open: '',
          close: '',
          mixable: true,
          expelEnclosingWhitespace: true,
        },
      },
    };
  },

  addCommands() {
    return {
      setAIChange:
        (attributes) =>
        ({ commands }) =>
          commands.setMark(this.name, attributes),
      unsetAIChange:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
      clearAllAIChanges:
        () =>
        ({ tr, state, dispatch }) => {
          const { doc } = state;
          const markType = state.schema.marks[this.name];
          if (!markType) return false;
          if (dispatch) {
            tr.removeMark(0, doc.content.size, markType);
            dispatch(tr);
          }
          return true;
        },
    };
  },
});

export default AIChangeMark;

