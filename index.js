'use strict';
require('dotenv').config();

const mineflayer = require('mineflayer');
const readline = require('node:readline');

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const config = {
  host: process.env.MC_HOST || '15.235.165.12',
  port: number(process.env.MC_PORT, 15025),
  username: process.env.MC_USERNAME || 'Zenith',
  password: process.env.MC_PASSWORD || '',

  versions: (
    process.env.MC_VERSIONS ||
    '1.21.8,1.21.4,1.20.4'
  ).split(',').map(v => v.trim()).filter(Boolean),

  radius: Math.max(
    2,
    number(process.env.MOVE_RADIUS, 5)
  ),

  reconnectSeconds: Math.max(
    5,
    number(process.env.RECONNECT_SECONDS, 15)
  ),

  loginTimeoutSeconds: Math.max(
    60,
    number(process.env.LOGIN_WATCHDOG_SECONDS, 180)
  ),

  movementDelaySeconds: Math.max(
    0,
    number(process.env.MOVE_START_DELAY, 8)
  ),

  movement: process.env.MOVEMENT !== 'false',
  physics: process.env.PHYSICS !== 'false',
  jump: process.env.AUTO_JUMP !== 'false',
  debug: process.env.DEBUG_LOGIN !== 'false'
};

const log = (tag, message) => {
  console.log(
    `[${new Date().toISOString()}] [${tag}] ${message}`
  );
};

const formatPos = p => p
  ? `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`
  : 'unknown';

const horizontal = (a, b) =>
  Math.hypot(a.x - b.x, a.z - b.z);

const unsafe = new Set([
  'lava',
  'fire',
  'soul_fire',
  'cactus',
  'magma_block',
  'campfire',
  'soul_campfire',
  'sweet_berry_bush',
  'powder_snow',
  'wither_rose',
  'pointed_dripstone',
  'water'
]);

let bot = null;
let session = null;
let reconnectTimer = null;
let reconnectCount = 0;
let versionIndex = 0;
let stopping = false;
let movementEnabled = config.movement;

// ======================================
// PLAYER CONTROLS
// ======================================

function release(b) {
  if (!b) return;

  for (const key of [
    'forward',
    'back',
    'left',
    'right',
    'jump',
    'sprint',
    'sneak'
  ]) {
    try {
      b.setControlState(key, false);
    } catch (_) {}
  }
}

// ======================================
// TERRAIN SAFETY
// ======================================

function safeAhead(b, p, ux, uz) {
  try {
    for (const step of [0.65, 1.1, 1.6]) {
      const at = p.offset(
        ux * step,
        0,
        uz * step
      );

      const feet = b.blockAt(at);
      const head = b.blockAt(
        at.offset(0, 1, 0)
      );

      const floor = b.blockAt(
        at.offset(0, -1, 0)
      );

      const below = b.blockAt(
        at.offset(0, -2, 0)
      );

      if (
        !feet ||
        !head ||
        !floor ||
        !below
      ) {
        return false;
      }

      if (
        [feet, head, floor, below]
          .some(block => unsafe.has(block.name))
      ) {
        return false;
      }

      if (
        floor.boundingBox !== 'block' &&
        below.boundingBox !== 'block'
      ) {
        return false;
      }
    }

    return true;

  } catch (_) {
    return false;
  }
}

// ======================================
// RECONNECTION
// ======================================

function reconnect(reason = '') {
  if (stopping || reconnectTimer) return;

  reconnectCount++;

  let seconds = Math.min(
    120,
    config.reconnectSeconds *
    Math.pow(
      1.5,
      Math.min(7, reconnectCount - 1)
    )
  );

  if (
    /already (online|connected)|logged in from another/i
      .test(reason)
  ) {
    seconds = Math.max(seconds, 30);
  }

  if (/banned/i.test(reason)) {
    seconds = Math.max(seconds, 600);
  }

  log(
    'RECONNECT',
    `Attempt ${reconnectCount} in ${Math.ceil(seconds)} seconds`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start();
  }, seconds * 1000);
}

