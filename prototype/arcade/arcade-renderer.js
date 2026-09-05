/* PBECAST ARCADE REPLAY — pixel field renderer (PROTOTYPE, not wired in)
 * =============================================================================
 * An ORIGINAL PropBetEdge pixel/arcade visual language. Nothing here is traced
 * from, measured against, or derived from any commercial football game's
 * artwork, sprites, logos, animations, fonts or UI. The figures are built from
 * rectangles at draw time; the palette is the PropBetEdge brand (ink, paper,
 * gold, crimson) plus the two teams' own colours; the type is the product's own
 * font stack drawn at pixel sizes.
 *
 * TECHNIQUE. One canvas at a fixed internal pixel grid (240 x 108 "pixels" =
 * 2px per yard across 120 yards), scaled up with image smoothing disabled. That
 * gives true pixel-art crispness at any CSS size, keeps the whole play to one
 * draw call per frame, and means a phone animates 22 figures without touching
 * the DOM. requestAnimationFrame drives a single 0..1 timeline.
 *
 * TRUTH. The renderer draws only what the ArcadePlay says. The snap spot, the
 * destination, the line of scrimmage, the first-down marker and the result are
 * taken from the play. Routes, lanes, blocking, defender movement, formation
 * and all 22 positions are RECONSTRUCTED and are labelled as such on the canvas
 * itself, not only in the surrounding UI.
 * ========================================================================== */

const GRID_W = 240;          // 120 yards x 2px
const GRID_H = 108;
const PX_PER_YARD = 2;
const EZ = 10 * PX_PER_YARD; // end zone depth in grid px
const FIELD_TOP = 26;
const FIELD_BOT = GRID_H - 8;
const FIELD_H = FIELD_BOT - FIELD_TOP;

