(function (global) {
  const { mulberry32, makeValueNoise, makeFBM } = global.TerrainNoise;
  const T = { DEEP: 0, SHALLOW: 1, SAND: 2, GRASS: 3, FOREST: 4 };

  function makePoles(seed, gw, gh) {
    const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    const cand = [];
    const xf = [0.2, 0.5, 0.8];
    const yf = [0.28, 0.72];
    for (const fx of xf) for (const fy of yf) cand.push([fx, fy]);
    for (let i = cand.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = cand[i]; cand[i] = cand[j]; cand[j] = t;
    }
    const poles = [];
    const count = cand.length > 5 ? 5 : cand.length;
    for (let k = 0; k < count; k++) {
      const [fx, fy] = cand[k];
      const jitter = (s, amp) => s + (rnd() * 2 - 1) * amp;
      poles.push({
        x: jitter(fx * gw, gw * 0.06),
        y: jitter(fy * gh, gh * 0.07),
        r: 24 + rnd() * 8
      });
    }
    return poles;
  }

  function generateMap(seed, gw, gh, landFrac) {
    const noise = makeValueNoise(seed);
    const fbm = makeFBM(noise);
    const poles = makePoles(seed, gw, gh);
    const n = gw * gh;
    const heights = new Float32Array(n);
    const vals = [];
    const cx = (gw - 1) / 2, cy = (gh - 1) / 2;
    const maxD = Math.hypot(cx, cy);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let c = 0;
        for (const pole of poles) {
          const d = Math.hypot(x - pole.x, y - pole.y);
          const inf = d < pole.r ? 1 - d / pole.r : 0;
          if (inf > c) c = inf;
        }
        const detail = fbm(x / 11 + 3.1, y / 11 - 5.2, 4, 2, 0.5);
        let h = c + (detail - 0.5) * 0.35;
        const d = Math.hypot(x - cx, y - cy) / maxD;
        h -= Math.max(0, d - 0.6) * 2.0;
        h -= Math.max(0, d - 0.42) * Math.max(0, d - 0.42) * 2.0;
        const i = y * gw + x;
        heights[i] = h;
        vals.push(h);
      }
    }
    vals.sort((a, b) => a - b);
    const th = vals[Math.floor(vals.length * (1 - landFrac))];
    const grid = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const h = heights[i];
      grid[i] = h < th - 0.06 ? T.DEEP : h < th ? T.SHALLOW : h < th + 0.05 ? T.SAND : h < th + 0.2 ? T.GRASS : T.FOREST;
    }
    let land = 0;
    for (let i = 0; i < n; i++) if (grid[i] >= T.SAND) land++;
    return { grid, land, threshold: th };
  }

  global.Terrain = { generateMap, T };
})(typeof self !== 'undefined' ? self : this);