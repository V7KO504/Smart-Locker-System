const { db } = require('../config/firebase');

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function createOTP(lockerId, userId, resendCount = 0) {
  const otp    = generateOTP();
  const expiry = Date.now() + 5 * 60 * 1000;
  await db.ref(`otpTokens/${lockerId}`).set({ otp, expiry, userId, resendCount });
  return { otp, expiry };
}

async function validateOTP(lockerId, submittedOTP) {
  const snap = await db.ref(`otpTokens/${lockerId}`).once('value');
  if (!snap.exists()) return { valid: false, reason: 'No active OTP.' };
  const { otp, expiry, userId } = snap.val();
  if (Date.now() > expiry) {
    // Clean up expired OTP
    await db.ref(`otpTokens/${lockerId}`).remove();
    return { valid: false, reason: 'OTP expired.' };
  }
  if (submittedOTP !== otp)  return { valid: false, reason: 'Incorrect OTP.' };
  await db.ref(`otpTokens/${lockerId}`).remove();
  return { valid: true, userId };
}

async function logEvent(lockerId, userId, eventType, status = 'SUCCESS') {
  await db.ref('accessLogs').push({
    lockerId, userId: userId || null, eventType, status, timestamp: Date.now()
  });
}

module.exports = { generateOTP, createOTP, validateOTP, logEvent };
