(function (global) {
  const Net = {
    peer: null,
    conn: null,
    role: null,
    code: null,
    hostConns: new Map(),
    hostHandlers: null,
    clientHandlers: null,
    connected: false
  };

  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function makeCode(n) {
    n = n || 5;
    let s = '';
    for (let i = 0; i < n; i++) s += CHARS[(Math.random() * CHARS.length) | 0];
    return s;
  }

  Net.makeCode = makeCode;

  Net.host = function (onReady, onFail) {
    let tries = 0;
    function attempt() {
      tries++;
      const c = makeCode();
      const id = 'tp2p-' + c;
      const peer = new Peer(id, { debug: 0 });
      let done = false;
      peer.on('open', () => {
        done = true;
        Net.role = 'host';
        Net.code = c;
        Net.peer = peer;
        peer.on('connection', (conn) => {
          conn.on('open', () => {
            Net.hostConns.set(conn.peer, conn);
            conn.on('data', (d) => { if (Net.hostHandlers) Net.hostHandlers.onData(conn, d); });
            conn.on('close', () => {
              Net.hostConns.delete(conn.peer);
              if (Net.hostHandlers) Net.hostHandlers.onClose(conn);
            });
            if (Net.hostHandlers) Net.hostHandlers.onConn(conn);
          });
        });
        onReady(c);
      });
      peer.on('error', (err) => {
        if (done) return;
        if (err.type === 'unavailable-id' && tries < 3) {
          try { peer.destroy(); } catch (e) {}
          attempt();
        } else {
          done = true;
          if (onFail) onFail(err);
        }
      });
    }
    attempt();
  };

  Net.join = function (code, onOpen, onFail) {
    const peer = new Peer({ debug: 0 });
    let done = false;
    peer.on('open', () => {
      const conn = peer.connect('tp2p-' + code.toUpperCase(), { reliable: true });
      Net.role = 'client';
      Net.code = code;
      Net.peer = peer;
      Net.conn = conn;
      conn.on('open', () => {
        Net.connected = true;
        conn.on('data', (d) => { if (Net.clientHandlers) Net.clientHandlers.onData(d); });
        conn.on('close', () => {
          Net.connected = false;
          if (Net.clientHandlers) Net.clientHandlers.onClose();
        });
        if (onOpen) onOpen(conn);
      });
      conn.on('error', (err) => {
        if (!done) { done = true; if (onFail) onFail(err); }
      });
    });
    peer.on('error', (err) => {
      if (!done) { done = true; if (onFail) onFail(err); }
    });
  };

  Net.send = function (msg) {
    if (Net.role === 'host') {
      for (const conn of Net.hostConns.values()) {
        if (conn.open) conn.send(msg);
      }
    } else if (Net.conn && Net.connected) {
      Net.conn.send(msg);
    }
  };

  Net.hostSend = function (conn, msg) {
    if (conn && conn.open) conn.send(msg);
  };

  Net.close = function () {
    if (Net.peer) try { Net.peer.destroy(); } catch (e) {}
    Net.peer = null;
    Net.conn = null;
    Net.role = null;
    Net.hostConns.clear();
    Net.connected = false;
  };

  global.Net = Net;
})(typeof self !== 'undefined' ? self : this);