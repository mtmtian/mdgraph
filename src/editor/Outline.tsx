import { useMemo, useRef, useState } from 'react';
import { useWorkspace } from '../store/workspace';
import type { WorkspaceStore } from '../store/workspace';
import BlockEditor from './BlockEditor';
import type { EditorActions } from './BlockEditor';
import type { InlineContext } from './inline';
import { makeInlineContext } from './inlineContext';
import { caretInEditable, flatten } from './keys';
import type { Caret, FocusRequest } from './keys';
import './editor.css';

interface Props {
  path: string;
  /** Defaults to the application store; tests inject their own. */
  store?: WorkspaceStore;
}

export default function Outline({ path, store: injected }: Props) {
  const store = injected ?? useWorkspace;
  const doc = store((s) => s.docs.get(path));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const seq = useRef(0);

  const blocks = useMemo(() => (doc ? flatten(doc.blocks) : []), [doc]);

  const startEdit = (id: string, caret: Caret) => {
    setEditingId(id);
    setFocusRequest({ id, caret, seq: ++seq.current });
  };

  const inline: InlineContext = makeInlineContext(store);

  const commit = (id: string, text: string) => store.getState().setBlockText(path, id, text);

  const actions: EditorActions = {
    onStartEdit: (id) => startEdit(id, 'end'),
    onBlur: (id, text) => {
      commit(id, text);
      setEditingId((cur) => (cur === id ? null : cur));
    },
    onEnter: (id, text) => {
      commit(id, text);
      startEdit(store.getState().insertAfter(path, id), 0);
    },
    onTab: (id, text, shift, caret) => {
      commit(id, text);
      const s = store.getState();
      if (shift) s.outdent(path, id);
      else s.indent(path, id);
      startEdit(id, caret);
    },
    onBackspaceAtStart: (id, text) => {
      commit(id, text);
      const s = store.getState();
      const r = s.mergeWithPrevious(path, id);
      if (!r) return;
      const after = store.getState().docs.get(path);
      const merged = after ? flatten(after.blocks).find((b) => b.id === r.blockId) : undefined;
      startEdit(r.blockId, merged ? caretInEditable(merged, r.caret) : r.caret);
    },
    onNavigate: (id, text, dir) => {
      const at = blocks.findIndex((b) => b.id === id);
      const target = blocks[at + (dir === 'up' ? -1 : 1)];
      if (!target) return;
      commit(id, text);
      startEdit(target.id, dir === 'up' ? 'end' : 'start');
    },
  };

  if (!doc) return null;
  if (blocks.length === 0) return <p className="outline-empty">（空页面）</p>;

  return (
    <ul className="outline">
      {blocks.map((b) => (
        <li
          key={b.id}
          id={b.id}
          className={`block block-${b.kind}`}
          data-depth={b.depth}
          style={{ paddingLeft: `${b.depth * 1.5}rem` }}
        >
          <span className="block-dot" aria-hidden="true">{b.kind === 'bullet' ? '•' : ''}</span>
          <BlockEditor
            path={path}
            block={b}
            store={store}
            editing={editingId === b.id}
            focusRequest={focusRequest}
            inline={inline}
            actions={actions}
          />
        </li>
      ))}
    </ul>
  );
}
