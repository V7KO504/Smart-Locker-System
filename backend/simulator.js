require('dotenv').config();
const mqtt = require('mqtt');

const LOCKER_IDS      = ['locker_01', 'locker_02', 'locker_03', 'locker_04', 'locker_05', 'locker_06', 'locker_07'];
const LOCK_DURATION   = 60000; // 60 seconds (1 minute) before auto-close
const PUBLISH_INTERVAL_MS = 60000; // per locker status heartbeat publish interval
const TAMPER_CHECK_INTERVAL_MS = 30000; // tamper probability check cadence, unchanged

const lockers = {};
LOCKER_IDS.forEach((id, i) => {
  lockers[id] = {
    id, status: 'locked', doorState: 'closed',
    rssi: -(55 + i * 5), uptime: 0, bootTime: Date.now(),
    battery: 100 - (i * 2) // simulated battery levels (e.g. 100%, 98%, 96%, etc.)
  };
});

const c = {
  reset:'\x1b[0m', green:'\x1b[32m', yellow:'\x1b[33m',
  red:'\x1b[31m', cyan:'\x1b[36m', gray:'\x1b[90m', bold:'\x1b[1m'
};

function ts() { return new Date().toLocaleTimeString('en-KE',{hour12:false}); }
function log(id, msg, col=c.reset) { console.log(`${c.gray}[${ts()}]${c.reset} ${c.cyan}[${id}]${c.reset} ${col}${msg}${c.reset}`); }
function sys(msg, col=c.reset)     { console.log(`${c.gray}[${ts()}]${c.reset} ${c.bold}[SIM]${c.reset} ${col}${msg}${c.reset}`); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function boot() {
  console.log(`\n${c.bold}${c.cyan}══════════════════════════════════════════${c.reset}`);
  console.log(`${c.bold}${c.cyan}  Smart Locker Simulator — Kabarak University${c.reset}`);
  console.log(`${c.bold}${c.cyan}══════════════════════════════════════════${c.reset}\n`);
  for (const id of LOCKER_IDS) {
    log(id, 'GPIO initialized. Relay LOW (locked).', c.gray);
    await delay(100);
    log(id, `Wi-Fi connected → IP 192.168.1.${100+LOCKER_IDS.indexOf(id)}`, c.green);
    await delay(100);
    log(id, `Ready. ID: ${id}`, c.green);
    console.log();
  }
  sys('All units booted.', c.green);
  console.log();
}

function connect() {
  sys(`Connecting to MQTT broker...`, c.yellow);

  const client = mqtt.connect(process.env.MQTT_BROKER_URL, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clientId: 'simulator_' + Math.random().toString(16).slice(2,8),
    reconnectPeriod: 5000
  });

  client.on('connect', () => {
    sys('MQTT connected.', c.green);
    console.log();
    LOCKER_IDS.forEach(id => {
      client.subscribe(`lockers/${id}/command`);
      log(id, `Subscribed to lockers/${id}/command`, c.cyan);
    });
    console.log();
    sys('Simulator running. Press Ctrl+C to stop.\n', c.green);
    LOCKER_IDS.forEach(id => {
      publishStatus(client, id);
      setInterval(() => publishStatus(client, id), PUBLISH_INTERVAL_MS);
    });
    // Trigger simulated tamper alert after exactly 10 minutes (600,000 ms)
    sys('Scheduled simulated tamper alert to occur in 10 minutes.', c.yellow);
    setTimeout(() => {
      const targetLocker = LOCKER_IDS[Math.floor(Math.random() * LOCKER_IDS.length)];
      simulateTamper(client, targetLocker);
    }, 10 * 60 * 1000);
  });

  client.on('message', (topic, payload) => {
    const parts    = topic.split('/');
    const lockerId = parts[1];
    let data;
    try { data = JSON.parse(payload.toString()); } catch { return; }
    const action = data.action;
    log(lockerId, `Command: ${action}`, c.yellow);
    if (action === 'unlock' || action === 'admin_unlock') unlock(client, lockerId);
    else if (action === 'admin_lock') forceLock(client, lockerId);
  });

  client.on('reconnect', () => sys('Reconnecting to MQTT...', c.yellow));
  client.on('error', err => sys(`MQTT error: ${err.message}`, c.red));
}

function publishStatus(client, id) {
  const l = lockers[id];
  l.uptime = Math.floor((Date.now() - l.bootTime) / 1000);
  l.rssi += Math.floor((Math.random() - 0.5) * 3);
  // Slowly discharge battery over time by a tiny fraction (optional, let's keep it stable or slowly drop)
  l.battery = Math.max(10, l.battery - (Math.random() < 0.05 ? 1 : 0));
  const p = JSON.stringify({ lockerId:id, status:l.status, doorState:l.doorState, rssi:l.rssi, uptime:l.uptime, battery:l.battery, timestamp:Date.now() });
  client.publish(`lockers/${id}/status`, p, { retain: true });
  log(id, `Status → ${l.status} | door:${l.doorState} | rssi:${l.rssi}dBm | battery:${l.battery}% | up:${l.uptime}s`, c.gray);
}

async function unlock(client, id) {
  const l = lockers[id];
  log(id, 'RELAY → HIGH (solenoid energized — unlocked)', c.green);
  l.status = 'unlocked'; l.doorState = 'open';
  publishStatus(client, id);
  await delay(2500);
  log(id, 'Door sensor → CLOSED', c.gray);
  l.doorState = 'closed';
  await delay(LOCK_DURATION - 2500);
  log(id, 'RELAY → LOW (solenoid de-energized — re-locked)', c.yellow);
  l.status = 'locked';
  publishStatus(client, id);
}

function forceLock(client, id) {
  const l = lockers[id];
  log(id, 'Admin force-lock applied.', c.yellow);
  l.status = 'locked'; l.doorState = 'closed';
  publishStatus(client, id);
}

async function simulateTamper(client, id) {
  const l = lockers[id];
  if (!l.status === 'locked') return;
  log(id, '⚠  TAMPER DETECTED — door opened without auth!', c.red);
  l.status = 'tamper'; l.doorState = 'open';
  publishStatus(client, id);
  client.publish(`lockers/${id}/tamper`, JSON.stringify({ lockerId:id, event:'TAMPER_DETECTED', timestamp:Date.now() }));
  await delay(8000);
  l.status = 'locked'; l.doorState = 'closed';
  log(id, 'Tamper resolved.', c.yellow);
  publishStatus(client, id);
}

async function main() {
  await boot();
  connect();
  process.on('SIGINT', () => { sys('\nShutting down simulator.', c.yellow); process.exit(0); });
}

main();
