import { forwardRef, useRef, useState, type HTMLAttributes, type PointerEvent, type ReactNode } from 'react';

interface SwipeDismissProps extends HTMLAttributes<HTMLDivElement> {
  // 横にスワイプ（マウスならドラッグ）して消したときに呼ぶ。
  onDismiss: () => void;
  children: ReactNode;
}

// これ以上動かしたらドラッグ開始（それまでは普通のクリック。「更新する」ボタンなどはそのまま押せる）。
const DRAG_START_PX = 8;
// 幅の何割以上、または絶対値で何px以上動かして離したら「消す」。
const DISMISS_RATIO = 0.3;
const DISMISS_MIN_PX = 80;
const ANIM_MS = 180;

/**
 * トースト（Snackbar の中身）を、左右どちらかへスワイプ／ドラッグして消せるようにする。
 * 指でもマウスでも動く（Pointer Events）。しきい値に届かなければ元の位置に戻る。
 * Snackbar の子として使うため ref とその他の props（Grow が付ける style など）は外側の要素へそのまま渡し、
 * 動かす transform は内側の要素に付けて Grow のアニメーションとぶつからないようにする。
 */
const SwipeDismiss = forwardRef<HTMLDivElement, SwipeDismissProps>(function SwipeDismiss({ onDismiss, children, ...rest }, ref) {
  const [dx, setDx] = useState(0);
  const [animating, setAnimating] = useState(false);
  const drag = useRef<{ id: number; startX: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const innerRef = useRef<HTMLDivElement | null>(null);

  const finish = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.dragging) return;
    if (innerRef.current?.hasPointerCapture(e.pointerId)) innerRef.current.releasePointerCapture(e.pointerId);
    const width = innerRef.current?.offsetWidth ?? 300;
    const moved = e.clientX - d.startX;
    setAnimating(true);
    if (e.type === 'pointerup' && Math.abs(moved) >= Math.max(DISMISS_MIN_PX, width * DISMISS_RATIO)) {
      // 動かした向きへ画面の外まで滑らせてから消す。
      setDx(Math.sign(moved) * (width + 80));
      window.setTimeout(onDismiss, ANIM_MS);
    } else {
      setDx(0);
    }
  };

  return (
    <div ref={ref} {...rest}>
      <div
        ref={innerRef}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          drag.current = { id: e.pointerId, startX: e.clientX, dragging: false };
          suppressClick.current = false;
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const moved = e.clientX - d.startX;
          if (!d.dragging) {
            if (Math.abs(moved) < DRAG_START_PX) return;
            d.dragging = true;
            suppressClick.current = true;
            setAnimating(false);
            innerRef.current?.setPointerCapture(e.pointerId);
          }
          setDx(moved);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        // ドラッグして離したときに、下にあるボタンが押されたことになるのを防ぐ。
        onClickCapture={(e) => {
          if (suppressClick.current) { e.stopPropagation(); e.preventDefault(); suppressClick.current = false; }
        }}
        style={{
          transform: dx === 0 ? undefined : `translateX(${dx}px)`,
          opacity: dx === 0 ? 1 : Math.max(0, 1 - Math.abs(dx) / ((innerRef.current?.offsetWidth ?? 300) * 1.2)),
          transition: animating ? `transform ${ANIM_MS}ms ease-out, opacity ${ANIM_MS}ms ease-out` : 'none',
          // 縦スクロールはそのまま、横の動きだけ自前で扱う。マウスでの文字選択もドラッグ中は起こさない。
          touchAction: 'pan-y',
          userSelect: drag.current?.dragging ? 'none' : undefined,
          cursor: drag.current?.dragging ? 'grabbing' : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
});

export default SwipeDismiss;
