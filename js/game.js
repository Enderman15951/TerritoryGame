(function (global) {
  const GW = 600, GH = 400, CELLS = GW * GH;
  const T = global.Terrain.T;

  const TICK = 0.5;
  const INCOME_CYCLE = 10;
  const EARLY = 107;
  const SOFT_F = 100, HARD_F = 150;
  const COST_NEUTRAL = 90;
  const DEFENSE_F = 2, DENSITY_F = 50;
  const TAX_F = 0.0117;
  const BOAT_COST_F = 0.03125, BOAT_MIN = 130, BOAT_SPEED = 5.5;
  const START_BALANCE = 600, START_BLOB = 200;
  const WAVE_SPEED = 10;
  const PICK_TIME = 10;
  const SPAWN_R = 8;

  class Country {
    constructor(idx, id, name, color, isBot) {
      this.idx = idx;
      this.id = id;
      this.name = name;
      this.color = color;
      this.isBot = !!isBot;
      this.balance = START_BALANCE;
      this.pixels = 0;
      this.alive = true;
      this.dead = false;
      this.attackPct = 0.3;
      this.attack = null;
      this.ships = [];
      this.aiT = 0;
      this.px = 0;
      this.py = 0;
      this.sx = 0;
      this.sy = 0;
    }
  }

  class Game {
    constructor(settings) {
      this.settings = settings;
      const map = global.Terrain.generateMap(settings.seed, GW, GH, settings.landFrac);
      this.terrain = map.grid;
      this.totalLand = map.land;
      this.owner = new Int16Array(CELLS).fill(-1);
      this.scanStamp = new Uint32Array(CELLS);
      this.scanGen = 0;
      this.players = [];
      this.ships = [];
      this.shipSeq = 1;
      this.time = 0;
      this.over = false;
      this.winner = null;
      this.events = [];
      this.changed = [];
      this.changedMap = new Map();
      this.simAcc = 0;
      this.cycle = 0;
      this.phase = 'pick';
      this.pickEnd = PICK_TIME;
    }

    addPlayer(id, name, color, isBot) {
      const p = new Country(this.players.length, id, name, color, isBot);
      this.players.push(p);
      if (isBot || this.phase === 'play') this.claimStartBlob(p);
      return p;
    }

    claimStartBlob(p) {
      let best = null, bestCount = 0;
      for (let s = 0; s < 160; s++) {
        const idx = (Math.random() * CELLS) | 0;
        if (this.terrain[idx] < T.SAND || this.owner[idx] !== -1) continue;
        const count = this.blobAround(idx, p, true);
        if (count > bestCount) { bestCount = count; best = idx; }
        if (bestCount >= START_BLOB) break;
      }
      if (best !== null && bestCount > 0) {
        this.blobAround(best, p, false);
        p.sx = best % GW;
        p.sy = (best / GW) | 0;
      }
    }

    setSpawn(p, x, y) {
      p.sx = Math.max(0, Math.min(GW - 1, x | 0));
      p.sy = Math.max(0, Math.min(GH - 1, y | 0));
    }

    claimPick(p, idx) {
      if (this.phase !== 'pick' || p.dead) return false;
      if (p.pixels > 0) return false;
      if (idx < 0 || idx >= CELLS || this.terrain[idx] < T.SAND) return false;
      p.sx = idx % GW;
      p.sy = (idx / GW) | 0;
      this.blobAround(idx, p, false);
      return p.pixels > 0;
    }

    endPick() {
      if (this.phase !== 'pick') return;
      this.phase = 'play';
      for (const p of this.players) {
        if (p.dead || p.pixels > 0) continue;
        if (p.sx >= 0 && p.sy >= 0 && this.terrain[p.sy * GW + p.sx] >= T.SAND) {
          this.blobAround(p.sy * GW + p.sx, p, false);
        } else {
          this.claimStartBlob(p);
        }
      }
      this.events.push({ type: 'phase', v: 'play' });
    }

    blobAround(start, p, dry) {
      const target = START_BLOB;
      const radius = Math.sqrt(target / Math.PI);
      const cx = start % GW, cy = (start / GW) | 0;
      const x0 = Math.max(0, cx - Math.ceil(radius)), x1 = Math.min(GW - 1, cx + Math.ceil(radius));
      const y0 = Math.max(0, cy - Math.ceil(radius)), y1 = Math.min(GH - 1, cy + Math.ceil(radius));
      let count = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy > radius * radius) continue;
          const i = y * GW + x;
          if (this.terrain[i] < T.SAND) continue;
          if (this.owner[i] !== -1) continue;
          count++;
          if (!dry) this.setOwner(i, p.idx);
        }
      }
      return count;
    }

    setOwner(idx, owner) {
      const prev = this.owner[idx];
      if (prev === owner) return;
      this.owner[idx] = owner;
      this.changedMap.set(idx, owner);
      if (prev !== -1) {
        const q = this.players[prev];
        if (q) q.pixels--;
      }
      if (owner !== -1) {
        const q = this.players[owner];
        if (q) {
          q.pixels++;
          if (q.dead) { q.dead = false; q.alive = true; this.events.push({ type: 'revive', p: q.idx }); }
        }
      }
      if (prev !== -1 && this.players[prev] && this.players[prev].pixels <= 0) this.checkDefeat(this.players[prev]);
    }

    checkDefeat(p) {
      if (p.pixels > 0 || p.dead) return;
      if (p.ships.length > 0) return;
      p.alive = false;
      p.dead = true;
      p.attack = null;
      this.events.push({ type: 'elim', p: p.idx });
      this.evalWin();
    }

    evalWin() {
      if (this.over) return;
      let owned = 0;
      for (const p of this.players) owned += p.pixels;
      if (owned >= this.totalLand) {
        let best = null, bc = -1;
        for (const p of this.players) if (p.pixels > bc) { bc = p.pixels; best = p; }
        this.endGame(best);
        return;
      }
      const active = this.players.filter((p) => !p.dead);
      if (active.length === 1 && active[0].pixels > 0) {
        this.endGame(active[0]);
      }
    }

    endGame(winner) {
      if (this.over) return;
      this.over = true;
      this.winner = winner;
      this.events.push({ type: 'gameover', p: winner ? winner.idx : -1 });
    }

    tick(dt) {
      if (this.over) return;
      this.time += dt;
      if (this.phase === 'pick') {
        if (this.time >= this.pickEnd) this.endPick();
        return;
      }
      this.simAcc += dt;
      for (const s of this.ships) this.stepShip(s, dt);
      while (this.simAcc >= TICK) {
        this.simAcc -= TICK;
        this.economyTick();
      }
      for (const p of this.players) {
        if (!p.dead && p.isBot) global.updateBot(this, p, dt);
      }
    }

    economyTick() {
      this.cycle++;
      const t = this.time;
      for (const p of this.players) {
        if (p.dead) continue;
        if (p.pixels > 0) {
          const occ = Math.min(1, p.pixels / this.totalLand);
          const early = t < EARLY ? (1 + 6 * (1 - t / EARLY)) : 1;
          let interest = 0.01 * early * (1 + 0.16 * Math.sqrt(occ));
          const soft = SOFT_F * p.pixels, hard = HARD_F * p.pixels;
          if (p.balance > soft && hard > soft) {
            interest *= Math.max(0, (hard - p.balance) / (hard - soft));
          }
          p.balance += p.balance * interest;
          if (this.cycle % INCOME_CYCLE === 0) p.balance += p.pixels;
          if (p.balance > hard) p.balance = hard;
        } else {
          p.balance = 0;
        }
      }
      for (const p of this.players) {
        if (!p.dead) this.stepAttack(p);
      }
    }

    attackOrder(p, cell, pct) {
      if (p.dead) return false;
      if (cell < 0 || cell >= CELLS || this.terrain[cell] < T.SAND) return false;
      if (this.owner[cell] === p.idx) {
        this.endAttack(p);
        return true;
      }
      const x = cell % GW, y = (cell / GW) | 0;
      let adjacent = false;
      const cand = [cell - 1, cell + 1, cell - GW, cell + GW];
      for (const j of cand) {
        if (j < 0 || j >= CELLS) continue;
        const jx = j % GW;
        if (Math.abs(jx - x) > 1) continue;
        if (this.owner[j] === p.idx) { adjacent = true; break; }
      }
      if (!adjacent) return false;
      const commit = Math.min(p.balance, Math.floor(p.balance * pct));
      const tgt = this.owner[cell] >= 0 ? this.owner[cell] : -2;
      if (p.attack && p.attack.tgt === tgt) {
        p.balance -= commit;
        p.attack.pool += commit;
        p.attack.pct = Math.max(p.attack.pct, pct);
        return true;
      }
      const carry = p.attack ? p.attack.pool : 0;
      p.balance -= commit;
      p.attack = {
        tx: x, ty: y,
        pct: pct,
        pool: carry + commit,
        r: 0,
        tgt: tgt,
        stall: 0
      };
      return true;
    }

    setPct(p, v) {
      v = Math.min(1, Math.max(0, v));
      p.attackPct = v;
      const a = p.attack;
      if (!a) return;
      const oldP = a.pct;
      a.pct = v;
      if (v > oldP) {
        const add = Math.min(p.balance, Math.floor(p.balance * (v - oldP)));
        if (add > 0) { p.balance -= add; a.pool += add; }
      }
    }

    cancelAttack(p) {
      this.endAttack(p);
    }

    endAttack(p) {
      const a = p.attack;
      if (a && a.pool > 0) {
        p.balance += a.pool;
        const cap = HARD_F * Math.max(1, p.pixels);
        if (p.balance > cap) p.balance = cap;
      }
      p.attack = null;
    }

    stepAttack(p) {
      const a = p.attack;
      if (!a) return;
      if (a.pct <= 0) return;
      if (a.bonus > 0) { a.pool += a.bonus; a.bonus = 0; }
      if (a.pool < COST_NEUTRAL) { this.endAttack(p); return; }

      const maxR = Math.sqrt(a.pool / COST_NEUTRAL / Math.PI);
      let targetR = Math.min(maxR, a.r + WAVE_SPEED);
      if (targetR <= a.r) {
        const fr = this.frontierBox(p, a.tx, a.ty, a.r + 2);
        if (!fr.length) { this.endAttack(p); return; }
        targetR = a.r;
      }
      const tR2 = targetR * targetR;
      const cx = a.tx, cy = a.ty;

      this.scanGen = (this.scanGen + 1) | 0;
      if (this.scanGen === 0) { this.scanStamp.fill(0); this.scanGen = 1; }
      const stamp = this.scanGen;
      const seen = this.scanStamp;
      const q = [];
      const start = cy * GW + cx;
      if (this.terrain[start] >= T.SAND) {
        seen[start] = stamp;
        q.push(start);
      }
      let claimed = false, elseSeen = false, maxClaimed = 0;
      let guard = 0;
      while (q.length && guard < 4000) {
        guard++;
        const i = q.pop();
        const x = i % GW, y = (i / GW) | 0;
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > tR2) continue;
        if (this.terrain[i] < T.SAND) continue;
        const o = this.owner[i];
        if (o !== p.idx) {
          elseSeen = true;
          const cost = o === -1 ? COST_NEUTRAL : this.costFor(p, o);
          if (a.pool < cost) continue;
          a.pool -= cost;
          if (o >= 0) this.defendBalance(o, cost / DEFENSE_F);
          this.setOwner(i, p.idx);
          claimed = true;
          if (d2 > maxClaimed) maxClaimed = d2;
          if (this.over) return;
        }
        const push = (j, nx, ny) => {
          if (seen[j] === stamp) return;
          const ndx = nx - cx, ndy = ny - cy;
          if (ndx * ndx + ndy * ndy > tR2) return;
          if (this.terrain[j] < T.SAND) return;
          seen[j] = stamp;
          q.push(j);
        };
        if (x > 0) push(i - 1, x - 1, y);
        if (x < GW - 1) push(i + 1, x + 1, y);
        if (y > 0) push(i - GW, x, y - 1);
        if (y < GH - 1) push(i + GW, x, y + 1);
      }

      if (claimed) {
        a.r = Math.min(targetR, Math.sqrt(maxClaimed) + 0.5);
        a.stall = 0;
      } else {
        a.r = Math.min(targetR, a.r + 0.05);
        a.stall++;
        if (a.stall >= 8) this.endAttack(p);
      }
    }

    frontierBox(p, cx, cy, r) {
      const front = [];
      const x0 = Math.max(0, cx - Math.ceil(r) - 1), x1 = Math.min(GW - 1, cx + Math.ceil(r) + 1);
      const y0 = Math.max(0, cy - Math.ceil(r) - 1), y1 = Math.min(GH - 1, cy + Math.ceil(r) + 1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * GW + x;
          if (this.owner[i] !== p.idx) continue;
          if (x > 0) { const j = i - 1; if (this.terrain[j] >= T.SAND && this.owner[j] !== p.idx) front.push(j); }
          if (x < GW - 1) { const j = i + 1; if (this.terrain[j] >= T.SAND && this.owner[j] !== p.idx) front.push(j); }
          if (y > 0) { const j = i - GW; if (this.terrain[j] >= T.SAND && this.owner[j] !== p.idx) front.push(j); }
          if (y < GH - 1) { const j = i + GW; if (this.terrain[j] >= T.SAND && this.owner[j] !== p.idx) front.push(j); }
        }
      }
      return front;
    }

    defendBalance(ownerIdx, loss) {
      const q = this.players[ownerIdx];
      if (!q || q.dead || loss <= 0) return;
      q.balance = Math.max(0, q.balance - loss);
    }

    costFor(p, ownerIdx) {
      if (ownerIdx === -1) return COST_NEUTRAL;
      const q = this.players[ownerIdx];
      if (!q || q.dead || q.pixels <= 0) return COST_NEUTRAL;
      const dens = q.balance / Math.max(1, q.pixels);
      return COST_NEUTRAL * DEFENSE_F * (1 + dens / DENSITY_F);
    }

    coastNear(tx, ty) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < CELLS; i++) {
        if (this.owner[i] === -1) continue;
        const x = i % GW, y = (i / GW) | 0;
        const onWater = (x > 0 && this.terrain[i - 1] < T.SAND) || (x < GW - 1 && this.terrain[i + 1] < T.SAND) ||
          (y > 0 && this.terrain[i - GW] < T.SAND) || (y < GH - 1 && this.terrain[i + GW] < T.SAND);
        if (!onWater) continue;
        const d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }

    buildShip(p, tx, ty) {
      if (p.dead || p.pixels <= 0) return false;
      const cost = Math.max(BOAT_MIN, p.balance * BOAT_COST_F);
      if (p.balance < cost + 60) return false;
      const ci = this.coastNear(tx, ty);
      if (ci === -1) return false;
      p.balance -= cost;
      const sx = (ci % GW) + 0.5, sy = ((ci / GW) | 0) + 0.5;
      const ship = { id: this.shipSeq++, owner: p.idx, x: sx, y: sy, tx: tx, ty: ty, troops: cost, dead: false };
      this.ships.push(ship);
      p.ships.push(ship);
      this.events.push({ type: 'boat', id: ship.id });
      return true;
    }

    retargetShip(p, tx, ty) {
      if (p.ships.length) {
        const s = p.ships[p.ships.length - 1];
        s.tx = tx; s.ty = ty;
        return true;
      }
      return false;
    }

    shipTo(p, tx, ty) {
      if (this.retargetShip(p, tx, ty)) return true;
      return this.buildShip(p, tx, ty);
    }

    stepShip(s, dt) {
      const dx = s.tx - s.x, dy = s.ty - s.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.5) { this.shipLanding(s); return; }
      const step = BOAT_SPEED * dt;
      if (d <= step) { s.x = s.tx; s.y = s.ty; }
      else { s.x += (dx / d) * step; s.y += (dy / d) * step; }
      const cx = s.x | 0, cy = s.y | 0;
      if (cx >= 0 && cy >= 0 && cx < GW && cy < GH && this.terrain[cy * GW + cx] >= T.SAND) {
        this.shipLanding(s);
      }
    }

    shipLanding(s) {
      const cx = s.x | 0, cy = s.y | 0;
      if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) return;
      const idx = cy * GW + cx;
      const p = this.players[s.owner];
      if (!p) { this.removeShip(s); return; }
      const cur = this.owner[idx];
      if (cur === s.owner) { this.removeShip(s); return; }
      const cost = this.costFor(p, cur);
      if (s.troops >= cost) {
        s.troops -= cost;
        this.setOwner(idx, p.idx);
        this.startNaval(p, idx, s.troops);
        this.removeShip(s);
      } else {
        this.removeShip(s);
      }
    }

    startNaval(p, idx, troops) {
      if (p.dead) return;
      if (!p.attack) {
        const x = idx % GW, y = (idx / GW) | 0;
        p.attack = { tx: x, ty: y, pct: Math.max(p.attackPct, 0.2), pool: 0, r: 0, tgt: -2, stall: 0, bonus: troops };
      } else {
        p.attack.bonus += troops;
      }
    }

    removeShip(s) {
      const p = this.players[s.owner];
      if (p) {
        const k = p.ships.indexOf(s);
        if (k >= 0) p.ships.splice(k, 1);
      }
      const k = this.ships.indexOf(s);
      if (k >= 0) this.ships.splice(k, 1);
      if (p && !p.dead && p.pixels <= 0 && p.ships.length === 0) this.checkDefeat(p);
    }

    drainChanged() {
      if (!this.changedMap.size) return [];
      const out = [];
      for (const [i, o] of this.changedMap) { out.push(i, o); }
      this.changedMap.clear();
      return out;
    }

    rleGrid() {
      const out = [];
      let prev = -2, run = 0;
      for (let i = 0; i < CELLS; i++) {
        const v = this.owner[i];
        if (v === prev) run++;
        else {
          if (prev !== -2) out.push(run, prev);
          prev = v;
          run = 1;
        }
      }
      out.push(run, prev);
      return out;
    }

    drainEvents() {
      const ev = this.events;
      this.events = [];
      return ev;
    }
  }

  function decodeRLE(rle, out) {
    out = out || new Int16Array(CELLS).fill(-1);
    let i = 0, o = 0;
    while (i < rle.length) {
      const run = rle[i++], val = rle[i++];
      for (let k = 0; k < run; k++) out[o++] = val;
    }
    return out;
  }

  global.Game = Game;
  global.DecodeRLE = decodeRLE;
  global.CELLS = CELLS;
  global.GW = GW;
  global.GH = GH;
})(typeof self !== 'undefined' ? self : this);
