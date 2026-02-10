const functions = require('firebase-functions');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK (no credentials needed in Cloud Functions)
admin.initializeApp();
console.log('✅ Firebase Admin SDK initialized successfully');

// ============================================================================
// FEATURE FLAGS - Toggle features to control costs
// ============================================================================
const FEATURES = {
  ENABLE_SOS_ALERT_SNAPSHOT: true,  // Set to false to disable SOS alert snapshot storage for admin dashboard
  BLOCKED_USERS: true               // Always keep true - critical security feature
};

// ============================================================================
// SCHEDULED FUNCTION CONFIGURATION
// ============================================================================
const SCHEDULE_CONFIG = {
  ALERT_EXPIRATION_CHECK_INTERVAL: 'every 1 hours',  // How often to check for expired alerts (cron syntax or 'every X hours/minutes')
  ALERT_EXPIRATION_THRESHOLD_MS: 60 * 60 * 1000      // How old an alert must be to expire (default: 1 hour in milliseconds)
};

// ============================================================================
// DATABASE OPERATIONS - Centralized Firestore operations
// ============================================================================

/**
 * Check if a sender is blocked (CRITICAL - always enabled)
 */
async function isSenderBlocked(sender_id) {
  if (!FEATURES.BLOCKED_USERS) return false;
  
  try {
    const blockedDoc = await admin.firestore()
      .collection('blocked_users')
      .doc(sender_id)
      .get();
    
    return blockedDoc.exists && blockedDoc.data()?.blocked === true;
  } catch (error) {
    console.error('Error checking blocked status:', error);
    // Fail open or closed depending on your preference
    return false; // Fail open - allow request if check fails
  }
}

/**
 * Store/Update SOS alert snapshot in Firestore for admin dashboard (OPTIONAL - can be disabled)
 * Uses sender_id as document ID for easy lookup and tabular display
 * 
 * @param {string} sender_id - Firebase Installation ID (used as document ID)
 * @param {boolean} active - true for SOS alert, false for stop
 * @param {object} location - GPS coordinates {latitude, longitude, accuracy}
 * @param {object} userInfo - User details {name, mobile_number, message}
 * @param {string} district - District name (e.g., "udupi", "mangalore")
 * @param {string} state - State extracted from user location (last component of location string)
 */
async function storeSOSAlert(sender_id, active, location = null, userInfo = null, district = null, state = null) {
  if (!FEATURES.ENABLE_SOS_ALERT_SNAPSHOT) {
    console.log('⏭️  SOS alert snapshot disabled');
    return false;
  }
  
  try {
    const alertData = {
      sender_id: sender_id,
      active: active,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Only update location, userInfo, and district when creating/updating an active alert
    if (active && location) {
      alertData.location = location;
    }
    
    if (active && userInfo) {
      alertData.userInfo = {
        name: userInfo.name || 'Unknown',
        mobile_number: userInfo.phone || userInfo.mobile_number || 'N/A',
        message: userInfo.message || ''
      };
    }
    
    if (active && district) {
      alertData.district = district;
    }
    
    if (active && state) {
      alertData.state = state;
    }
    
    // Use sender_id as document ID for easy updates
    await admin.firestore()
      .collection('sos_alerts')
      .doc(sender_id)
      .set(alertData, { merge: true });
    
    console.log(`📝 SOS alert ${active ? 'activated' : 'deactivated'} in Firestore for ${sender_id}`);
    return true;
  } catch (error) {
    console.error('⚠️  Failed to store SOS alert:', error);
    return false; // Don't fail the request if snapshot fails
  }
}

/**
 * Block a user in Firestore (CRITICAL - always enabled)
 */
async function blockUser(sender_id, reason, blocked_by) {
  const blockData = {
    blocked: true,
    blockedAt: admin.firestore.FieldValue.serverTimestamp(),
    reason: reason || 'No reason provided',
    blockedBy: blocked_by || 'admin'
  };
  
  await admin.firestore()
    .collection('blocked_users')
    .doc(sender_id)
    .set(blockData);
  
  return blockData;
}

/**
 * Unblock a user in Firestore (CRITICAL - always enabled)
 */
async function unblockUser(sender_id) {
  await admin.firestore()
    .collection('blocked_users')
    .doc(sender_id)
    .delete();
}

/**
 * Get blocked user document (CRITICAL - always enabled)
 */
async function getBlockedUser(sender_id) {
  const doc = await admin.firestore()
    .collection('blocked_users')
    .doc(sender_id)
    .get();
  
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/**
 * List all blocked users (CRITICAL - always enabled)
 */
async function listBlockedUsers() {
  const snapshot = await admin.firestore()
    .collection('blocked_users')
    .where('blocked', '==', true)
    .orderBy('blockedAt', 'desc')
    .get();
  
  const blockedUsers = [];
  snapshot.forEach(doc => {
    blockedUsers.push({
      sender_id: doc.id,
      ...doc.data(),
      blockedAt: doc.data().blockedAt?.toDate().toISOString()
    });
  });
  
  return blockedUsers;
}

/**
 * Get all SOS alert snapshots for admin dashboard (OPTIONAL - can be disabled)
 * @param {boolean} activeOnly - If true, only return active alerts
 */
async function getSOSAlerts(activeOnly = false) {
  if (!FEATURES.ENABLE_SOS_ALERT_SNAPSHOT) {
    return [];
  }
  
  let query = admin.firestore().collection('sos_alerts');
  
  if (activeOnly) {
    query = query.where('active', '==', true);
  }
  
  const snapshot = await query.orderBy('timestamp', 'desc').get();
  
  const alerts = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    alerts.push({
      sender_id: doc.id,
      active: data.active,
      district: data.district,
      location: data.location,
      userInfo: data.userInfo,
      timestamp: data.timestamp?.toDate().toISOString()
    });
  });
  
  return alerts;
}

