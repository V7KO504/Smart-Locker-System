const mqtt   = require('mqtt');
const { db } = require('../config/firebase');

const client = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username:        process.env.MQTT_USERNAME,
  password:        process.env.MQTT_PASSWORD,
  clientId:        'backend_' + Math.random().toString(16).slice(2, 8),
  reconnectPeriod: 5000
});

client.on('connect', () => {
  console.log('Backend MQTT connected.');
  client.subscribe('lockers/+/status');
  client.subscribe('lockers/+/tamper');
});

client.on('message', async (topic, payload) => {
  const parts     = topic.split('/');
  const lockerId  = parts[1];
  const eventType = parts[2];
  let data;
  try { data = JSON.parse(payload.toString()); } catch { return; }

  if (eventType === 'status') {
    await db.ref(`lockers/${lockerId}`).update({
      status: data.status, doorState: data.doorState,
      rssi: data.rssi, battery: data.battery || 100, lastSeen: Date.now()
    });
  }
  if (eventType === 'tamper') {
    const { logAndNotify } = require('./notifications');
    await logAndNotify({
      lockerId,
      userId: null,
      eventType: 'TAMPER_ALERT',
      status: 'ALERT',
      message: `TAMPER ALERT: Physical tampering detected on Locker ${lockerId}`
    });
    console.warn(`TAMPER ALERT: ${lockerId}`);
  }
});

client.on('error', err => console.error('MQTT error:', err.message));

function publishCommand(lockerId, action, token = '') {
  client.publish(
    `lockers/${lockerId}/command`,
    JSON.stringify({ action, token, timestamp: Date.now() }),
    { qos: 1 }
  );
  console.log(`Command → ${lockerId}: ${action}`);
}

module.exports = { client, publishCommand };
