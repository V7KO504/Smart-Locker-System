const express          = require('express');
const { db }           = require('../config/firebase');
const { requireAdmin } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAdmin, async (req, res) => {
  const { limit = 200, lockerId, eventType } = req.query;
  const snap = await db.ref('accessLogs')
    .orderByChild('timestamp').limitToLast(parseInt(limit)).once('value');
  if (!snap.exists()) return res.json([]);
  const logs = [];
  snap.forEach(child => {
    const log = { id: child.key, ...child.val() };
    if (lockerId  && log.lockerId  !== lockerId)  return;
    if (eventType && log.eventType !== eventType) return;
    logs.push(log);
  });
  logs.reverse();
  res.json(logs);
});

router.put('/:id/acknowledge', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const logSnap = await db.ref(`accessLogs/${id}`).once('value');
    if (!logSnap.exists()) return res.status(404).json({ error: 'Alert log not found.' });
    const log = logSnap.val();

    await db.ref(`accessLogs/${id}`).update({ status: 'ACKNOWLEDGED', ack: true });
    
    const notifSnap = await db.ref('notifications').orderByChild('id').equalTo(id).once('value');
    if (notifSnap.exists()) {
      const updates = {};
      notifSnap.forEach(c => {
        updates[`notifications/${c.key}/status`] = 'ACKNOWLEDGED';
      });
      await db.ref().update(updates);
    }

    const { logAndNotify } = require('../utils/notifications');
    const adminId = req.session.adminId || 'admin';
    await logAndNotify({
      lockerId: log.lockerId || null,
      userId: adminId,
      eventType: 'ALERT_ACKNOWLEDGEMENT',
      status: 'SUCCESS',
      message: `Tamper alert on locker ${log.lockerId} acknowledged by admin ${adminId}.`,
      details: `Alert log ID: ${id}`
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to acknowledge tamper alert.' });
  }
});

router.put('/:id/resolve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    
    const logSnap = await db.ref(`accessLogs/${id}`).once('value');
    if (!logSnap.exists()) return res.status(404).json({ error: 'Alert log not found.' });
    const log = logSnap.val();

    await db.ref(`accessLogs/${id}`).update({ 
      status: 'RESOLVED', 
      resolved: true, 
      resolutionNotes: notes || '' 
    });

    if (log.lockerId) {
      await db.ref(`lockers/${log.lockerId}`).update({ status: 'locked' });
    }

    const notifSnap = await db.ref('notifications').orderByChild('id').equalTo(id).once('value');
    if (notifSnap.exists()) {
      const updates = {};
      notifSnap.forEach(c => {
        updates[`notifications/${c.key}/status`] = 'RESOLVED';
      });
      await db.ref().update(updates);
    }

    const { logAndNotify } = require('../utils/notifications');
    const adminId = req.session.adminId || 'admin';
    await logAndNotify({
      lockerId: log.lockerId || null,
      userId: adminId,
      eventType: 'ALERT_RESOLUTION',
      status: 'SUCCESS',
      message: `Tamper alert on locker ${log.lockerId} resolved by admin ${adminId}.`,
      details: `Notes: ${notes || ''}. Alert log ID: ${id}`
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve tamper alert.' });
  }
});

module.exports = router;