/**
 * Expire old active SOS alerts (OPTIONAL - can be disabled)
 * Checks all active alerts and marks them as inactive if they exceed the threshold
 * @returns {object} Summary of expired alerts
 */
async function expireOldAlerts() {
  if (!FEATURES.ENABLE_SOS_ALERT_SNAPSHOT) {
    console.log('⏭️  Alert expiration disabled (SOS alert snapshot disabled)');
    return { expired: 0, checked: 0, enabled: false };
  }
  
  try {
    const now = Date.now();
    const thresholdTime = now - SCHEDULE_CONFIG.ALERT_EXPIRATION_THRESHOLD_MS;
    
    console.log(`🔍 Checking for alerts older than ${SCHEDULE_CONFIG.ALERT_EXPIRATION_THRESHOLD_MS / 1000 / 60} minutes`);
    
    // Query all active alerts
    const snapshot = await admin.firestore()
      .collection('sos_alerts')
      .where('active', '==', true)
      .get();
    
    const expiredAlerts = [];
    const batch = admin.firestore().batch();
    
    snapshot.forEach(doc => {
      const data = doc.data();
      const timestamp = data.timestamp?.toDate();
      
      if (timestamp && timestamp.getTime() < thresholdTime) {
        // Alert is older than threshold, mark for expiration
        const alertRef = admin.firestore().collection('sos_alerts').doc(doc.id);
        batch.update(alertRef, {
          active: false,
          expiredAt: admin.firestore.FieldValue.serverTimestamp(),
          expiredBy: 'scheduled_job'
        });
        
        expiredAlerts.push({
          sender_id: doc.id,
          district: data.district,
          age_minutes: Math.floor((now - timestamp.getTime()) / 1000 / 60)
        });
      }
    });
    
    // Commit all updates in a single batch
    if (expiredAlerts.length > 0) {
      await batch.commit();
      console.log(`✅ Expired ${expiredAlerts.length} old alerts:`, expiredAlerts);
    } else {
      console.log(`✅ No alerts to expire (checked ${snapshot.size} active alerts)`);
    }
    
    return {
      expired: expiredAlerts.length,
      checked: snapshot.size,
      enabled: true,
      expiredAlerts: expiredAlerts
    };
  } catch (error) {
    console.error('⚠️  Failed to expire old alerts:', error);
    throw error;
  }
}

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

