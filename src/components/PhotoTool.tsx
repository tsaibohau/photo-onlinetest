import { useRef, useState } from 'preact/hooks';
import { normalizeRect, type Rect, type SourcePhoto } from '../core/photo';

interface Props {
  sources: SourcePhoto[];
  initialIndex?: number;
  /** mask：框出要在 OCR 時忽略的區域（可多個）；crop：框出一塊截圖（一個） */
  mode: 'mask' | 'crop';
  initialRects?: Rect[];
  onDone: (sourceIndex: number, rects: Rect[]) => void;
  onCancel: () => void;
}

export function PhotoTool({ sources, initialIndex = 0, mode, initialRects = [], onDone, onCancel }: Props) {
  const [idx, setIdx] = useState(initialIndex);
  const [rects, setRects] = useState<Rect[]>(initialRects);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [zoom, setZoom] = useState(false);
  const [draw, setDraw] = useState(true);
  const start = useRef<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const pt = (e: PointerEvent) => {
    const b = boxRef.current!.getBoundingClientRect();
    return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
  };
  const onDown = (e: PointerEvent) => {
    if (!draw || (e.target as HTMLElement).closest('.pt-del')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = pt(e);
    setDraft(normalizeRect(start.current, start.current));
  };
  const onMove = (e: PointerEvent) => {
    if (start.current) setDraft(normalizeRect(start.current, pt(e)));
  };
  const onUp = () => {
    if (draft && draft.w > 0.01 && draft.h > 0.01) setRects(mode === 'crop' ? [draft] : [...rects, draft]);
    start.current = null;
    setDraft(null);
  };

  const shown = draft ? [...(mode === 'crop' ? [] : rects), draft] : rects;
  const src = sources[idx];

  return (
    <div class="modal-backdrop pt-backdrop">
      <div class="pt-modal card">
        <div class="pt-head">
          <b>{mode === 'mask' ? '🩹 框出附圖（辨識時會跳過）' : '✂️ 框出要截取的附圖'}</b>
          <div class="spacer" />
          <button class="btn ghost small" onClick={onCancel}>
            ✕
          </button>
        </div>
        <p class="small muted pt-hint">
          {mode === 'mask'
            ? '用手指或滑鼠拖曳框出圖片、表格等非文字區域，可以框多個；點框右上角的 ✕ 刪除。'
            : '拖曳框出要放進題目的圖片範圍，重新拖曳可以重框。'}
        </p>
        {sources.length > 1 && (
          <div class="pt-sources">
            {sources.map((s, i) => (
              <button
                key={s.id}
                class={`pt-thumb ${i === idx ? 'on' : ''}`}
                onClick={() => {
                  setIdx(i);
                  setRects(mode === 'mask' ? s.masks : []);
                }}
                title={s.name}
              >
                <img src={s.url} alt={s.name} />
              </button>
            ))}
          </div>
        )}
        <div class="pt-tools">
          <div class="seg small">
            <button class={draw ? 'on' : ''} onClick={() => setDraw(true)}>
              ✏️ 框選
            </button>
            <button class={!draw ? 'on' : ''} onClick={() => setDraw(false)}>
              ✋ 捲動
            </button>
          </div>
          <button class="btn small" onClick={() => setZoom(!zoom)}>
            {zoom ? '🔍 縮小' : '🔍 放大'}
          </button>
          {mode === 'mask' && rects.length > 0 && (
            <button class="btn small ghost" onClick={() => setRects([])}>
              全部清除
            </button>
          )}
        </div>
        <div class="pt-scroll">
          <div
            ref={boxRef}
            class={`pt-box ${draw ? 'drawing' : ''}`}
            style={{ width: zoom ? '200%' : '100%' }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <img src={src.url} alt={src.name} draggable={false} />
            {shown.map((r, i) => (
              <div
                key={i}
                class={`pt-rect ${mode}`}
                style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
              >
                {mode === 'mask' && r !== draft && (
                  <button class="pt-del" onClick={() => setRects(rects.filter((_, j) => j !== i))} aria-label="刪除這個框">
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" onClick={onCancel}>
            取消
          </button>
          <button class="btn primary" disabled={mode === 'crop' && rects.length === 0} onClick={() => onDone(idx, rects)}>
            {mode === 'mask' ? `重新辨識（跳過 ${rects.length} 個區域）` : '使用這張截圖'}
          </button>
        </div>
      </div>
    </div>
  );
}
