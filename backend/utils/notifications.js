const { db } = require('../config/firebase');

function parseStudentId(message) {
  if (!message) return 'N/A';
  const match = message.match(/student\s*(?:\:|\s+)\s*([^\s()]+)/i);
  return match ? match[1] : 'N/A';
}

async function logAndNotify({ lockerId, userId, eventType, status, message, details, adminId, studentId }) {
  const timestamp = Date.now();
  
  // Deduce adminId and studentId for audit consistency
  const deducedAdminId = adminId || (['USER_CREATE', 'USER_EDIT', 'USER_DELETE', 'ASSIGN', 'UNASSIGN', 'ALERT_ACKNOWLEDGEMENT', 'ALERT_RESOLUTION', 'ADMIN_LOCK', 'ADMIN_UNLOCK'].includes(eventType) ? (userId || 'admin') : null);
  let deducedStudentId = studentId;
  if (!deducedStudentId) {
    if (!['USER_CREATE', 'USER_EDIT', 'USER_DELETE', 'ASSIGN', 'UNASSIGN', 'ALERT_ACKNOWLEDGEMENT', 'ALERT_RESOLUTION', 'ADMIN_LOCK', 'ADMIN_UNLOCK'].includes(eventType)) {
      deducedStudentId = userId || null;
    } else {
      const parsedId = parseStudentId(message || details || '');
      if (parsedId !== 'N/A') {
        deducedStudentId = parsedId;
      }
    }
  }

  // 1. Push to accessLogs with standardized schema
  const logRef = await db.ref('accessLogs').push({
    lockerId: lockerId || null,
    userId: userId || null,
    adminId: deducedAdminId || null,
    studentId: deducedStudentId || null,
    eventType,
    status: status || 'SUCCESS',
    timestamp,
    details: details || message || '',
    severity: eventType === 'TAMPER_ALERT' ? 'CRITICAL' : 'INFO',
    description: message || '',
    ack: false,
    resolved: false,
    resolutionNotes: ''
  });
  
  // 2. Push to notifications (Task 4 requirement)
  const typeMapping = {
    'OTP_REQUEST': 'OTP_GENERATED',
    'USSD_OTP_GENERATED': 'OTP_GENERATED',
    'OTP_UNLOCK': 'SUCCESSFUL_UNLOCK',
    'PIN_UNLOCK': 'SUCCESSFUL_UNLOCK',
    'ADMIN_UNLOCK': 'SUCCESSFUL_UNLOCK',
    'OTP_FAILED': 'FAILED_UNLOCK',
    'PIN_FAILED': 'FAILED_UNLOCK',
    'TAMPER_ALERT': 'TAMPER_ALERT',
    'USER_CREATE': 'USER_REGISTRATION',
    'USER_DELETE': 'USER_REMOVAL',
    'ASSIGN': 'LOCKER_ASSIGNMENT',
    'UNASSIGN': 'LOCKER_ASSIGNMENT'
  };

  const notificationType = typeMapping[eventType] || 'SYSTEM_EVENT';
  
  await db.ref('notifications').push({
    id: logRef.key,
    message: message || `${eventType} - ${status}`,
    timestamp,
    read: false,
    cleared: false,
    type: notificationType,
    lockerId: lockerId || null,
    userId: userId || null,
    adminId: deducedAdminId || null,
    studentId: deducedStudentId || null,
    status: status || 'SUCCESS',
    severity: eventType === 'TAMPER_ALERT' ? 'CRITICAL' : 'INFO',
    description: message || ''
  });
}

module.exports = { logAndNotify };
