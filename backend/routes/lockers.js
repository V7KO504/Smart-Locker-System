const express            = require('express');
const { db }             = require('../config/firebase');
const { publishCommand } = require('../utils/mqtt');
const { requireAdmin }   = require('../middleware/auth');
const { logAndNotify }   = require('../utils/notifications');
const router = express.Router();

router.get('/', requireAdmin, async (req, res) => {
  const snap = await db.ref('lockers').once('value');
  res.json(snap.val() || {});
});

router.put('/:id/command', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { action, userId } = req.body;

  const snap = await db.ref(`lockers/${id}`).once('value');
  if (!snap.exists())
    return res.status(404).json({ error: 'Locker not found.' });

  if (action === 'lock' || action === 'unlock') {
    const adminAction = `admin_${action}`;
    publishCommand(id, adminAction, 'admin');
    await logAndNotify({
      lockerId: id,
      userId: req.session.adminId || 'admin',
      eventType: adminAction.toUpperCase(),
      status: 'SUCCESS',
      message: `${adminAction === 'admin_lock' ? 'Admin locked' : 'Admin unlocked'} Locker ${id}`
    });
    return res.json({ success: true, message: `${adminAction} sent to ${id}` });
  }

  if (action === 'assign') {
    if (!userId)
      return res.status(400).json({ error: 'userId required to assign a locker.', message: 'userId required to assign a locker.' });
    const safeKey = userId.replace(/[/.#$[\]]/g, '_').toUpperCase();
    const userSnap = await db.ref(`users/${safeKey}`).once('value');
    if (!userSnap.exists())
      return res.status(404).json({ error: 'Student not found.', message: 'Student not found.' });

    // Prevent assigning occupied locker
    const currentAssignedUser = snap.val().assignedUser;
    if (currentAssignedUser) {
      return res.status(400).json({ error: 'Locker is already assigned to another user.', message: 'Locker is already assigned to another user.' });
    }

    // Prevent assigning student to multiple lockers
    const currentLockerId = userSnap.val().lockerId;
    if (currentLockerId) {
      return res.status(400).json({ error: 'Student is already assigned to another locker.', message: 'Student is already assigned to another locker.' });
    }

    const adminId = req.session.adminId || 'admin';

    // Execute updates
    await db.ref(`lockers/${id}`).update({ assignedUser: safeKey });
    await db.ref(`users/${safeKey}`).update({ lockerId: id });

    // Standardized log: administrator is the actor, student is target
    await logAndNotify({
      lockerId: id,
      userId: adminId,
      eventType: 'ASSIGN',
      status: 'SUCCESS',
      message: `Locker ${id} assigned to student ${userId} by admin ${adminId}`
    });
    return res.json({ success: true, message: `${id} assigned to ${userId}` });
  }

  if (action === 'unassign') {
    const currentAssignee = snap.val().assignedUser;
    const adminId = req.session.adminId || 'admin';

    await db.ref(`lockers/${id}`).update({ assignedUser: null });
    if (currentAssignee) {
      await db.ref(`users/${currentAssignee}`).update({ lockerId: null });
    }

    // Standardized log: administrator is the actor, student is target
    await logAndNotify({
      lockerId: id,
      userId: adminId,
      eventType: 'UNASSIGN',
      status: 'SUCCESS',
      message: `Locker ${id} unassigned from student ${currentAssignee || 'unknown'} by admin ${adminId}`
    });
    return res.json({ success: true, message: `${id} unassigned` });
  }

  return res.status(400).json({ error: 'Invalid action. Use "lock", "unlock", "assign", or "unassign".' });
});

module.exports = router;