// ======================================
// MAIN CONNECTION
// ======================================

function start() {
  if (stopping || bot) return;

  const version =
    config.versions[
      versionIndex % config.versions.length
    ];

  const s = {
    version,
    ended: false,
    spawned: false,
    authenticated: !config.password,

    authAttempts: 0,
    authLast: 0,

    home: null,
    goal: null,

    pauseUntil: 0,
    goalUntil: 0,
    movementAfter: Infinity,

    lastPos: null,
    lastProgress: Date.now(),

    blocked: 0,
    dead: false,
    lastKick: '',

    timers: new Set(),
    intervals: new Set()
  };

  session = s;

  const later = (fn, delay) => {
    const timer = setTimeout(() => {
      s.timers.delete(timer);

      if (active()) {
        fn();
      }
    }, delay);

    s.timers.add(timer);
    return timer;
  };

  const every = (fn, delay) => {
    const timer = setInterval(() => {
      if (active()) {
        fn();
      }
    }, delay);

    s.intervals.add(timer);
  };

  const active = () =>
    !stopping &&
    !s.ended &&
    session === s &&
    bot === b;

  const cleanup = () => {
    s.ended = true;

    for (const timer of s.timers) {
      clearTimeout(timer);
    }

    for (const timer of s.intervals) {
      clearInterval(timer);
    }

    s.timers.clear();
    s.intervals.clear();

    release(b);
  };

  let b;

  log(
    'CONNECT',
    `${config.username} -> ${config.host}:${config.port} using ${version}`
  );

  try {
    b = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      version,

      auth: 'offline',
      hideErrors: false,
      respawn: true,

      checkTimeoutInterval: 60000,
      viewDistance: 'tiny'
    });

  } catch (error) {
    session = null;

    log(
      'ERROR',
      error.stack || error.message
    );

    if (
      /unsupported|version/i.test(
        String(error.message)
      )
    ) {
      versionIndex++;
    }

    reconnect(error.message);
    return;
  }

  bot = b;

  // ====================================
  // PHYSICS DIAGNOSTICS
  // ====================================

  if (!config.physics) {
    b.physicsEnabled = false;

    log(
      'PHYSICS',
      'Disabled for packet-isolation test'
    );
  }

  if (b._client && config.debug) {
    b._client.on('state', (now, old) => {
      log(
        'STATE',
        `${old} -> ${now}`
      );
    });

    b._client.on('packet', (_data, meta) => {
      if (meta?.name === 'show_dialog') {
        log(
          'DIALOG',
          `Received during ${meta.state}; manual response intentionally disabled`
        );
      }
    });
  }

  // ====================================
  // RESOURCE PACK
  // ====================================

  b.on('resourcePack', () => {
    log(
      'PACK',
      'Resource pack requested'
    );

    try {
      b.acceptResourcePack();

    } catch (error) {
      log(
        'PACK',
        error.message
      );
    }
  });

  // ====================================
  // NLOGIN AUTHENTICATION
  // ====================================

  function markAuthenticated(reason) {
    if (s.authenticated) return;

    s.authenticated = true;

    s.movementAfter =
      Date.now() +
      config.movementDelaySeconds * 1000;

    s.home = null;
    s.goal = null;

    log(
      'AUTH',
      `Confirmed: ${reason}`
    );
  }

  function sendLogin() {
    if (
      !active() ||
      s.authenticated ||
      !config.password ||
      !s.spawned
    ) {
      return;
    }

    if (
      s.authAttempts >= 4 ||
      Date.now() - s.authLast < 7000
    ) {
      return;
    }

    s.authLast = Date.now();
    s.authAttempts++;

    try {
      b.chat(
        `/login ${config.password}`
      );

      log(
        'AUTH',
        `/login sent (attempt ${s.authAttempts})`
      );

    } catch (error) {
      log(
        'AUTH',
        `Command failed: ${error.message}`
      );
    }
  }

  // ====================================
  // MOVEMENT CENTER
  // ====================================

  function setHome() {
    if (!b.entity) return;

    s.home = b.entity.position.clone();

    s.goal = null;
    s.lastPos = null;
    s.lastProgress = Date.now();

    log(
      'HOME',
      `${formatPos(s.home)} radius=${config.radius}`
    );
  }

  function stopWalk() {
    release(b);
    s.goal = null;
  }

  function chooseGoal() {
    const p = b.entity.position;

    if (
      horizontal(p, s.home) >
      config.radius - 0.7
    ) {
      s.goal = {
        x: s.home.x,
        z: s.home.z
      };

    } else {
      const angle =
        Math.random() *
        2 *
        Math.PI;

      const r =
        Math.sqrt(Math.random()) *
        config.radius *
        0.7;

      s.goal = {
        x: s.home.x + Math.cos(angle) * r,
        z: s.home.z + Math.sin(angle) * r
      };
    }

    s.goalUntil =
      Date.now() + 8000;
  }

  // ====================================
  // AUTOMATIC MOVEMENT
  // ====================================

  function moveTick() {
    if (
      !active() ||
      !s.spawned ||
      !s.authenticated ||
      s.dead ||
      !movementEnabled ||
      !config.physics ||
      !b.entity
    ) {
      release(b);
      return;
    }

    const now = Date.now();

    if (
      now < s.movementAfter ||
      now < s.pauseUntil
    ) {
      release(b);
      return;
    }

    const p = b.entity.position;

    if (!s.home) {
      setHome();
    }

    if (!s.home) return;

    if (
      horizontal(p, s.home) >
      config.radius * 3
    ) {
      log(
        'MOVE',
        'Large displacement detected; resetting center'
      );

      setHome();
    }

    if (!b.entity.onGround) {
      b.setControlState(
        'jump',
        false
      );

      return;
    }

    if (!s.goal) {
      if (Math.random() < 0.18) {
        s.pauseUntil =
          now +
          1200 +
          Math.random() * 2500;

        release(b);
        return;
      }

      chooseGoal();
    }

    const dx =
      s.goal.x - p.x;

    const dz =
      s.goal.z - p.z;

    const distance =
      Math.hypot(dx, dz);

    if (
      distance < 0.65 ||
      now > s.goalUntil
    ) {
      stopWalk();

      s.pauseUntil =
        now +
        600 +
        Math.random() * 1800;

      return;
    }

    const ux = dx / distance;
    const uz = dz / distance;

    const next = {
      x: p.x + ux * 0.4,
      z: p.z + uz * 0.4
    };

    if (
      horizontal(next, s.home) >
        config.radius ||
      !safeAhead(b, p, ux, uz)
    ) {
      s.blocked++;

      stopWalk();

      s.pauseUntil =
        now +
        500 +
        Math.random() * 900;

      return;
    }

    const yaw =
      Math.atan2(-dx, -dz);

    try {
      Promise.resolve(
        b.look(yaw, 0, true)
      ).catch(() => {});

    } catch (_) {}

    b.setControlState(
      'forward',
      true
    );

    b.setControlState(
      'sprint',
      false
    );

    // Jump when horizontally blocked.

    if (
      config.jump &&
      b.entity.isCollidedHorizontally &&
      b.entity.onGround
    ) {
      b.setControlState(
        'jump',
        true
      );

      later(() => {
        b.setControlState(
          'jump',
          false
        );
      }, 200);
    }

    // Detect stuck movement.

    if (
      !s.lastPos ||
      horizontal(p, s.lastPos) > 0.18
    ) {
      s.lastPos = p.clone();
      s.lastProgress = now;

    } else if (
      now - s.lastProgress > 3500
    ) {
      log(
        'MOVE',
        'Stuck; selecting another direction'
      );

      stopWalk();

      s.lastProgress = now;
      s.pauseUntil = now + 1200;
    }
  }

  // ====================================
  // LOGIN EVENT
  // ====================================

  b.on('login', () => {
    if (!active()) return;

    log(
      'NETWORK',
      'Minecraft login event'
    );
  });

  // ====================================
  // SPAWN EVENT
  // ====================================

  b.on('spawn', () => {
    if (!active()) return;

    s.spawned = true;
    s.dead = false;

    s.home = null;
    s.goal = null;

    release(b);

    log(
      'SPAWN',
      `Position ${formatPos(b.entity?.position)}`
    );

    if (!s.authenticated) {
      later(sendLogin, 600);

    } else {
      s.movementAfter =
        Date.now() +
        config.movementDelaySeconds * 1000;
    }

    if (!s.intervals.size) {
      every(moveTick, 200);

      every(() => {
        if (!b.entity) return;

        log(
          'STATUS',
          `auth=${s.authenticated} ` +
          `physics=${b.physicsEnabled} ` +
          `movement=${movementEnabled} ` +
          `pos=${formatPos(b.entity.position)}`
        );

      }, 30000);
    }

    later(() => {
      if (
        s.spawned &&
        s.authenticated
      ) {
        reconnectCount = 0;
      }
    }, 60000);
  });

  // ====================================
  // CHAT / NLOGIN RESPONSE
  // ====================================

  b.on('messagestr', message => {
    if (!active()) return;

    const text = String(message || '');

    if (
      config.password &&
      text.includes(config.password)
    ) {
      return;
    }

    if (
      /successfully logged in|successfully logged|logged in successfully|login successful|already logged in|welcome back/i
        .test(text)
    ) {
      markAuthenticated(
        'server message'
      );

    } else if (
      /wrong password|incorrect password|invalid password/i
        .test(text)
    ) {
      log(
        'AUTH',
        'Incorrect password reported; stopping retries'
      );

      s.authAttempts = 4;

    } else if (
      !s.authenticated &&
      /\/login|please log.?in|seconds to log.?in/i
        .test(text)
    ) {
      sendLogin();
    }

    if (config.debug) {
      log(
        'CHAT',
        text.slice(0, 250)
      );
    }
  });

  // ====================================
  // DEATH / RESPAWN
  // ====================================

  b.on('death', () => {
    if (!active()) return;

    s.dead = true;

    stopWalk();

    log(
      'DEATH',
      'Waiting for Mineflayer auto-respawn'
    );
  });

  // ====================================
  // KICK DIAGNOSTICS
  // ====================================

  b.on('kicked', reason => {
    s.lastKick =
      typeof reason === 'string'
        ? reason
        : JSON.stringify(reason);

    if (active()) {
      log(
        'KICK',
        s.lastKick
      );
    }
  });

  b.on('error', error => {
    if (active()) {
      log(
        'ERROR',
        error.stack || error.message
      );
    }
  });

  // ====================================
  // DISCONNECT
  // ====================================

  b.on('end', reason => {
    if (bot !== b) return;

    cleanup();

    bot = null;
    session = null;

    log(
      'END',
      String(reason)
    );

    if (
      /invalid.player.movement|invalid move player packet/i
        .test(s.lastKick)
    ) {
      log(
        'DIAG',
        `Movement rejection on ${version}; ` +
        'try PHYSICS=false to isolate the cause'
      );

      if (
        config.versions.length > 1
      ) {
        versionIndex++;
      }
    }

    reconnect(
      `${s.lastKick} ${reason}`
    );
  });

  // ====================================
  // LOGIN WATCHDOG
  // ====================================

  later(() => {
    if (
      !(
        s.spawned &&
        s.authenticated
      )
    ) {
      log(
        'WATCHDOG',
        `Not authenticated after ${config.loginTimeoutSeconds}s; reconnecting`
      );

      try {
        b.quit('Login watchdog');

      } catch (_) {
        try {
          b.end();
        } catch (_) {}
      }
    }
  }, config.loginTimeoutSeconds * 1000);

  // ====================================
  // CONSOLE ACCESS
  // ====================================

  s.setHome = setHome;

  s.sendCommand = command => {
    if (
      !active() ||
      !s.spawned ||
      !s.authenticated
    ) {
      log(
        'CONSOLE',
        'Not ready or not authenticated'
      );

      return;
    }

    try {
      b.chat(command);

      log(
        'COMMAND',
        `Sent ${command}`
      );

    } catch (error) {
      log(
        'COMMAND',
        error.message
      );
    }
  };
}

