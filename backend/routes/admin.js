const express = require('express');
const bcrypt  = require('bcryptjs');
const { db }  = require('../config/firebase');
const router  = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  if (username.length > 64 || password.length > 128)
    return res.status(401).json({ error: 'Invalid credentials.' });
  try {
    const safeKey = username.replace(/[/.#$[\]]/g, '_');
    const snap = await db.ref(`admins/${safeKey}`).once('value');
    if (!snap.exists()) return res.status(401).json({ error: 'Invalid credentials.' });
    const match = await bcrypt.compare(password, snap.val().passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials.' });
    req.session.isAdmin = true;
    req.session.adminId = username;
    res.json({ success: true, adminId: username });
  } catch (err) {
    console.error('[admin/login] ERROR:', err.message);
    res.status(401).json({ error: 'Invalid credentials.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.get('/me', (req, res) => {
  if (req.session && req.session.isAdmin)
    return res.json({ loggedIn: true, adminId: req.session.adminId });
  res.json({ loggedIn: false });
});

const { requireAdmin } = require('../middleware/auth');
const { client } = require('../utils/mqtt');

router.get('/health', requireAdmin, async (req, res) => {
  try {
    // Check Firebase connection state by fetching lockers
    const lockersSnap = await db.ref('lockers').once('value');
    const firebaseConnected = true;

    const lockersVal = lockersSnap.val() || {};
    const lockersList = Object.entries(lockersVal).map(([id, l]) => {
      const lastSeen = l.lastSeen || 0;
      // Consider locker online if its heartbeat was received in the last 90 seconds
      const online = lastSeen ? (Date.now() - lastSeen < 90000) : false;
      return {
        id,
        online,
        lastSeen,
        rssi: l.rssi || 0,
        battery: l.battery || 100,
        doorState: l.doorState || 'closed',
        status: l.status || 'unknown'
      };
    });

    const onlineCount = lockersList.filter(l => l.online).length;
    const offlineCount = lockersList.length - onlineCount;

    res.json({
      mqttConnected: client ? client.connected : false,
      firebaseConnected,
      smsGatewayStatus: (process.env.AT_USERNAME || 'sandbox') === 'sandbox' ? 'Sandbox Active' : 'Production Active',
      lockers: lockersList,
      onlineCount,
      offlineCount,
      lastSyncTime: Date.now()
    });
  } catch (err) {
    console.error('[admin/health] ERROR:', err.message);
    res.status(500).json({ error: 'Failed to retrieve system health.' });
  }
});

router.get('/notifications', requireAdmin, async (req, res) => {
  try {
    const snap = await db.ref('notifications').orderByChild('timestamp').limitToLast(100).once('value');
    const list = [];
    if (snap.exists()) {
      snap.forEach(child => {
        const val = child.val();
        if (!val.cleared) {
          list.push({
            id: child.key,
            ...val
          });
        }
      });
    }
    list.reverse(); // newest first
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch notifications.' });
  }
});

router.put('/notifications/:id/read', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.ref(`notifications/${id}`).update({ read: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark notification as read.' });
  }
});

router.put('/notifications/:id/clear', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.ref(`notifications/${id}`).update({ cleared: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear notification.' });
  }
});

router.post('/notifications/clear-all', requireAdmin, async (req, res) => {
  try {
    const snap = await db.ref('notifications').once('value');
    if (snap.exists()) {
      const updates = {};
      snap.forEach(child => {
        updates[`notifications/${child.key}/cleared`] = true;
      });
      await db.ref().update(updates);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear all notifications.' });
  }
});

module.exports = router;
