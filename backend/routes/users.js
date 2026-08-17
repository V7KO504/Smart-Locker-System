const express          = require('express');
const bcrypt           = require('bcryptjs');
const { db }           = require('../config/firebase');
const { requireAdmin } = require('../middleware/auth');
const router = express.Router();

router.post('/register', async (req, res) => {
  console.log('[register] body:', JSON.stringify(req.body));
  const { userId, name, phone, pin, confirmPin } = req.body;
  const missing = ['userId','name','phone','pin'].filter(f => !req.body[f]);
  if (missing.length)
    return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
  if (pin !== confirmPin)
    return res.status(400).json({ error: 'PINs do not match.' });

  try {
    const safeKey = userId.replace(/[/.#$[\]]/g, '_').toUpperCase();
    console.log('[register] safeKey:', safeKey);

    const existingSnap = await db.ref(`users/${safeKey}`).once('value');
    if (existingSnap.exists())
      return res.status(400).json({ error: 'User ID already registered.' });

    const lockersSnap = await db.ref('lockers').once('value');
    let availableLocker = null;
    if (lockersSnap.exists()) {
      lockersSnap.forEach(child => {
        if (!availableLocker && !child.val().assignedUser) {
          availableLocker = child.key;
        }
      });
    }

    if (!availableLocker)
      return res.status(400).json({ error: 'No available lockers.' });

    const pinHash = await bcrypt.hash(pin, 10);
    await db.ref(`users/${safeKey}`).set({
      studentId: userId, name, phone, lockerId: availableLocker, pinHash,
      status: 'active', createdAt: Date.now()
    });

    await db.ref(`lockers/${availableLocker}`).update({ assignedUser: safeKey });

    const { logAndNotify } = require('../utils/notifications');
    await logAndNotify({
      lockerId: availableLocker,
      userId: safeKey,
      eventType: 'USER_CREATE',
      status: 'SUCCESS',
      message: `Student self-registered: ${name} (${userId})`
    });
    
    res.status(201).json({
      success: true,
      message: `User ${userId} registered successfully.`,
      lockerId: availableLocker
    });
  } catch (err) {
    console.error('[register] ERROR:', err.message || err, err.stack || '');
    res.status(500).json({ error: 'Registration failed.' });
  }
});

router.post('/login', async (req, res) => {
  const { userId, lockerId, phone } = req.body;
  if (!userId || !lockerId || !phone)
    return res.status(400).json({ error: 'Missing: userId, lockerId, phone' });

  const safeKey = userId.replace(/[/.#$[\]]/g, '_').toUpperCase();
  try {
    const snap = await db.ref(`users/${safeKey}`).once('value');
    if (!snap.exists())
      return res.status(404).json({ error: 'Student ID not found' });

    const user = snap.val();
    if (user.lockerId !== lockerId)
      return res.status(403).json({ error: 'Locker not assigned to you' });
    if (user.phone !== phone)
      return res.status(401).json({ error: 'Phone number does not match' });

    res.json({ success: true, name: user.name, lockerId: user.lockerId, token: safeKey, createdAt: user.createdAt || Date.now() });
  } catch (err) {
    console.error('[login] ERROR:', err.message || err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  console.log('[POST /users] body:', JSON.stringify(req.body));
  const { userId, name, phone, lockerId, pin } = req.body;
  const missing = ['userId','name','phone','lockerId','pin'].filter(f => !req.body[f]);
  if (missing.length) {
    console.log('[POST /users] missing fields:', missing);
    return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
  }
  try {
    const safeKey = userId.replace(/[/.#$[\]]/g, '_').toUpperCase();
    console.log('[POST /users] safeKey:', safeKey);
    const existing = await db.ref(`users/${safeKey}`).once('value');
    if (existing.exists())
      return res.status(409).json({ error: 'User already exists.' });

    // Validate locker availability and prevent duplicates
    const lockerSnap = await db.ref(`lockers/${lockerId}`).once('value');
    if (!lockerSnap.exists()) {
      return res.status(404).json({ error: 'Locker ID not found.' });
    }
    const lockerVal = lockerSnap.val();
    if (lockerVal.assignedUser) {
      return res.status(400).json({ error: 'Locker is already assigned to another user.' });
    }

    const pinHash = await bcrypt.hash(pin, 10);
    await db.ref(`users/${safeKey}`).set({ studentId: userId, name, phone, lockerId, pinHash, status: 'active', createdAt: Date.now() });
    await db.ref(`lockers/${lockerId}`).update({ assignedUser: safeKey });

    const adminId = req.session.adminId || 'admin';

    // Log the user registration action
    await logAndNotify({
      lockerId,
      userId: adminId,
      eventType: 'USER_CREATE',
      status: 'SUCCESS',
      message: `Admin registered student: ${userId}`
    });

    // Also log the locker assignment action
    await logAndNotify({
      lockerId,
      userId: adminId,
      eventType: 'ASSIGN',
      status: 'SUCCESS',
      message: `Locker ${lockerId} assigned to student ${userId} by admin ${adminId}`
    });

    res.status(201).json({ success: true, message: `User ${userId} registered.` });
  } catch (err) {
    console.error('[POST /users] ERROR:', err.message || err, err.stack || '');
    res.status(500).json({ error: err.message || 'Failed to add user.' });
  }
});

router.get('/', requireAdmin, async (req, res) => {
  const snap = await db.ref('users').once('value');
  const users = {};
  if (snap.exists()) {
    snap.forEach(child => {
      const u = child.val();
      delete u.pinHash;
      users[child.key] = u;
    });
  }
  res.json(users);
});

router.get('/my-locker-status', async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth && auth.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Token required.' });
  }

  try {
    const userSnap = await db.ref(`users/${token}`).once('value');
    if (!userSnap.exists()) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    const user = userSnap.val();
    if (!user.lockerId) {
      return res.json({ lockerId: null, message: 'No locker assigned.' });
    }

    const lockerSnap = await db.ref(`lockers/${user.lockerId}`).once('value');
    const locker = lockerSnap.exists() ? lockerSnap.val() : {};

    // Get last successful access log for this locker
    const logsSnap = await db.ref('accessLogs')
      .orderByChild('lockerId')
      .equalTo(user.lockerId)
      .limitToLast(10)
      .once('value');

    let lastAccessTime = 'Never';
    if (logsSnap.exists()) {
      const logs = [];
      logsSnap.forEach(c => {
        const val = c.val();
        if (val.status === 'SUCCESS' && (val.eventType === 'OTP_UNLOCK' || val.eventType === 'PIN_UNLOCK')) {
          logs.push(val);
        }
      });
      if (logs.length > 0) {
        logs.sort((a, b) => b.timestamp - a.timestamp);
        lastAccessTime = new Date(logs[0].timestamp).toLocaleString();
      }
    }

    res.json({
      lockerId: user.lockerId,
      status: locker.status || 'unknown',
      doorState: locker.doorState || 'unknown',
      lastSeen: locker.lastSeen || 0,
      lastAccess: lastAccessTime,
      failedAttempts: user.failedPinAttempts || 0,
      lockoutUntil: user.lockoutUntil || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve locker status.' });
  }
});

router.put('/update-phone', async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth && auth.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Token required.' });
  }

  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.status(400).json({ error: 'Phone number and PIN are required.' });
  }

  try {
    const safeKey = token.toUpperCase();
    const userSnap = await db.ref(`users/${safeKey}`).once('value');
    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = userSnap.val();
    
    // Check PIN lockout
    if (user.lockoutUntil && user.lockoutUntil > Date.now()) {
      return res.status(423).json({ error: 'Too many failed attempts. Keypad locked for 5 minutes.' });
    }

    const match = await bcrypt.compare(pin, user.pinHash);
    if (!match) {
      const failedAttempts = (user.failedPinAttempts || 0) + 1;
      const updates = { failedPinAttempts: failedAttempts };
      if (failedAttempts >= 5) {
        updates.lockoutUntil = Date.now() + 5 * 60 * 1000;
      }
      await db.ref(`users/${safeKey}`).update(updates);
      return res.status(401).json({ error: 'Incorrect PIN.' });
    }

    // PIN matches: reset attempts and update phone
    await db.ref(`users/${safeKey}`).update({
      phone,
      failedPinAttempts: 0,
      lockoutUntil: null
    });

    // Log the phone update action in the Audit Log and notify
    await logAndNotify({
      lockerId: user.lockerId || 'N/A',
      userId: safeKey,
      eventType: 'PHONE_UPDATE',
      status: 'SUCCESS',
      message: `Updated student ${safeKey} phone number to ${phone}`
    });

    res.json({ success: true, message: 'Phone number updated successfully.' });
  } catch (err) {
    console.error('[PUT /update-phone] ERROR:', err.message);
    res.status(500).json({ error: 'Failed to update phone number.' });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const oldUserId = req.params.id;
  const oldSafeKey = oldUserId.replace(/[/.#$[\]]/g, '_').toUpperCase();
  const { userId, name, phone, lockerId, pin } = req.body;

  try {
    const userSnap = await db.ref(`users/${oldSafeKey}`).once('value');
    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const currentUser = userSnap.val();
    const newUserId = userId || currentUser.studentId;
    const newSafeKey = newUserId.replace(/[/.#$[\]]/g, '_').toUpperCase();

    // If student ID changed, check if new ID already exists
    if (newSafeKey !== oldSafeKey) {
      const existing = await db.ref(`users/${newSafeKey}`).once('value');
      if (existing.exists()) {
        return res.status(409).json({ error: 'New Student ID already registered.' });
      }
    }

    // If locker changed, check availability of new locker
    const targetLockerId = lockerId || currentUser.lockerId;
    if (targetLockerId !== currentUser.lockerId) {
      const newLockerSnap = await db.ref(`lockers/${targetLockerId}`).once('value');
      if (!newLockerSnap.exists()) {
        return res.status(404).json({ error: 'New Locker ID not found.' });
      }
      const newLocker = newLockerSnap.val();
      if (newLocker.assignedUser && newLocker.assignedUser !== oldSafeKey) {
        return res.status(400).json({ error: 'New Locker is already assigned to another user.' });
      }
    }

    // Prepare updates
    const updates = {
      name: name || currentUser.name,
      phone: phone || currentUser.phone,
      lockerId: targetLockerId,
      studentId: newUserId,
    };

    if (pin) {
      updates.pinHash = await bcrypt.hash(pin, 10);
    } else {
      updates.pinHash = currentUser.pinHash || '';
    }
    
    updates.status = currentUser.status || 'active';
    updates.createdAt = currentUser.createdAt || Date.now();

    // Execute DB operations
    if (newSafeKey !== oldSafeKey) {
      await db.ref(`users/${oldSafeKey}`).remove();
      await db.ref(`users/${newSafeKey}`).set(updates);
    } else {
      await db.ref(`users/${oldSafeKey}`).set(updates);
    }

    // Update locker assignments
    if (targetLockerId !== currentUser.lockerId) {
      if (currentUser.lockerId) {
        await db.ref(`lockers/${currentUser.lockerId}`).update({ assignedUser: null });
        await logAndNotify({
          lockerId: currentUser.lockerId,
          userId: req.session.adminId || 'admin',
          eventType: 'UNASSIGN',
          status: 'SUCCESS',
          message: `Locker ${currentUser.lockerId} unassigned from student ${currentUser.studentId} (edit)`
        });
      }
      await db.ref(`lockers/${targetLockerId}`).update({ assignedUser: newSafeKey });
      await logAndNotify({
        lockerId: targetLockerId,
        userId: req.session.adminId || 'admin',
        eventType: 'ASSIGN',
        status: 'SUCCESS',
        message: `Locker ${targetLockerId} assigned to student ${newUserId} (edit)`
      });
    } else if (newSafeKey !== oldSafeKey) {
      await db.ref(`lockers/${targetLockerId}`).update({ assignedUser: newSafeKey });
    }

    // Log the user management edit action in the Audit Log and notify
    await logAndNotify({
      lockerId: targetLockerId,
      userId: req.session.adminId || 'admin',
      eventType: 'USER_EDIT',
      status: 'SUCCESS',
      message: `Admin edited student: ${newUserId}`
    });

    res.json({ success: true, message: `User ${newUserId} updated successfully.`, lockerId: targetLockerId });
  } catch (err) {
    console.error('[PUT /users/:id] ERROR:', err);
    res.status(500).json({ error: err.message || 'Failed to update user.' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const safeKey = req.params.id.replace(/[/.#$[\]]/g, '_').toUpperCase();
  const snap = await db.ref(`users/${safeKey}`).once('value');
  if (!snap.exists()) return res.status(404).json({ error: 'User not found.' });
  const { lockerId } = snap.val();
  await db.ref(`users/${safeKey}`).remove();
  if (lockerId) {
    await db.ref(`lockers/${lockerId}`).update({ assignedUser: null });
    await logAndNotify({
      lockerId,
      userId: req.session.adminId || 'admin',
      eventType: 'UNASSIGN',
      status: 'SUCCESS',
      message: `Locker ${lockerId} unassigned from student ${req.params.id} due to user removal`
    });
  }

  // Log the user delete action in the Audit Log and notify
  await logAndNotify({
    lockerId: lockerId || 'N/A',
    userId: req.session.adminId || 'admin',
    eventType: 'USER_DELETE',
    status: 'SUCCESS',
    message: `Admin removed student: ${req.params.id}`
  });

  res.json({ success: true, message: `User ${req.params.id} removed.` });
});

module.exports = router;