// ======================================
// SHUTDOWN
// ======================================

function shutdown() {
  if (stopping) return;

  stopping = true;

  clearTimeout(reconnectTimer);

  release(bot);

  try {
    bot?.quit('Shutdown');
  } catch (_) {}

  setTimeout(
    () => process.exit(0),
    500
  );
}

// ======================================
// CONSOLE COMMANDS
// ======================================

const cli = readline.createInterface({
  input: process.stdin,
  terminal: false
});

cli.on('line', line => {
  const cmd = line.trim();
  const lower = cmd.toLowerCase();

  if (!cmd) return;

  if (lower === 'stop') {
    return shutdown();
  }

  if (lower === 'help') {
    return log(
      'HELP',
      'status | position | move on | move off | ' +
      'home reset | reconnect | say <message> | ' +
      '/command | stop'
    );
  }

  if (lower === 'status') {
    return log(
      'STATUS',
      JSON.stringify({
        connected: !!bot,
        spawned: !!session?.spawned,
        authenticated: !!session?.authenticated,

        physics:
          bot?.physicsEnabled ?? null,

        movement:
          movementEnabled,

        position:
          bot?.entity?.position ?? null,

        health:
          bot?.health ?? null,

        version:
          session?.version ?? null
      })
    );
  }

  if (lower === 'position') {
    return log(
      'POSITION',
      formatPos(
        bot?.entity?.position
      )
    );
  }

  if (lower === 'move off') {
    movementEnabled = false;

    release(bot);

    return log(
      'MOVE',
      'Disabled'
    );
  }

  if (lower === 'move on') {
    movementEnabled = true;

    return log(
      'MOVE',
      'Enabled'
    );
  }

  if (lower === 'home reset') {
    if (session?.setHome) {
      session.setHome();

    } else {
      log(
        'HOME',
        'Not connected'
      );
    }

    return;
  }

  if (lower === 'reconnect') {
    reconnectCount = 0;

    if (bot) {
      try {
        bot.quit('Manual reconnect');
      } catch (_) {}

    } else {
      clearTimeout(reconnectTimer);

      reconnectTimer = null;

      start();
    }

    return;
  }

  if (lower.startsWith('say ')) {
    return session?.sendCommand?.(
      cmd.slice(4)
    );
  }

  if (cmd.startsWith('/')) {
    if (
      /^\/(login|register)\b/i.test(cmd)
    ) {
      return log(
        'AUTH',
        'Managed through MC_PASSWORD'
      );
    }

    return session?.sendCommand?.(cmd);
  }

  log(
    'CONSOLE',
    'Unknown command; type help'
  );
});

// ======================================
// PROCESS HANDLERS
// ======================================

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);

process.on('unhandledRejection', error => {
  log(
    'UNHANDLED',
    error?.stack || String(error)
  );
});

process.on('uncaughtException', error => {
  log(
    'FATAL',
    error?.stack || String(error)
  );
});

// ======================================
// START
// ======================================

log(
  'SYSTEM',
  `Zenith AFK | versions=${config.versions.join(' > ')} | physics=${config.physics}`
);

start();
