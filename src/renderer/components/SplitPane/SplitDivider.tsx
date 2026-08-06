import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../../styles/splitpane.css';

interface SplitDividerProps {
  direction: 'horizontal' | 'vertical';
  onRatioChange: (delta: number) => void;
  onDoubleClick?: () => void;
}

export default function SplitDivider({ direction, onRatioChange, onDoubleClick }: SplitDividerProps) {
  const startPosRef = useRef(0);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      // Capture the pointer so move/up events keep flowing to THIS element even
      // when the cursor passes over a terminal canvas or an out-of-process
      // <webview>. Previously we listened for mouseup on window; dragging over a
      // webview swallowed the event, leaving the drag stuck "on" (issue #59).
      try {
        dividerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture can throw if the pointer is already gone */
      }
      startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;
      setDragging(true);
    },
    [direction],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || !dividerRef.current) return;
      const parent = dividerRef.current.parentElement;
      if (!parent) return;

      const parentRect = parent.getBoundingClientRect();
      const parentSize = direction === 'horizontal' ? parentRect.width : parentRect.height;

      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = (currentPos - startPosRef.current) / parentSize;
      startPosRef.current = currentPos;

      onRatioChange(delta);
    },
    [dragging, direction, onRatioChange],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      try {
        dividerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      setDragging(false);
    },
    [dragging],
  );

  useEffect(() => {
    if (!dragging) return;

    // Pointer capture normally ends the resize, but Electron can omit the
    // matching pointerup/pointercancel when focus moves to another window. In
    // that case the full-window drag overlay would permanently block inputs.
    const cancelInterruptedDrag = () => setDragging(false);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') cancelInterruptedDrag();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelInterruptedDrag();
    };

    window.addEventListener('blur', cancelInterruptedDrag);
    window.addEventListener('pointerup', cancelInterruptedDrag, true);
    window.addEventListener('pointercancel', cancelInterruptedDrag, true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('blur', cancelInterruptedDrag);
      window.removeEventListener('pointerup', cancelInterruptedDrag, true);
      window.removeEventListener('pointercancel', cancelInterruptedDrag, true);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dragging]);

  return (
    <div
      ref={dividerRef}
      className={`split-divider split-divider--${direction}${dragging ? ' split-divider--dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={onDoubleClick}
    >
      <div className="split-divider__line" />
      {/* While dragging, a full-window overlay sits above every pane (and above
          the out-of-process <webview>, via z-index) so the host keeps receiving
          pointer events and the webview can't hijack the drag (issue #59). */}
      {dragging && <div className={`split-divider__drag-overlay split-divider__drag-overlay--${direction}`} />}
    </div>
  );
}
