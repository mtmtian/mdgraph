import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Block } from '../parser/types';
import { editableTextOf } from '../store/types';
import type { WorkspaceStore } from '../store/workspace';
import { computeItems } from './acItems';
import type { AcItem } from './acItems';
import Autocomplete from './Autocomplete';
import { renderInline } from './inline';
import type { InlineContext } from './inline';
import { detectTrigger } from './keys';
import type { FocusRequest, Trigger } from './keys';

/** What a block asks of its Outline; every handler receives the current textarea text. */
export interface EditorActions {
  onStartEdit(id: string): void;
  onBlur(id: string, text: string): void;
  onEnter(id: string, text: string): void;
  onTab(id: string, text: string, shift: boolean, caret: number): void;
  onBackspaceAtStart(id: string, text: string): void;
  onNavigate(id: string, text: string, dir: 'up' | 'down'): void;
}

interface Props {
  path: string;
  block: Block;
  store: WorkspaceStore;
  editing: boolean;
  focusRequest: FocusRequest | null;
  inline: InlineContext;
  actions: EditorActions;
}

export default function BlockEditor({ path, block, store, editing, focusRequest, inline, actions }: Props) {
  if (editing) return <BlockInput path={path} block={block} store={store} focusRequest={focusRequest} actions={actions} />;
  const text = editableTextOf(block);
  const edit = () => actions.onStartEdit(block.id);
  return (
    <div
      className={`block-view${block.task === 'DONE' ? ' block-done' : ''}${text === '' ? ' block-blank' : ''}`}
      tabIndex={0}
      onClick={edit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          edit();
        }
      }}
    >
      {text === '' ? ' ' : renderInline(text, inline, { task: block.kind === 'bullet' })}
    </div>
  );
}

interface InputProps {
  path: string;
  block: Block;
  store: WorkspaceStore;
  focusRequest: FocusRequest | null;
  actions: EditorActions;
}

interface AcState extends Trigger {
  active: number;
}

function BlockInput({ path, block, store, focusRequest, actions }: InputProps) {
  const id = block.id;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(() => editableTextOf(block));
  const [ac, setAc] = useState<AcState | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const dismissedAt = useRef(-1);

  const items: AcItem[] = ac ? computeItems(ac.kind, ac.query, store.getState().index, id) : [];

  // Auto height, and apply a caret chosen by an autocomplete pick once the new value is rendered.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  const mine = focusRequest?.id === id ? focusRequest : null;
  const seq = mine?.seq ?? null;
  const caretWanted = mine?.caret ?? 'end';
  useEffect(() => {
    const el = ref.current;
    if (!el || seq === null) return;
    el.focus();
    const len = el.value.length;
    const c = caretWanted;
    const pos = c === 'start' ? 0 : c === 'end' ? len : Math.min(c, len);
    el.setSelectionRange(pos, pos);
  }, [seq, caretWanted]);

  function pick(item: AcItem) {
    const el = ref.current;
    if (!el || !ac) return;
    const current = el.value;
    const caret = el.selectionStart;
    const closer = item.kind === 'page' ? ']]' : '))';
    const rep = item.kind === 'page' ? `[[${item.name}]]` : `((${store.getState().ensureBlockId(item.path, item.blockId)}))`;
    const tail = current.slice(caret);
    pendingCaret.current = ac.start + rep.length;
    setValue(current.slice(0, ac.start) + rep + (tail.startsWith(closer) ? tail.slice(2) : tail));
    setAc(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const text = el.value;

    if (ac) {
      const move = (d: number) => {
        e.preventDefault();
        setAc({ ...ac, active: items.length === 0 ? 0 : (ac.active + d + items.length) % items.length });
      };
      if (e.key === 'ArrowDown') return move(1);
      if (e.key === 'ArrowUp') return move(-1);
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        const item = items[ac.active];
        if (item) pick(item);
        else setAc(null);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissedAt.current = ac.start;
        setAc(null);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setAc(null);
    }

    const noMod = !e.ctrlKey && !e.metaKey && !e.altKey;
    switch (e.key) {
      case 'Enter':
        if (e.shiftKey || !noMod) return;
        e.preventDefault();
        actions.onEnter(id, text);
        return;
      case 'Tab':
        if (!noMod) return;
        e.preventDefault();
        actions.onTab(id, text, e.shiftKey, el.selectionStart);
        return;
      case 'Backspace':
        if (el.selectionStart === 0 && el.selectionEnd === 0 && noMod) {
          e.preventDefault();
          actions.onBackspaceAtStart(id, text);
        }
        return;
      case 'ArrowUp':
        if (!e.shiftKey && noMod && !text.slice(0, el.selectionStart).includes('\n')) {
          e.preventDefault();
          actions.onNavigate(id, text, 'up');
        }
        return;
      case 'ArrowDown':
        if (!e.shiftKey && noMod && !text.slice(el.selectionEnd).includes('\n')) {
          e.preventDefault();
          actions.onNavigate(id, text, 'down');
        }
        return;
      case 'Escape':
        e.preventDefault();
        el.blur();
        return;
    }
  }

  return (
    <div className="block-edit">
      <textarea
        ref={ref}
        className="block-input"
        aria-label="编辑块"
        rows={1}
        spellCheck={false}
        value={value}
        data-path={path}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          const t = detectTrigger(next, e.target.selectionStart);
          if (!t) {
            dismissedAt.current = -1;
            setAc(null);
          } else if (t.start === dismissedAt.current) setAc(null);
          else setAc((prev) => ({ ...t, active: prev && prev.start === t.start && prev.query === t.query ? prev.active : 0 }));
        }}
        onKeyDown={onKeyDown}
        onClick={() => setAc(null)}
        onBlur={(e) => actions.onBlur(id, e.currentTarget.value)}
      />
      {ac && <Autocomplete items={items} active={ac.active} onPick={pick} onHover={(i) => setAc({ ...ac, active: i })} />}
    </div>
  );
}
