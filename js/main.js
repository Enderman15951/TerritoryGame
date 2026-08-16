(function () {
  const global = typeof self !== 'undefined' ? self : globalThis;
  const $ = (id) => document.getElementById(id);
  const PALETTE = ['#e63946', '#2a9d8f', '#f4a261', '#9b5de5', '#00b4d8', '#ffd166', '#f15bb5', '#90be6d', '#f77f00', '#577590', '#f94144', '#43aa8b'];
  const BOT_NAMES = ['Maru', 'Kai', 'Juno', 'Vex', 'Nova', 'Rex', 'Pika', 'Zane', 'Oto', 'Brie'];
  const STEP = 1 / 30;

  const screens = { menu: $('menu'), lobby: $('lobby'), hud: $('hud'), gameover: $('gameover') };

  const state = {
    screen: 'menu',
    role: null,
    host: false,
    offline: false,
    started: false,
    over: false,
    game: null,
    clientGame: null,
    clientPlayers: [],
    clientShips: [],
    renderer: null,
    myIdx: 0,
    myPeerId: null,
    myName: 'Captain',
    myColor: '#e63946',
    botCount: 4,
    myPct: 0.3,
    hoverIdx: -1,
    peerToIdx: new Map(),
    clientInfo: new Map(),
    simAcc: 0,
    last: performance.now(),
    lastState: 0,
    lastShips: 0,
    totalLand: 1,
    gameoverSent: false,
    results: null,
    drag: null
  };

  function screen(name) {
    for (const k in screens) screens[k].classList.toggle('hidden', k !== name);
    document.body.classList.toggle('in-game', name === 'hud');
    state.screen = name;
  }

  function fmt(n) {
    n = Math.floor(n);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return '' + n;
  }

  function countLand(grid) {
    let c = 0;
    for (let i = 0; i < global.CELLS; i++) if (grid[i] >= global.Terrain.T.SAND) c++;
    return c;
  }

  function logChat(logId, name, text) {
    const el = $(logId);
    if (!el) return;
    const div = document.createElement('span');
    div.className = name === 'sys' ? 'sys' : 'msg';
    if (name === 'sys') div.textContent = text;
    else {
      const b = document.createElement('b');
      b.textContent = name + ': ';
      div.appendChild(b);
      div.appendChild(document.createTextNode(text));
    }
    el.appendChild(div);
    while (el.children.length > 60) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  function logSys(text) {
    logChat('lobbyChatLog', 'sys', text);
    logChat('gameChatLog', 'sys', text);
  }

  function broadcastLobby() {
    let players;
    if (state.host && state.started && state.game) {
      players = state.game.players.map((p) => ({ name: p.name, color: p.color, i: p.idx }));
    } else {
      players = [{ name: state.myName, color: state.myColor, i: -1 }];
      for (const info of state.clientInfo.values()) players.push({ name: info.name, color: info.color, i: -1 });
    }
    Net.send({ type: 'lobby', players });
    renderLobby(players);
  }

  function renderLobby(players) {
    const ul = $('lobbyList');
    ul.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      const d = document.createElement('span');
      d.className = 'dot';
      d.style.background = p.color;
      li.appendChild(d);
      li.appendChild(document.createTextNode(p.name + (p.name === state.myName ? ' (you)' : '')));
      ul.appendChild(li);
    }
  }

  function showLobby(code) {
    screen('lobby');
    $('codeShow').textContent = code || (state.host ? state.roomCode : Net.code || '-');
    $('startBtn').style.display = state.host ? '' : 'none';
    $('leaveBtn').textContent = state.host ? 'Cancel' : 'Leave';
    $('status2').textContent = '';
    broadcastLobby();
  }

  function buildHello(you) {
    const g = state.game;
    return {
      type: 'hello',
      you: you,
      seed: g.settings.seed,
      settings: g.settings,
      totalLand: g.totalLand,
      players: g.players.map((p) => ({
        i: p.idx, name: p.name, color: p.color, isBot: p.isBot ? 1 : 0,
        balance: Math.floor(p.balance), pixels: p.pixels, dead: p.dead ? 1 : 0,
        sx: p.sx, sy: p.sy
      })),
      phase: g.phase,
      pickEnd: g.pickEnd,
      time: g.time,
      ships: g.ships.map((s) => ({ id: s.id, o: s.owner, x: s.x, y: s.y, tx: s.tx, ty: s.ty })),
      territoryRLE: g.rleGrid()
    };
  }

  function sendHelloToAll() {
    for (const conn of Net.hostConns.values()) {
      const idx = state.peerToIdx.get(conn.peer);
      if (idx === undefined) continue;
      Net.hostSend(conn, buildHello(idx));
    }
  }

  function onHostConn(conn) {}

  function onHostData(conn, d) {
    if (!d || typeof d !== 'object') return;
    const idx = state.peerToIdx.get(conn.peer);
    const pl = idx !== undefined && state.game && state.game.players[idx] ? state.game.players[idx] : null;
    if (d.type === 'join') {
      state.clientInfo.set(conn.peer, { name: d.name, color: d.color });
      if (state.started && state.game) {
        const p = state.game.addPlayer(conn.peer, d.name, d.color, false);
        state.peerToIdx.set(conn.peer, p.idx);
        Net.hostSend(conn, buildHello(p.idx));
        logSys(d.name + ' joined as a country');
        broadcastLobby();
      } else {
        logSys(d.name + ' joined');
        broadcastLobby();
      }
    } else if (pl) {
      if (d.type === 'attack') {
        if (state.game.phase !== 'pick') {
          state.game.setPct(pl, Math.min(1, Math.max(0, typeof d.v === 'number' ? d.v : pl.attackPct)));
          state.game.attackOrder(pl, d.i, pl.attackPct);
        }
      } else if (d.type === 'cancel') {
        state.game.cancelAttack(pl);
      } else if (d.type === 'pct') {
        state.game.setPct(pl, Math.min(1, Math.max(0, d.v)));
      } else if (d.type === 'boat') {
        state.game.shipTo(pl, d.x, d.y);
      } else if (d.type === 'spawn') {
        state.game.setSpawn(pl, d.x, d.y);
      } else if (d.type === 'claim') {
        state.game.claimPick(pl, d.i);
      } else if (d.type === 'chat') {
        routeChat(pl.name, d.text, conn);
      }
    } else if (d.type === 'chat') {
      routeChat(d.name || '?', d.text, conn);
    }
  }

  function routeChat(name, text, skipConn) {
    logChat('lobbyChatLog', name, text);
    logChat('gameChatLog', name, text);
    for (const c of Net.hostConns.values()) if (c !== skipConn) Net.hostSend(c, { type: 'chat', name, text });
  }

  function onHostClose(conn) {
    const idx = state.peerToIdx.get(conn.peer);
    state.peerToIdx.delete(conn.peer);
    state.clientInfo.delete(conn.peer);
    if (idx !== undefined && state.game && state.game.players[idx]) {
      const p = state.game.players[idx];
      logSys(p.name + ' left');
      if (state.started && !p.dead) {
        p.isBot = true;
        p.aiT = 0;
      }
    }
    broadcastLobby();
  }

  function sendState() {
    Net.send({
      type: 'state',
      phase: state.game.phase,
      pickEnd: state.game.pickEnd,
      time: state.game.time,
      players: state.game.players.map((p) => ({
        i: p.idx, balance: Math.floor(p.balance), pixels: p.pixels, dead: p.dead ? 1 : 0,
        sx: p.sx, sy: p.sy
      }))
    });
  }

  function sendShips() {
    Net.send({
      type: 'ships',
      ships: state.game.ships.map((s) => ({ id: s.id, o: s.owner, x: s.x, y: s.y, tx: s.tx, ty: s.ty }))
    });
  }

  function drainAndSend() {
    const g = state.game;
    if (!g) return;
    const cells = g.drainChanged();
    if (cells.length) Net.send({ type: 'cells', cells });
    for (const ev of g.drainEvents()) {
      if (ev.type === 'elim') {
        logSys(g.players[ev.p].name + ' has been eliminated!');
        Net.send({ type: 'elim', p: ev.p });
      } else if (ev.type === 'revive') {
        logSys(g.players[ev.p].name + ' survives from a ship!');
        Net.send({ type: 'revive', p: ev.p });
      } else if (ev.type === 'phase') {
        Net.send({ type: 'phase', v: ev.v });
      }
    }
    const now = performance.now();
    if (now - state.lastState > 250) { state.lastState = now; sendState(); }
    if (now - state.lastShips > 500) { state.lastShips = now; sendShips(); }
  }

  function handleGameOver() {
    const results = state.game.players.map((p) => ({
      name: p.name, color: p.color, i: p.idx,
      pixels: p.pixels, balance: p.balance, dead: p.dead,
      winner: p === state.game.winner
    }));
    results.sort((a, b) => (b.dead ? -1 : b.pixels) - (a.dead ? -1 : a.pixels));
    state.results = results;
    Net.send({ type: 'gameover', players: results.map((r) => ({ name: r.name, color: r.color, pixels: r.pixels, winner: r.winner })) });
    showGameOver(results, true);
  }

  function showGameOver(results, isHost) {
    state.over = true;
    screen('gameover');
    $('results').innerHTML = '';
    const winner = results.find((r) => r.winner);
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'rr' + (r.winner ? ' win' : '');
      const d = document.createElement('span');
      d.className = 'dot';
      d.style.background = r.color;
      const name = document.createElement('span');
      name.style.flex = '1';
      name.textContent = r.name + (r.winner ? '  WINNER' : (r.dead ? '  OUT' : ''));
      const pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = (r.dead ? '0%' : ((r.pixels / state.totalLand) * 100).toFixed(1) + '%');
      div.appendChild(d);
      div.appendChild(name);
      div.appendChild(pct);
      $('results').appendChild(div);
    }
    $('status3').textContent = isHost ? 'Host: press Play Again to start a new map.' : 'Waiting for host to start a new round...';
    $('restartBtn').style.display = isHost ? '' : 'none';
  }

  function startGame() {
    state.game = new global.Game({
      seed: (Math.random() * 0x7fffffff) | 0,
      landFrac: 0.42,
      bots: state.botCount
    });
    state.totalLand = state.game.totalLand;
    state.myIdx = state.game.addPlayer('host', state.myName, state.myColor, false).idx;
    state.started = true;
    state.over = false;
    state.gameoverSent = false;
    state.renderer.buildTerrain(state.game.terrain);
    for (let i = 0; i < state.botCount; i++) {
      state.game.addPlayer('bot' + i, BOT_NAMES[i % BOT_NAMES.length], PALETTE[(i + 2) % PALETTE.length], true);
    }
    for (const conn of Net.hostConns.values()) {
      const info = state.clientInfo.get(conn.peer);
      if (!info) continue;
      const p = state.game.addPlayer(conn.peer, info.name, info.color, false);
      state.peerToIdx.set(conn.peer, p.idx);
    }
    sendHelloToAll();
    broadcastLobby();
    screen('hud');
    logSys('Conquer the map — last country standing wins.');
  }

  function startOffline(bots) {
    if (state.host) return;
    state.host = true;
    state.offline = true;
    state.role = 'host';
    state.botCount = bots;
    state.myPeerId = 'offline';
    logSys('Offline mode: playing solo with bots (no internet for hosting).');
    startGame();
  }

  function hostGame() {
    state.myName = $('name').value.trim() || 'Captain';
    state.myColor = $('color').value;
    state.botCount = Math.max(0, Math.min(8, parseInt($('bots').value) || 0));
    state.clientInfo = new Map();
    state.peerToIdx = new Map();
    $('status2').textContent = 'Connecting to peer network...';
    if (typeof Peer === 'undefined') {
      $('status2').textContent = 'PeerJS unavailable — playing offline.';
      setTimeout(() => startOffline(state.botCount), 400);
      return;
    }
    let hosted = false;
    Net.hostHandlers = { onConn: onHostConn, onData: onHostData, onClose: onHostClose };
    Net.host((code) => {
      if (hosted) return;
      hosted = true;
      state.host = true;
      state.offline = false;
      state.role = 'host';
      state.roomCode = code;
      logSys('Room created — share the code above.');
      showLobby(code);
    }, (err) => {
      if (!hosted) {
        $('status2').textContent = 'Hosting unavailable (' + (err.type || 'error') + ') — playing offline.';
        setTimeout(() => startOffline(state.botCount), 400);
      }
    });
    setTimeout(() => {
      if (!hosted) {
        if (Net.role !== 'host') {
          $('status2').textContent = 'Connection timed out — playing offline.';
          startOffline(state.botCount);
        }
      }
    }, 6000);
  }

  function clientOnData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'hello') {
      state.clientGame = {
        terrain: global.Terrain.generateMap(d.seed, global.GW, global.GH, d.settings.landFrac).grid,
        owner: global.DecodeRLE(d.territoryRLE)
      };
      state.totalLand = d.totalLand || countLand(state.clientGame.terrain);
      state.myIdx = d.you;
      state.clientPhase = d.phase || 'play';
      state.clientPickEnd = d.pickEnd || 0;
      state.clientTime = d.time || 0;
      state.clientPlayers = d.players.map((q) => ({
        idx: q.i, name: q.name, color: q.color, isBot: q.isBot,
        balance: q.balance, pixels: q.pixels, dead: !!q.dead, sx: q.sx, sy: q.sy
      }));
      state.clientShips = d.ships || [];
      state.renderer.buildTerrain(state.clientGame.terrain);
      state.started = true;
      state.over = false;
      screen('hud');
      logSys('Conquer the map — last country standing wins.');
    } else if (d.type === 'cells') {
      if (state.clientGame) {
        const c = d.cells;
        for (let k = 0; k < c.length; k += 2) state.clientGame.owner[c[k]] = c[k + 1];
      }
    } else if (d.type === 'state') {
      state.clientPhase = d.phase || state.clientPhase;
      state.clientPickEnd = d.pickEnd || state.clientPickEnd;
      state.clientTime = d.time || state.clientTime;
      for (const q of d.players) {
        const cp = state.clientPlayers[q.i];
        if (cp) {
          cp.balance = q.balance; cp.pixels = q.pixels; cp.dead = !!q.dead;
          cp.sx = q.sx; cp.sy = q.sy;
        }
      }
    } else if (d.type === 'phase') {
      state.clientPhase = d.v || 'play';
    } else if (d.type === 'ships') {
      state.clientShips = d.ships || [];
    } else if (d.type === 'elim') {
      const cp = state.clientPlayers[d.p];
      logSys((cp ? cp.name : 'A country') + ' has been eliminated!');
    } else if (d.type === 'revive') {
      const cp = state.clientPlayers[d.p];
      logSys((cp ? cp.name : 'A country') + ' survives from a ship!');
    } else if (d.type === 'lobby') {
      renderLobby(d.players);
    } else if (d.type === 'chat') {
      logChat('lobbyChatLog', d.name, d.text);
      logChat('gameChatLog', d.name, d.text);
    } else if (d.type === 'gameover') {
      const results = d.players.map((r) => ({
        name: r.name, color: r.color, pixels: r.pixels, winner: r.winner, dead: false,
        balance: 0, i: 0
      }));
      showGameOver(results, false);
    }
  }

  function clientOnClose() {
    if (state.screen !== 'menu') {
      logSys('Disconnected from host.');
      backToMenu();
    }
  }

  function backToMenu() {
    Net.close();
    state.mouse = null;
    state.host = false;
    state.offline = false;
    state.started = false;
    state.over = false;
    state.game = null;
    state.clientGame = null;
    state.clientPlayers = [];
    state.clientShips = [];
    state.role = null;
    state.gameoverSent = false;
    $('status2').textContent = '';
    screen('menu');
  }

  function setupClientNet(code) {
    state.myName = $('name').value.trim() || 'Player';
    state.myColor = $('color').value;
    Net.clientHandlers = { onData: clientOnData, onClose: clientOnClose };
    $('status2').textContent = 'Connecting to ' + code + '...';
    Net.join(code, () => {
      Net.send({ type: 'join', name: state.myName, color: state.myColor });
      $('status2').textContent = '';
    }, (err) => {
      $('status2').textContent = 'Could not connect: ' + (err.type || 'error');
      Net.close();
    });
  }

  function buildView() {
    if (state.host) {
      if (!state.game) return null;
      return {
        terrain: state.game.terrain,
        territory: state.game.owner,
        phase: state.game.phase,
        pickEnd: state.game.pickEnd,
        time: state.game.time,
        ships: state.game.ships.map((s) => ({ id: s.id, o: s.owner, x: s.x, y: s.y, tx: s.tx, ty: s.ty, dead: false })),
        players: state.game.players.map((p) => ({
          idx: p.idx, name: p.name, color: p.color, isBot: p.isBot,
          balance: p.balance, pixels: p.pixels, dead: p.dead, sx: p.sx, sy: p.sy
        })),
        attacks: state.game.players.filter((p) => !p.dead && p.attack).map((p) => ({
          x: p.attack.tx, y: p.attack.ty, r: p.attack.r, color: p.color
        }))
      };
    }
    if (!state.clientGame) return null;
    return {
      terrain: state.clientGame.terrain,
      territory: state.clientGame.owner,
      phase: state.clientPhase,
      pickEnd: state.clientPickEnd,
      time: state.clientTime,
      ships: state.clientShips,
      players: state.clientPlayers.map((cp) => {
        if (cp.idx === state.myIdx && state.clientPhase === 'pick' && state.mouseCell) {
          return {
            idx: cp.idx, name: cp.name, color: cp.color, isBot: cp.isBot,
            balance: cp.balance, pixels: cp.pixels, dead: cp.dead, sx: state.mouseCell.x, sy: state.mouseCell.y
          };
        }
        return {
          idx: cp.idx, name: cp.name, color: cp.color, isBot: cp.isBot,
          balance: cp.balance, pixels: cp.pixels, dead: cp.dead, sx: cp.sx, sy: cp.sy
        };
      })
    };
  }

  function updateHUD(view) {
    if (state.screen !== 'hud') return;
    const inPick = view.phase === 'pick';
    const owned = view.players.reduce((s, p) => s + p.pixels, 0);
    const pct = (owned / state.totalLand) * 100;
    const remain = Math.max(0, Math.ceil(view.pickEnd - view.time));
    $('timer').textContent = inPick ? (remain + 's TO START') : (pct.toFixed(0) + '% OF MAP');
    const me = view.players.find((p) => p.idx === state.myIdx);
    $('mode').textContent = inPick ? 'CLICK LAND TO CLAIM YOUR SPAWN' : (me ? 'BAL ' + fmt(me.balance) + '  LAND ' + me.pixels : '');
    $('attackBar').classList.toggle('hidden', inPick);
    $('atkVal').textContent = Math.round(state.myPct * 100) + '%';
    const sorted = view.players.slice().sort((a, b) => (b.dead ? -1 : b.pixels) - (a.dead ? -1 : a.pixels));
    $('score').innerHTML = '';
    for (const p of sorted) {
      const div = document.createElement('div');
      div.className = 'sr' + (p.idx === state.myIdx ? ' me' : '') + (p.dead ? ' dead' : '');
      const d = document.createElement('span');
      d.className = 'dot';
      d.style.background = p.color;
      const name = document.createElement('span');
      name.style.width = '70px';
      name.textContent = p.name + (p.dead ? ' OUT' : '');
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.className = 'bfill';
      fill.style.width = (state.totalLand ? (p.pixels / state.totalLand) * 100 : 0).toFixed(1) + '%';
      fill.style.background = p.color;
      bar.appendChild(fill);
      const bal = document.createElement('span');
      bal.className = 'bal';
      bal.textContent = p.dead ? '' : fmt(p.balance);
      const pctEl = document.createElement('span');
      pctEl.className = 'pct';
      pctEl.textContent = (state.totalLand ? (p.pixels / state.totalLand) * 100 : 0).toFixed(1) + '%';
      div.appendChild(d);
      div.appendChild(name);
      div.appendChild(bar);
      div.appendChild(bal);
      div.appendChild(pctEl);
      $('score').appendChild(div);
    }
  }

  function updateHover() {
    if (!state.renderer || !state.mouse) return;
    const w = state.renderer.toWorld(state.mouse.x, state.mouse.y);
    const cx = Math.floor(w.x / 6), cy = Math.floor(w.y / 6);
    state.mouseCell = { x: cx, y: cy };
    if (cx < 0 || cy < 0 || cx >= global.GW || cy >= global.GH) { state.hoverIdx = -1; return; }
    const idx = cy * global.GW + cx;
    const view = buildView();
    if (view && view.territory[idx] !== state.myIdx && view.territory[idx] >= 0) state.hoverIdx = idx;
    else state.hoverIdx = -1;
  }

