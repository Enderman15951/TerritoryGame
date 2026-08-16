(function (global) {
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeValueNoise(seed) {
    const rnd = mulberry32(seed >>> 0);
    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const hash = (ix, iy) => perm[(perm[ix & 255] + (iy & 255)) & 255] / 255;
    const smooth = (t) => t * t * (3 - 2 * t);
    return function (x, y) {
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const v00 = hash(x0, y0);
      const v10 = hash(x0 + 1, y0);
      const v01 = hash(x0, y0 + 1);
      const v11 = hash(x0 + 1, y0 + 1);
      const sx = smooth(fx), sy = smooth(fy);
      const a = v00 + (v10 - v00) * sx;
      const b = v01 + (v11 - v01) * sx;
      return a + (b - a) * sy;
    };
  }

  function makeFBM(noise) {
    return function (x, y, octaves, lac, gain) {
      let amp = 1, freq = 1, sum = 0, norm = 0;
      for (let i = 0; i < octaves; i++) {
        sum += amp * noise(x * freq, y * freq);
        norm += amp;
        amp *= gain;
        freq *= lac;
      }
      return sum / norm;
    };
  }

  global.TerrainNoise = { mulberry32, makeValueNoise, makeFBM };
})(typeof self !== 'undefined' ? self : this);