/**
 * Super admin emails (hardcoded)
 * 
 * ⚠️ SINGLE SOURCE OF TRUTH ⚠️
 * This is the ONLY place where super admin emails need to be maintained.
 * The system automatically sets custom claims for these users, which are
 * then used by:
 * - Firestore security rules (via custom claims)
 * - Flutter app (via /admin/profile API response)
 * 
 * To add/remove super admins, only modify this list and redeploy cloud functions.
 */
const SUPER_ADMINS = [
  'shamanthknr@gmail.com',
  'karthik.dhanya11@gmail.com'
];

/**
 * Middleware to verify Firebase ID token
 * Also sets custom claims for super admins if needed
 */
async function authenticateUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header'
      });
    }
    
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Set custom claim for super admins if not already set
    if (isSuperAdmin(decodedToken.email) && !decodedToken.superadmin) {
      await admin.auth().setCustomUserClaims(decodedToken.uid, { superadmin: true });
      console.log(`✅ Set superadmin custom claim for ${decodedToken.email}`);
    }
    
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email
    };
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }
}

/**
 * Middleware to verify super admin access
 */
async function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Authentication required'
    });
  }
  
  if (!SUPER_ADMINS.includes(req.user.email)) {
    return res.status(403).json({ 
      error: 'Forbidden',
      message: 'Super admin access required'
    });
  }
  
  next();
}

/**
 * Get admin document from Firestore
 */
async function getAdmin(email) {
  const doc = await admin.firestore()
    .collection('admins')
    .doc(email)
    .get();
  
  return doc.exists ? { email: doc.id, ...doc.data() } : null;
}

/**
 * Check if user is super admin
 */
function isSuperAdmin(email) {
  return SUPER_ADMINS.includes(email);
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    firebase: 'connected', // Always connected in CF
    features: {
      sosAlertSnapshot: FEATURES.ENABLE_SOS_ALERT_SNAPSHOT,
      blockedUsers: FEATURES.BLOCKED_USERS
    },
    scheduledJobs: {
      alertExpiration: {
        enabled: FEATURES.ENABLE_SOS_ALERT_SNAPSHOT,
        interval: SCHEDULE_CONFIG.ALERT_EXPIRATION_CHECK_INTERVAL,
        thresholdMinutes: SCHEDULE_CONFIG.ALERT_EXPIRATION_THRESHOLD_MS / 1000 / 60
      }
    }
  });
});

