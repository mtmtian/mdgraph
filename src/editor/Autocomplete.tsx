import { useEffect, useRef } from 'react';
import type { AcItem } from './acItems';

interface Props {
  items: AcItem[];
  active: number;
  onPick(item: AcItem): void;
  onHover(i: number): void;
}

/** Suggestion list shown under the textarea. Mouse picks must not blur the textarea. */
export default function Autocomplete({ items, active, onPick, onHover }: Props) {
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  return (
    <ul className="ac-list" role="listbox">
      {items.length === 0 && <li className="ac-empty">无匹配</li>}
      {items.map((item, i) => (
        <li
          key={item.kind === 'page' ? `p:${item.name}` : `b:${item.blockId}`}
          ref={i === active ? activeRef : undefined}
          role="option"
          aria-selected={i === active}
          className={`ac-item${i === active ? ' ac-item-active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
          onMouseEnter={() => onHover(i)}
        >
          {item.kind === 'page' ? (
            <>
              <span className="ac-text">{item.name}</span>
              {item.virtual && <span className="ac-sub">虚拟页</span>}
            </>
          ) : (
            <>
              <span className="ac-text">{item.label || '(空块)'}</span>
              <span className="ac-sub">{item.pageName}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
