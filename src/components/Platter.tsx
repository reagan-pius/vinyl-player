import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { usePlatterAnimation } from '../hooks/usePlatterAnimation';

/**
 * Canvas platter. The disc gets a light source so it never drowns in the
 * background: lighter grooves, a sheen highlight that stays put while the
 * disc rotates under it (light doesn't spin with the record), a rim glint,
 * an ivory label, and a wear-band that brightens with condition.
 *
 * The static disc (grooves, label, art, spindle) is rendered once into an
 * offscreen canvas and blitted under rotation, and the rAF loop stops when
 * the platter has coasted to a halt — a paused deck must not burn a core.
 */
export function Platter() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const angleRef = useRef(0);
  const current = usePlayerStore((s) => s.queue[s.currentTrackIndex]);
  const speed = usePlayerStore((s) => s.platterSpeed);
  const state = usePlayerStore((s) => s.state);
  const cond = usePlayerStore((s) => s.vinylCondition);
  const [fontsReady, setFontsReady] = useState(false);
  const [artVersion, setArtVersion] = useState(0);

  usePlatterAnimation((a) => { angleRef.current = a; });

  // album art is drawn into the label, so tint it dark for ivory text
  const imgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    imgRef.current = null;
    if (!current?.coverUrl) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setArtVersion((n) => n + 1); // repaint now that the art exists
    };
    img.src = current.coverUrl;
  }, [current?.coverUrl, current?.id]);

  // canvas text can only use the fonts once they've actually loaded
  useEffect(() => {
    let mounted = true;
    void document.fonts?.ready.then(() => { if (mounted) setFontsReady(true); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const disc = document.createElement('canvas');
    const dctx = disc.getContext('2d');
    const title = current?.title ?? 'HALCYON';
    const artist = current?.artist ?? 'Hi-Fi · 33⅓';

    let width = 0;
    let height = 0;
    let discKey = '';
    let raf = 0;

    const measure = () => {
      width = cv.clientWidth;
      height = cv.clientHeight;
      if (!width || !height) return;
      const px = Math.round(width * dpr);
      if (cv.width !== px) {
        cv.width = px;
        cv.height = Math.round(height * dpr);
      }
      cv.style.width = `${width}px`;
      cv.style.height = `${height}px`;
    };

    const drawDisc = (w: number, h: number) => {
      if (!dctx) return;
      const size = Math.min(w, h);
      const R = size / 2 - 4;
      disc.width = Math.round(w * dpr);
      disc.height = Math.round(h * dpr);
      dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dctx.clearRect(0, 0, w, h);
      dctx.save();
      dctx.translate(w / 2, h / 2);

      // ---- vinyl disc: keyed-up base so grooves can read against it ----
      const grad = dctx.createRadialGradient(-R * 0.35, -R * 0.35, R * 0.05, 0, 0, R);
      grad.addColorStop(0, '#25231d');
      grad.addColorStop(0.65, '#171610');
      grad.addColorStop(1, '#0a0a08');
      dctx.fillStyle = grad;
      dctx.beginPath(); dctx.arc(0, 0, R, 0, Math.PI * 2); dctx.fill();

      // ---- groove rings (static, refreshed when the cache is rebuilt) ----
      const N = 135;
      for (let i = 0; i < N; i++) {
        const y = i / N;
        const radius = R * 0.965 - y * (R * 0.72);
        dctx.strokeStyle =
          y < 0.06 ? 'rgba(255,255,255,0.17)' :       // lead-in shines
          y > 0.93 ? 'rgba(220,195,160,0.11)' :        // run-out grooves
          'rgba(255,255,255,0.055)';
        dctx.lineWidth = 1;
        dctx.beginPath(); dctx.arc(0, 0, radius, 0, Math.PI * 2); dctx.stroke();
      }

      // ---- wear band: scuffed sheen that grows with record condition ----
      dctx.save();
      dctx.globalAlpha = 0.45 * cond + 0.06;
      dctx.beginPath();
      dctx.arc(0, 0, R * 0.95, 0, Math.PI * 2);
      dctx.arc(0, 0, R * 0.52, 0, Math.PI * 2, true);
      dctx.fillStyle = 'rgba(210,190,170,0.16)';
      dctx.fill();
      dctx.restore();

      // ---- ivory center label with album art ----
      const LR = R * 0.2;
      dctx.fillStyle = '#e9dcc3';
      dctx.beginPath(); dctx.arc(0, 0, LR, 0, Math.PI * 2); dctx.fill();
      const art = imgRef.current;
      if (art && art.complete && art.naturalWidth) {
        dctx.save();
        dctx.globalAlpha = 0.5;                       // tint art dark under ivory text
        dctx.beginPath(); dctx.arc(0, 0, LR, 0, Math.PI * 2); dctx.clip();
        dctx.drawImage(art, -LR, -LR, LR * 2, LR * 2);
        dctx.restore();
        dctx.fillStyle = 'rgba(233,220,195,0.28)';
        dctx.beginPath(); dctx.arc(0, 0, LR, 0, Math.PI * 2); dctx.fill();
      }
      dctx.textAlign = 'center';
      dctx.fillStyle = '#2b2013';
      dctx.font = `560 ${Math.max(9, R * 0.095)}px Fraunces, serif`;
      dctx.fillText(clip(dctx, title, LR * 1.7), 0, -LR * 0.12);
      dctx.font = `500 ${Math.max(7.5, R * 0.07)}px Afacad, sans-serif`;
      dctx.fillText(clip(dctx, artist, LR * 1.7), 0, LR * 0.32);

      // ---- spindle hub ----
      dctx.strokeStyle = 'rgba(0,0,0,0.55)'; dctx.lineWidth = 3;
      dctx.beginPath(); dctx.arc(0, 0, R * 0.082, 0, Math.PI * 2); dctx.stroke();
      dctx.fillStyle = '#17150f';
      dctx.beginPath(); dctx.arc(0, 0, R * 0.062, 0, Math.PI * 2); dctx.fill();
      dctx.fillStyle = '#04040a';
      dctx.beginPath(); dctx.arc(0, 0, R * 0.028, 0, Math.PI * 2); dctx.fill();
      dctx.fillStyle = 'rgba(255,255,255,0.25)';       // micro punch marks
      for (const a of [0.6, 2.7, 4.8]) {
        dctx.beginPath();
        dctx.arc(Math.cos(a) * R * 0.072, Math.sin(a) * R * 0.072, 0.8, 0, Math.PI * 2);
        dctx.fill();
      }

      dctx.restore();
    };

    const render = () => {
      if (!width || !height) return;
      const key = `${width}x${height}@${dpr}|${title}|${artist}|${cond.toFixed(3)}|${artVersion}|${fontsReady ? 1 : 0}`;
      if (key !== discKey) {
        drawDisc(width, height);
        discKey = key;
      }

      const w = width;
      const h = height;
      const size = Math.min(w, h);
      const R = size / 2 - 4;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(angleRef.current);
      ctx.drawImage(disc, -w / 2, -h / 2, w, h);

      // ---- window sheen: stays put while the record turns under it ----
      ctx.rotate(-angleRef.current);
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(-R * 0.34, -R * 0.42, R * 0.52, R * 0.3, -0.7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;

      // ---- rim glint ----
      ctx.strokeStyle = `rgba(255,240,214,${0.22 + cond * 0.2})`;
      ctx.lineWidth = Math.max(2, R * 0.02);
      ctx.beginPath(); ctx.arc(0, 0, R - 2, -2.3, -1.15); ctx.stroke();
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.arc(0, 0, R - 2, 0.7, 1.3); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
    };

    // Keep animating while the deck is live, plus a short tail so the platter
    // can coast to a stop after pause/stop.
    const spinning = state === 'playing' || state === 'cueing';
    const coastUntil = performance.now() + 1400;

    const loop = () => {
      render();
      if (spinning || performance.now() < coastUntil) {
        raf = requestAnimationFrame(loop);
      } else {
        raf = 0;
      }
    };

    measure();
    render();
    raf = requestAnimationFrame(loop);

    const observer = new ResizeObserver(() => {
      measure();
      render();
    });
    observer.observe(cv);

    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [current?.id, current?.title, current?.artist, cond, state, artVersion, fontsReady]);

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
