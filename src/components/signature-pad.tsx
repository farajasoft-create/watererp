'use client';

import { useEffect, useRef } from 'react';

/** A box to sign in with a finger or mouse; reports the signature as a PNG data URL (null when cleared). */
export function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const drawn = useRef(false);

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height] as const;
    };
    const down = (e: PointerEvent) => {
      drawing.current = true;
      const [x, y] = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      c.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drawing.current) return;
      const [x, y] = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      drawn.current = true;
    };
    const up = () => {
      if (!drawing.current) return;
      drawing.current = false;
      if (drawn.current) onChange(c.toDataURL('image/png'));
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
    };
  }, [onChange]);

  const clear = () => {
    const c = canvas.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    drawn.current = false;
    onChange(null);
  };

  return (
    <div>
      <canvas ref={canvas} width={480} height={140} className="w-full touch-none rounded border border-dashed border-line bg-white" aria-label="Sign here" />
      <button type="button" onClick={clear} className="mt-1 text-xs text-brand-700">Clear</button>
    </div>
  );
}
