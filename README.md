# RRT Cloud Functions

Backend API for **Rapid Response Team** mobile app - A community-based SOS alert system that sends emergency notifications to nearby users via Firebase Cloud Messaging.

**Firebase Project**: `askrapidresponse@gmail.com`

## What It Does

- 🚨 Sends SOS alerts to users in specific districts via FCM
- 📧 Sends welcome emails to new admins
- 🚫 Blocks/unblocks abusive users
- 📊 Stores alert snapshots for admin dashboard
- 👥 Manages admin accounts and permissions

## Setup

### Prerequisites
- Node.js 24+
- Firebase CLI: `npm install -g firebase-tools`

### Installation

1. **Install dependencies**
```bash
cd functions
npm install
```

2. **Configure environment secrets**

Set Gmail credentials for admin welcome emails:
```bash
firebase functions:secrets:set GMAIL_USER
# Enter: askrapidresponseteam@gmail.com

firebase functions:secrets:set GMAIL_PASS
# Enter: your-app-password
```

View secrets in [Google Cloud Secret Manager](https://console.cloud.google.com/security/secret-manager)

3. **Deploy**
```bash
firebase deploy --only functions
```

### Firestore Setup

Enable Firestore in Firebase Console and apply these security rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /blocked_users/{userId} {
      allow read, write: if false; // Cloud Functions only
    }
    
    match /sos_alerts/{alertId} {
      allow read: if request.auth != null;
      allow write: if false; // Cloud Functions only
    }
    
    match /admins/{email} {
      allow read: if request.auth != null && request.auth.token.email == email;
      allow write: if false; // Cloud Functions only
    }
  }
}
```

## API Endpoints

### Public
- `GET /health` - Health check
- `POST /sos` - Send/stop SOS alert
- `POST /test-push` - Test push notification

### Admin (Auth Required)
- `GET /admin/profile` - Get current admin profile
- `GET /admin/users` - List all users (paginated)
- `POST /admin/block-user` - Block user
- `POST /admin/unblock-user` - Unblock user
- `GET /admin/blocked-users` - List blocked users
- `GET /admin/sos-alerts` - Get all SOS alerts

### Super Admin Only
- `GET /admin/admins` - List all admins
- `POST /admin/admins` - Create new admin
- `PUT /admin/admins/:email` - Update admin
- `DELETE /admin/admins/:email` - Delete admin

## Configuration

### Feature Flags (`functions/index.js`)

```javascript
const FEATURES = {
  ENABLE_SOS_ALERT_SNAPSHOT: true,  // Store alerts in Firestore
  BLOCKED_USERS: true               // Always keep enabled
};
```

### Super Admins (`functions/index.js`)

Edit the `SUPER_ADMINS` array to manage super admin emails:
```javascript
const SUPER_ADMINS = [
  'shamanthknr@gmail.com',
  'karthik.dhanya11@gmail.com',
  'gandhim@exmpls.sansad.in'
];
```

## Local Development

```bash
cd functions
npm run serve
```

## Tech Stack

- Node.js 24 + Express.js
- Firebase Cloud Functions (v2)
- Cloud Firestore
- Firebase Cloud Messaging
- Nodemailer (Gmail SMTP)