function onMapClick(btn) {
      if (state.screen !== 'hud' || !state.started || !state.renderer || !state.mouse) return;
      const w = state.renderer.toWorld(state.mouse.x, state.mouse.y);
      const cx = Math.floor(w.x / 6), cy = Math.floor(w.y / 6);
      if (cx < 0 || cy < 0 || cx >= global.GW || cy >= global.GH) return;
      const idx = cy * global.GW + cx;
      const view = buildView();
      if (!view) return;
      if (view.phase === 'pick') {
        if (state.host) {
          state.game.claimPick(state.game.players[state.myIdx], idx);
        } else if (Net.connected) {
          Net.send({ type: 'claim', i: idx });
        }
        return;
      }
      const onWater = view.terrain[idx] < global.Terrain.T.SAND;
      if (onWater) {
        if (state.host) {
          const p = state.game.players[state.myIdx];
          state.game.shipTo(p, cx + 0.5, cy + 0.5);
        } else if (Net.connected) {
          Net.send({ type: 'boat', x: cx + 0.5, y: cy + 0.5 });
        }
        return;
      }
      const owner = view.territory[idx];
      if (owner === state.myIdx) {
        if (state.host) state.game.cancelAttack(state.game.players[state.myIdx]);
        else if (Net.connected) Net.send({ type: 'cancel' });
        return;
      }
      if (owner === -1) return;
      if (state.host) {
        const p = state.game.players[state.myIdx];
        state.game.attackOrder(p, idx, state.myPct);
      } else if (Net.connected) {
        Net.send({ type: 'attack', i: idx, v: state.myPct });
      }
    }

    function ctxAction() {
      if (state.screen !== 'hud' || !state.started || !state.renderer || !state.mouse) return;
      const w = state.renderer.toWorld(state.mouse.x, state.mouse.y);
      const cx = Math.floor(w.x / 6), cy = Math.floor(w.y / 6);
      if (cx < 0 || cy < 0 || cx >= global.GW || cy >= global.GH) return;
      const idx = cy * global.GW + cx;
      const view = buildView();
      if (!view) return;
      if (view.phase === 'pick') {
        if (state.host) state.game.claimPick(state.game.players[state.myIdx], idx);
        else if (Net.connected) Net.send({ type: 'claim', i: idx });
        return;
      }
      const t = Math.floor(view.terrain[idx]);
      const o = Math.floor(view.territory[idx]);
      if (t < global.Terrain.T.SAND) {
        if (state.host) state.game.shipTo(state.game.players[state.myIdx], cx + 0.5, cy + 0.5);
        else if (Net.connected) Net.send({ type: 'boat', x: cx + 0.5, y: cy + 0.5 });
        return;
      }
      if (o === state.myIdx) {
        if (state.host) state.game.cancelAttack(state.game.players[state.myIdx]);
        else if (Net.connected) Net.send({ type: 'cancel' });
        return;
      }
      if (o >= 0 || o === -1) {
        if (state.host) state.game.attackOrder(state.game.players[state.myIdx], idx, state.myPct);
        else if (Net.connected) Net.send({ type: 'attack', i: idx, v: state.myPct });
      }
    }

    function openCtxMenu(sx, sy) {
      const menu = $('ctxMenu');
      const lbl = $('ctxAttack');
      const view = buildView();
      let title = '', label = 'Attack';
      if (state.screen === 'hud' && view && state.mouse) {
        const w = state.renderer.toWorld(state.mouse.x, state.mouse.y);
        const cx = Math.floor(w.x / 6), cy = Math.floor(w.y / 6);
        if (cx >= 0 && cy >= 0 && cx < global.GW && cy < global.GH) {
          const idx = cy * global.GW + cx;
          const t = Math.floor(view.terrain[idx]);
          const o = Math.floor(view.territory[idx]);
          if (view.phase === 'pick') {
            title = t >= global.Terrain.T.SAND ? 'Claim spawn' : 'Water';
            label = t >= global.Terrain.T.SAND ? 'Claim' : 'Ship';
          } else if (t < global.Terrain.T.SAND) {
            title = 'Water';
            label = 'Send Ship';
          } else if (o === state.myIdx) {
            title = 'Your territory';
            label = 'Stop Attack';
          } else if (o >= 0) {
            const p = view.players.find((q) => q.idx === o);
            title = (p ? p.name : 'Enemy') + ' territory';
            label = 'Attack ' + (p ? p.name : '');
          } else {
            title = 'Unowned land';
            label = 'Attack Land';
          }
        }
      }
      menu.title = '';
      const t = document.createElement('div');
      t.className = 'ctxTitle';
      t.textContent = title;
      menu.innerHTML = '';
      menu.appendChild(t);
      lbl.textContent = label;
      menu.appendChild(lbl);
      const pad = 8;
      menu.style.left = Math.min(sx, window.innerWidth - 170) + 'px';
      menu.style.top = Math.min(sy, window.innerHeight - 90) + 'px';
      menu.classList.remove('hidden');
    }

    function closeCtxMenu() {
      const menu = $('ctxMenu');
      if (menu) menu.classList.add('hidden');
    }

  function frame(now) {
    requestAnimationFrame(frame);
    if (state.host && state.started && state.game) {
      if (state.game.phase === 'pick' && state.mouseCell) {
        state.game.setSpawn(state.game.players[state.myIdx], state.mouseCell.x, state.mouseCell.y);
      }
      state.simAcc += Math.min(0.05, (now - state.last) / 1000);
      state.last = now;
      let stepped = false;
      let guard = 0;
      while (state.simAcc >= STEP && guard < 4) {
        state.simAcc -= STEP;
        state.game.tick(STEP);
        stepped = true;
        guard++;
      }
      if (stepped) {
        drainAndSend();
        if (state.game.over && !state.gameoverSent) {
          state.gameoverSent = true;
          handleGameOver();
        }
      }
    } else {
      if (!state.host && state.started && state.clientPhase === 'pick' && state.mouseCell) {
        const n = performance.now();
        if (!state.lastSpawn || n - state.lastSpawn > 120) {
          state.lastSpawn = n;
          Net.send({ type: 'spawn', x: state.mouseCell.x, y: state.mouseCell.y });
        }
      }
      state.last = now;
    }
    const view = buildView();
    if (view && state.renderer) {
      state.renderer.draw(view, state.myIdx, state.hoverIdx);
      state.renderer.drawMinimap(view);
      updateHUD(view);
    }
    updateHover();
  }

  function init() {
    const canvas = $('game');
    const mini = $('mini');
    mini.width = global.GW;
    mini.height = global.GH;
    state.renderer = new global.Renderer(canvas, mini);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      state.renderer.cam.zoom = -1;
    }
    resize();
    window.addEventListener('resize', resize);

    $('hostBtn').addEventListener('click', () => {
      screen('lobby');
      setTimeout(() => { screens.menu.classList.add('hidden'); }, 0);
      hostGame();
    });

    $('joinBtn').addEventListener('click', () => {
      $('joinBox').classList.toggle('hidden');
    });

    $('joinGo').addEventListener('click', () => {
      const code = $('code').value.toUpperCase().trim();
      if (code.length < 4) { $('status').textContent = 'Enter the room code (5 letters/numbers).'; return; }
      if (typeof Peer === 'undefined') { $('status').textContent = 'PeerJS unavailable offline — only hosting with bots works.'; return; }
      screen('lobby');
      setTimeout(() => { screens.menu.classList.add('hidden'); }, 0);
      setupClientNet(code);
    });

    $('startBtn').addEventListener('click', () => {
      if (state.host) startGame();
    });

    $('leaveBtn').addEventListener('click', () => {
      backToMenu();
    });

    $('chatSend').addEventListener('click', sendLobbyChat);
    $('chatText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendLobbyChat();
      e.stopPropagation();
    });

    $('gameChatSend').addEventListener('click', sendGameChat);
    $('gameChatText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendGameChat();
      e.stopPropagation();
    });

    function sendLobbyChat() {
      const v = $('chatText').value.trim();
      if (!v) return;
      sendChat(v);
      $('chatText').value = '';
    }
    function sendGameChat() {
      const v = $('gameChatText').value.trim();
      if (!v) return;
      sendChat(v);
      $('gameChatText').value = '';
    }
    function sendChat(text) {
      const name = state.myName;
      if (state.host) {
        logChat('lobbyChatLog', name, text);
        logChat('gameChatLog', name, text);
        Net.send({ type: 'chat', name, text });
      } else if (Net.connected) {
        Net.send({ type: 'chat', name, text });
      } else {
        logChat(state.screen === 'hud' ? 'gameChatLog' : 'lobbyChatLog', name, text);
      }
    }

    $('restartBtn').addEventListener('click', () => {
      if (state.host) startGame();
    });
    $('backBtn').addEventListener('click', () => {
      backToMenu();
      screen('menu');
      $('status').textContent = '';
    });

    $('atkSlider').addEventListener('input', (e) => {
      state.myPct = (parseInt(e.target.value) || 0) / 100;
      if (state.host && state.started && state.game) {
        state.game.setPct(state.game.players[state.myIdx], state.myPct);
      } else if (Net.connected) {
        Net.send({ type: 'pct', v: state.myPct });
      }
      $('atkVal').textContent = Math.round(state.myPct * 100) + '%';
    });

    $('cancelAtk').addEventListener('click', () => {
      if (state.host && state.started && state.game) {
        state.game.cancelAttack(state.game.players[state.myIdx]);
      } else if (Net.connected) {
        Net.send({ type: 'cancel' });
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') {
        if (e.key === 'Enter') e.target.blur();
        return;
      }
      if (e.key === 'Enter' && state.screen === 'hud') {
        const gc = $('gameChat');
        gc.classList.toggle('open');
        if (gc.classList.contains('open')) $('gameChatText').focus();
      }
      if (e.key === 'Escape' && state.screen === 'hud') {
        state.drag = null;
      }
    });

    function canvasPos(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
    }

    canvas.addEventListener('mousemove', (e) => {
      const p = canvasPos(e);
      state.mouse = p;
      if (state.drag) {
        state.renderer.panBy(e.movementX * (canvas.width / canvas.getBoundingClientRect().width), e.movementY * (canvas.height / canvas.getBoundingClientRect().height));
      }
    });

    canvas.addEventListener('mousedown', (e) => {
      const p = canvasPos(e);
      state.mouse = p;
      if (e.button === 0) {
        if (state.screen === 'hud') $('gameChat').classList.remove('open');
        closeCtxMenu();
        onMapClick(0);
      } else if (e.button === 1) {
        state.drag = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    });

    canvas.addEventListener('mouseup', (e) => {
      if (e.button === 1) state.drag = null;
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = canvasPos(e);
      state.mouse = p;
      closeCtxMenu();
      openCtxMenu(e.clientX, e.clientY);
    });

    $('ctxAttack').addEventListener('click', () => {
      const p = state.mouse;
      closeCtxMenu();
      if (!p) return;
      ctxAction();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = canvasPos(e);
      state.mouse = p;
      state.renderer.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    window.addEventListener('blur', () => {
      state.drag = null;
    });

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();