// Admin endpoint: Block a user
app.post('/admin/block-user', authenticateUser, async (req, res) => {
  console.log('🔒 Block user request received:', req.body);
  
  try {
    const { sender_id, reason } = req.body;
    const blocked_by = req.user.email;
    
    // Validate required fields
    if (!sender_id) {
      return res.status(400).json({ 
        error: 'Missing required field',
        required: ['sender_id']
      });
    }
    
    // Check if user is already blocked
    const existingUser = await getBlockedUser(sender_id);
    
    if (existingUser && existingUser.blocked === true) {
      return res.status(409).json({ 
        error: 'User already blocked',
        message: `User ${sender_id} is already in the blocked list`,
        blockedAt: existingUser.blockedAt,
        reason: existingUser.reason
      });
    }
    
    // Block the user
    await blockUser(sender_id, reason, blocked_by);
    
    console.log(`✅ User blocked successfully: ${sender_id}`);
    
    res.json({ 
      success: true, 
      message: 'User blocked successfully',
      sender_id: sender_id,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Block user error:', error);
    res.status(500).json({ 
      error: 'Failed to block user',
      message: error.message
    });
  }
});

// Admin endpoint: Unblock a user
app.post('/admin/unblock-user', authenticateUser, async (req, res) => {
  console.log('🔓 Unblock user request received:', req.body);
  
  try {
    const { sender_id } = req.body;
    
    // Validate required fields
    if (!sender_id) {
      return res.status(400).json({ 
        error: 'Missing required field',
        required: ['sender_id']
      });
    }
    
    // Check if user exists in blocked list
    const existingUser = await getBlockedUser(sender_id);
    
    if (!existingUser) {
      return res.status(404).json({ 
        error: 'User not found',
        message: `User ${sender_id} is not in the blocked list`
      });
    }
    
    // Unblock the user
    await unblockUser(sender_id);
    
    console.log(`✅ User unblocked successfully: ${sender_id}`);
    
    res.json({ 
      success: true, 
      message: 'User unblocked successfully',
      sender_id: sender_id,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Unblock user error:', error);
    res.status(500).json({ 
      error: 'Failed to unblock user',
      message: error.message
    });
  }
});

// Admin endpoint: List all blocked users
app.get('/admin/blocked-users', async (req, res) => {
  console.log('📋 List blocked users request received');
  
  try {
    const blockedUsers = await listBlockedUsers();
    
    console.log(`✅ Found ${blockedUsers.length} blocked users`);
    
    res.json({ 
      success: true,
      count: blockedUsers.length,
      blockedUsers: blockedUsers,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ List blocked users error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve blocked users',
      message: error.message
    });
  }
});

// Admin endpoint: Get SOS alerts for dashboard
app.get('/admin/sos-alerts', async (req, res) => {
  console.log('📊 Get SOS alerts request received');
  
  try {
    const activeOnly = req.query.active === 'true';
    const alerts = await getSOSAlerts(activeOnly);
    
    console.log(`✅ Found ${alerts.length} SOS alerts${activeOnly ? ' (active only)' : ''}`);
    
    res.json({ 
      success: true,
      count: alerts.length,
      activeOnly: activeOnly,
      alerts: alerts,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Get SOS alerts error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve SOS alerts',
      message: error.message
    });
  }
});

// Admin endpoint: Get paginated list of users with search
app.get('/admin/users', authenticateUser, async (req, res) => {
  console.log('👥 Get users list request received');
  
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;
    const search = req.query.search || '';
    
    // Get admin profile to check permissions
    const isSuperAdminUser = isSuperAdmin(req.user.email);
    let allowedDistricts = [];
    
    if (!isSuperAdminUser) {
      const adminDoc = await getAdmin(req.user.email);
      if (!adminDoc || !adminDoc.active) {
        return res.status(403).json({ 
          error: 'Forbidden',
          message: 'Admin account is inactive or not found'
        });
      }
      allowedDistricts = adminDoc.assignedDistricts || [];
    }
    
    // Get all SOS alerts to extract unique users
    let query = admin.firestore().collection('sos_alerts');
    
    // Filter by district if admin (not super admin)
    if (!isSuperAdminUser && allowedDistricts.length > 0) {
      query = query.where('district', 'in', allowedDistricts);
    }
    
    const snapshot = await query.get();
    
    // Build user map (using sender_id as key to get unique users)
    const userMap = new Map();
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const senderId = doc.id;
      const userInfo = data.userInfo || {};
      
      // Only include if we have user info
      if (userInfo.name || userInfo.mobile_number) {
        userMap.set(senderId, {
          sender_id: senderId,
          name: userInfo.name || 'Unknown',
          mobile_number: userInfo.mobile_number || 'N/A',
          state: data.state || 'Unknown',
          district: data.district || 'Unknown',
          blocked: false // Will be updated below
        });
      }
    }
    
    // Get blocked users information
    const blockedSnapshot = await admin.firestore()
      .collection('blocked_users')
      .where('blocked', '==', true)
      .get();
    
    const blockedMap = new Map();
    blockedSnapshot.forEach(doc => {
      const data = doc.data();
      blockedMap.set(doc.id, {
        blocked: true,
        blockedAt: data.blockedAt?.toDate().toISOString(),
        blockedBy: data.blockedBy,
        reason: data.reason
      });
    });
    
    // Merge blocked info into user map
    for (const [senderId, userData] of userMap.entries()) {
      if (blockedMap.has(senderId)) {
        const blockedInfo = blockedMap.get(senderId);
        userMap.set(senderId, { ...userData, ...blockedInfo });
      }
    }
    
    // Convert map to array
    let users = Array.from(userMap.values());
    
    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      users = users.filter(user => 
        user.name.toLowerCase().includes(searchLower) ||
        user.mobile_number.toLowerCase().includes(searchLower) ||
        user.state.toLowerCase().includes(searchLower) ||
        user.district.toLowerCase().includes(searchLower)
      );
    }
    
    // Sort by name
    users.sort((a, b) => a.name.localeCompare(b.name));
    
    // Calculate pagination
    const total = users.length;
    const totalPages = Math.ceil(total / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedUsers = users.slice(startIndex, endIndex);
    
    console.log(`✅ Found ${total} users (showing ${paginatedUsers.length} on page ${page})`);
    
    res.json({ 
      success: true,
      users: paginatedUsers,
      total: total,
      page: page,
      pageSize: pageSize,
      totalPages: totalPages,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Get users list error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve users',
      message: error.message
    });
  }
});

// ============================================================================
// ADMIN MANAGEMENT ENDPOINTS
// ============================================================================

// Get current user profile (authenticated user - super admin or admin)
app.get('/admin/profile', authenticateUser, async (req, res) => {
  console.log('👤 Get profile request received for:', req.user.email);
  
  try {
    const isSuperAdminUser = isSuperAdmin(req.user.email);
    let adminDoc = null;
    
    if (!isSuperAdminUser) {
      adminDoc = await getAdmin(req.user.email);
      
      if (!adminDoc || !adminDoc.active) {
        return res.status(403).json({ 
          error: 'Forbidden',
          message: 'Admin account is inactive or not found'
        });
      }
    }
    
    res.json({ 
      success: true,
      user: {
        email: req.user.email,
        role: isSuperAdminUser ? 'superadmin' : 'admin',
        assignedDistricts: isSuperAdminUser ? [] : (adminDoc?.assignedDistricts || []),
        active: isSuperAdminUser ? true : (adminDoc?.active || false)
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Get profile error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve profile',
      message: error.message
    });
  }
});

// List all admins (super admin only)
app.get('/admin/admins', authenticateUser, requireSuperAdmin, async (req, res) => {
  console.log('📋 List admins request received');
  
  try {
    const snapshot = await admin.firestore()
      .collection('admins')
      .orderBy('createdAt', 'desc')
      .get();
    
    const admins = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      admins.push({
        email: doc.id,
        role: data.role || 'admin',
        assignedDistricts: data.assignedDistricts || [],
        active: data.active !== false,
        createdAt: data.createdAt?.toDate().toISOString(),
        createdBy: data.createdBy || 'unknown'
      });
    });
    
    console.log(`✅ Found ${admins.length} admins`);
    
    res.json({ 
      success: true,
      count: admins.length,
      admins: admins,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ List admins error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve admins',
      message: error.message
    });
  }
});

// Create new admin (super admin only)
app.post('/admin/admins', authenticateUser, requireSuperAdmin, async (req, res) => {
  console.log('➕ Create admin request received:', req.body);
  
  try {
    const { email, password, assignedDistricts } = req.body;
    
    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['email', 'password']
      });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format'
      });
    }
    
    // Check if email is a super admin
    if (isSuperAdmin(email)) {
      return res.status(400).json({ 
        error: 'Cannot create admin account',
        message: 'This email is reserved for super admin'
      });
    }
    
    // Check if admin already exists in Firestore
    const existingAdmin = await getAdmin(email);
    if (existingAdmin) {
      return res.status(409).json({ 
        error: 'Admin already exists',
        message: `Admin with email ${email} already exists`
      });
    }
    
    // Create user in Firebase Auth
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email: email,
        password: password,
        emailVerified: true
      });
    } catch (authError) {
      console.error('Auth creation error:', authError);
      return res.status(400).json({ 
        error: 'Failed to create user account',
        message: authError.message
      });
    }
    
    // Create admin document in Firestore
    const adminData = {
      role: 'admin',
      assignedDistricts: assignedDistricts || [],
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.email
    };
    
    await admin.firestore()
      .collection('admins')
      .doc(email)
      .set(adminData);
    
    console.log(`✅ Admin created successfully: ${email}`);
    
    res.json({ 
      success: true,
      message: 'Admin created successfully',
      admin: {
        email: email,
        uid: userRecord.uid,
        ...adminData,
        createdAt: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Create admin error:', error);
    res.status(500).json({ 
      error: 'Failed to create admin',
      message: error.message
    });
  }
});

