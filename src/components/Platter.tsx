import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { usePlatterAnimation } from '../hooks/usePlatterAnimation';

/**
 * Canvas platter. The disc gets a light source so it never drowns in the
 * background: lighter grooves, a sheen highlight that stays put while the
 * disc rotates under it (light doesn't spin with the record), a rotating
 * rim glint, an ivory label, and a wear-band that brightens with condition.
 */
export function Platter() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const angleRef = useRef(0);
  const current = usePlayerStore((s) => s.queue[s.currentTrackIndex]);
  const speed = usePlayerStore((s) => s.platterSpeed);
  const state = usePlayerStore((s) => s.state);

  usePlatterAnimation((a) => { angleRef.current = a; });

  // album art is drawn into the label, so tint it dark for ivory text
  const imgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!current?.coverUrl) { imgRef.current = null; return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = current.coverUrl;
    imgRef.current = img;
  }, [current?.coverUrl, current?.id]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const draw = () => {
      const w = cv.offsetWidth, h = cv.offsetHeight;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size = Math.min(w, h);
      const R = size / 2 - 4;

      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(angleRef.current);

      // ---- vinyl disc: keyed-up base so grooves can read against it ----
      const grad = ctx.createRadialGradient(-R * 0.35, -R * 0.35, R * 0.05, 0, 0, R);
      grad.addColorStop(0, '#25231d');
      grad.addColorStop(0.65, '#171610');
      grad.addColorStop(1, '#0a0a08');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();

      // ---- groove rings (static, refresh each frame — no residue) ----
      const N = 135;
      for (let i = 0; i < N; i++) {
        const y = i / N;
        const radius = R * 0.965 - y * (R * 0.72);
        ctx.strokeStyle =
          y < 0.06 ? 'rgba(255,255,255,0.17)' :       // lead-in shines
          y > 0.93 ? 'rgba(220,195,160,0.11)' :        // run-out grooves
          'rgba(255,255,255,0.055)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke();
      }

      // ---- wear band: scuffed sheen that grows with record condition ----
      const cond = usePlayerStore.getState().vinylCondition;
      ctx.save();
      ctx.globalAlpha = 0.45 * cond + 0.06;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.95, 0, Math.PI * 2);
      ctx.arc(0, 0, R * 0.52, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(210,190,170,0.16)';
      ctx.fill();
      ctx.restore();

      // ---- ivory center label with album art ----
      const LR = R * 0.2;
      ctx.fillStyle = '#e9dcc3';
      ctx.beginPath(); ctx.arc(0, 0, LR, 0, Math.PI * 2); ctx.fill();
      if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth) {
        ctx.save();
        ctx.globalAlpha = 0.5;                       // tint art dark under ivory text
        ctx.beginPath(); ctx.arc(0, 0, LR, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(imgRef.current, -LR, -LR, LR * 2, LR * 2);
        ctx.restore();
        ctx.fillStyle = 'rgba(233,220,195,0.28)';
        ctx.beginPath(); ctx.arc(0, 0, LR, 0, Math.PI * 2); ctx.fill();
      }
      ctx.textAlign = 'center';
      const title = current?.title ?? 'HALCYON';
      const artist = current?.artist ?? 'Hi-Fi · 33⅓';
      ctx.fillStyle = '#2b2013';
      ctx.font = `560 ${Math.max(9, R * 0.095)}px Fraunces, serif`;
      ctx.fillText(clip(ctx, title, LR * 1.7), 0, -LR * 0.12);
      ctx.font = `500 ${Math.max(7.5, R * 0.07)}px Afacad, sans-serif`;
      ctx.fillText(clip(ctx, artist, LR * 1.7), 0, LR * 0.32);

      // ---- spindle hub ----
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, R * 0.082, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#17150f';
      ctx.beginPath(); ctx.arc(0, 0, R * 0.062, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#04040a';
      ctx.beginPath(); ctx.arc(0, 0, R * 0.028, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';       // micro punch marks
      for (const a of [0.6, 2.7, 4.8]) {
        ctx.beginPath();
        ctx.arc(Math.cos(a) * R * 0.072, Math.sin(a) * R * 0.072, 0.8, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- window sheen: stays put while the record turns under it ----
      ctx.rotate(-angleRef.current);
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(-R * 0.34, -R * 0.42, R * 0.52, R * 0.3, -0.7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;

      // ---- rotating rim glint ----
      ctx.strokeStyle = `rgba(255,240,214,${0.22 + cond * 0.2})`;
      ctx.lineWidth = Math.max(2, R * 0.02);
      ctx.beginPath(); ctx.arc(0, 0, R - 2, -2.3, -1.15); ctx.stroke();
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.arc(0, 0, R - 2, 0.7, 1.3); ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [current?.title, current?.artist]);

  return (
    <div className="platter-wrap">
      <canvas ref={canvasRef} className="platter" />
      <div className="platter-rpm">{Math.round(speed)} RPM <i>· {state}</i></div>
    </div>
  );
}

/** Truncate text to px width with an ellipsis. */
function clip(ctx: CanvasRenderingContext2D, text: string, maxPx: number) {
  if (ctx.measureText(text).width <= maxPx) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxPx) t = t.slice(0, -1);
  return t + '…';
}
