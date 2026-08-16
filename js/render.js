(function (global) {
  const GW = global.GW, GH = global.GH, CELLS = global.CELLS;
  const T = global.Terrain.T;
  const CELL = 6;
  const WORLD_W = GW * CELL, WORLD_H = GH * CELL;
  const SPAWN_R = 8;

  const TERRAIN_COLOR = {};
  TERRAIN_COLOR[T.DEEP] = '#0a2239';
  TERRAIN_COLOR[T.SHALLOW] = '#16568f';
  TERRAIN_COLOR[T.SAND] = '#e0c98e';
  TERRAIN_COLOR[T.GRASS] = '#4d9e52';
  TERRAIN_COLOR[T.FOREST] = '#2f7d3e';
  const TERRAIN_RGB = {};
  const BORDER_RGBA = 'rgba(0,0,0,0.55)';

  function hexRgb(hex) {
    hex = hex.replace('#', '');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  function rgba(hex, a) {
    const r = hexRgb(hex);
    return 'rgba(' + r[0] + ',' + r[1] + ',' + r[2] + ',' + a + ')';
  }
  for (const k in TERRAIN_COLOR) TERRAIN_RGB[k] = hexRgb(TERRAIN_COLOR[k]);

  class Renderer {
    constructor(canvas, mini) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.mini = mini;
      this.mctx = mini.getContext('2d');
      this.mimg = this.mctx.createImageData(GW, GH);
      this.terrCanvas = document.createElement('canvas');
      this.terrCanvas.width = WORLD_W;
      this.terrCanvas.height = WORLD_H;
      this.terrCtx = this.terrCanvas.getContext('2d');
      this.pcolors = new Map();
      this.pAlpha = {};
      this.cam = { x: -1, y: -1, zoom: 1 };
    }

    buildTerrain(terrain) {
      const ctx = this.terrCtx;
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          ctx.fillStyle = TERRAIN_COLOR[terrain[y * GW + x]];
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
      this.cam.zoom = -1;
      this.cam.x = -1;
    }

    setPlayers(players) {
      this.pcolors.clear();
      for (const p of players) this.pcolors.set(p.idx, p.color);
    }

    color(idx, a) {
      const c = this.pcolors.get(idx) || '#ffffff';
      const key = c + a;
      if (!this.pAlpha[key]) this.pAlpha[key] = rgba(c, a);
      return this.pAlpha[key];
    }

    fitCam() {
      const cw = this.canvas.width, ch = this.canvas.height;
      const fit = Math.min(cw / WORLD_W, ch / WORLD_H);
      this.cam.zoom = Math.min(fit, 3.5);
      this.cam.x = (WORLD_W - cw / this.cam.zoom) / 2;
      this.cam.y = (WORLD_H - ch / this.cam.zoom) / 2;
      this.clampCam();
    }

    toWorld(sx, sy) {
      const z = this.cam.zoom;
      return { x: this.cam.x + sx / z, y: this.cam.y + sy / z };
    }

    panBy(dx, dy) {
      const z = this.cam.zoom;
      this.cam.x -= dx / z;
      this.cam.y -= dy / z;
      this.clampCam();
    }

    clampCam() {
      const cw = this.canvas.width, ch = this.canvas.height;
      const z = this.cam.zoom;
      const vw = cw / z, vh = ch / z;
      if (vw >= WORLD_W) this.cam.x = (WORLD_W - vw) / 2;
      else this.cam.x = Math.min(Math.max(0, this.cam.x), WORLD_W - vw);
      if (vh >= WORLD_H) this.cam.y = (WORLD_H - vh) / 2;
      else this.cam.y = Math.min(Math.max(0, this.cam.y), WORLD_H - vh);
    }

    zoomAt(sx, sy, factor) {
      const z0 = this.cam.zoom;
      const z1 = Math.min(4, Math.max(0.35, z0 * factor));
      const wx = this.cam.x + sx / z0;
      const wy = this.cam.y + sy / z0;
      this.cam.zoom = z1;
      this.cam.x = wx - sx / z1;
      this.cam.y = wy - sy / z1;
      this.clampCam();
    }

    draw(view, myIdx, hoverIdx) {
      if (this.cam.zoom < 0) this.fitCam();
      const cw = this.canvas.width, ch = this.canvas.height;
      const ctx = this.ctx;
      const z = this.cam.zoom;
      this.setPlayers(view.players);
      ctx.save();
      ctx.fillStyle = '#03040a';
      ctx.fillRect(0, 0, cw, ch);
      ctx.translate(-this.cam.x * z, -this.cam.y * z);
      ctx.scale(z, z);
      ctx.drawImage(this.terrCanvas, 0, 0);
      this.drawTerritory(view, z);
      if (view.attacks) this.drawWaves(view.attacks, z);
      if (view.phase === 'pick') this.drawSpawns(view, z);
      if (view.ships) for (const s of view.ships) this.drawShip(ctx, s);
      if (hoverIdx >= 0 && view.territory[hoverIdx] >= 0) {
        const hx = (hoverIdx % GW) * CELL + CELL / 2, hy = ((hoverIdx / GW) | 0) * CELL + CELL / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.arc(hx, hy, CELL * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5 / z;
        ctx.setLineDash([4 / z, 3 / z]);
        ctx.beginPath();
        ctx.arc(hx, hy, CELL * 0.62, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    drawSpawns(view, z) {
      const ctx = this.ctx;
      const R = SPAWN_R * CELL;
      for (const p of view.players) {
        if (p.dead) continue;
        const cx = (p.sx + 0.5) * CELL, cy = (p.sy + 0.5) * CELL;
        if (p.pixels > 0) {
          ctx.fillStyle = this.color(p.idx, 0.35);
        } else {
          ctx.fillStyle = this.color(p.idx, 0.15);
        }
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = this.color(p.idx, 0.95);
        ctx.lineWidth = 2 / z;
        ctx.setLineDash([8 / z, 5 / z]);
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    drawWaves(attacks, z) {
      const ctx = this.ctx;
      for (const a of attacks) {
        const cx = (a.x + 0.5) * CELL, cy = (a.y + 0.5) * CELL;
        const r = Math.max(0.6, a.r) * CELL;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fill();
        ctx.strokeStyle = rgba(a.color, 0.95);
        ctx.lineWidth = 2 / z;
        ctx.setLineDash([6 / z, 4 / z]);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    drawTerritory(view, z) {
      const cw = this.canvas.width, ch = this.canvas.height;
      const ctx = this.ctx;
      const x0 = Math.max(0, Math.floor(this.cam.x / CELL));
      const y0 = Math.max(0, Math.floor(this.cam.y / CELL));
      const x1 = Math.min(GW - 1, Math.ceil((this.cam.x + cw / this.cam.zoom) / CELL));
      const y1 = Math.min(GH - 1, Math.ceil((this.cam.y + ch / this.cam.zoom) / CELL));
      const tr = view.territory;
      const r = CELL * 0.71;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const o = tr[y * GW + x];
          if (o >= 0) {
            const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2;
            ctx.fillStyle = this.color(o, 0.55);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    drawShip(ctx, s) {
      const x = s.x * CELL, y = s.y * CELL;
      const color = s.dead ? '#888888' : (this.pcolors.get(s.owner) || '#ffffff');
      ctx.save();
      ctx.translate(x, y);
      const dx = s.tx - s.x, dy = s.ty - s.y;
      if (dx || dy) ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.lineTo(-6, 5);
      ctx.lineTo(-2.5, 0);
      ctx.lineTo(-6, -5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    drawMinimap(view) {
      const m = this.mimg.data;
      let k = 0;
      for (let i = 0; i < CELLS; i++, k += 4) {
        const o = view.territory[i];
        let rgb;
        if (o >= 0) rgb = hexRgb(this.pcolors.get(o) || '#ffffff');
        else rgb = TERRAIN_RGB[view.terrain[i]];
        m[k] = rgb[0];
        m[k + 1] = rgb[1];
        m[k + 2] = rgb[2];
        m[k + 3] = 255;
      }
      this.mctx.putImageData(this.mimg, 0, 0);
    }
  }

  global.Renderer = Renderer;
})(typeof self !== 'undefined' ? self : this);