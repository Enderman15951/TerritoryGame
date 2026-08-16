(function (global) {
  const GW = global.GW, GH = global.GH, CELLS = global.CELLS;
  const T = global.Terrain.T;
  const R = 6;
  const MAX_BORDER_CELLS = 8;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  const ARCHETYPES = [
    { name: 'Aggressive', aggression: 0.9, riskTolerance: 0.8, expansionBias: 0.7 },
    { name: 'Defensive', aggression: 0.2, riskTolerance: 0.15, expansionBias: 0.5 },
    { name: 'Expansionist', aggression: 0.4, riskTolerance: 0.4, expansionBias: 0.95 },
    { name: 'Balanced', aggression: 0.6, riskTolerance: 0.55, expansionBias: 0.7 }
  ];

  function makePersonality() {
    const a = ARCHETYPES[(Math.random() * ARCHETYPES.length) | 0];
    const j = () => 0.9 + Math.random() * 0.2;
    return {
      name: a.name,
      aggression: clamp(a.aggression * j(), 0.05, 1),
      riskTolerance: clamp(a.riskTolerance * j(), 0.05, 1),
      expansionBias: clamp(a.expansionBias * j(), 0.05, 1)
    };
  }

  function scanFrontier(game, p) {
    const owners = new Map();
    const cells = new Map();
    const neutrals = [];
    const seen = new Uint8Array(CELLS);
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < CELLS; i++) {
      if (game.owner[i] !== p.idx) continue;
      const x = i % GW, y = (i / GW) | 0;
      sx += x; sy += y; n++;
    }
    if (n === 0) return null;
    p.cx = (sx / n) | 0;
    p.cy = (sy / n) | 0;
    for (let i = 0; i < CELLS; i++) {
      if (game.owner[i] !== p.idx) continue;
      const x = i % GW, y = (i / GW) | 0;
      const near = [i - 1, i + 1, i - GW, i + GW];
      for (const j of near) {
        if (j < 0 || j >= CELLS) continue;
        const jx = j % GW;
        if (Math.abs(jx - x) > 1) continue;
        if (game.terrain[j] < T.SAND || game.owner[j] === p.idx) continue;
        if (seen[j]) continue;
        seen[j] = 1;
        const o = game.owner[j];
        if (o === -1) { neutrals.push(j); continue; }
        const q = game.players[o];
        if (!q || q.dead) { neutrals.push(j); continue; }
        owners.set(o, (owners.get(o) || 0) + 1);
        let arr = cells.get(o);
        if (!arr) { arr = []; cells.set(o, arr); }
        if (arr.length < MAX_BORDER_CELLS) arr.push(j);
      }
    }
    return { owners, cells, neutrals };
  }

  function neutralLandNear(game, idx) {
    const x = idx % GW, y = (idx / GW) | 0;
    let land = 0;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= GW || Y >= GH) continue;
        const j = Y * GW + X;
        if (game.terrain[j] >= T.SAND && game.owner[j] === -1) land++;
      }
    }
    return land;
  }

  function chooseExpansion(game, sc, p) {
    if (!sc.neutrals.length) return null;
    let best = null, bs = -Infinity;
    const tries = Math.min(24, sc.neutrals.length * 2);
    for (let k = 0; k < tries; k++) {
      const idx = sc.neutrals[(Math.random() * sc.neutrals.length) | 0];
      const land = neutralLandNear(game, idx);
      const x = idx % GW, y = (idx / GW) | 0;
      const d = 1 + Math.hypot(x - p.cx, y - p.cy) / 100;
      const s = (land / d) * p.bot.personality.expansionBias + Math.random() * 6;
      if (s > bs) { bs = s; best = idx; }
    }
    return best;
  }

  function chooseAttack(game, sc, p) {
    let best = null, bs = -Infinity;
    const myBal = p.balance, myPix = Math.max(1, p.pixels);
    const myDen = myBal / myPix;
    const aggr = p.bot.aggrNow;
    const risk = p.bot.personality.riskTolerance;
    for (const [o, borderLen] of sc.owners) {
      const q = game.players[o];
      if (!q || q.dead || q.pixels <= 0) continue;
      const enDen = q.balance / Math.max(1, q.pixels);
      const strengthRatio = (myDen + 1) / (enDen + 1);
      const landValue = Math.log1p(q.pixels);
      const access = Math.min(2 + borderLen, 4);
      let score = (landValue * access) / 10 * (0.6 + aggr * 0.8);
      if (strengthRatio > 1.3) score += 2;
      else if (strengthRatio > 1.05) score += 1;
      else if (strengthRatio < 0.8) score -= 4;
      else if (strengthRatio < 0.95) score -= 1.5;
      score -= (1 - risk) * 1.5;
      if (p.bot.targetPlayer === o) score += 3;
      if (score > bs) { bs = score; best = { o, borderLen, score, strengthRatio }; }
    }
    return best;
  }

  function commitPct(p, t) {
    const sr = t.strengthRatio;
    let pct;
    if (sr > 2.2) pct = 0.6 + Math.random() * 0.1;
    else if (sr > 1.5) pct = 0.45 + Math.random() * 0.1;
    else if (sr > 1.05) pct = 0.3 + Math.random() * 0.08;
    else if (sr > 0.8) pct = 0.18 + Math.random() * 0.07;
    else pct = 0.1 + Math.random() * 0.05;
    pct *= 0.7 + (p.bot.aggrNow || p.bot.personality.aggression) * 0.5;
    return clamp(pct, 0.05, 0.8);
  }

  function pickBorderCell(sc, o) {
    const arr = sc.cells.get(o);
    if (!arr || !arr.length) return -1;
    return arr[(Math.random() * arr.length) | 0];
  }

  function farUnownedLand(game, p) {
    let best = -1, bd = -1;
    for (let s = 0; s < 80; s++) {
      const idx = (Math.random() * CELLS) | 0;
      if (game.terrain[idx] < T.SAND || game.owner[idx] !== -1) continue;
      const x = idx % GW, y = (idx / GW) | 0;
      const d = Math.hypot(x - p.cx, y - p.cy);
      if (d > bd) { bd = d; best = idx; }
    }
    return best;
  }

  function updateBot(game, p, dt) {
    if (p.dead) return;
    if (!p.bot) {
      p.bot = {
        personality: makePersonality(),
        evalT: Math.random() * 0.8,
        goal: 'expand',
        goalT: 0,
        targetPlayer: -1
      };
    }
    const personality = p.bot.personality;
    p.bot.evalT -= dt;
    if (p.bot.evalT > 0) {
      if (p.attack && p.balance < 60) game.setPct(p, 0);
      return;
    }
    p.bot.evalT = 0.8 + Math.random() * 0.8;

    const alive = game.players.filter((q) => !q.dead).length;
    let aggression = personality.aggression;
    if (alive <= 4) aggression *= 1.15;
    if (alive <= 2) aggression *= 1.35;
    p.bot.aggrNow = aggression;

    const sc = scanFrontier(game, p);
    if (!sc) return;
    const myBal = p.balance, myPix = Math.max(1, p.pixels);
    const myDen = myBal / myPix;

    if (!(myBal > 60)) {
      if (p.attack) game.cancelAttack(p);
      p.bot.goal = 'defend';
      return;
    }

    let topThreat = 0;
    for (const [o, b] of sc.owners) {
      const q = game.players[o];
      if (!q || q.dead) continue;
      const enDen = q.balance / Math.max(1, q.pixels);
      const ratio = enDen / (myDen + 1) * Math.min(b, 2.5);
      if (ratio > topThreat) topThreat = ratio;
    }
    const danger = topThreat * (1 - personality.riskTolerance);

    const t = chooseAttack(game, sc, p);
    const enemyScore = t ? t.score : -Infinity;
    const expansionAvailable = sc.neutrals.length > 0;
    const neutralScore = Math.min(sc.neutrals.length / 6, 10) * personality.expansionBias + (expansionAvailable ? 1 : 0);

    if (danger > 1.6 && aggression < 0.5 && (!t || t.strengthRatio < 1)) {
      if (p.attack && p.bot.goal !== 'defend') game.cancelAttack(p);
      p.bot.goal = 'defend';
      p.bot.goalT = 2;
      return;
    }

    if (enemyScore > neutralScore && enemyScore > 1.5 && t.strengthRatio > 0.6) {
      const c = pickBorderCell(sc, t.o);
      if (c !== null && c >= 0) {
        p.bot.goal = 'attack';
        p.bot.targetPlayer = t.o;
        if (p.attack && p.attack.tgt === t.o) {
          game.setPct(p, commitPct(p, t));
          return;
        }
        p.cx = c % GW; p.cy = (c / GW) | 0;
        game.attackOrder(p, c, commitPct(p, t));
        return;
      }
    }

    if (expansionAvailable) {
      if (p.attack && p.attack.tgt === -2) {
        const pct = clamp(personality.expansionBias * (0.2 + Math.random() * 0.2), 0.15, 0.6);
        game.setPct(p, pct);
        p.bot.goal = 'expand';
        p.bot.targetPlayer = -1;
        return;
      }
      const c = chooseExpansion(game, sc, p);
      if (c !== null && c >= 0) {
        p.bot.goal = 'expand';
        p.bot.targetPlayer = -1;
        p.cx = c % GW; p.cy = (c / GW) | 0;
        const pct = clamp(personality.expansionBias * (0.2 + Math.random() * 0.2), 0.15, 0.6);
        game.attackOrder(p, c, pct);
        return;
      }
    }

    p.bot.goal = 'build';
    if (myBal > 3500 && p.ships.length === 0) {
      const idx = farUnownedLand(game, p);
      if (idx >= 0) {
        const x = (idx % GW) + 0.5, y = ((idx / GW) | 0) + 0.5;
        game.buildShip(p, x, y);
      }
    }
  }

  global.updateBot = updateBot;
})(typeof self !== 'undefined' ? self : this);