const PAL = {
  ink: '#14110d', ink2: '#1d1914', line: 'rgba(235,225,205,0.16)',
  paper: '#f5f1eb', dim: '#b8b3a8', faint: '#8a867d',
  gold: '#d4af37', crimson: '#e63946',
  turfA: '#1b2f22', turfB: '#18291e', chalk: 'rgba(245,241,235,0.55)'
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - Math.pow(1 - t, 2.2);
const easeIn = t => t * t;

/* yard 0..100 in the offense's frame -> grid x. The offense always attacks to
   the right, so every play reads left-to-right regardless of real orientation.
   That is a presentation choice and is stated in the caption. */
const yardToX = y => EZ + clamp(y, -10, 110) * PX_PER_YARD;

function hexToRgb(h) {
  const m = String(h || '').replace('#', '');
  if (m.length !== 6) return null;
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
/* Team colours come from the feed and can be near-black on a dark field, so
   they are lifted to a minimum luminance rather than used raw. */
function readable(hex, fallback) {
  const rgb = hexToRgb(hex);
  if (!rgb) return fallback;
  let [r, g, b] = rgb;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.34) { const k = 0.34 / Math.max(lum, 0.04); r = clamp(r * k, 0, 255); g = clamp(g * k, 0, 255); b = clamp(b * k, 0, 255); }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/* ---- original pixel figure ------------------------------------------------
 * Eleven rectangles: helmet, facemask notch, shoulders, chest, two arms, hips,
 * two legs, plus a one-pixel outline. Deliberately blocky and deliberately ours.
 */
function drawFigure(ctx, x, y, color, opts = {}) {
  const { facing = 1, carrying = false, down = false, dim = false } = opts;
  const px = Math.round(x), py = Math.round(y);
  ctx.globalAlpha = dim ? 0.55 : 1;

  if (down) {                                  // tackled: figure lies flat
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(px - 4, py, 9, 2);
    ctx.fillStyle = color;
    ctx.fillRect(px - 4, py - 2, 8, 3);
    ctx.fillStyle = PAL.paper;
    ctx.fillRect(px + (facing > 0 ? 4 : -5), py - 3, 2, 2);
    ctx.globalAlpha = 1;
    return;
  }

  ctx.fillStyle = 'rgba(0,0,0,0.40)';          // grounded shadow
  ctx.fillRect(px - 3, py + 1, 6, 1);

  ctx.fillStyle = color;
  ctx.fillRect(px - 2, py - 9, 4, 3);          // helmet
  ctx.fillRect(px - 3, py - 6, 6, 3);          // shoulders
  ctx.fillRect(px - 2, py - 3, 4, 2);          // chest
  ctx.fillRect(px - 2, py - 1, 1, 2);          // legs
  ctx.fillRect(px + 1, py - 1, 1, 2);

  ctx.fillStyle = PAL.paper;                   // facemask
  ctx.fillRect(px + (facing > 0 ? 2 : -3), py - 8, 1, 1);

  if (carrying) {                              // tucked ball
    ctx.fillStyle = '#c8a06a';
    ctx.fillRect(px + (facing > 0 ? 3 : -4), py - 5, 2, 2);
  }
  ctx.globalAlpha = 1;
}

function drawBall(ctx, x, y, spin = 0) {
  const px = Math.round(x), py = Math.round(y);
  ctx.fillStyle = '#c8a06a';
  if (spin % 2) { ctx.fillRect(px - 1, py - 1, 3, 2); }
  else { ctx.fillRect(px - 1, py - 1, 2, 3); }
  ctx.fillStyle = PAL.paper;
  ctx.fillRect(px, py, 1, 1);
}

/* ---- field ---------------------------------------------------------------- */
function drawField(ctx, play) {
  ctx.fillStyle = PAL.ink;
  ctx.fillRect(0, 0, GRID_W, GRID_H);

  // turf with a 5-yard banding, quiet enough to read data over
  for (let y = 0; y < 100; y += 5) {
    ctx.fillStyle = (y / 5) % 2 ? PAL.turfA : PAL.turfB;
    ctx.fillRect(yardToX(y), FIELD_TOP, 5 * PX_PER_YARD, FIELD_H);
  }
  // end zones: offense attacks right
  const offC = readable(play?.offenseColor, PAL.gold);
  ctx.fillStyle = 'rgba(20,17,13,0.86)';
  ctx.fillRect(EZ - EZ, FIELD_TOP, EZ, FIELD_H);
  ctx.fillRect(yardToX(100), FIELD_TOP, EZ, FIELD_H);
  ctx.fillStyle = offC; ctx.globalAlpha = 0.22;
  ctx.fillRect(yardToX(100), FIELD_TOP, EZ, FIELD_H);
  ctx.globalAlpha = 1;

  // yard lines every 5, chalk every 10
  for (let y = 0; y <= 100; y += 5) {
    if (y % 10 === 0) {
      ctx.fillStyle = PAL.chalk;
      ctx.fillRect(yardToX(y), FIELD_TOP, 1, FIELD_H);
    } else {
      /* a 5-yard line is a tick at the sidelines, not a full-height rule */
      ctx.fillStyle = 'rgba(245,241,235,0.22)';
      ctx.fillRect(yardToX(y), FIELD_TOP, 1, 5);
      ctx.fillRect(yardToX(y), FIELD_BOT - 5, 1, 5);
    }
  }
  // goal lines
  ctx.fillStyle = PAL.paper;
  ctx.fillRect(yardToX(0), FIELD_TOP, 1, FIELD_H);
  ctx.fillRect(yardToX(100), FIELD_TOP, 1, FIELD_H);

  // hash marks
  ctx.fillStyle = 'rgba(245,241,235,0.24)';
  for (let y = 1; y < 100; y += 1) {
    ctx.fillRect(yardToX(y), FIELD_TOP + FIELD_H * 0.33, 1, 1);
    ctx.fillRect(yardToX(y), FIELD_TOP + FIELD_H * 0.66, 1, 1);
  }

  // yard numbers, drawn small and quiet
  ctx.fillStyle = 'rgba(245,241,235,0.34)';
  ctx.font = '6px "JetBrains Mono",monospace';
  ctx.textAlign = 'center';
  for (let y = 10; y <= 90; y += 10) {
    const label = String(y <= 50 ? y : 100 - y);
    ctx.fillText(label, yardToX(y), FIELD_BOT - 22);   /* clear of the result band */
  }
}

function drawMarkers(ctx, play) {
  const los = play.startYard;
  if (los !== null && los !== undefined) {
    ctx.fillStyle = 'rgba(245,241,235,0.85)';
    for (let y = FIELD_TOP; y < FIELD_BOT; y += 4) ctx.fillRect(yardToX(los), y, 1, 2);
  }
  const fd = play.firstDownYard;
  if (fd !== null && fd !== undefined && fd <= 100) {
    ctx.fillStyle = PAL.gold;
    for (let y = FIELD_TOP; y < FIELD_BOT; y += 4) ctx.fillRect(yardToX(fd), y, 1, 2);
  }
}

/* ---- reconstructed geometry ----------------------------------------------
 * Everything below is illustrative. It is generated from the play id so the
 * same play always reconstructs the same way (a replay must not wander), but it
 * is not, and is never presented as, tracking data.
 */
function seeded(id) {
  let h = 2166136261;
  for (let i = 0; i < String(id).length; i++) { h ^= String(id).charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
}

function formation(play, rand) {
  const los = yardToX(play.startYard ?? 25);
  const midY = FIELD_TOP + FIELD_H / 2;
  const off = [], def = [];
  for (let i = 0; i < 5; i++) off.push({ x: los - 3, y: midY - 14 + i * 7, role: 'line' });      // O-line
  off.push({ x: los - 12, y: midY, role: 'qb' });
  off.push({ x: los - 16, y: midY + 8, role: 'back' });
  off.push({ x: los - 2, y: midY - 26 + rand() * 4, role: 'wide' });
  off.push({ x: los - 2, y: midY + 24 - rand() * 4, role: 'wide' });
  off.push({ x: los - 5, y: midY - 20, role: 'slot' });
  off.push({ x: los - 5, y: midY + 18, role: 'slot' });
  for (let i = 0; i < 4; i++) def.push({ x: los + 4, y: midY - 11 + i * 7 });                    // front
  for (let i = 0; i < 3; i++) def.push({ x: los + 12, y: midY - 16 + i * 16 });                  // second level
  def.push({ x: los + 8, y: midY - 26 });
  def.push({ x: los + 8, y: midY + 24 });
  def.push({ x: los + 28, y: midY - 10 });
  def.push({ x: los + 30, y: midY + 12 });
  return { off, def, midY, los };
}

/* ---- the play timeline ----------------------------------------------------
 * Each kind is a small script of phases. Phase boundaries are in normalized
 * time; the ball's position at t is what the caption's "result" must agree with
 * at t = 1.
 */
function ballPathFor(play, geo) {
  const sx = yardToX(play.startYard ?? 25);
  const ex = yardToX(play.endYard ?? play.startYard ?? 25);
  const midY = geo.midY;
  const k = play.kind;

  if (k === 'pass_complete' || k === 'passing_touchdown' || k === 'interception' || k === 'interception_td') {
    const catchX = k.startsWith('interception') ? ex : lerp(sx, ex, 0.55);
    const targetY = midY + (play.id.charCodeAt(play.id.length - 1) % 2 ? -18 : 18);
    return { type: 'pass', sx, ex, catchX, targetY, midY };
  }
  if (k === 'pass_incomplete' || k === 'spike') {
    const targetY = midY + (play.id.charCodeAt(play.id.length - 1) % 2 ? -18 : 18);
    return { type: 'incomplete', sx, ex: sx, targetY, midY };
  }
  if (k === 'field_goal_good' || k === 'field_goal_missed' || k === 'extra_point') {
    return { type: 'kick', sx, ex: yardToX(100) + EZ / 2, midY, good: k !== 'field_goal_missed' };
  }
  if (k === 'punt' || k === 'kickoff') return { type: 'boot', sx, ex, midY };
  if (k === 'sack') return { type: 'sack', sx, ex, midY };
  return { type: 'carry', sx, ex, midY };
}

export class ArcadeReplay {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    this.reduced = opts.reducedMotion ??
      (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.compact = Boolean(opts.compact);      // phone: fewer labels, bigger marks
    this.play = null;
    this.t = 0;
    this.raf = null;
    this.playing = false;
    this.duration = 3200;
    this.onEnd = opts.onEnd || null;
    this._resize();
  }

  _resize() {
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
    const cssW = this.canvas.clientWidth || 640;
    const scale = Math.max(2, Math.ceil((cssW * dpr) / GRID_W));
    this.canvas.width = GRID_W * scale;
    this.canvas.height = GRID_H * scale;
    this.scale = scale;
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  load(play) {
    this.play = play;
    this.rand = seeded(play?.id || '0');
    this.geo = formation(play, this.rand);
    this.path = ballPathFor(play, this.geo);
    this.t = this.reduced ? 1 : 0;
    this._draw();
    return this;
  }

  start() {
    if (!this.play) return;
    if (this.reduced) { this.t = 1; this._draw(); this.onEnd?.(); return; }
    this.t = 0; this.playing = true;
    const t0 = performance.now();
    const step = now => {
      if (!this.playing) return;
      this.t = clamp((now - t0) / this.duration, 0, 1);
      this._draw();
      if (this.t < 1) this.raf = requestAnimationFrame(step);
      else { this.playing = false; this.onEnd?.(); }
    };
    this.raf = requestAnimationFrame(step);
  }
  pause() { this.playing = false; if (this.raf) cancelAnimationFrame(this.raf); }
  resume() {
    if (this.playing || this.t >= 1 || this.reduced) return;
    const startT = this.t, t0 = performance.now();
    this.playing = true;
    const step = now => {
      if (!this.playing) return;
      this.t = clamp(startT + (now - t0) / this.duration, 0, 1);
      this._draw();
      if (this.t < 1) this.raf = requestAnimationFrame(step);
      else { this.playing = false; this.onEnd?.(); }
    };
    this.raf = requestAnimationFrame(step);
  }
  toEnd() { this.pause(); this.t = 1; this._draw(); }
  destroy() { this.pause(); }

  /* ---- one frame --------------------------------------------------------- */
  _draw() {
    const ctx = this.ctx, p = this.play;
    if (!p) return;
    drawField(ctx, p);
    drawMarkers(ctx, p);
    this._drawHud();
    if (p.kind === 'stoppage' || p.kind === 'period_end' || p.kind === 'unknown' ||
        p.startYard === null || p.startYard === undefined) {
      this._drawStateOnly();
      return;
    }
    this._drawPlayers();
    this._drawBall();
    this._drawResult();
  }

  _drawPlayers() {
    const ctx = this.ctx, p = this.play, g = this.geo, t = this.t;
    const offC = readable(p.offenseColor, PAL.gold);
    const defC = PAL.crimson;
    const path = this.path;
    const carryT = clamp((t - 0.28) / 0.62, 0, 1);

    // defence converges on the ball's destination -- illustrative
    /* Pursuit, not a swarm: each defender keeps its own lane offset and arrives
       on its own schedule, so the frame reads as eleven players converging
       rather than one red mass at the ball. */
    const endX = yardToX(p.endYard ?? p.startYard);
    g.def.forEach((d, i) => {
      const lag = 0.55 + (i % 4) * 0.14;
      const dt = easeOut(clamp(carryT / lag, 0, 1));
      const laneY = g.midY + ((i % 6) - 2.5) * 7;
      const standoff = 6 + (i % 5) * 4;
      const targetX = lerp(d.x, endX + standoff, dt * 0.92);
      const targetY = lerp(d.y, laneY, dt * 0.75);
      drawFigure(ctx, targetX, targetY, defC, { facing: -1, dim: true });
    });

    // offence: line holds, skill players run reconstructed routes
    g.off.forEach(o => {
      if (o.role === 'qb') return;              // drawn with the ball logic
      let x = o.x, y = o.y;
      if (o.role === 'wide' || o.role === 'slot') {
        const routeT = easeOut(clamp(t / 0.55, 0, 1));
        x = lerp(o.x, o.x + 26, routeT);
        y = lerp(o.y, g.midY + (o.y < g.midY ? -14 : 14), routeT * 0.6);
      } else if (o.role === 'line') {
        x = lerp(o.x, o.x + 3, easeOut(clamp(t / 0.4, 0, 1)));
      } else if (o.role === 'back') {
        if (path.type === 'carry') return;
        x = lerp(o.x, o.x + 6, easeOut(clamp(t / 0.5, 0, 1)));
      }
      drawFigure(ctx, x, y, offC, { facing: 1, dim: true });
    });
  }

  _drawBall() {
    const ctx = this.ctx, p = this.play, g = this.geo, path = this.path, t = this.t;
    const offC = readable(p.offenseColor, PAL.gold);
    const spin = Math.floor(t * 24);
    const snapT = 0.18;

    if (t < snapT) {                               // pre-snap
      drawFigure(ctx, path.sx - 12, g.midY, offC, { facing: 1, carrying: true });
      return;
    }
    const a = clamp((t - snapT) / (1 - snapT), 0, 1);

    if (path.type === 'pass' || path.type === 'incomplete') {
      const dropX = lerp(path.sx - 12, path.sx - 20, easeOut(clamp(a / 0.3, 0, 1)));
      const throwT = clamp((a - 0.3) / 0.35, 0, 1);
      const flightT = clamp((a - 0.42) / 0.34, 0, 1);
      drawFigure(ctx, dropX, g.midY, offC, { facing: 1, carrying: throwT < 0.5 });
      if (flightT > 0 && flightT < 1) {
        const tx = path.type === 'incomplete' ? lerp(path.sx, path.sx + 30, 1) : path.catchX;
        const bx = lerp(dropX, tx, flightT);
        const by = lerp(g.midY, path.targetY, flightT) - Math.sin(flightT * Math.PI) * 12;
        drawBall(ctx, bx, by, spin);
      } else if (flightT >= 1) {
        if (path.type === 'incomplete') {
          const gx = lerp(path.sx, path.sx + 30, 1), gy = path.targetY;
          drawBall(ctx, gx, gy + 3, 0);
          this._pixelText('INCOMPLETE', gx, gy - 6, PAL.paper);
        } else {
          const runT = clamp((a - 0.76) / 0.24, 0, 1);
          const cx = lerp(path.catchX, path.ex, easeOut(runT));
          const cy = lerp(path.targetY, g.midY + 6, easeOut(runT));
          const isInt = p.kind === 'interception' || p.kind === 'interception_td';
          drawFigure(ctx, cx, cy, isInt ? PAL.crimson : offC, { facing: isInt ? -1 : 1, carrying: true, down: runT >= 1 && !p.scoring });
          if (isInt && runT > 0.05) this._pixelText('INTERCEPTED', path.catchX, path.targetY - 8, PAL.crimson);
        }
      }
      return;
    }

    if (path.type === 'carry') {
      const runT = easeOut(clamp((a - 0.1) / 0.9, 0, 1));
      const laneY = g.midY + Math.sin(runT * Math.PI) * 6;
      const x = lerp(path.sx - 12, path.ex, runT);
      drawFigure(ctx, x, laneY, offC, { facing: 1, carrying: true, down: runT >= 1 && !p.scoring });
      return;
    }

    if (path.type === 'sack') {
      const dropT = clamp(a / 0.55, 0, 1);
      const x = lerp(path.sx - 12, path.ex - 4, easeOut(dropT));
      drawFigure(ctx, x, g.midY, offC, { facing: 1, carrying: true, down: a > 0.8 });
      if (a > 0.8) this._pixelText('SACK', x, g.midY - 12, PAL.crimson);
      return;
    }

    if (path.type === 'kick') {
      const kickT = clamp(a / 0.85, 0, 1);
      drawFigure(ctx, path.sx - 8, g.midY, offC, { facing: 1 });
      const bx = lerp(path.sx, path.ex, easeIn(kickT));
      const by = g.midY - Math.sin(kickT * Math.PI) * 26;
      drawBall(ctx, bx, by, spin);
      if (kickT >= 1) this._pixelText(path.good ? 'GOOD' : 'NO GOOD', path.ex - 10, g.midY - 22, path.good ? PAL.gold : PAL.crimson);
      return;
    }

    // punt / kickoff
    const bootT = clamp(a / 0.8, 0, 1);
    const bx = lerp(path.sx, path.ex, easeOut(bootT));
    const by = g.midY - Math.sin(bootT * Math.PI) * 22;
    drawFigure(ctx, path.sx - 6, g.midY, offC, { facing: 1 });
    drawBall(ctx, bx, by, spin);
    if (bootT >= 1) drawFigure(ctx, path.ex, g.midY, PAL.crimson, { facing: -1, carrying: true });
  }

  _drawStateOnly() {
    const ctx = this.ctx, p = this.play;
    ctx.fillStyle = 'rgba(20,17,13,0.72)';
    ctx.fillRect(0, FIELD_TOP, GRID_W, FIELD_H);
    this._pixelText(p.kind === 'unknown' ? 'NO RECONSTRUCTION FOR THIS PLAY TYPE' : (p.typeText || '').toUpperCase(),
      GRID_W / 2, FIELD_TOP + FIELD_H / 2 - 2, PAL.dim);
    this._pixelText('FIELD STATE ONLY', GRID_W / 2, FIELD_TOP + FIELD_H / 2 + 8, PAL.faint);
  }

  _pixelText(s, x, y, color, size = 6) {
    const ctx = this.ctx;
    ctx.font = `${size}px "JetBrains Mono",monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(s, Math.round(x) + 1, Math.round(y) + 1);
    ctx.fillStyle = color;
    ctx.fillText(s, Math.round(x), Math.round(y));
  }

  _drawHud() {
    const ctx = this.ctx, p = this.play;
    ctx.fillStyle = PAL.ink2;
    ctx.fillRect(0, 0, GRID_W, FIELD_TOP - 2);
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(0, FIELD_TOP - 2, GRID_W, 1);

    ctx.textAlign = 'left';
    ctx.font = '6px "JetBrains Mono",monospace';
    ctx.fillStyle = PAL.gold;
    ctx.fillText('PBECAST ARCADE REPLAY', 4, 8);
    ctx.fillStyle = PAL.faint;
    /* the full strapline runs into the clock on a 240px grid at phone width */
    ctx.fillText(this.compact ? 'RECONSTRUCTED' : 'RECONSTRUCTED FROM LIVE PLAY-BY-PLAY', 4, 16);

    ctx.textAlign = 'right';
    ctx.fillStyle = PAL.paper;
    const dd = p.down ? `${p.down} & ${p.distance}` : '';
    ctx.fillText(`${p.offense || ''}${p.defense ? ' v ' + p.defense : ''}   ${dd}`, GRID_W - 4, 8);
    ctx.fillStyle = PAL.dim;
    ctx.fillText(`Q${p.quarter || '-'}  ${p.clock || ''}`, GRID_W - 4, 16);

    /* Direction is carried by the arrow alone. A centred "ATTACKING" caption sat
       on top of the strapline at every width. The arrow is placed over the
       right-hand end zone, where it means something. */
    /* drawn inside the attacking end zone, clear of the clock line above it */
    const ax = yardToX(100) + 3, ay = FIELD_TOP + 6;
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(ax, ay, 11, 1);
    ctx.fillRect(ax + 10, ay - 2, 1, 5);
    ctx.fillRect(ax + 11, ay - 1, 1, 3);
  }

  _drawResult() {
    const p = this.play;
    if (this.t < 0.98) return;
    const ctx = this.ctx;
    let label;
    if (p.scoring && (p.kind === 'field_goal_good' || p.kind === 'extra_point')) label = 'GOOD';
    else if (p.scoring) label = 'TOUCHDOWN';
    else if (p.kind === 'pass_incomplete') label = 'INCOMPLETE';
    else if (p.possessionChange) label = 'TURNOVER';
    else if (p.yardsGained !== null && p.yardsGained !== undefined) label = `${p.yardsGained >= 0 ? '+' : ''}${p.yardsGained} YARDS`;
    else label = (p.typeText || '').toUpperCase();

    /* The result gets its own band across the foot of the field. The
       reconstruction caption used to be drawn on the same baseline and the two
       overlapped; it now sits on the band's own second line, or is dropped
       entirely on a phone where the strapline above already carries it. */
    const bandH = this.compact ? 11 : 17;
    ctx.fillStyle = 'rgba(20,17,13,0.90)';
    ctx.fillRect(0, FIELD_BOT - bandH, GRID_W, bandH);
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(0, FIELD_BOT - bandH, GRID_W, 1);

    ctx.fillStyle = p.scoring ? PAL.gold : p.possessionChange ? PAL.crimson : PAL.paper;
    ctx.font = '7px "JetBrains Mono",monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, GRID_W / 2, FIELD_BOT - bandH + 8);

    if (!this.compact) {
      ctx.font = '5px "JetBrains Mono",monospace';
      ctx.fillStyle = PAL.faint;
      ctx.textAlign = 'center';
      ctx.fillText('ROUTES, LANES AND DEFENDER MOVEMENT ARE RECONSTRUCTED', GRID_W / 2, FIELD_BOT - 3);
    }
  }
}

export const __visual = { GRID_W, GRID_H, PAL, yardToX, drawFigure, readable };