// Update admin (super admin only)
app.put('/admin/admins/:email', authenticateUser, requireSuperAdmin, async (req, res) => {
  console.log('✏️ Update admin request received:', req.params.email, req.body);
  
  try {
    const { email } = req.params;
    const { assignedDistricts, active } = req.body;
    
    // Check if email is a super admin
    if (isSuperAdmin(email)) {
      return res.status(400).json({ 
        error: 'Cannot update super admin',
        message: 'Super admin accounts cannot be modified'
      });
    }
    
    // Check if admin exists
    const existingAdmin = await getAdmin(email);
    if (!existingAdmin) {
      return res.status(404).json({ 
        error: 'Admin not found',
        message: `Admin with email ${email} does not exist`
      });
    }
    
    // Build update data
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user.email
    };
    
    if (assignedDistricts !== undefined) {
      updateData.assignedDistricts = assignedDistricts;
    }
    
    if (active !== undefined) {
      updateData.active = active;
    }
    
    // Update admin document
    await admin.firestore()
      .collection('admins')
      .doc(email)
      .update(updateData);
    
    console.log(`✅ Admin updated successfully: ${email}`);
    
    res.json({ 
      success: true,
      message: 'Admin updated successfully',
      email: email,
      updates: updateData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Update admin error:', error);
    res.status(500).json({ 
      error: 'Failed to update admin',
      message: error.message
    });
  }
});

// Delete admin (super admin only)
app.delete('/admin/admins/:email', authenticateUser, requireSuperAdmin, async (req, res) => {
  console.log('🗑️ Delete admin request received:', req.params.email);
  
  try {
    const { email } = req.params;
    
    // Check if email is a super admin
    if (isSuperAdmin(email)) {
      return res.status(400).json({ 
        error: 'Cannot delete super admin',
        message: 'Super admin accounts cannot be deleted'
      });
    }
    
    // Check if admin exists
    const existingAdmin = await getAdmin(email);
    if (!existingAdmin) {
      return res.status(404).json({ 
        error: 'Admin not found',
        message: `Admin with email ${email} does not exist`
      });
    }
    
    // Get user by email to delete from Auth
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
      await admin.auth().deleteUser(userRecord.uid);
    } catch (authError) {
      console.error('Auth deletion error:', authError);
      // Continue to delete from Firestore even if Auth deletion fails
    }
    
    // Delete admin document from Firestore
    await admin.firestore()
      .collection('admins')
      .doc(email)
      .delete();
    
    console.log(`✅ Admin deleted successfully: ${email}`);
    
    res.json({ 
      success: true,
      message: 'Admin deleted successfully',
      email: email,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Delete admin error:', error);
    res.status(500).json({ 
      error: 'Failed to delete admin',
      message: error.message
    });
  }
});

// SOS Alert endpoint
app.post('/sos', async (req, res) => {
  console.log('📡 SOS request received:', req.body);
  
  try {
    const { sender_id, sos_type, location, userInfo, timestamp } = req.body;
    
    // Validate required fields
    if (!sender_id || !sos_type || !location) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['sender_id', 'sos_type', 'location']
      });
    }

    // Check if sender is blocked
    if (await isSenderBlocked(sender_id)) {
      console.log(`🚫 Blocked sender attempted SOS: ${sender_id}`);
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'Your account has been restricted from using this service'
      });
    }

    // Validate sos_type
    if (!['sos_alert', 'stop'].includes(sos_type)) {
      return res.status(400).json({ 
        error: 'Invalid sos_type',
        message: 'sos_type must be either "sos_alert" or "stop"'
      });
    }

    if (sos_type === 'stop') {
      console.log(`🛑 Stopping SOS alert from sender: ${sender_id}`);
      
      // Extract district and user info for stop notification
      const district = userInfo?.district;
      if (!district) {
        return res.status(400).json({ 
          error: 'Missing district in userInfo',
          message: 'district is required for stop notification'
        });
      }
      
      const userName = userInfo?.name || 'Someone';
      const userLocation = userInfo?.location || district.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      // Send stop notification to all devices in the district
      const stopMessage = {
        topic: `district-${district}`,
        notification: {
          title: '✅ Emergency Resolved',
          body: `All good now. ${userName} • ${userLocation}`
        },
        data: {
          type: 'sos_resolved',
          sender_id: sender_id,
          district: district,
          timestamp: timestamp || Date.now().toString()
        },
      android: {
        priority: 'high',  // Critical: Forces immediate delivery bypassing Doze mode
        notification: {
          channelId: 'sos_alerts',  // Use high-importance channel
          icon: 'ic_notification',
          color: '#00FF00',
          sound: 'default',
          priority: 'high'
        }
      },
        apns: {
          headers: {
            'apns-priority': '10'  // High priority for iOS
          },
          payload: {
            aps: {
              contentAvailable: true,
              alert: {
                title: '✅ Emergency Resolved',
                body: `All good now. ${userName} • ${userLocation}`
              },
              sound: 'default',
              badge: 0
            }
          }
        }
      };

      // Send stop FCM message
      const stopResponse = await admin.messaging().send(stopMessage);
      
      console.log('✅ Stop notification sent successfully:', stopResponse);
      
      // Update SOS alert status to inactive in Firestore (optional)
      await storeSOSAlert(sender_id, false);
      
      return res.json({ 
        success: true, 
        message: 'SOS alert stopped successfully',
        messageId: stopResponse,
        senderId: sender_id,
        district: district,
        timestamp: new Date().toISOString()
      });
    }
    else if (sos_type === 'sos_alert') {
      // Extract district from userInfo
      const district = userInfo?.district;
      if (!district) {
        return res.status(400).json({ 
          error: 'Missing district in userInfo',
          message: 'district is required for SOS alert'
        });
      }
      
      console.log(`🚨 Sending SOS alert to district: ${district} (Sender: ${sender_id})`);
      
      // Extract user info for notification
      const userName = userInfo?.name || 'Someone';
      const userLocation = userInfo?.location || district.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      const state = userLocation.split(',').pop().trim().toUpperCase()
      
      // Prepare FCM message
      const message = {
        topic: `district-${district}`,
        notification: {
          title: '🚨 Emergency Alert',
          body: `Help needed. ${userName} • ${userLocation}`
        },
        data: {
          type: 'sos_alert',
          sender_id: sender_id,
          district: district,
          location: JSON.stringify(location),
          timestamp: timestamp || Date.now().toString(),
          userInfo: userInfo ? JSON.stringify(userInfo) : '{}'
        },
        android: {
          priority: 'high',  // Critical: Forces immediate delivery bypassing Doze mode
          notification: {
            channelId: 'sos_alerts',  // Use high-importance channel
            icon: 'ic_notification',
            color: '#FF0000',
            sound: 'default',
            priority: 'high',
            defaultSound: true
          }
        },
        apns: {
          headers: {
            'apns-priority': '10'  // High priority for iOS
          },
          payload: {
            aps: {
              contentAvailable: true, 
              alert: {
                title: '🚨 Emergency Alert',
                body: `Help needed. ${userName} • ${userLocation}`
              },
              sound: 'default',
              badge: 1
            }
          }
        }
      };

      // Send FCM message
      const response = await admin.messaging().send(message);
      
      console.log('✅ SOS alert sent successfully:', response);
      
      // Store SOS alert snapshot in Firestore for admin dashboard (optional)
      await storeSOSAlert(sender_id, true, location, userInfo, district, state);
      
      res.json({ 
        success: true, 
        message: 'SOS alert sent successfully',
        messageId: response,
        topic: `district-${district}`,
        senderId: sender_id,
        district: district,
        timestamp: new Date().toISOString()
      });
    }
    else {
      return res.status(400).json({ 
        error: 'Invalid sos_type',
        message: 'sos_type must be either "sos_alert" or "stop"'
      });
    }
  } catch (error) {
    console.error('❌ SOS send error:', error);
    
    res.status(500).json({ 
      error: 'Failed to send SOS alert',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test push notification endpoint
app.post('/test-push', async (req, res) => {
  console.log('📡 Test push notification request received:', req.body);
  
  try {
    const { district, title, body } = req.body;
    
    // Default to udupi if no district specified
    const targetDistrict = district || 'udupi';
    
    // Generate test sender ID
    const testSenderId = 'test-sender-fid';
    
    // Create test location data (sample coordinates for Udupi)
    const testLocation = {
      latitude: 13.3409,
      longitude: 74.7421,
      accuracy: 10
    };
    
    // Create test user info
    const testUserInfo = {
      name: 'Test User',
      district: targetDistrict,
      location: `${targetDistrict.charAt(0).toUpperCase() + targetDistrict.slice(1)} Test Location`,
      phone: '+91-XXXX-XXXX'
    };
    
    const userName = title || testUserInfo.name;
    const userLocation = body || testUserInfo.location;
    
    console.log(`🧪 Sending test SOS alert to district: ${targetDistrict}`);
    
    // Prepare test FCM message (matching SOS alert structure)
    const message = {
      topic: `district-${targetDistrict}`,
      notification: {
        title: '🧪 Test Emergency Alert',
        body: `Test alert. ${userName} • ${userLocation}`
      },
      data: {
        type: 'sos_alert',
        sender_id: testSenderId,
        district: targetDistrict,
        location: JSON.stringify(testLocation),
        timestamp: Date.now().toString(),
        userInfo: JSON.stringify(testUserInfo)
      },
      android: {
        priority: 'high',  // Critical: Forces immediate delivery bypassing Doze mode
        notification: {
          channelId: 'sos_alerts',  // Use high-importance channel
          icon: 'ic_notification',
          color: '#FF0000',
          sound: 'default',
          priority: 'high',
          defaultSound: true
        }
      },
      apns: {
        headers: {
          'apns-priority': '10'  // High priority for iOS
        },
        payload: {
          aps: {
            contentAvailable: true, 
            alert: {
              title: '🧪 Test Emergency Alert',
              body: `Test SOS alert in ${targetDistrict.toUpperCase()} area`
            },
            sound: 'default',
            badge: 1
          }
        }
      }
    };

    // Send FCM message
    const response = await admin.messaging().send(message);
    
    console.log('✅ Test notification sent successfully:', response);
    
    res.json({ 
      success: true, 
      message: 'Test SOS alert sent successfully',
      messageId: response,
      topic: `district-${targetDistrict}`,
      district: targetDistrict,
      senderId: testSenderId,
      testData: {
        location: testLocation,
        userInfo: testUserInfo
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Test notification error:', error);
    
    res.status(500).json({ 
      error: 'Failed to send test notification',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 404 handler
app.use((req, res) => {  // No path specified here—it's implied as catch-all
  res.status(404).json({ 
    error: 'Endpoint not found',
    availableEndpoints: [
      'GET /health',
      'POST /sos',
      'POST /test-push',
      'POST /admin/block-user',
      'POST /admin/unblock-user',
      'GET /admin/blocked-users',
      'GET /admin/sos-alerts?active=true',
      'GET /admin/profile (auth required)',
      'GET /admin/users (auth required)',
      'GET /admin/admins (super admin only)',
      'POST /admin/admins (super admin only)',
      'PUT /admin/admins/:email (super admin only)',
      'DELETE /admin/admins/:email (super admin only)'
    ]
  });
});

// Error handler (unchanged)
app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: error.message 
  });
});

// Export as Cloud Function (unchanged)
exports.api = functions.https.onRequest(app);

// ============================================================================
// SCHEDULED FUNCTIONS
// ============================================================================

/**
 * Scheduled function to automatically expire old active alerts
 * Runs every hour (configurable via SCHEDULE_CONFIG.ALERT_EXPIRATION_CHECK_INTERVAL)
 * Can be enabled/disabled via FEATURES.ENABLE_SOS_ALERT_SNAPSHOT
 * 
 * Configuration:
 * - ALERT_EXPIRATION_CHECK_INTERVAL: How often to run (default: every 1 hours)
 * - ALERT_EXPIRATION_THRESHOLD_MS: How old alerts must be to expire (default: 1 hour)
 */
exports.expireOldAlertsScheduled = onSchedule({
  schedule: SCHEDULE_CONFIG.ALERT_EXPIRATION_CHECK_INTERVAL,
  timeZone: 'Asia/Kolkata',  // IST timezone
}, async (event) => {
  console.log('⏰ Running scheduled alert expiration check');
  
  try {
    const result = await expireOldAlerts();
    
    console.log('✅ Scheduled alert expiration completed:', result);
    
    return result;
  } catch (error) {
    console.error('❌ Scheduled alert expiration failed:', error);
    throw error;
  }
});