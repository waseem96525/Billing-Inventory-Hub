const STORAGE_KEY = 'billing-inventory-hub-state';
const AUTH_STORAGE_KEY = 'billing-inventory-hub-auth';
const AUTH_USERS_STORAGE_KEY = 'billing-inventory-hub-auth-users';
const REALTIME_CHANNEL = 'billing-inventory-hub-sync';

const DEFAULT_AUTH_USERS = [
  { username: 'admin', password: 'admin123', role: 'admin', displayName: 'Admin' },
  { username: 'cashier', password: 'cashier123', role: 'cashier', displayName: 'Cashier' }
];

let currentView = 'admin';
let currentUser = null;
let authUsers = [];  // Will be populated in initializeApp
let cart = [];
let lastReceipt = null;
let heldBills = [];
let activeDiscount = 0;
let priceOverride = null;
let shopId = 'default-shop'; // Shop ID for multi-device sync
let globalHeldBills = []; // Holds all bills from all devices
let customers = []; // Customer profiles with loyalty points
let selectedCustomerForDetail = null; // Track customer detail view
let returns = []; // Return/refund records
let pendingReturnTransaction = null; // Transaction selected for return
let auditLog = []; // Audit trail records

// ─── Audit Trail Core ─────────────────────────────────────────────────────────
const AUDIT_STORAGE_KEY = 'billing-inventory-hub-audit';
const AUDIT_CATEGORIES = { AUTH: 'auth', SALE: 'sale', RETURN: 'return', INVENTORY: 'inventory', SETTINGS: 'settings', USER: 'user', CART: 'cart' };

function logAudit(action, category, details, metadata = {}) {
  const entry = {
    id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    user: currentUser?.username || 'system',
    role: currentUser?.role || 'unknown',
    action,
    category,
    details,
    metadata
  };
  auditLog.unshift(entry);
  // Keep last 1000 entries to avoid bloat
  if (auditLog.length > 1000) auditLog = auditLog.slice(0, 1000);
  try { window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(auditLog)); } catch (e) {}
  return entry;
}

function loadAuditLog() {
  try {
    const raw = window.localStorage.getItem(AUDIT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// ─── End Audit Core ───────────────────────────────────────────────────────────

// ─── Employee Management ──────────────────────────────────────────────────────
const EMPLOYEES_STORAGE_KEY = 'billing-inventory-hub-employees';
let employees = []; // Employee profile data (linked to authUsers by username)
let selectedEmployeeId = null; // For detail view

function loadEmployees() {
  try {
    const raw = window.localStorage.getItem(EMPLOYEES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveEmployees() {
  try { window.localStorage.setItem(EMPLOYEES_STORAGE_KEY, JSON.stringify(employees)); } catch (e) {}
}

function getEmployeePerformance(username, state) {
  const userTransactions = (state.transactions || []).filter(t => t.cashierName === username);
  const totalSales = userTransactions.reduce((s, t) => s + t.total, 0);
  const txnCount = userTransactions.length;
  const avgBill = txnCount > 0 ? totalSales / txnCount : 0;
  const lastActive = userTransactions.length > 0 ? userTransactions[0].timestamp : null;
  return { totalSales, txnCount, avgBill, lastActive };
}

function renderEmployees(state) {
  const listView = document.getElementById('emp-list-view');
  const detailView = document.getElementById('emp-detail-view');
  const cardsGrid = document.getElementById('emp-cards-grid');
  const statsStrip = document.getElementById('emp-stats-strip');
  if (!cardsGrid) return;

  if (selectedEmployeeId) {
    listView.classList.add('hidden');
    detailView.classList.remove('hidden');
    renderEmployeeDetail(selectedEmployeeId, state);
    return;
  }
  listView.classList.remove('hidden');
  detailView.classList.add('hidden');

  // Stats strip
  const active = employees.filter(e => e.status === 'active').length;
  const inactive = employees.filter(e => e.status !== 'active').length;
  const totalEmployees = employees.length;
  if (statsStrip) {
    statsStrip.innerHTML = `
      <div class="emp-stat"><span class="emp-stat-val">${totalEmployees}</span><span class="emp-stat-label">Total</span></div>
      <div class="emp-stat"><span class="emp-stat-val emp-active">${active}</span><span class="emp-stat-label">Active</span></div>
      <div class="emp-stat"><span class="emp-stat-val emp-inactive">${inactive}</span><span class="emp-stat-label">Inactive/Leave</span></div>
    `;
  }

  const search = (document.getElementById('emp-search')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('emp-status-filter')?.value || 'all';

  let filtered = employees;
  if (search) filtered = filtered.filter(e =>
    e.fullName.toLowerCase().includes(search) ||
    e.username.toLowerCase().includes(search) ||
    (e.position || '').toLowerCase().includes(search)
  );
  if (statusFilter !== 'all') filtered = filtered.filter(e => e.status === statusFilter);

  if (!filtered.length) {
    cardsGrid.innerHTML = `<div class="emp-empty">${employees.length === 0 ? '👥 No employees yet. Click "Add Employee" to get started.' : 'No employees match your search.'}</div>`;
    return;
  }

  // Fill branch select in emp form
  const empBranchSelect = document.getElementById('emp-branch');
  if (empBranchSelect && empBranchSelect.options.length === 0) {
    state.branches.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id; opt.textContent = b.name;
      empBranchSelect.appendChild(opt);
    });
  }

  const statusConfig = {
    active: { label: 'Active', cls: 'emp-badge-active' },
    inactive: { label: 'Inactive', cls: 'emp-badge-inactive' },
    on_leave: { label: 'On Leave', cls: 'emp-badge-leave' }
  };

  cardsGrid.innerHTML = filtered.map(emp => {
    const perf = getEmployeePerformance(emp.username, state);
    const branch = state.branches.find(b => b.id === emp.branchId);
    const cfg = statusConfig[emp.status] || statusConfig.active;
    const initials = emp.fullName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return `
      <div class="emp-card" data-emp-id="${emp.id}">
        <div class="emp-card-header">
          <div class="emp-avatar">${initials}</div>
          <div class="emp-card-info">
            <strong>${escapeHtml(emp.fullName)}</strong>
            <div class="emp-username">@${escapeHtml(emp.username)}</div>
          </div>
          <span class="emp-badge ${cfg.cls}">${cfg.label}</span>
        </div>
        <div class="emp-card-meta">
          <span>${escapeHtml(emp.role)}</span>
          ${emp.position ? `<span>• ${escapeHtml(emp.position)}</span>` : ''}
          ${branch ? `<span>• ${escapeHtml(branch.name)}</span>` : ''}
        </div>
        <div class="emp-perf-row">
          <div class="emp-perf-stat"><span class="emp-perf-val">${perf.txnCount}</span><span>Sales</span></div>
          <div class="emp-perf-stat"><span class="emp-perf-val">${formatCurrency(perf.totalSales)}</span><span>Revenue</span></div>
          <div class="emp-perf-stat"><span class="emp-perf-val">${formatCurrency(perf.avgBill)}</span><span>Avg Bill</span></div>
        </div>
        ${emp.phone ? `<div class="emp-contact">📱 ${escapeHtml(emp.phone)}</div>` : ''}
        <div class="emp-card-actions">
          <button class="emp-view-btn" data-emp-id="${emp.id}">View Profile</button>
          <button class="emp-edit-btn" data-emp-id="${emp.id}">Edit</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderEmployeeDetail(empId, state) {
  const emp = employees.find(e => e.id === empId);
  const container = document.getElementById('emp-detail-content');
  if (!emp || !container) return;

  const perf = getEmployeePerformance(emp.username, state);
  const branch = state.branches.find(b => b.id === emp.branchId);
  const statusConfig = { active: { label: 'Active', cls: 'emp-badge-active' }, inactive: { label: 'Inactive', cls: 'emp-badge-inactive' }, on_leave: { label: 'On Leave', cls: 'emp-badge-leave' } };
  const cfg = statusConfig[emp.status] || statusConfig.active;
  const initials = emp.fullName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  // Get recent transactions for this employee
  const empTxns = (state.transactions || []).filter(t => t.cashierName === emp.username).slice(0, 10);

  container.innerHTML = `
    <div class="emp-detail-card">
      <div class="emp-detail-header">
        <div class="emp-avatar-lg">${initials}</div>
        <div class="emp-detail-info">
          <h3>${escapeHtml(emp.fullName)}</h3>
          <div class="emp-detail-sub">@${escapeHtml(emp.username)} · ${escapeHtml(emp.role)}</div>
          ${emp.position ? `<div class="emp-detail-sub">${escapeHtml(emp.position)}</div>` : ''}
          <span class="emp-badge ${cfg.cls}" style="margin-top:8px">${cfg.label}</span>
        </div>
        <button class="emp-edit-detail-btn emp-edit-btn" data-emp-id="${emp.id}" style="align-self:flex-start">✏️ Edit</button>
      </div>

      <div class="emp-detail-meta-grid">
        ${emp.phone ? `<div><strong>📱 Phone</strong><span>${escapeHtml(emp.phone)}</span></div>` : ''}
        ${emp.email ? `<div><strong>✉️ Email</strong><span>${escapeHtml(emp.email)}</span></div>` : ''}
        ${branch ? `<div><strong>🏬 Branch</strong><span>${escapeHtml(branch.name)}</span></div>` : ''}
        ${emp.joiningDate ? `<div><strong>📅 Joined</strong><span>${escapeHtml(emp.joiningDate)}</span></div>` : ''}
        ${emp.notes ? `<div style="grid-column:1/-1"><strong>📝 Notes</strong><span>${escapeHtml(emp.notes)}</span></div>` : ''}
      </div>

      <div class="emp-perf-banner">
        <div class="emp-perf-stat-lg"><span class="emp-perf-val-lg">${perf.txnCount}</span><span>Total Transactions</span></div>
        <div class="emp-perf-stat-lg"><span class="emp-perf-val-lg">${formatCurrency(perf.totalSales)}</span><span>Total Revenue</span></div>
        <div class="emp-perf-stat-lg"><span class="emp-perf-val-lg">${formatCurrency(perf.avgBill)}</span><span>Avg Bill Value</span></div>
        <div class="emp-perf-stat-lg"><span class="emp-perf-val-lg">${perf.lastActive ? new Date(perf.lastActive).toLocaleDateString() : '—'}</span><span>Last Active</span></div>
      </div>

      <div class="emp-txn-section">
        <h4>Recent Transactions</h4>
        ${empTxns.length === 0
          ? '<p class="muted" style="padding:12px 0">No transactions recorded for this employee yet.</p>'
          : `<table class="emp-txn-table">
              <thead><tr><th>Bill #</th><th>Date</th><th>Items</th><th>Total</th><th>Payment</th></tr></thead>
              <tbody>${empTxns.map(t => `
                <tr>
                  <td>${escapeHtml(t.billNumber || t.id)}</td>
                  <td>${escapeHtml(t.timestamp)}</td>
                  <td>${t.items.map(i => `${i.name}×${i.qty}`).join(', ')}</td>
                  <td>${formatCurrency(t.total)}</td>
                  <td>${escapeHtml(t.paymentMethod)}</td>
                </tr>`).join('')}</tbody>
             </table>`}
      </div>

      <div class="emp-danger-zone">
        <h4>⚠️ Danger Zone</h4>
        <button class="emp-delete-btn" data-emp-id="${emp.id}" data-username="${escapeHtml(emp.username)}">🗑️ Remove Employee</button>
      </div>
    </div>
  `;
}

function openEmpForm(emp = null) {
  const card = document.getElementById('emp-form-card');
  document.getElementById('emp-form-title').textContent = emp ? 'Edit Employee' : 'Add New Employee';
  document.getElementById('emp-fullname').value = emp?.fullName || '';
  document.getElementById('emp-username').value = emp?.username || '';
  document.getElementById('emp-password').value = '';
  document.getElementById('emp-password').placeholder = emp ? 'Leave blank to keep current' : 'Password';
  document.getElementById('emp-role').value = emp?.role || 'cashier';
  document.getElementById('emp-phone').value = emp?.phone || '';
  document.getElementById('emp-email').value = emp?.email || '';
  document.getElementById('emp-position').value = emp?.position || '';
  document.getElementById('emp-joining').value = emp?.joiningDate || '';
  document.getElementById('emp-status').value = emp?.status || 'active';
  document.getElementById('emp-notes').value = emp?.notes || '';
  document.getElementById('emp-form-error').textContent = '';
  card.dataset.editId = emp?.id || '';
  card.classList.remove('hidden');
  document.getElementById('emp-fullname').focus();
}

// ─── End Employee Management ──────────────────────────────────────────────────

let shopProfile = {
  shopName: 'Billing & Inventory Hub',
  ownerName: '',
  phone: '',
  email: '',
  address: '',
  gst: '',
  website: '',
  footer: 'Thank you for shopping with us!',
  taxName: 'GST',
  taxRate: 0,
  receiptPrefix: 'INV',
  nextReceiptNumber: 1001,
  printLayout: 'standard'
};

function formatCurrency(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2
  }).format(value);
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function openDBAsync() {
  if (typeof window === 'undefined' || !window.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open('billing-hub-db', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  if (typeof window === 'undefined' || !window.indexedDB) return;
  try {
    const db = await openDBAsync();
    if (!db) return;
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    store.put(value, key);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch (e) {
    console.warn('IndexedDB set failed', e);
  }
}

async function dbGet(key) {
  if (typeof window === 'undefined' || !window.indexedDB) return null;
  try {
    const db = await openDBAsync();
    if (!db) return null;
    return await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const req = store.get(key);
      req.onsuccess = () => {
        res(req.result);
        db.close();
      };
      req.onerror = () => {
        rej(req.error);
        db.close();
      };
    });
  } catch (e) {
    console.warn('IndexedDB get failed', e);
    return null;
  }
}

async function dbDelete(key) {
  if (typeof window === 'undefined' || !window.indexedDB) return;
  try {
    const db = await openDBAsync();
    if (!db) return;
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    store.delete(key);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch (e) {
    console.warn('IndexedDB delete failed', e);
  }
}

// Firebase Realtime Database sync (client-side). Guarded so tests/node don't execute.
let firebaseEnabled = false;
let firebaseDatabaseRef = null;
let firebaseListener = null;
let lastCloudSaveTime = 0;
let isApplyingRemoteState = false;  // Flag to prevent recursive saves
let cloudSaveTimeout = null;

const firebaseConfig = {
  apiKey: "AIzaSyCBi6GCigBZx5yRTTTW8SXHzSkA1uTAvpM",
  authDomain: "billingsol-e9a83.firebaseapp.com",
  databaseURL: "https://billingsol-e9a83-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "billingsol-e9a83",
  storageBucket: "billingsol-e9a83.firebasestorage.app",
  messagingSenderId: "436716611232",
  appId: "1:436716611232:web:e185ad817d4a67d0f94bc5",
  measurementId: "G-7RG9H1C0BM"
};

function firebaseInit() {
  if (typeof window === 'undefined' || typeof window.firebase === 'undefined') return;
  try {
    if (!window.firebase.apps || !window.firebase.apps.length) {
      window.firebase.initializeApp(firebaseConfig);
    }
    firebaseEnabled = true;
  } catch (e) {
    console.warn('Firebase init failed', e);
    firebaseEnabled = false;
  }
}

function cloudSaveState(state, username) {
  if (!firebaseEnabled || !username || isApplyingRemoteState) return;
  
  try {
    // Debounce: don't save more than once per 500ms
    const now = Date.now();
    if (now - lastCloudSaveTime < 500) {
      // Clear existing timeout and set a new one
      if (cloudSaveTimeout) clearTimeout(cloudSaveTimeout);
      cloudSaveTimeout = setTimeout(() => {
        cloudSaveState(state, username);
      }, 500);
      return;
    }
    
    lastCloudSaveTime = now;
    const ref = window.firebase.database().ref(`/users/${encodeURIComponent(username)}/state`);
    const payload = { 
      state, 
      lastUpdated: Date.now(),
      device: Math.random().toString(36).substr(2, 9)  // device ID to detect conflicts
    };
    ref.set(payload).catch((e) => console.warn('cloudSaveState failed', e));
  } catch (e) {
    console.warn('cloudSaveState error', e);
  }
}

function cloudLoadInitialState(username) {
  if (!firebaseEnabled || !username) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const ref = window.firebase.database().ref(`/users/${encodeURIComponent(username)}/state`);
      ref.once('value', (snap) => {
        if (snap.exists()) {
          const val = snap.val();
          resolve(val.state || val);
        } else {
          resolve(null);
        }
      }).catch((e) => {
        console.warn('cloudLoadInitialState failed', e);
        resolve(null);
      });
    } catch (e) {
      console.warn('cloudLoadInitialState error', e);
      resolve(null);
    }
  });
}

function cloudSubscribe(username, onUpdate) {
  if (!firebaseEnabled || !username) return;
  try {
    const ref = window.firebase.database().ref(`/users/${encodeURIComponent(username)}/state`);
    firebaseDatabaseRef = ref;
    firebaseListener = ref.on('value', (snap) => {
      const val = snap.val();
      if (!val) return;
      try {
        // Set flag to prevent recursive saves when applying remote state
        isApplyingRemoteState = true;
        onUpdate(val.state || val);
        // Reset flag after a tick
        setTimeout(() => { isApplyingRemoteState = false; }, 100);
      } catch (e) { console.warn('cloud update handler failed', e); }
    });
  } catch (e) {
    console.warn('cloudSubscribe error', e);
  }
}

function cloudUnsubscribe() {
  try {
    if (firebaseDatabaseRef && firebaseListener) {
      firebaseDatabaseRef.off('value', firebaseListener);
    }
  } catch (e) { }
  firebaseDatabaseRef = null;
  firebaseListener = null;
}

function cloudSaveAuthUsers(users) {
  if (!firebaseEnabled) return;
  try {
    const ref = window.firebase.database().ref('/global/authUsers');
    ref.set({ users, lastUpdated: Date.now() }).catch((e) => console.warn('cloudSaveAuthUsers failed', e));
  } catch (e) {
    console.warn('cloudSaveAuthUsers error', e);
  }
}

function cloudLoadAuthUsers() {
  if (!firebaseEnabled) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const ref = window.firebase.database().ref('/global/authUsers');
      ref.once('value', (snap) => {
        if (snap.exists()) {
          const val = snap.val();
          resolve(val.users || null);
        } else {
          resolve(null);
        }
      }).catch((e) => {
        console.warn('cloudLoadAuthUsers failed', e);
        resolve(null);
      });
    } catch (e) {
      console.warn('cloudLoadAuthUsers error', e);
      resolve(null);
    }
  });
}

// Device ID for tracking which device the bill came from
function getDeviceId() {
  if (typeof window === 'undefined') return 'node-env';
  let deviceId = localStorage.getItem('device-id');
  if (!deviceId) {
    deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('device-id', deviceId);
  }
  return deviceId;
}

// Cloud sync for held bills (shared across all devices in shop)
function cloudSaveHeldBills(bills, shopId = 'default-shop') {
  if (!firebaseEnabled) return;
  try {
    const ref = window.firebase.database().ref(`/shops/${shopId}/heldBills`);
    const billsWithMetadata = bills.map((bill, idx) => ({
      ...bill,
      id: bill.id || `bill_${Date.now()}_${idx}`,
      deviceId: bill.deviceId || getDeviceId(),
      cashier: bill.cashier || currentUser?.displayName || 'Unknown',
      createdAt: bill.createdAt || Date.now(),
      status: bill.status || 'open'
    }));
    ref.set(billsWithMetadata).catch((e) => console.warn('cloudSaveHeldBills failed', e));
  } catch (e) {
    console.warn('cloudSaveHeldBills error', e);
  }
}

function cloudLoadHeldBills(shopId = 'default-shop') {
  if (!firebaseEnabled) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const ref = window.firebase.database().ref(`/shops/${shopId}/heldBills`);
      ref.once('value', (snap) => {
        if (snap.exists()) {
          const val = snap.val();
          resolve(Array.isArray(val) ? val : Object.values(val));
        } else {
          resolve([]);
        }
      }).catch((e) => {
        console.warn('cloudLoadHeldBills error', e);
        resolve([]);
      });
    } catch (e) {
      console.warn('cloudLoadHeldBills error', e);
      resolve([]);
    }
  });
}

let heldBillsListener = null;
function cloudSubscribeHeldBills(shopId = 'default-shop', onUpdate) {
  if (!firebaseEnabled) return;
  try {
    const ref = window.firebase.database().ref(`/shops/${shopId}/heldBills`);
    heldBillsListener = ref.on('value', (snap) => {
      const val = snap.val();
      const bills = val ? (Array.isArray(val) ? val : Object.values(val)) : [];
      onUpdate(bills);
    });
  } catch (e) {
    console.warn('cloudSubscribeHeldBills error', e);
  }
}

function cloudUnsubscribeHeldBills(shopId = 'default-shop') {
  if (!firebaseEnabled) return;
  try {
    const ref = window.firebase.database().ref(`/shops/${shopId}/heldBills`);
    ref.off();
  } catch (e) { }
}

function loadAuthUsers() {
  if (typeof window === 'undefined') return [...DEFAULT_AUTH_USERS];
  const raw = window.localStorage.getItem(AUTH_USERS_STORAGE_KEY);
  if (!raw) return [...DEFAULT_AUTH_USERS];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : [...DEFAULT_AUTH_USERS];
  } catch {
    return [...DEFAULT_AUTH_USERS];
  }
}

function persistAuthUsers(users) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUTH_USERS_STORAGE_KEY, JSON.stringify(users));
  } catch (e) {}
  dbSet(AUTH_USERS_STORAGE_KEY, JSON.stringify(users)).catch(() => {});
  // Also sync to Firebase if enabled
  if (firebaseEnabled) {
    cloudSaveAuthUsers(users);
  }
}

export function authenticateUser(username, password) {
  const entry = authUsers.find((user) => user.username === username && user.password === password);
  if (!entry) return null;
  return { username: entry.username, role: entry.role, displayName: entry.displayName };
}

export function updateUserCredentials(currentUsername, currentPassword, newUsername, newPassword) {
  const trimmedUsername = String(newUsername || '').trim();
  const trimmedPassword = String(newPassword || '').trim();

  if (!trimmedUsername || !trimmedPassword) {
    return { success: false, message: 'Please enter a new username and password.' };
  }

  const existingUser = authUsers.find((user) => user.username === currentUsername && user.password === currentPassword);
  if (!existingUser) {
    return { success: false, message: 'Current password is incorrect.' };
  }

  const duplicate = authUsers.some((user) => user.username === trimmedUsername && user.username !== currentUsername);
  if (duplicate) {
    return { success: false, message: 'That username is already taken.' };
  }

  authUsers = authUsers.map((user) => {
    if (user.username === currentUsername) {
      return { ...user, username: trimmedUsername, password: trimmedPassword };
    }
    return user;
  });
  persistAuthUsers(authUsers);
  return {
    success: true,
    message: 'Login credentials updated.',
    user: { username: trimmedUsername, role: existingUser.role, displayName: existingUser.displayName }
  };
}

export function addUser(username, password, role) {
  const trimmedUsername = String(username || '').trim();
  const trimmedPassword = String(password || '').trim();

  if (!trimmedUsername || !trimmedPassword) {
    return { success: false, message: 'Username and password required.' };
  }

  if (authUsers.some((user) => user.username === trimmedUsername)) {
    return { success: false, message: 'Username already exists.' };
  }

  const newUser = {
    username: trimmedUsername,
    password: trimmedPassword,
    role: role || 'cashier',
    displayName: trimmedUsername.charAt(0).toUpperCase() + trimmedUsername.slice(1)
  };

  authUsers.push(newUser);
  persistAuthUsers(authUsers);
  return { success: true, message: `User ${trimmedUsername} created successfully.` };
}

export function deleteUser(username) {
  if (username === 'admin' || username === 'cashier') {
    return { success: false, message: 'Cannot delete default users.' };
  }

  authUsers = authUsers.filter((user) => user.username !== username);
  persistAuthUsers(authUsers);
  return { success: true, message: `User ${username} deleted.` };
}

function getStoredAuth() {
  if (typeof window === 'undefined') return null;
  // try localStorage first for synchronous access
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return authenticateUser(parsed.username, parsed.password) ? parsed : null;
    }
  } catch (e) {
    // continue to indexedDB fallback
  }
  // As a fallback, attempt to read from IndexedDB (async but we return null here).
  // The app will re-hydrate auth after DB load during initialization.
  return null;
}

function persistAuth(user, password, rememberMe = false) {
  if (typeof window === 'undefined') return;
  if (user && password) {
    try {
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ username: user, password, rememberMe }));
    } catch (e) {}
    dbSet(AUTH_STORAGE_KEY, JSON.stringify({ username: user, password, rememberMe })).catch(() => {});
  } else {
    try { window.localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) {}
    dbDelete(AUTH_STORAGE_KEY).catch(() => {});
  }
}

function shouldAutoLogin() {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed.rememberMe === true;
  } catch (e) {
    return false;
  }
}

export function buildReceiptHtml(receipt = {}, branchName = 'Store') {
  const profile = receipt.shopProfile || shopProfile || {};
  const items = (receipt.items || []).map((entry) => `
    <tr>
      <td>${escapeHtml(entry.name)}${entry.hsnCode ? `<br><small style="color:#888">HSN: ${escapeHtml(entry.hsnCode)}</small>` : ''}</td>
      <td>${entry.qty}</td>
      <td>${formatCurrency(entry.price || 0)}</td>
      ${entry.itemTaxRate !== undefined ? `<td>${entry.itemTaxRate}%</td>` : '<td>-</td>'}
    </tr>`).join('');

  const subtotal = Number(receipt.subtotal || 0);
  const discountPercent = Number(receipt.discountPercent || 0);
  const discountAmount = Number(receipt.discountAmount || subtotal * (discountPercent / 100));
  const taxRate = Number(receipt.taxRate || profile.taxRate || 0);
  const taxAmount = Number(receipt.taxAmount || (taxRate > 0 ? subtotal * (taxRate / 100) : 0));
  const taxLabel = receipt.taxLabel || profile.taxName || 'Tax';
  const taxType = receipt.taxType || profile.taxType || 'gst';
  const billNumber = receipt.billNumber || receipt.id || 'POS';
  const layout = receipt.layout || profile.printLayout || 'standard';
  const total = Number(receipt.total || subtotal - discountAmount + taxAmount);

  // Build tax breakdown for receipt
  let taxLinesHTML = '';
  if (receipt.taxSlabs && receipt.taxSlabs.length > 0 && taxType === 'gst') {
    taxLinesHTML = receipt.taxSlabs
      .filter(s => s.tax > 0)
      .map(s => `
        <div><span>CGST @ ${s.rate/2}%</span><strong>${formatCurrency(s.tax/2)}</strong></div>
        <div><span>SGST @ ${s.rate/2}%</span><strong>${formatCurrency(s.tax/2)}</strong></div>
      `).join('');
  } else if (taxAmount > 0) {
    taxLinesHTML = `<div><span>${escapeHtml(taxLabel)} (${taxRate}%)</span><strong>${formatCurrency(taxAmount)}</strong></div>`;
  }

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>Receipt</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
        body[data-layout="compact"] { padding: 16px; font-size: 13px; }
        h1 { margin-bottom: 4px; }
        .meta { color: #555; font-size: 14px; margin-bottom: 10px; }
        body[data-layout="compact"] .meta { font-size: 12px; margin-bottom: 6px; }
        table { width: 100%; border-collapse: collapse; margin: 12px 0; }
        th, td { padding: 8px 6px; border-bottom: 1px solid #ddd; text-align: left; }
        .totals { margin-top: 12px; font-size: 15px; }
        .totals div { display: flex; justify-content: space-between; margin: 4px 0; }
      </style>
    </head>
    <body data-layout="${escapeHtml(layout)}">
      <h1>${escapeHtml(profile.shopName || 'Billing & Inventory Hub')}</h1>
      <div class="meta">Owner: ${escapeHtml(profile.ownerName || 'N/A')}</div>
      <div class="meta">Phone: ${escapeHtml(profile.phone || 'N/A')}</div>
      <div class="meta">Address: ${escapeHtml(profile.address || 'N/A')}</div>
      <div class="meta">GST: ${escapeHtml(profile.gst || 'N/A')}</div>
      <div class="meta">Branch: ${escapeHtml(branchName)}</div>
      <div class="meta">Bill: ${escapeHtml(billNumber)}</div>
      <div class="meta">Invoice: ${escapeHtml(receipt.id || 'POS')}</div>
      <div class="meta">Date: ${escapeHtml(receipt.timestamp || new Date().toLocaleString())}</div>
      <div class="meta">Payment: ${escapeHtml(receipt.paymentMethod || 'Cash')}</div>
      ${receipt.splitPayments && receipt.splitPayments.length > 1
        ? receipt.splitPayments.map(p => `<div class="meta">&nbsp;&nbsp;↳ ${escapeHtml(p.method)}: ${formatCurrency(p.amount)}</div>`).join('')
        : ''}
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Tax%</th></tr></thead>
        <tbody>${items}</tbody>
      </table>
      <div class="totals">
        <div><span>Subtotal</span><strong>${formatCurrency(subtotal)}</strong></div>
        <div><span>Discount (${discountPercent}%)</span><strong>-${formatCurrency(discountAmount)}</strong></div>
        ${taxLinesHTML}
        <div style="border-top:2px solid #000;margin-top:4px;padding-top:4px"><span><strong>Total</strong></span><strong>${formatCurrency(total)}</strong></div>
      </div>
      <div class="meta" style="margin-top:16px">${escapeHtml(profile.footer || 'Thank you for shopping with us!')}</div>
    </body>
  </html>`;
}

export function createInitialState() {
  return {
    branches: [
      { id: 'branch-1', name: 'Downtown Store', location: 'Downtown', contact: '0412-555-000' },
      { id: 'branch-2', name: 'North Plaza', location: 'North District', contact: '0412-555-111' }
    ],
    inventory: [
      { id: 'item-1', branchId: 'branch-1', sku: 'SKU001', barcode: '8901234567001', name: 'Milk', category: 'Dairy', brand: 'FreshMart', unit: 'Litre', costPrice: 35, mrp: 50, sellingPrice: 45, description: 'Fresh pasteurized milk', stock: 20, lowStock: 5 },
      { id: 'item-2', branchId: 'branch-1', sku: 'SKU002', barcode: '8901234567002', name: 'Bread', category: 'Bakery', brand: 'DailyBake', unit: 'Pack', costPrice: 20, mrp: 32, sellingPrice: 28, description: 'Soft sandwich bread', stock: 10, lowStock: 3 },
      { id: 'item-3', branchId: 'branch-2', sku: 'SKU003', barcode: '8901234567003', name: 'Coffee', category: 'Beverages', brand: 'BeanHouse', unit: 'Pack', costPrice: 70, mrp: 110, sellingPrice: 95, description: 'Arabica coffee beans', stock: 15, lowStock: 4 }
    ],
    transactions: [
      { id: 'txn-1', branchId: 'branch-1', timestamp: '2026-07-01 09:30', total: 90, paymentMethod: 'Cash', items: [{ name: 'Milk', qty: 2 }] }
    ],
    shopProfile: {
      shopName: 'Billing & Inventory Hub',
      ownerName: 'Aarav Sharma',
      phone: '+91 98765 43210',
      email: 'hello@billinghub.com',
      address: '123 Market Street, Delhi',
      gst: '29ABCDE1234F1Z5',
      website: 'www.billinghub.com',
      footer: 'Thank you for shopping with us!',
      taxName: 'GST',
      taxRate: 0,
      receiptPrefix: 'INV',
      nextReceiptNumber: 1001,
      printLayout: 'standard'
    }
  };
}

export function loadState() {
  if (typeof window === 'undefined') return createInitialState();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return createInitialState();
  try {
    const parsed = JSON.parse(raw);
    return {
      ...createInitialState(),
      ...parsed,
      branches: parsed.branches || createInitialState().branches,
      inventory: parsed.inventory || createInitialState().inventory,
      transactions: parsed.transactions || createInitialState().transactions,
      shopProfile: parsed.shopProfile || createInitialState().shopProfile
    };
  } catch {
    return createInitialState();
  }
}

export function saveState(state) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // ignore
  }
  // persist to IndexedDB asynchronously for more robust local storage
  dbSet(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
  // also try to persist to Firebase for cross-device sync when signed in
  try {
    if (typeof currentUser !== 'undefined' && currentUser && firebaseEnabled) {
      cloudSaveState(state, currentUser.username);
    }
  } catch (e) {}
  if (typeof window.BroadcastChannel !== 'undefined') {
    const channel = new window.BroadcastChannel(REALTIME_CHANNEL);
    channel.postMessage({ type: 'state-update', state });
    channel.close();
  }
}

export function addBranch(state, payload) {
  const branch = {
    id: `branch-${Date.now()}`,
    name: payload.name,
    location: payload.location,
    contact: payload.contact || 'Pending'
  };
  return { ...state, branches: [...state.branches, branch] };
}

export function addInventoryItem(state, payload) {
  const item = {
    id: `item-${Date.now()}`,
    branchId: payload.branchId,
    sku: payload.sku,
    barcode: payload.barcode,
    name: payload.name,
    category: payload.category,
    brand: payload.brand,
    unit: payload.unit,
    costPrice: Number(payload.costPrice),
    mrp: Number(payload.mrp),
    sellingPrice: Number(payload.sellingPrice),
    description: payload.description,
    stock: Number(payload.stock),
    lowStock: Number(payload.lowStock),
    hsnCode: payload.hsnCode || '',
    itemTaxRate: payload.itemTaxRate !== undefined ? Number(payload.itemTaxRate) : undefined,
    taxInclusive: payload.taxInclusive || 'exclusive'
  };
  return { ...state, inventory: [...state.inventory, item] };
}

export function getInventoryForBranch(state, branchId) {
  return state.inventory.filter((item) => item.branchId === branchId);
}

// Held Bills Management Functions
export function addHeldBill(items, branchId, discount = 0) {
  const bill = {
    id: `bill_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    items: [...items],
    branchId,
    discount,
    deviceId: getDeviceId(),
    cashier: currentUser?.displayName || 'Unknown',
    createdAt: Date.now(),
    status: 'open'
  };
  heldBills.push(bill);
  globalHeldBills.push(bill);
  cloudSaveHeldBills(globalHeldBills, shopId);
  return bill;
}

export function removeHeldBill(billId) {
  heldBills = heldBills.filter((b) => b.id !== billId);
  globalHeldBills = globalHeldBills.filter((b) => b.id !== billId);
  cloudSaveHeldBills(globalHeldBills, shopId);
}

export function restoreHeldBill(billId) {
  const bill = globalHeldBills.find((b) => b.id === billId);
  if (!bill) return false;
  cart = [...bill.items];
  activeDiscount = bill.discount || 0;
  removeHeldBill(billId);
  return true;
}

export function transferHeldBill(billId, toCashier) {
  const bill = globalHeldBills.find((b) => b.id === billId);
  if (!bill) return false;
  bill.cashier = toCashier;
  bill.transferredAt = Date.now();
  cloudSaveHeldBills(globalHeldBills, shopId);
  return true;
}

export function checkoutCart(state, branchId, paymentMethod, cashierName = 'Cashier', discountPercent = 0, splitPayments = null) {
  const selectedItems = cart.filter((entry) => entry.branchId === branchId);
  if (!selectedItems.length) {
    return { success: false, message: 'Cart is empty.' };
  }

  const inventory = [...state.inventory];
  for (const entry of selectedItems) {
    const item = inventory.find((candidate) => candidate.id === entry.id);
    if (!item || item.stock < entry.qty) {
      return { success: false, message: `Insufficient stock for ${entry.name}.` };
    }
    item.stock -= entry.qty;
  }

  const subtotal = selectedItems.reduce((sum, entry) => sum + entry.qty * entry.price, 0);
  const discountAmount = subtotal * (discountPercent / 100);
  const discountedSubtotal = subtotal - discountAmount;
  const profile = state.shopProfile || {};
  const globalTaxRate = Number(profile.taxRate || 0);
  const taxType = profile.taxType || 'gst'; // 'gst', 'vat', 'none'
  const taxInclusive = profile.taxInclusive || 'exclusive';

  // Per-item tax calculation (use item taxRate if set, else global)
  let taxSlabs = {}; // { '18': { taxable: 0, taxAmount: 0 }, ... }
  let totalTaxAmount = 0;

  selectedItems.forEach(entry => {
    const invItem = state.inventory.find(i => i.id === entry.id);
    const itemTaxRate = invItem?.itemTaxRate !== undefined ? Number(invItem.itemTaxRate) : globalTaxRate;
    const itemInclusive = invItem?.taxInclusive || taxInclusive;
    const lineTotal = entry.qty * entry.price * (1 - discountPercent / 100);

    let taxableAmount, taxAmt;
    if (itemInclusive === 'inclusive' && itemTaxRate > 0) {
      // Back-calculate: taxable = price / (1 + rate/100)
      taxableAmount = lineTotal / (1 + itemTaxRate / 100);
      taxAmt = lineTotal - taxableAmount;
    } else {
      taxableAmount = lineTotal;
      taxAmt = lineTotal * (itemTaxRate / 100);
    }

    totalTaxAmount += taxAmt;
    const slabKey = String(itemTaxRate);
    if (!taxSlabs[slabKey]) taxSlabs[slabKey] = { rate: itemTaxRate, taxable: 0, tax: 0 };
    taxSlabs[slabKey].taxable += taxableAmount;
    taxSlabs[slabKey].tax += taxAmt;
  });

  // For inclusive pricing, subtotal is already tax-included, so adjust
  const finalTotal = taxInclusive === 'inclusive'
    ? discountedSubtotal  // total is already final
    : discountedSubtotal + totalTaxAmount;

  const receiptPrefix = String(profile.receiptPrefix || 'INV').trim() || 'INV';
  const nextReceiptNumber = Number(profile.nextReceiptNumber || 1001);
  const billNumber = `${receiptPrefix}${receiptPrefix.endsWith('-') ? '' : '-'}${nextReceiptNumber}`;

  // Validate split payments if provided
  if (splitPayments && splitPayments.length > 0) {
    const splitTotal = splitPayments.reduce((s, p) => s + p.amount, 0);
    if (Math.abs(splitTotal - finalTotal) > 0.01) {
      return { success: false, message: `Split payment total (${formatCurrency(splitTotal)}) must equal bill total (${formatCurrency(finalTotal)}).` };
    }
  }

  // Build payment label for display
  const effectivePaymentMethod = splitPayments && splitPayments.length > 1
    ? splitPayments.map(p => p.method).join(' + ')
    : paymentMethod;

  const transaction = {
    id: `txn-${Date.now()}`,
    branchId,
    timestamp: new Date().toLocaleString(),
    subtotal,
    discountPercent,
    discountAmount,
    taxRate: globalTaxRate,
    taxAmount: totalTaxAmount,
    taxSlabs: Object.values(taxSlabs),
    taxType,
    total: finalTotal,
    billNumber,
    paymentMethod: effectivePaymentMethod,
    splitPayments: splitPayments && splitPayments.length > 1 ? splitPayments : null,
    cashierName,
    items: selectedItems.map((entry) => {
      const invItem = state.inventory.find(i => i.id === entry.id);
      return {
        name: entry.name,
        qty: entry.qty,
        price: entry.price,
        hsnCode: invItem?.hsnCode || '',
        itemTaxRate: invItem?.itemTaxRate !== undefined ? Number(invItem.itemTaxRate) : globalTaxRate
      };
    })
  };

  const nextProfile = {
    ...profile,
    nextReceiptNumber: nextReceiptNumber + 1
  };

  const nextState = {
    ...state,
    inventory,
    transactions: [transaction, ...state.transactions],
    shopProfile: nextProfile
  };

  return { success: true, nextState, transaction };
}

export function addToCart(item, qty = 1) {
  const existing = cart.find((entry) => entry.id === item.id);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({ ...item, qty, price: item.price ?? item.sellingPrice });
  }
  return cart;
}

export function updateCartItem(itemId, delta) {
  const existing = cart.find((entry) => entry.id === itemId);
  if (!existing) return cart;
  existing.qty += delta;
  if (existing.qty <= 0) {
    cart = cart.filter((entry) => entry.id !== itemId);
  }
  return cart;
}

export function clearCart() {
  cart = [];
  return cart;
}

export function getCartTotal() {
  return cart.reduce((sum, entry) => sum + entry.qty * entry.price, 0);
}

export function buildReportData(state) {
  const branchLookup = Object.fromEntries((state.branches || []).map((branch) => [branch.id, branch.name]));
  const salesRows = (state.transactions || []).map((transaction) => ({
    id: transaction.id,
    branchName: branchLookup[transaction.branchId] || 'Unknown',
    timestamp: transaction.timestamp,
    paymentMethod: transaction.paymentMethod,
    itemsSold: (transaction.items || []).reduce((sum, item) => sum + Number(item.qty || 0), 0),
    total: Number(transaction.total || 0)
  }));

  const inventoryRows = (state.inventory || []).map((item) => ({
    name: item.name,
    stock: Number(item.stock || 0),
    lowStock: Number(item.lowStock || 0),
    costPrice: Number(item.costPrice || 0),
    sellingPrice: Number(item.sellingPrice || 0),
    stockValue: Number(item.stock || 0) * Number(item.costPrice || 0),
    status: Number(item.stock || 0) <= Number(item.lowStock || 0) ? 'Low stock' : 'Healthy'
  }));

  return {
    totalTransactions: salesRows.length,
    totalSales: salesRows.reduce((sum, row) => sum + row.total, 0),
    totalItemsSold: salesRows.reduce((sum, row) => sum + row.itemsSold, 0),
    inventoryValue: inventoryRows.reduce((sum, row) => sum + row.stockValue, 0),
    lowStockItems: inventoryRows.filter((row) => row.status === 'Low stock').length,
    salesRows,
    inventoryRows
  };
}

function renderAdmin(state) {
  const branchSelect = document.getElementById('inventory-branch');
  const inventoryTable = document.getElementById('inventory-table');
  const inventoryCount = document.getElementById('inventory-count');
  const inventorySummary = document.getElementById('inventory-summary');
  const transactionsList = document.getElementById('transactions-list');
  const reportsSummary = document.getElementById('reports-summary');
  const salesReportList = document.getElementById('sales-report-list');
  const inventoryReportList = document.getElementById('inventory-report-list');
  const branchCount = document.getElementById('branch-count');
  const stockAlertsCount = document.getElementById('stock-alerts-count');
  const revenueCount = document.getElementById('revenue-count');
  const transactionsCount = document.getElementById('transactions-count');

  branchCount.textContent = state.branches.length.toString();
  inventoryCount.textContent = state.inventory.length.toString();
  const lowStockItems = state.inventory.filter((item) => item.stock <= item.lowStock).length;
  stockAlertsCount.textContent = lowStockItems.toString();
  revenueCount.textContent = formatCurrency(state.transactions.reduce((sum, entry) => sum + entry.total, 0));
  transactionsCount.textContent = state.transactions.length.toString();
  const returnsCountEl = document.getElementById('returns-count');
  if (returnsCountEl) returnsCountEl.textContent = returns.length.toString();

  branchSelect.innerHTML = state.branches
    .map((branch) => `<option value="${branch.id}" ${branch.id === state.branches[0]?.id ? 'selected' : ''}>${branch.name}</option>`)
    .join('');

  inventorySummary.textContent = `${state.inventory.length} items • ${lowStockItems} require attention`;
  inventoryTable.innerHTML = state.inventory
    .map((item) => {
      const branch = state.branches.find((entry) => entry.id === item.branchId);
      return `
        <tr>
          <td>${item.name}</td>
          <td>${item.barcode || '-'}</td>
          <td>${item.category || '-'}</td>
          <td>${branch ? branch.name : 'Unknown'}</td>
          <td>${item.stock}</td>
          <td>${formatCurrency(item.mrp ?? item.sellingPrice)}</td>
          <td>${formatCurrency(item.sellingPrice)}</td>
          <td>${item.itemTaxRate !== undefined ? item.itemTaxRate + '%' : (state.shopProfile?.taxRate || 0) + '%'}</td>
        </tr>`;
    })
    .join('');

  transactionsList.innerHTML = state.transactions
    .slice(0, 5)
    .map((transaction) => `
      <div class="list-item">
        <div class="row between">
          <strong>#${transaction.id}</strong>
          <span class="small">${transaction.timestamp}</span>
        </div>
        <div class="small">${transaction.items.map((entry) => `${entry.name} × ${entry.qty}`).join(', ')}</div>
        <div class="small">Payment: ${transaction.paymentMethod} • Total: ${formatCurrency(transaction.total)}</div>
      </div>`)
    .join('');

  const reportData = buildReportData(state);
  reportsSummary.innerHTML = `
    <div class="report-card">
      <p class="stat-label">Sales</p>
      <h3>${formatCurrency(reportData.totalSales)}</h3>
    </div>
    <div class="report-card">
      <p class="stat-label">Transactions</p>
      <h3>${reportData.totalTransactions}</h3>
    </div>
    <div class="report-card">
      <p class="stat-label">Items sold</p>
      <h3>${reportData.totalItemsSold}</h3>
    </div>
    <div class="report-card">
      <p class="stat-label">Inventory value</p>
      <h3>${formatCurrency(reportData.inventoryValue)}</h3>
    </div>
    <div class="report-card">
      <p class="stat-label">Low stock</p>
      <h3>${reportData.lowStockItems}</h3>
    </div>`;

  salesReportList.innerHTML = reportData.salesRows.map((row) => `
    <tr>
      <td>${row.id}</td>
      <td>${row.branchName}</td>
      <td>${row.timestamp}</td>
      <td>${row.itemsSold}</td>
      <td>${formatCurrency(row.total)}</td>
      <td>${row.paymentMethod}</td>
    </tr>`).join('');

  inventoryReportList.innerHTML = reportData.inventoryRows.map((item) => `
    <tr>
      <td>${item.name}</td>
      <td>${item.stock}</td>
      <td>${item.lowStock}</td>
      <td>${formatCurrency(item.costPrice)}</td>
      <td>${formatCurrency(item.sellingPrice)}</td>
      <td>${formatCurrency(item.stockValue)}</td>
      <td>${item.status}</td>
    </tr>`).join('');
}

function renderCashier(state, branchId) {
  const catalog = document.getElementById('cashier-catalog');
  const cartList = document.getElementById('cart-list');
  const cartTotal = document.getElementById('cart-total');
  const branchSelect = document.getElementById('cashier-branch');
  const searchInput = document.getElementById('cashier-search');
  const receiptPreview = document.getElementById('receipt-preview');

  branchSelect.innerHTML = state.branches
    .map((branch) => `<option value="${branch.id}" ${branch.id === branchId ? 'selected' : ''}>${branch.name}</option>`)
    .join('');

  const searchValue = searchInput.value.trim().toLowerCase();
  const items = getInventoryForBranch(state, branchId).filter((item) => {
    const haystack = `${item.name} ${item.sku} ${item.barcode || ''} ${item.category || ''}`.toLowerCase();
    return haystack.includes(searchValue);
  });

  catalog.innerHTML = items.map((item) => {
    const isLow = item.stock <= item.lowStock;
    const profile = state.shopProfile || {};
    const itemTax = item.itemTaxRate !== undefined ? item.itemTaxRate : (profile.taxRate || 0);
    return `
    <div class="catalog-item${isLow ? ' catalog-item-low' : ''}">
      <strong>${item.name}</strong>
      <div class="small">${item.sku}</div>
      <div class="small">${item.category || 'General'} • ${item.brand || 'Brand'}</div>
      ${item.barcode ? `<div class="catalog-barcode" title="Barcode: ${escapeHtml(item.barcode)}">⬛ ${escapeHtml(item.barcode)}</div>` : ''}
      <div class="small${isLow ? ' stock-low-text' : ''}">Stock ${item.stock}${isLow ? ' ⚠️' : ''}</div>
      <div>${formatCurrency(item.sellingPrice)} ${itemTax > 0 ? `<span class="catalog-tax">GST ${itemTax}%</span>` : ''}</div>
      <button class="primary" data-add-item="${item.id}">Add to cart</button>
    </div>`;
  }).join('');

  if (!cart.length) {
    cartList.innerHTML = '<div class="small">Cart is empty.</div>';
  } else {
    cartList.innerHTML = cart.map((entry) => `
      <div class="list-item">
        <div class="row between">
          <strong>${entry.name}</strong>
          <span>${formatCurrency(entry.qty * entry.price)}</span>
        </div>
        <div class="row between top-gap">
          <div class="row">
            <button data-change-qty="${entry.id}" data-delta="-1">-</button>
            <span>${entry.qty}</span>
            <button data-change-qty="${entry.id}" data-delta="1">+</button>
          </div>
          <button data-remove-item="${entry.id}">Remove</button>
        </div>
      </div>`).join('');
  }

  const subtotal = getCartTotal();
  const discountAmount = subtotal * (activeDiscount / 100);
  const discountedSubtotal = subtotal - discountAmount;
  const profile = state.shopProfile || {};
  const globalTaxRate = Number(profile.taxRate || 0);
  const taxType = profile.taxType || 'gst';
  const taxInclusive = profile.taxInclusive || 'exclusive';
  const taxName = profile.taxName || 'GST';

  // Compute live tax from cart
  let liveTaxAmount = 0;
  let liveTaxSlabs = {};
  cart.forEach(entry => {
    const invItem = state.inventory.find(i => i.id === entry.id);
    const itemTaxRate = invItem?.itemTaxRate !== undefined ? Number(invItem.itemTaxRate) : globalTaxRate;
    const lineTotal = entry.qty * entry.price * (1 - activeDiscount / 100);
    const taxAmt = taxInclusive === 'inclusive' && itemTaxRate > 0
      ? lineTotal - (lineTotal / (1 + itemTaxRate / 100))
      : lineTotal * (itemTaxRate / 100);
    liveTaxAmount += taxAmt;
    const key = String(itemTaxRate);
    if (!liveTaxSlabs[key]) liveTaxSlabs[key] = { rate: itemTaxRate, tax: 0 };
    liveTaxSlabs[key].tax += taxAmt;
  });

  const finalTotal = taxInclusive === 'inclusive' ? discountedSubtotal : discountedSubtotal + liveTaxAmount;

  // Build tax breakdown string
  let taxBreakdown = '';
  if (liveTaxAmount > 0) {
    const slabs = Object.values(liveTaxSlabs).filter(s => s.tax > 0);
    if (taxType === 'gst') {
      taxBreakdown = slabs.map(s => `CGST ${s.rate/2}%: ${formatCurrency(s.tax/2)} + SGST ${s.rate/2}%: ${formatCurrency(s.tax/2)}`).join(' | ');
    } else {
      taxBreakdown = slabs.map(s => `${taxName} ${s.rate}%: ${formatCurrency(s.tax)}`).join(' | ');
    }
  }

  cartTotal.textContent = liveTaxAmount > 0
    ? `Subtotal: ${formatCurrency(subtotal)} • Discount: ${activeDiscount}% • Tax: ${formatCurrency(liveTaxAmount)} • Final: ${formatCurrency(finalTotal)}`
    : `Subtotal: ${formatCurrency(subtotal)} • Discount: ${activeDiscount}% • Final: ${formatCurrency(finalTotal)}`;

  // Show tax breakdown below the total
  let taxBreakdownEl = document.getElementById('cart-tax-breakdown');
  if (!taxBreakdownEl) {
    taxBreakdownEl = document.createElement('div');
    taxBreakdownEl.id = 'cart-tax-breakdown';
    taxBreakdownEl.className = 'cart-tax-breakdown';
    cartTotal.parentNode.insertBefore(taxBreakdownEl, cartTotal.nextSibling);
  }
  taxBreakdownEl.textContent = taxBreakdown;
  taxBreakdownEl.style.display = taxBreakdown ? '' : 'none';

  if (lastReceipt) {
    receiptPreview.innerHTML = `
      <strong>Last receipt</strong>
      <div class="small">${lastReceipt.timestamp}</div>
      <div class="small">${lastReceipt.items.map((entry) => `${entry.name} × ${entry.qty}`).join(', ')}</div>
      <div class="small">Discount: ${lastReceipt.discountPercent}% • Total: ${formatCurrency(lastReceipt.total)}</div>
    `;
  } else {
    receiptPreview.innerHTML = '<div class="small">Checkout completed orders will appear here.</div>';
  }
}

function getAllowedViews() {
  if (currentUser?.role === 'admin') return ['admin', 'cashier', 'queue', 'customers', 'returns', 'analytics', 'employees', 'audit', 'settings'];
  if (currentUser?.role === 'cashier') return ['cashier', 'queue', 'customers', 'returns'];
  return [];
}

function renderAuth(state) {
  const loginScreen = document.getElementById('login-screen');
  const appShell = document.getElementById('app-shell');
  const authLabel = document.getElementById('auth-user-label');
  const logoutButton = document.getElementById('logout-btn');
  const viewSwitcher = document.querySelector('.view-switcher');

  if (!currentUser) {
    loginScreen?.classList.remove('hidden');
    appShell?.classList.add('hidden');
    authLabel.textContent = 'Not signed in';
    logoutButton?.classList.add('hidden');
    viewSwitcher?.classList.add('hidden');
    return;
  }

  loginScreen?.classList.add('hidden');
  appShell?.classList.remove('hidden');
  authLabel.textContent = `${currentUser.displayName} (${currentUser.role})`;
  logoutButton?.classList.remove('hidden');
  viewSwitcher?.classList.remove('hidden');
  renderView(state);
}

function renderUsersList() {
  const usersList = document.getElementById('users-list');
  if (!usersList) return;

  usersList.innerHTML = authUsers.map((user) => `
    <div style="padding: 8px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <strong>${escapeHtml(user.username)}</strong>
        <span style="margin-left: 10px; color: #666; font-size: 0.9em;">${escapeHtml(user.role)}</span>
      </div>
      ${user.username !== 'admin' && user.username !== 'cashier' ? `
        <button class="delete-user-btn" data-username="${escapeHtml(user.username)}" style="padding: 5px 10px; background: #ff6b6b; color: white; border: none; border-radius: 3px; cursor: pointer;">Delete</button>
      ` : ''}
    </div>
  `).join('');

  // Add delete user event listeners
  usersList.querySelectorAll('.delete-user-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const username = btn.getAttribute('data-username');
      if (confirm(`Delete user "${username}"?`)) {
        const result = deleteUser(username);
        alert(result.message);
        renderUsersList();
      }
    });
  });
}

function renderView(state) {
  const allowedViews = getAllowedViews();
  if (!allowedViews.includes(currentView)) {
    currentView = allowedViews[0] || 'cashier';
  }

  document.getElementById('admin-panel').classList.toggle('hidden', currentView !== 'admin');
  document.getElementById('cashier-panel').classList.toggle('hidden', currentView !== 'cashier');
  document.getElementById('queue-panel').classList.toggle('hidden', currentView !== 'queue');
  document.getElementById('customers-panel').classList.toggle('hidden', currentView !== 'customers');
  document.getElementById('returns-panel').classList.toggle('hidden', currentView !== 'returns');
  document.getElementById('analytics-panel').classList.toggle('hidden', currentView !== 'analytics');
  document.getElementById('employees-panel').classList.toggle('hidden', currentView !== 'employees');
  document.getElementById('audit-panel').classList.toggle('hidden', currentView !== 'audit');
  document.getElementById('settings-panel').classList.toggle('hidden', currentView !== 'settings');
  document.querySelectorAll('.view-btn').forEach((button) => {
    const allowed = allowedViews.includes(button.dataset.view);
    button.classList.toggle('hidden', !allowed);
    button.classList.toggle('active', button.dataset.view === currentView && allowed);
  });
  renderAdmin(state);
  renderCashier(state, document.getElementById('cashier-branch')?.value || state.branches[0]?.id);
  renderQueue(state);
  renderCustomers(state);
  renderReturns(state);
  renderAnalytics(state);
  renderEmployees(state);
  renderAuditLog();
  renderSettings(state);
}

// Analytics & Reporting Functions
function getAnalyticsPeriod() {
  return document.getElementById('analytics-period')?.value || 'month';
}

function filterTransactionsByPeriod(transactions, period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  if (period === 'today') {
    return transactions.filter(t => {
      const tDate = new Date(t.timestamp);
      const tDay = new Date(tDate.getFullYear(), tDate.getMonth(), tDate.getDate());
      return tDay.getTime() === today.getTime();
    });
  } else if (period === 'week') {
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return transactions.filter(t => new Date(t.timestamp) >= weekAgo);
  } else if (period === 'month') {
    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    return transactions.filter(t => new Date(t.timestamp) >= monthAgo);
  }
  return transactions;
}

function calculateAnalytics(state, period) {
  const allTransactions = state.transactions || [];
  const transactions = filterTransactionsByPeriod(allTransactions, period);
  
  const totalRevenue = transactions.reduce((sum, t) => sum + (Number(t.total) || 0), 0);
  const totalTransactions = transactions.length;
  const totalItems = transactions.reduce((sum, t) => sum + (t.items || []).reduce((s, item) => s + Number(item.qty || 0), 0), 0);
  const avgBill = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;

  // Branch Performance
  const branchMap = {};
  const branches = state.branches || [];
  branches.forEach(branch => {
    branchMap[branch.id] = { name: branch.name, revenue: 0, count: 0, items: 0 };
  });
  transactions.forEach(t => {
    if (branchMap[t.branchId]) {
      branchMap[t.branchId].revenue += Number(t.total) || 0;
      branchMap[t.branchId].count += 1;
      branchMap[t.branchId].items += (t.items || []).reduce((s, item) => s + Number(item.qty || 0), 0);
    }
  });

  // Top Products
  const productMap = {};
  transactions.forEach(t => {
    (t.items || []).forEach(item => {
      if (!productMap[item.id]) {
        productMap[item.id] = { name: item.name, qty: 0, revenue: 0 };
      }
      productMap[item.id].qty += Number(item.qty) || 0;
      productMap[item.id].revenue += Number(item.qty || 0) * Number(item.rate || 0);
    });
  });

  // Cashier Performance
  const cashierMap = {};
  transactions.forEach(t => {
    const cashier = t.cashierName || 'Unknown';
    if (!cashierMap[cashier]) {
      cashierMap[cashier] = { count: 0, revenue: 0 };
    }
    cashierMap[cashier].count += 1;
    cashierMap[cashier].revenue += Number(t.total) || 0;
  });

  // Payment Methods
  const paymentMap = {};
  transactions.forEach(t => {
    const method = t.paymentMethod || 'Unknown';
    if (!paymentMap[method]) {
      paymentMap[method] = { count: 0, amount: 0 };
    }
    paymentMap[method].count += 1;
    paymentMap[method].amount += Number(t.total) || 0;
  });

  return {
    totalRevenue,
    totalTransactions,
    totalItems,
    avgBill,
    branches: Object.values(branchMap).sort((a, b) => b.revenue - a.revenue),
    topProducts: Object.entries(productMap)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 10),
    cashiers: Object.entries(cashierMap)
      .map(([name, data]) => ({ name, ...data, avgBill: data.count > 0 ? data.revenue / data.count : 0 }))
      .sort((a, b) => b.revenue - a.revenue),
    paymentMethods: Object.entries(paymentMap)
      .map(([method, data]) => ({ method, ...data, percentage: totalRevenue > 0 ? (data.amount / totalRevenue * 100) : 0 }))
      .sort((a, b) => b.amount - a.amount)
  };
}

function drawSalesTrendChart(transactions, period) {
  const canvas = document.getElementById('sales-trend-chart');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const now = new Date();
  const data = [];
  const labels = [];
  
  let days = 7;
  if (period === 'month') days = 30;
  if (period === 'all') days = 90;
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    labels.push(date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }));
    
    const dayTotal = transactions
      .filter(t => t.timestamp.substring(0, 10) === dateStr)
      .reduce((sum, t) => sum + (Number(t.total) || 0), 0);
    data.push(dayTotal);
  }
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Draw simple line chart
  const maxValue = Math.max(...data, 1);
  const padding = 40;
  const width = canvas.width - 2 * padding;
  const height = canvas.height - 2 * padding;
  const pointSpacing = width / (data.length - 1 || 1);
  
  // Draw grid
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding + (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(canvas.width - padding, y);
    ctx.stroke();
  }
  
  // Draw line
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((value, index) => {
    const x = padding + index * pointSpacing;
    const y = canvas.height - padding - (value / maxValue) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // Draw points
  ctx.fillStyle = '#2563eb';
  data.forEach((value, index) => {
    const x = padding + index * pointSpacing;
    const y = canvas.height - padding - (value / maxValue) * height;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fill();
  });
  
  // Draw labels (every 3rd)
  ctx.fillStyle = '#666';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((label, index) => {
    if (index % Math.ceil(labels.length / 4) === 0) {
      const x = padding + index * pointSpacing;
      ctx.fillText(label, x, canvas.height - 10);
    }
  });
}

function renderAnalytics(state) {
  const period = getAnalyticsPeriod();
  const analytics = calculateAnalytics(state, period);
  
  // Update summary cards
  document.getElementById('analytics-revenue').textContent = formatCurrency(analytics.totalRevenue);
  document.getElementById('analytics-trans-count').textContent = analytics.totalTransactions;
  document.getElementById('analytics-items-count').textContent = analytics.totalItems;
  document.getElementById('analytics-avg-bill').textContent = formatCurrency(analytics.avgBill);
  
  // Draw chart
  drawSalesTrendChart(state.transactions || [], period);
  
  // Branch Performance Table
  const branchTable = document.getElementById('branch-performance-table');
  branchTable.innerHTML = analytics.branches.map(branch => `
    <tr>
      <td><strong>${escapeHtml(branch.name)}</strong></td>
      <td>${formatCurrency(branch.revenue)}</td>
      <td>${branch.count}</td>
      <td>${formatCurrency(branch.count > 0 ? branch.revenue / branch.count : 0)}</td>
    </tr>
  `).join('');
  
  // Top Products Table
  const productsTable = document.getElementById('top-products-table');
  productsTable.innerHTML = analytics.topProducts.map((product, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td><strong>${escapeHtml(product.name)}</strong></td>
      <td>${product.qty}</td>
      <td>${formatCurrency(product.revenue)}</td>
    </tr>
  `).join('');
  
  // Cashier Performance Table
  const cashierTable = document.getElementById('cashier-performance-table');
  cashierTable.innerHTML = analytics.cashiers.map(cashier => `
    <tr>
      <td><strong>${escapeHtml(cashier.name)}</strong></td>
      <td>${cashier.count}</td>
      <td>${formatCurrency(cashier.revenue)}</td>
      <td>${formatCurrency(cashier.avgBill)}</td>
    </tr>
  `).join('');
  
  // Payment Methods Table
  const paymentTable = document.getElementById('payment-methods-table');
  paymentTable.innerHTML = analytics.paymentMethods.map(payment => `
    <tr>
      <td><strong>${escapeHtml(payment.method)}</strong></td>
      <td>${payment.count}</td>
      <td>${formatCurrency(payment.amount)}</td>
      <td>${payment.percentage.toFixed(1)}%</td>
    </tr>
  `).join('');
}

// Returns & Refund Functions
function loadReturns() {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem('billing-inventory-hub-returns');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function saveReturns() {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem('billing-inventory-hub-returns', JSON.stringify(returns)); } catch (e) {}
}

function renderReturns(state) {
  const historyList = document.getElementById('returns-history-list');
  if (!historyList) return;

  if (!returns.length) {
    historyList.innerHTML = '<p class="muted" style="padding:16px;">No returns processed yet.</p>';
    return;
  }

  historyList.innerHTML = returns
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(ret => {
      const reasonLabels = {
        defective: 'Defective / Damaged',
        wrong_item: 'Wrong Item',
        customer_change: 'Customer Changed Mind',
        quality: 'Quality Issue',
        other: 'Other'
      };
      const refundLabels = {
        full: 'Full Refund',
        partial: 'Partial Refund',
        store_credit: 'Store Credit',
        exchange: 'Exchange Only'
      };
      return `
        <div class="return-history-item">
          <div class="return-history-header">
            <div>
              <strong class="return-bill-ref">Return #${ret.id}</strong>
              <span class="return-original-ref">→ Original: ${escapeHtml(ret.originalBillNumber)}</span>
            </div>
            <span class="return-date">${ret.date}</span>
          </div>
          <div class="return-history-body">
            <div class="return-history-items">
              ${ret.items.map(i => `<span class="return-item-tag">${escapeHtml(i.name)} × ${i.qty}</span>`).join('')}
            </div>
            <div class="return-history-meta">
              <span class="return-reason-tag">${reasonLabels[ret.reason] || ret.reason}</span>
              <span class="return-refund-tag">${refundLabels[ret.refundType] || ret.refundType}</span>
              <strong class="return-refund-amount">-${formatCurrency(ret.refundAmount)}</strong>
            </div>
          </div>
          ${ret.notes ? `<div class="return-notes-display">${escapeHtml(ret.notes)}</div>` : ''}
        </div>
      `;
    }).join('');
}

function processReturn(state, originalTransaction, selectedItems, reason, refundType, notes) {
  if (!originalTransaction || !selectedItems.length) return null;

  // Calculate refund amount from selected items
  const originalItemsMap = {};
  originalTransaction.items.forEach(item => {
    originalItemsMap[item.name] = item;
  });

  let refundAmount = 0;
  selectedItems.forEach(item => {
    const originalPrice = item.unitPrice || 0;
    refundAmount += originalPrice * item.qty;
  });

  // Apply original discount to refund
  if (originalTransaction.discountPercent) {
    refundAmount -= refundAmount * (originalTransaction.discountPercent / 100);
  }

  // Restore stock for returned items
  const newInventory = state.inventory.map(invItem => {
    const returnedItem = selectedItems.find(si => si.inventoryId === invItem.id);
    if (returnedItem) {
      return { ...invItem, stock: invItem.stock + returnedItem.qty };
    }
    return invItem;
  });

  // Create return record
  const returnRecord = {
    id: `RET-${Date.now()}`,
    originalTransactionId: originalTransaction.id,
    originalBillNumber: originalTransaction.billNumber || originalTransaction.id,
    date: new Date().toLocaleString(),
    items: selectedItems.map(i => ({ name: i.name, qty: i.qty })),
    refundAmount,
    reason,
    refundType,
    notes: notes || ''
  };

  returns.unshift(returnRecord);
  saveReturns();

  // Update state with new inventory
  const newState = { ...state, inventory: newInventory };
  return { returnRecord, newState, refundAmount };
}

// Customer Management & Loyalty Functions
function getOrCreateCustomer(phone, transactionDetails = null) {
  if (!phone || phone.trim() === '') return null;
  
  const cleanPhone = phone.trim();
  let customer = customers.find(c => c.phone === cleanPhone);
  
  if (!customer) {
    customer = {
      id: `cust_${Date.now()}`,
      phone: cleanPhone,
      name: transactionDetails?.customerName || 'Customer ' + cleanPhone.slice(-4),
      createdAt: new Date().toISOString(),
      totalSpent: 0,
      transactionCount: 0,
      loyaltyPoints: 0,
      transactions: []
    };
    customers.push(customer);
    saveCustomers();
  }
  
  return customer;
}

function addCustomerTransaction(customerId, transactionData) {
  const customer = customers.find(c => c.id === customerId);
  if (!customer) return;
  
  const pointsEarned = Math.floor(transactionData.total);
  
  customer.totalSpent += transactionData.total;
  customer.transactionCount += 1;
  customer.loyaltyPoints += pointsEarned;
  customer.transactions.push({
    id: transactionData.id,
    date: transactionData.timestamp,
    amount: transactionData.total,
    items: (transactionData.items || []).map(i => `${i.name} (${i.qty})`).join(', '),
    pointsEarned
  });
  
  saveCustomers();
}

function saveCustomers() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem('billing-inventory-hub-customers', JSON.stringify(customers));
  } catch (e) {}
}

function loadCustomers() {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem('billing-inventory-hub-customers');
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function renderCustomers(state) {
  const detailView = document.getElementById('customer-detail-view');
  const customersList = document.getElementById('customers-list');
  const emptyState = document.getElementById('customers-empty');
  
  if (selectedCustomerForDetail) {
    // Show detail view
    detailView.classList.remove('hidden');
    const customer = customers.find(c => c.id === selectedCustomerForDetail);
    
    if (customer) {
      document.getElementById('detail-customer-name').textContent = customer.name;
      document.getElementById('detail-customer-phone').textContent = '📱 ' + customer.phone;
      document.getElementById('detail-trans-count').textContent = customer.transactionCount;
      document.getElementById('detail-total-spent').textContent = formatCurrency(customer.totalSpent);
      document.getElementById('detail-avg-trans').textContent = formatCurrency(customer.transactionCount > 0 ? customer.totalSpent / customer.transactionCount : 0);
      document.getElementById('detail-loyalty-points').textContent = customer.loyaltyPoints;
      document.getElementById('detail-points-input').value = customer.loyaltyPoints;
      
      // Render transaction history
      const historyTable = document.getElementById('detail-history-table');
      historyTable.innerHTML = (customer.transactions || []).map(trans => `
        <tr>
          <td>${new Date(trans.date).toLocaleDateString('en-IN')}</td>
          <td>${formatCurrency(trans.amount)}</td>
          <td>${escapeHtml(trans.items)}</td>
          <td>+${trans.pointsEarned}</td>
        </tr>
      `).join('');
    }
  } else {
    // Show customers list
    detailView.classList.add('hidden');
    const searchTerm = (document.getElementById('customer-search')?.value || '').toLowerCase();
    
    const filtered = customers.filter(c => 
      c.phone.includes(searchTerm) || c.name.toLowerCase().includes(searchTerm)
    );
    
    if (filtered.length === 0) {
      customersList.innerHTML = '';
      emptyState.classList.remove('hidden');
    } else {
      emptyState.classList.add('hidden');
      customersList.innerHTML = filtered
        .sort((a, b) => b.transactionCount - a.transactionCount)
        .map(customer => `
          <tr>
            <td>${escapeHtml(customer.phone)}</td>
            <td>${escapeHtml(customer.name)}</td>
            <td>${customer.transactionCount}</td>
            <td>${formatCurrency(customer.totalSpent)}</td>
            <td><span class="loyalty-badge">${customer.loyaltyPoints} pts</span></td>
            <td><button class="view-customer-btn" data-customer-id="${customer.id}">View</button></td>
          </tr>
        `).join('');
    }
  }
}

// Audit Trail Render
function renderAuditLog() {
  const container = document.getElementById('audit-log-table-body');
  const countEl = document.getElementById('audit-count');
  if (!container) return;

  const categoryFilter = document.getElementById('audit-category-filter')?.value || 'all';
  const searchFilter = (document.getElementById('audit-search')?.value || '').toLowerCase().trim();
  const dateFilter = document.getElementById('audit-date-filter')?.value || '';

  let filtered = auditLog;
  if (categoryFilter !== 'all') filtered = filtered.filter(e => e.category === categoryFilter);
  if (searchFilter) filtered = filtered.filter(e =>
    e.details.toLowerCase().includes(searchFilter) ||
    e.user.toLowerCase().includes(searchFilter) ||
    e.action.toLowerCase().includes(searchFilter)
  );
  if (dateFilter) {
    filtered = filtered.filter(e => {
      const entryDate = new Date(e.timestamp).toISOString().slice(0, 10);
      return entryDate === dateFilter;
    });
  }

  if (countEl) countEl.textContent = `${filtered.length} of ${auditLog.length} entries`;

  if (!filtered.length) {
    container.innerHTML = `<tr><td colspan="5" class="audit-empty">No audit entries match the current filter.</td></tr>`;
    return;
  }

  const categoryIcons = {
    auth: '🔑', sale: '💰', return: '↩️', inventory: '📦',
    settings: '⚙️', user: '👤', cart: '🛒'
  };
  const actionColors = {
    LOGIN: 'audit-tag-auth', LOGOUT: 'audit-tag-auth',
    SALE: 'audit-tag-sale', RETURN: 'audit-tag-return',
    VOID: 'audit-tag-cart', HOLD: 'audit-tag-cart', PRICE_OVERRIDE: 'audit-tag-cart',
    INVENTORY_ADD: 'audit-tag-inventory', INVENTORY_EDIT: 'audit-tag-inventory',
    THRESHOLD_CHANGE: 'audit-tag-inventory',
    SETTINGS_CHANGE: 'audit-tag-settings', PASSWORD_CHANGE: 'audit-tag-settings',
    USER_ADD: 'audit-tag-user', USER_REMOVE: 'audit-tag-user', POINTS_UPDATE: 'audit-tag-user'
  };

  container.innerHTML = filtered.map(entry => {
    const time = new Date(entry.timestamp).toLocaleString();
    const icon = categoryIcons[entry.category] || '📋';
    const tagClass = actionColors[entry.action] || 'audit-tag-default';
    return `
      <tr class="audit-row">
        <td class="audit-time">${escapeHtml(time)}</td>
        <td><span class="audit-user-badge">${escapeHtml(entry.user)}</span> <span class="audit-role">${escapeHtml(entry.role)}</span></td>
        <td><span class="audit-tag ${tagClass}">${icon} ${escapeHtml(entry.action)}</span></td>
        <td class="audit-details">${escapeHtml(entry.details)}</td>
        <td class="audit-category">${escapeHtml(entry.category)}</td>
      </tr>
    `;
  }).join('');
}

function exportAuditCSV() {
  const headers = ['Timestamp', 'User', 'Role', 'Action', 'Category', 'Details'];
  const rows = auditLog.map(e => [
    new Date(e.timestamp).toLocaleString(),
    e.user, e.role, e.action, e.category,
    e.details.replace(/,/g, ';')
  ]);
  downloadCSV('audit-log', headers, rows);
}

// ─── Backup & Export Functions ────────────────────────────────────────────────

const BACKUP_TIMESTAMP_KEY = 'billing-inventory-hub-last-backup';

function downloadCSV(filename, headers, rows) {
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv, { type: 'text/csv;charset=utf-8;' }]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportFullBackup(state) {
  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    exportedBy: currentUser?.username || 'unknown',
    state,
    customers,
    returns,
    employees,
    auditLog: auditLog.slice(0, 500) // cap to 500 for size
  };
  downloadJSON('billing-hub-backup', backup);
  try { window.localStorage.setItem(BACKUP_TIMESTAMP_KEY, new Date().toLocaleString()); } catch (e) {}
  updateLastBackupLabel();
  logAudit('BACKUP_EXPORT', AUDIT_CATEGORIES.SETTINGS, `Full backup exported by ${currentUser?.username}`);
}

function importFromBackup(file, onComplete) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.state || !backup.version) {
        onComplete(false, 'Invalid backup file. Missing required fields.');
        return;
      }
      // Restore all data
      saveState(backup.state);
      if (backup.customers) { customers = backup.customers; saveCustomers(); }
      if (backup.returns) { returns = backup.returns; saveReturns(); }
      if (backup.employees) { employees = backup.employees; saveEmployees(); }
      if (backup.auditLog) {
        auditLog = backup.auditLog;
        try { window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(auditLog)); } catch (_) {}
      }
      logAudit('BACKUP_IMPORT', AUDIT_CATEGORIES.SETTINGS, `Backup restored from file (exported: ${backup.exportedAt || 'unknown'})`);
      onComplete(true, `✓ Backup restored from ${backup.exportedAt ? new Date(backup.exportedAt).toLocaleString() : 'file'}. Please reload.`);
    } catch (err) {
      onComplete(false, `Failed to parse backup: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function exportTransactionsCSV(state) {
  const headers = ['Bill #', 'Date', 'Branch', 'Cashier', 'Items', 'Subtotal', 'Discount', 'Tax', 'Total', 'Payment'];
  const rows = state.transactions.map(t => {
    const branch = state.branches.find(b => b.id === t.branchId);
    return [
      t.billNumber || t.id,
      t.timestamp,
      branch?.name || t.branchId,
      t.cashierName || 'Cashier',
      t.items.map(i => `${i.name}x${i.qty}`).join('; '),
      t.subtotal,
      t.discountAmount || 0,
      t.taxAmount || 0,
      t.total,
      t.paymentMethod
    ];
  });
  downloadCSV('transactions', headers, rows);
}

function exportInventoryCSV(state) {
  const headers = ['SKU', 'Barcode', 'Name', 'Category', 'Brand', 'Unit', 'Cost Price', 'MRP', 'Selling Price', 'Stock', 'Low Stock', 'HSN Code', 'Tax Rate', 'Branch'];
  const rows = state.inventory.map(item => {
    const branch = state.branches.find(b => b.id === item.branchId);
    return [
      item.sku, item.barcode || '', item.name, item.category || '', item.brand || '',
      item.unit || '', item.costPrice, item.mrp, item.sellingPrice,
      item.stock, item.lowStock, item.hsnCode || '',
      item.itemTaxRate !== undefined ? item.itemTaxRate : '',
      branch?.name || ''
    ];
  });
  downloadCSV('inventory', headers, rows);
}

function exportCustomersCSV() {
  const headers = ['Phone', 'Name', 'Transactions', 'Total Spent', 'Loyalty Points', 'Created'];
  const rows = customers.map(c => [
    c.phone, c.name, c.transactionCount, c.totalSpent, c.loyaltyPoints, c.createdAt || ''
  ]);
  downloadCSV('customers', headers, rows);
}

function exportEmployeesCSV() {
  const headers = ['Username', 'Full Name', 'Role', 'Position', 'Phone', 'Email', 'Status', 'Joining Date', 'Notes'];
  const rows = employees.map(e => [
    e.username, e.fullName, e.role, e.position || '', e.phone || '', e.email || '', e.status, e.joiningDate || '', e.notes || ''
  ]);
  downloadCSV('employees', headers, rows);
}

function exportReturnsCSV() {
  const headers = ['Return ID', 'Original Bill', 'Date', 'Items', 'Refund Amount', 'Reason', 'Refund Type', 'Notes'];
  const rows = returns.map(r => [
    r.id, r.originalBillNumber, r.date,
    r.items.map(i => `${i.name}x${i.qty}`).join('; '),
    r.refundAmount, r.reason, r.refundType, r.notes || ''
  ]);
  downloadCSV('returns', headers, rows);
}

function exportTaxReportCSV(state) {
  const headers = ['Bill #', 'Date', 'Subtotal', 'Discount', 'Tax Type', 'Tax Rate', 'CGST', 'SGST', 'Total Tax', 'Grand Total'];
  const profile = state.shopProfile || {};
  const taxType = profile.taxType || 'gst';

  const rows = state.transactions.map(t => {
    const taxAmt = t.taxAmount || 0;
    const isGST = taxType === 'gst' || t.taxType === 'gst';
    return [
      t.billNumber || t.id,
      t.timestamp,
      t.subtotal,
      t.discountAmount || 0,
      isGST ? 'GST' : (profile.taxName || 'Tax'),
      t.taxRate || 0,
      isGST ? (taxAmt / 2).toFixed(2) : '',
      isGST ? (taxAmt / 2).toFixed(2) : '',
      taxAmt,
      t.total
    ];
  });
  downloadCSV('tax-report', headers, rows);
}

function generateInventoryCSVTemplate() {
  const headers = ['name', 'sku', 'sellingPrice', 'stock', 'barcode', 'category', 'brand', 'unit', 'costPrice', 'mrp', 'lowStock', 'hsnCode', 'taxRate', 'description'];
  const example = ['Milk 500ml', 'SKU100', '45', '100', '8901234567100', 'Dairy', 'FreshMart', 'Pack', '35', '50', '10', '0402', '5', 'Fresh milk'];
  downloadCSV('inventory-template', headers, [example]);
}

function importInventoryFromCSV(file, state, onComplete) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const lines = e.target.result.split('\n').filter(l => l.trim());
      if (lines.length < 2) { onComplete(false, 'CSV must have a header row and at least one data row.'); return; }

      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
      const required = ['name', 'sku', 'sellingprice', 'stock'];
      const missing = required.filter(r => !headers.includes(r));
      if (missing.length > 0) { onComplete(false, `Missing required columns: ${missing.join(', ')}`); return; }

      let added = 0, skipped = 0;
      const defaultBranchId = state.branches[0]?.id || 'branch-1';

      lines.slice(1).forEach(line => {
        if (!line.trim()) return;
        const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const row = {};
        headers.forEach((h, i) => { row[h] = values[i] || ''; });

        if (!row.name || !row.sku) { skipped++; return; }
        // Skip duplicates by SKU
        if (state.inventory.some(i => i.sku === row.sku)) { skipped++; return; }

        state = addInventoryItem(state, {
          branchId: defaultBranchId,
          sku: row.sku,
          barcode: row.barcode || '',
          name: row.name,
          category: row.category || '',
          brand: row.brand || '',
          unit: row.unit || '',
          costPrice: Number(row.costprice || row['cost price'] || 0),
          mrp: Number(row.mrp || row.sellingprice || 0),
          sellingPrice: Number(row.sellingprice || 0),
          stock: Number(row.stock || 0),
          lowStock: Number(row.lowstock || row['low stock'] || 0),
          hsnCode: row.hsncode || row.hsn || '',
          itemTaxRate: row.taxrate !== '' ? Number(row.taxrate) : undefined,
          description: row.description || ''
        });
        added++;
      });

      saveState(state);
      logAudit('INVENTORY_IMPORT', AUDIT_CATEGORIES.INVENTORY, `CSV import: ${added} items added, ${skipped} skipped`);
      onComplete(true, `✓ Imported ${added} items. ${skipped} skipped (duplicates or missing data). Reload to see all items.`, state);
    } catch (err) {
      onComplete(false, `CSV parse error: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function updateLastBackupLabel() {
  const el = document.getElementById('last-backup-label');
  if (!el) return;
  try {
    const ts = window.localStorage.getItem(BACKUP_TIMESTAMP_KEY);
    el.textContent = ts || 'Never';
    el.style.color = ts ? '#16a34a' : '#dc2626';
  } catch (_) {}
}

// ─── End Backup & Export ──────────────────────────────────────────────────────

function renderSettings(state) {
  const preview = document.getElementById('settings-preview');
  const profile = state.shopProfile || shopProfile;
  const fields = [
    ['Shop name', profile.shopName],
    ['Owner', profile.ownerName],
    ['Phone', profile.phone],
    ['Email', profile.email],
    ['Address', profile.address],
    ['GST', profile.gst],
    ['Tax name', profile.taxName],
    ['Tax rate', profile.taxRate],
    ['Receipt prefix', profile.receiptPrefix],
    ['Next receipt number', profile.nextReceiptNumber],
    ['Print layout', profile.printLayout],
    ['Website', profile.website],
    ['Footer', profile.footer]
  ];

  preview.innerHTML = fields.map(([label, value]) => `<div class="small"><strong>${label}:</strong> ${value || '—'}</div>`).join('');
  document.getElementById('shop-name').value = profile.shopName || '';
  document.getElementById('shop-owner').value = profile.ownerName || '';
  document.getElementById('shop-phone').value = profile.phone || '';
  document.getElementById('shop-email').value = profile.email || '';
  document.getElementById('shop-address').value = profile.address || '';
  document.getElementById('shop-gst').value = profile.gst || '';
  document.getElementById('shop-tax-name').value = profile.taxName || '';
  document.getElementById('shop-tax-rate').value = profile.taxRate ?? '';
  document.getElementById('shop-receipt-prefix').value = profile.receiptPrefix || '';
  document.getElementById('shop-next-receipt').value = profile.nextReceiptNumber ?? '';
  document.getElementById('shop-print-layout').value = profile.printLayout || 'standard';
  document.getElementById('shop-website').value = profile.website || '';
  document.getElementById('shop-footer').value = profile.footer || '';
  const taxTypeEl = document.getElementById('shop-tax-type');
  if (taxTypeEl) taxTypeEl.value = profile.taxType || 'gst';
  const taxInclusiveEl = document.getElementById('shop-tax-inclusive');
  if (taxInclusiveEl) taxInclusiveEl.value = profile.taxInclusive || 'exclusive';
  
  // Render thresholds
  renderThresholds(state);
  
  // Update last backup label
  updateLastBackupLabel();
}

function renderThresholds(state) {
  const container = document.getElementById('thresholds-container');
  if (!container) return;
  
  const items = state.inventory || [];
  if (!items.length) {
    container.innerHTML = '<p class="muted">No inventory items yet. Add items in Admin Console to set thresholds.</p>';
    return;
  }
  
  container.innerHTML = items.map(item => {
    const isLow = item.stock <= item.lowStock;
    const statusClass = isLow ? 'threshold-low' : 'threshold-healthy';
    
    return `
      <div class="threshold-item ${statusClass}">
        <div class="threshold-header">
          <strong>${escapeHtml(item.name)}</strong>
          <span class="threshold-status ${isLow ? 'alert-badge' : 'healthy-badge'}">
            ${isLow ? '🔴 Low' : '✓ Healthy'}
          </span>
        </div>
        <div class="threshold-info">
          <span>Current: <strong>${item.stock}</strong></span>
          <span>•</span>
          <span>Min: <strong>${item.lowStock}</strong></span>
          <span>•</span>
          <span>SKU: ${escapeHtml(item.sku)}</span>
        </div>
        <div class="threshold-input-group">
          <label>Set minimum threshold:</label>
          <input type="number" min="0" value="${item.lowStock}" class="threshold-input" data-item-id="${item.id}" />
          <button class="threshold-save-btn" data-item-id="${item.id}">Update</button>
        </div>
      </div>
    `;
  }).join('');
}

function getLowStockAlerts(state) {
  const items = state.inventory || [];
  return items.filter(item => item.stock <= item.lowStock).map(item => ({
    id: item.id,
    name: item.name,
    sku: item.sku,
    current: item.stock,
    threshold: item.lowStock,
    reorderQty: Math.ceil(item.lowStock * 1.5)
  }));
}

function renderQueue(state) {
  const queueList = document.getElementById('queue-list');
  const queueBadge = document.getElementById('queue-badge');
  const queueStatus = document.getElementById('queue-status');
  const queueTotalBills = document.getElementById('queue-total-bills');
  const queueActiveDevices = document.getElementById('queue-active-devices');
  const queueTotalItems = document.getElementById('queue-total-items');
  const queueTotalValue = document.getElementById('queue-total-value');

  if (!globalHeldBills.length) {
    queueList.innerHTML = '<div class="list-item"><p class="muted">No active bills in queue</p></div>';
    queueBadge.textContent = '0 bills';
    queueStatus.textContent = 'Queue empty';
    queueTotalBills.textContent = '0';
    queueActiveDevices.textContent = '0';
    queueTotalItems.textContent = '0';
    queueTotalValue.textContent = '₹0.00';
    return;
  }

  // Group bills by device
  const billsByDevice = {};
  globalHeldBills.forEach((bill) => {
    if (!billsByDevice[bill.deviceId]) {
      billsByDevice[bill.deviceId] = [];
    }
    billsByDevice[bill.deviceId].push(bill);
  });

  // Calculate statistics
  const totalItems = globalHeldBills.reduce((sum, bill) => sum + (bill.items?.length || 0), 0);
  const totalValue = globalHeldBills.reduce((sum, bill) => {
    const billTotal = bill.items?.reduce((s, item) => s + (item.qty * item.price), 0) || 0;
    return sum + (billTotal - (billTotal * (bill.discount || 0) / 100));
  }, 0);

  // Update statistics
  queueBadge.textContent = `${globalHeldBills.length} bills`;
  queueStatus.textContent = 'Live sync active';
  queueTotalBills.textContent = globalHeldBills.length.toString();
  queueActiveDevices.textContent = Object.keys(billsByDevice).length.toString();
  queueTotalItems.textContent = totalItems.toString();
  queueTotalValue.textContent = formatCurrency(totalValue);

  // Render bills grouped by device
  queueList.innerHTML = Object.entries(billsByDevice)
    .map(([deviceId, deviceBills]) => {
      const deviceShort = deviceId.substring(0, 14) + '...';
      const deviceBillsHtml = deviceBills
        .map((bill) => {
          const billSubtotal = bill.items?.reduce((s, item) => s + (item.qty * item.price), 0) || 0;
          const billDiscount = billSubtotal * ((bill.discount || 0) / 100);
          const billTotal = billSubtotal - billDiscount;
          const itemsText = bill.items?.map((i) => `${i.name} (${i.qty})`).join(', ') || 'No items';
          const createdTime = new Date(bill.createdAt).toLocaleTimeString();
          
          return `
            <div style="padding: 8px; border-left: 3px solid #5b6cff; background: #f9fbff; margin: 6px 0; border-radius: 6px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <strong>${bill.cashier}</strong>
                <span class="muted" style="font-size: 0.8rem;">${createdTime}</span>
              </div>
              <p class="muted" style="margin: 2px 0; font-size: 0.85rem;">${itemsText}</p>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
                <span class="small" style="color: #14213d;">₹${billTotal.toFixed(2)}</span>
                <div style="gap: 6px; display: flex;">
                  <button class="restore-bill-btn" data-bill-id="${bill.id}" style="padding: 4px 8px; font-size: 0.8rem; background: #f0f4ff; color: #1c3b7a; border: none; border-radius: 6px; cursor: pointer;">Restore</button>
                  <button class="transfer-bill-btn" data-bill-id="${bill.id}" style="padding: 4px 8px; font-size: 0.8rem; background: #f0f4ff; color: #1c3b7a; border: none; border-radius: 6px; cursor: pointer;">Transfer</button>
                </div>
              </div>
            </div>
          `;
        })
        .join('');
      
      return `
        <div class="list-item" style="padding: 10px; margin-bottom: 10px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong style="color: #102445;">📱 Device: ${deviceShort}</strong>
            <span class="pill" style="font-size: 0.8rem;">${deviceBills.length} bills</span>
          </div>
          ${deviceBillsHtml}
        </div>
      `;
    })
    .join('');

  // Add event listeners for restore buttons
  document.querySelectorAll('.restore-bill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const billId = btn.getAttribute('data-bill-id');
      if (restoreHeldBill(billId)) {
        currentView = 'cashier';
        renderView(state);
        alert('Bill restored to cart. Ready for checkout.');
      }
    });
  });

  // Add event listeners for transfer buttons
  document.querySelectorAll('.transfer-bill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const billId = btn.getAttribute('data-bill-id');
      const newCashier = prompt('Enter cashier name to transfer to:');
      if (newCashier && transferHeldBill(billId, newCashier)) {
        alert(`Bill transferred to ${newCashier}`);
        renderQueue(state);
      }
    });
  });
}

function printReceipt(receipt, state) {
  const branchSelect = document.getElementById('cashier-branch');
  const branchName = branchSelect?.selectedOptions?.[0]?.text || 'Store';
  const receiptData = receipt || {
    id: `txn-${Date.now()}`,
    subtotal: getCartTotal(),
    discountPercent: activeDiscount,
    discountAmount: getCartTotal() * (activeDiscount / 100),
    total: getCartTotal() - (getCartTotal() * (activeDiscount / 100)),
    paymentMethod: document.getElementById('payment-method').value,
    timestamp: new Date().toLocaleString(),
    items: cart.map((entry) => ({ name: entry.name, qty: entry.qty, price: entry.price })),
    shopProfile: state.shopProfile || shopProfile
  };

  const printWindow = window.open('', '_blank', 'width=700,height=900');
  if (!printWindow) {
    alert('Pop-up blocked. Please allow pop-ups to print the receipt.');
    return;
  }

  printWindow.document.write(buildReceiptHtml(receiptData, branchName));
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
    printWindow.close();
  }, 250);
}

function bindEvents(state) {
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const rememberMe = document.getElementById('login-remember').checked;
    const user = authenticateUser(username, password);
    const errorBox = document.getElementById('login-error');
    if (!user) {
      errorBox.textContent = 'Invalid username or password.';
      errorBox.classList.remove('hidden');
      return;
    }
    currentUser = user;
    persistAuth(username, password, rememberMe);
    logAudit('LOGIN', AUDIT_CATEGORIES.AUTH, `User "${username}" logged in as ${user.role}`);
    errorBox.classList.add('hidden');
    document.getElementById('login-form').reset();
    renderAuth(state);
    // initialize firebase and load user's cloud state
    firebaseInit();
    if (firebaseEnabled) {
      // Load initial state from Firebase on login (for new device scenario)
      const remoteState = await cloudLoadInitialState(currentUser.username);
      if (remoteState) {
        try {
          state = {
            ...state,
            ...remoteState,
            branches: remoteState.branches || state.branches,
            inventory: remoteState.inventory || state.inventory,
            transactions: remoteState.transactions || state.transactions,
            shopProfile: remoteState.shopProfile || state.shopProfile
          };
          saveState(state);
          renderView(state);
        } catch (e) { console.warn('Error applying initial remote state', e); }
      }
      // Subscribe to real-time updates after initial load
      cloudSubscribe(currentUser.username, (remoteState) => {
        try {
          // merge remote state, prefer remote values when available
          state = {
            ...state,
            ...remoteState,
            branches: remoteState.branches || state.branches,
            inventory: remoteState.inventory || state.inventory,
            transactions: remoteState.transactions || state.transactions,
            shopProfile: remoteState.shopProfile || state.shopProfile
          };
          saveState(state);
          renderView(state);
        } catch (e) { console.warn('Error applying remote state', e); }
      });
    }
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    logAudit('LOGOUT', AUDIT_CATEGORIES.AUTH, `User "${currentUser?.username}" logged out`);
    currentUser = null;
    persistAuth(null, null);
    cloudUnsubscribe();
    renderAuth(state);
  });

  // User management (admin only)
  const userForm = document.getElementById('user-form');
  if (userForm) {
    userForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const username = document.getElementById('user-username').value.trim();
      const password = document.getElementById('user-password').value.trim();
      const role = document.getElementById('user-role').value;
      
      const result = addUser(username, password, role);
      alert(result.message);
      
      if (result.success) {
        logAudit('USER_ADD', AUDIT_CATEGORIES.USER, `Added new user "${username}" with role "${role}"`, { username, role });
        document.getElementById('user-form').reset();
        renderUsersList();
      }
    });
  }

  document.querySelectorAll('.view-btn').forEach((button) => {
    button.addEventListener('click', () => {
      currentView = button.dataset.view;
      renderView(state);
      // Re-render users list when switching to admin view
      if (button.dataset.view === 'admin') {
        renderUsersList();
      }
    });
  });

  // Analytics period selector
  const analyticsPeriod = document.getElementById('analytics-period');
  if (analyticsPeriod) {
    analyticsPeriod.addEventListener('change', () => {
      renderAnalytics(state);
    });
  }

  // Customer Management event listeners
  const customerSearch = document.getElementById('customer-search');
  if (customerSearch) {
    customerSearch.addEventListener('input', () => {
      renderCustomers(state);
    });
  }

  // Customer list click handler
  document.addEventListener('click', (event) => {
    const viewBtn = event.target.closest('.view-customer-btn');
    if (viewBtn) {
      selectedCustomerForDetail = viewBtn.getAttribute('data-customer-id');
      renderCustomers(state);
      return;
    }

    const closeBtn = document.getElementById('close-customer-detail');
    if (event.target === closeBtn) {
      selectedCustomerForDetail = null;
      renderCustomers(state);
      return;
    }

    const updatePointsBtn = document.getElementById('update-points-btn');
    if (event.target === updatePointsBtn) {
      if (!selectedCustomerForDetail) return;
      const customer = customers.find(c => c.id === selectedCustomerForDetail);
      if (!customer) return;
      
      const newPoints = Number(document.getElementById('detail-points-input').value) || 0;
      customer.loyaltyPoints = newPoints;
      saveCustomers();
      renderCustomers(state);
      return;
    }

    const thresholdSaveBtn = event.target.closest('.threshold-save-btn');
    if (thresholdSaveBtn) {
      const itemId = thresholdSaveBtn.getAttribute('data-item-id');
      const input = thresholdSaveBtn.previousElementSibling;
      const newThreshold = Number(input.value) || 0;
      
      const itemIndex = state.inventory.findIndex(i => i.id === itemId);
      if (itemIndex !== -1) {
        const oldThreshold = state.inventory[itemIndex].lowStock;
        const itemName = state.inventory[itemIndex].name;
        state.inventory[itemIndex].lowStock = newThreshold;
        logAudit('THRESHOLD_CHANGE', AUDIT_CATEGORIES.INVENTORY, `Low stock threshold for "${itemName}" changed: ${oldThreshold} → ${newThreshold}`, { itemId, oldThreshold, newThreshold });
        saveState(state);
        renderThresholds(state);
        
        // Show brief notification
        const btn = thresholdSaveBtn;
        const originalText = btn.textContent;
        btn.textContent = '✓ Saved';
        btn.style.backgroundColor = '#10b981';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.backgroundColor = '';
        }, 1500);
      }
      return;
    }
  });

  // Return search button
  document.getElementById('return-search-btn').addEventListener('click', () => {
    const receiptInput = document.getElementById('return-receipt-input').value.trim();
    const resultDiv = document.getElementById('return-search-result');
    const formCard = document.getElementById('return-form-card');
    const itemsList = document.getElementById('return-items-list');

    if (!receiptInput) {
      resultDiv.innerHTML = '<p class="return-search-error">Please enter a receipt/bill number.</p>';
      resultDiv.classList.remove('hidden');
      formCard.classList.add('hidden');
      return;
    }

    // Find transaction by billNumber or id (case-insensitive)
    const txn = state.transactions.find(t =>
      (t.billNumber || '').toLowerCase() === receiptInput.toLowerCase() ||
      t.id.toLowerCase() === receiptInput.toLowerCase()
    );

    if (!txn) {
      resultDiv.innerHTML = `<p class="return-search-error">No transaction found for "<strong>${escapeHtml(receiptInput)}</strong>". Please check the receipt number.</p>`;
      resultDiv.classList.remove('hidden');
      formCard.classList.add('hidden');
      pendingReturnTransaction = null;
      return;
    }

    // Check if already fully returned
    const existingReturns = returns.filter(r => r.originalTransactionId === txn.id);
    const alreadyReturnedItemNames = existingReturns.flatMap(r => r.items.map(i => i.name));

    pendingReturnTransaction = txn;

    resultDiv.innerHTML = `
      <div class="return-found-info">
        <strong>Found: ${escapeHtml(txn.billNumber || txn.id)}</strong>
        <span>${txn.timestamp}</span>
        <span>Total: ${formatCurrency(txn.total)}</span>
        <span>Payment: ${txn.paymentMethod}</span>
      </div>
    `;
    resultDiv.classList.remove('hidden');

    // Build per-item unit prices from total/subtotal
    const itemCount = txn.items.length;
    const avgPrice = itemCount > 0 ? (txn.subtotal || txn.total) / txn.items.reduce((s, i) => s + i.qty, 0) : 0;

    // Build return items list
    itemsList.innerHTML = txn.items.map((item, index) => {
      // Attempt to find in inventory for accurate price and id
      const invItem = state.inventory.find(inv => inv.name === item.name);
      const unitPrice = invItem ? invItem.sellingPrice : avgPrice;
      const inventoryId = invItem ? invItem.id : '';
      const alreadyReturned = alreadyReturnedItemNames.includes(item.name);

      return `
        <div class="return-item-row ${alreadyReturned ? 'return-item-disabled' : ''}">
          <label class="return-item-check">
            <input type="checkbox" class="return-item-checkbox" 
              data-name="${escapeHtml(item.name)}" 
              data-unit-price="${unitPrice}" 
              data-inventory-id="${inventoryId}"
              data-max-qty="${item.qty}"
              ${alreadyReturned ? 'disabled' : ''}
            />
            <span>${escapeHtml(item.name)}</span>
          </label>
          <div class="return-item-detail">
            <span class="return-unit-price">${formatCurrency(unitPrice)} each</span>
            <label class="return-qty-wrap">
              Qty: <input type="number" min="1" max="${item.qty}" value="${item.qty}" 
                class="return-qty-input" data-index="${index}"
                ${alreadyReturned ? 'disabled' : ''}
              />
              <span class="return-qty-max">/ ${item.qty}</span>
            </label>
          </div>
          ${alreadyReturned ? '<span class="already-returned-tag">Already returned</span>' : ''}
        </div>
      `;
    }).join('');

    formCard.classList.remove('hidden');
    updateReturnSummary();
  });

  // Update summary on checkbox / qty change
  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('return-item-checkbox') || e.target.classList.contains('return-qty-input')) {
      updateReturnSummary();
    }
  });

  function updateReturnSummary() {
    const checkboxes = document.querySelectorAll('.return-item-checkbox:checked');
    let totalQty = 0;
    let totalRefund = 0;
    checkboxes.forEach(cb => {
      const row = cb.closest('.return-item-row');
      const qtyInput = row.querySelector('.return-qty-input');
      const qty = Math.min(Number(qtyInput?.value || 1), Number(cb.dataset.maxQty || 1));
      const unitPrice = Number(cb.dataset.unitPrice || 0);
      totalQty += qty;
      totalRefund += qty * unitPrice;
    });
    if (pendingReturnTransaction?.discountPercent) {
      totalRefund -= totalRefund * (pendingReturnTransaction.discountPercent / 100);
    }
    document.getElementById('return-item-count').textContent = totalQty;
    document.getElementById('return-refund-amount').textContent = formatCurrency(totalRefund);
  }

  // Process return button
  document.getElementById('process-return-btn').addEventListener('click', () => {
    if (!pendingReturnTransaction) return;

    const checkboxes = document.querySelectorAll('.return-item-checkbox:checked');
    if (!checkboxes.length) {
      alert('Please select at least one item to return.');
      return;
    }

    const selectedItems = Array.from(checkboxes).map(cb => {
      const row = cb.closest('.return-item-row');
      const qtyInput = row.querySelector('.return-qty-input');
      const qty = Math.min(Number(qtyInput?.value || 1), Number(cb.dataset.maxQty || 1));
      return {
        name: cb.dataset.name,
        qty,
        unitPrice: Number(cb.dataset.unitPrice || 0),
        inventoryId: cb.dataset.inventoryId
      };
    });

    const reason = document.getElementById('return-reason').value;
    const refundType = document.getElementById('return-refund-type').value;
    const notes = document.getElementById('return-notes').value.trim();

    const result = processReturn(state, pendingReturnTransaction, selectedItems, reason, refundType, notes);
    if (!result) return;

    logAudit('RETURN', AUDIT_CATEGORIES.RETURN,
      `Return on ${pendingReturnTransaction.billNumber}: ${selectedItems.map(i => `${i.name} ×${i.qty}`).join(', ')} — Refund ${formatCurrency(result.refundAmount)} (${reason}, ${refundType})`,
      { originalBillNumber: pendingReturnTransaction.billNumber, refundAmount: result.refundAmount }
    );

    state = result.newState;
    saveState(state);
    renderView(state);

    // Show confirmation
    const formCard = document.getElementById('return-form-card');
    const resultDiv = document.getElementById('return-search-result');
    formCard.classList.add('hidden');
    resultDiv.innerHTML = `
      <div class="return-success-banner">
        <strong>✓ Return processed successfully!</strong>
        <span>Refund: ${formatCurrency(result.refundAmount)} • Items: ${selectedItems.map(i => `${i.name} × ${i.qty}`).join(', ')}</span>
      </div>
    `;
    document.getElementById('return-receipt-input').value = '';
    pendingReturnTransaction = null;
  });

  // Cancel return button
  document.getElementById('cancel-return-btn').addEventListener('click', () => {
    document.getElementById('return-form-card').classList.add('hidden');
    document.getElementById('return-search-result').classList.add('hidden');
    document.getElementById('return-receipt-input').value = '';
    pendingReturnTransaction = null;
  });

  document.getElementById('branch-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = document.getElementById('branch-name').value.trim();
    const location = document.getElementById('branch-location').value.trim();
    if (!name || !location) return;
    state = addBranch(state, { name, location });
    saveState(state);
    document.getElementById('branch-form').reset();
    renderView(state);
  });

  // Show/hide custom tax rate input
  document.getElementById('inventory-tax-rate').addEventListener('change', (e) => {
    const customInput = document.getElementById('inventory-tax-rate-custom');
    customInput.classList.toggle('hidden', e.target.value !== 'custom');
  });

  document.getElementById('inventory-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const entry = {
      branchId: document.getElementById('inventory-branch').value,
      sku: document.getElementById('inventory-sku').value.trim(),
      barcode: document.getElementById('inventory-barcode').value.trim(),
      name: document.getElementById('inventory-name').value.trim(),
      category: document.getElementById('inventory-category').value.trim(),
      brand: document.getElementById('inventory-brand').value.trim(),
      unit: document.getElementById('inventory-unit').value.trim(),
      costPrice: document.getElementById('inventory-cost').value,
      mrp: document.getElementById('inventory-mrp').value,
      sellingPrice: document.getElementById('inventory-price').value,
      description: document.getElementById('inventory-description').value.trim(),
      stock: document.getElementById('inventory-stock').value,
      lowStock: document.getElementById('inventory-threshold').value,
      hsnCode: document.getElementById('inventory-hsn').value.trim(),
      itemTaxRate: document.getElementById('inventory-tax-rate').value === 'custom'
        ? document.getElementById('inventory-tax-rate-custom').value
        : document.getElementById('inventory-tax-rate').value,
      taxInclusive: document.getElementById('inventory-tax-inclusive').value
    };
    state = addInventoryItem(state, entry);
    logAudit('INVENTORY_ADD', AUDIT_CATEGORIES.INVENTORY, `Added item "${entry.name}" (SKU: ${entry.sku}), stock: ${entry.stock}, price: ₹${entry.sellingPrice}`, { sku: entry.sku, name: entry.name });
    saveState(state);
    document.getElementById('inventory-form').reset();
    renderView(state);
  });

  document.getElementById('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const profile = {
      shopName: document.getElementById('shop-name').value.trim(),
      ownerName: document.getElementById('shop-owner').value.trim(),
      phone: document.getElementById('shop-phone').value.trim(),
      email: document.getElementById('shop-email').value.trim(),
      address: document.getElementById('shop-address').value.trim(),
      gst: document.getElementById('shop-gst').value.trim(),
      taxName: document.getElementById('shop-tax-name').value.trim(),
      taxRate: Number(document.getElementById('shop-tax-rate').value || 0),
      taxType: document.getElementById('shop-tax-type').value,
      taxInclusive: document.getElementById('shop-tax-inclusive').value,
      receiptPrefix: document.getElementById('shop-receipt-prefix').value.trim(),
      nextReceiptNumber: Number(document.getElementById('shop-next-receipt').value || 1001),
      printLayout: document.getElementById('shop-print-layout').value,
      website: document.getElementById('shop-website').value.trim(),
      footer: document.getElementById('shop-footer').value.trim()
    };
    shopProfile = profile;
    state = { ...state, shopProfile: profile };
    logAudit('SETTINGS_CHANGE', AUDIT_CATEGORIES.SETTINGS, `Shop profile updated: "${profile.shopName}" by ${currentUser?.username}`);
    saveState(state);
    renderView(state);
    alert('Shop settings saved.');
  });

  document.getElementById('account-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const currentPassword = document.getElementById('account-current-password').value;
    const newUsername = document.getElementById('account-new-username').value;
    const newPassword = document.getElementById('account-new-password').value;
    const confirmPassword = document.getElementById('account-confirm-password').value;
    const feedback = document.getElementById('account-feedback');

    if (newPassword !== confirmPassword) {
      feedback.textContent = 'Passwords do not match.';
      feedback.className = 'account-feedback error';
      return;
    }

    const result = updateUserCredentials(currentUser?.username || '', currentPassword, newUsername, newPassword);
    feedback.textContent = result.message;
    feedback.className = `account-feedback ${result.success ? 'success' : 'error'}`;
    if (result.success) {
      currentUser = result.user;
      persistAuth(currentUser.username, newPassword);
      document.getElementById('account-form').reset();
      renderAuth(state);
    }
  });

  document.getElementById('cashier-branch').addEventListener('change', (event) => {
    renderView(state);
    document.getElementById('cashier-search').value = '';
    renderCashier(state, event.target.value);
  });

  document.getElementById('cashier-search').addEventListener('input', () => {
    renderCashier(state, document.getElementById('cashier-branch').value);
  });

  // ─── Barcode Scanner Logic ────────────────────────────────────────────────

  let barcodeBuffer = '';
  let barcodeTimer = null;
  const SCANNER_SPEED_THRESHOLD = 50; // ms — hardware scanners type faster than this
  let lastKeystrokeTime = 0;
  let isHardwareScanner = false;

  function lookupBarcode(code) {
    const branchId = document.getElementById('cashier-branch').value;
    const allItems = state.inventory; // search all branches by barcode
    const item = allItems.find(i =>
      (i.barcode && i.barcode.trim().toLowerCase() === code.trim().toLowerCase()) ||
      (i.sku && i.sku.trim().toLowerCase() === code.trim().toLowerCase())
    );
    return item;
  }

  function showBarcodeFeedback(message, isSuccess) {
    const fb = document.getElementById('barcode-feedback');
    fb.textContent = message;
    fb.className = `barcode-feedback ${isSuccess ? 'feedback-success' : 'feedback-error'}`;
    clearTimeout(fb._timer);
    fb._timer = setTimeout(() => { fb.className = 'barcode-feedback hidden'; }, 2500);
  }

  function processBarcodeScan(code) {
    if (!code) return;
    const item = lookupBarcode(code);
    if (item) {
      addToCart(item);
      renderCashier(state, document.getElementById('cashier-branch').value);
      showBarcodeFeedback(`✓ Added: ${item.name}`, true);
      document.getElementById('barcode-scan-input').value = '';
      // Flash the input green
      const input = document.getElementById('barcode-scan-input');
      input.classList.add('scan-success-flash');
      setTimeout(() => input.classList.remove('scan-success-flash'), 600);
    } else {
      showBarcodeFeedback(`✗ Not found: "${code}"`, false);
      const input = document.getElementById('barcode-scan-input');
      input.classList.add('scan-error-flash');
      setTimeout(() => { input.classList.remove('scan-error-flash'); input.value = ''; }, 800);
    }
  }

  // Keyboard wedge scanner: detects rapid key input followed by Enter
  document.getElementById('barcode-scan-input').addEventListener('keydown', (e) => {
    const now = Date.now();
    const timeSinceLast = now - lastKeystrokeTime;
    lastKeystrokeTime = now;

    if (timeSinceLast < SCANNER_SPEED_THRESHOLD) {
      isHardwareScanner = true;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const code = document.getElementById('barcode-scan-input').value.trim();
      processBarcodeScan(code);
      barcodeBuffer = '';
      isHardwareScanner = false;
    }
  });

  // Also support manual typing then Enter
  document.getElementById('barcode-scan-input').addEventListener('keyup', (e) => {
    if (e.key === 'Enter') return;
    // Clear after long pause (user stopped typing)
    clearTimeout(barcodeTimer);
    barcodeTimer = setTimeout(() => {
      if (!isHardwareScanner) barcodeBuffer = '';
    }, 3000);
  });

  // Camera scanning using BarcodeDetector API (Chromium only)
  let cameraStream = null;
  let cameraDetectionLoop = null;

  document.getElementById('camera-scan-btn').addEventListener('click', async () => {
    const overlay = document.getElementById('camera-scan-overlay');
    overlay.classList.remove('hidden');
    document.getElementById('camera-status').textContent = 'Requesting camera access...';

    if (!('BarcodeDetector' in window)) {
      document.getElementById('camera-status').textContent =
        '⚠️ Camera barcode detection not supported in this browser. Use keyboard scanner input or type the barcode manually.';
      return;
    }

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const video = document.getElementById('barcode-video');
      video.srcObject = cameraStream;
      await video.play();
      document.getElementById('camera-status').textContent = 'Point camera at barcode...';

      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code', 'data_matrix'] });
      let lastDetected = '';
      let lastDetectedTime = 0;

      cameraDetectionLoop = setInterval(async () => {
        if (!video.readyState || video.readyState < 2) return;
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            const code = barcodes[0].rawValue;
            const now = Date.now();
            // Debounce — don't re-scan same code within 2s
            if (code === lastDetected && now - lastDetectedTime < 2000) return;
            lastDetected = code;
            lastDetectedTime = now;

            document.getElementById('camera-status').textContent = `Detected: ${code}`;
            processBarcodeScan(code);
            if (lookupBarcode(code)) {
              stopCamera();
            }
          }
        } catch (_) {}
      }, 200);
    } catch (err) {
      document.getElementById('camera-status').textContent = `Camera error: ${err.message}`;
    }
  });

  function stopCamera() {
    if (cameraDetectionLoop) { clearInterval(cameraDetectionLoop); cameraDetectionLoop = null; }
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    document.getElementById('camera-scan-overlay').classList.add('hidden');
  }

  document.getElementById('close-camera-btn').addEventListener('click', stopCamera);

  // Auto-focus scanner input when switching to cashier view
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'cashier') {
        setTimeout(() => document.getElementById('barcode-scan-input')?.focus(), 100);
      } else {
        stopCamera();
      }
    });
  });

  // ─── End Barcode Scanner ─────────────────────────────────────────────────

  document.getElementById('cashier-catalog').addEventListener('click', (event) => {
    const button = event.target.closest('[data-add-item]');
    if (!button) return;
    const itemId = button.getAttribute('data-add-item');
    const item = state.inventory.find((entry) => entry.id === itemId);
    if (item) {
      addToCart(item);
      renderCashier(state, document.getElementById('cashier-branch').value);
    }
  });

  document.getElementById('cart-list').addEventListener('click', (event) => {
    const changeButton = event.target.closest('[data-change-qty]');
    if (changeButton) {
      const itemId = changeButton.getAttribute('data-change-qty');
      const delta = Number(changeButton.getAttribute('data-delta'));
      updateCartItem(itemId, delta);
      renderCashier(state, document.getElementById('cashier-branch').value);
      return;
    }
    const removeButton = event.target.closest('[data-remove-item]');
    if (removeButton) {
      const itemId = removeButton.getAttribute('data-remove-item');
      cart = cart.filter((entry) => entry.id !== itemId);
      renderCashier(state, document.getElementById('cashier-branch').value);
    }
  });

  document.getElementById('discount-input').addEventListener('input', (event) => {
    activeDiscount = Math.max(0, Math.min(100, Number(event.target.value) || 0));
    renderCashier(state, document.getElementById('cashier-branch').value);
  });

  document.getElementById('apply-override-btn').addEventListener('click', () => {
    const value = Number(document.getElementById('price-override-input').value);
    if (!cart.length) {
      alert('Cart is empty.');
      return;
    }
    if (!Number.isFinite(value) || value < 0) {
      alert('Enter a valid price override.');
      return;
    }
    cart = cart.map((entry) => ({ ...entry, price: value }));
    priceOverride = value;
    logAudit('PRICE_OVERRIDE', AUDIT_CATEGORIES.CART, `Price override applied: ₹${value} on ${cart.length} cart item(s)`, { value, itemCount: cart.length });
    renderCashier(state, document.getElementById('cashier-branch').value);
  });

  document.getElementById('hold-bill-btn').addEventListener('click', () => {
    if (!cart.length) {
      alert('Cart is empty.');
      return;
    }
    const branchId = document.getElementById('cashier-branch').value;
    addHeldBill(cart, branchId, activeDiscount);
    const heldItems = cart.map(e => `${e.name} ×${e.qty}`).join(', ');
    const heldTotal = cart.reduce((s, e) => s + e.qty * e.price, 0);
    logAudit('HOLD', AUDIT_CATEGORIES.CART, `Bill held: ${heldItems} — ${formatCurrency(heldTotal)}`, { itemCount: cart.length, total: heldTotal });
    clearCart();
    activeDiscount = 0;
    priceOverride = null;
    document.getElementById('discount-input').value = '0';
    document.getElementById('price-override-input').value = '';
    renderView(state);
    alert('Bill held successfully and synced to cloud.');
  });

  document.getElementById('void-cart-btn').addEventListener('click', () => {
    if (cart.length) {
      const voidItems = cart.map(e => `${e.name} ×${e.qty}`).join(', ');
      const voidTotal = cart.reduce((s, e) => s + e.qty * e.price, 0);
      logAudit('VOID', AUDIT_CATEGORIES.CART, `Cart voided: ${voidItems} — ${formatCurrency(voidTotal)}`, { itemCount: cart.length });
    }
    clearCart();
    activeDiscount = 0;
    priceOverride = null;
    document.getElementById('discount-input').value = '0';
    document.getElementById('price-override-input').value = '';
    renderCashier(state, document.getElementById('cashier-branch').value);
  });

  document.getElementById('print-receipt-btn').addEventListener('click', () => {
    if (!lastReceipt && !cart.length) {
      alert('No receipt available to print.');
      return;
    }
    printReceipt(lastReceipt, state);
  });

  document.getElementById('reprint-receipt-btn').addEventListener('click', () => {
    if (!lastReceipt) {
      alert('No reprintable receipt available.');
      return;
    }
    printReceipt(lastReceipt, state);
  });

  // Split payment toggle
  document.getElementById('split-payment-toggle').addEventListener('change', (e) => {
    const isSplit = e.target.checked;
    document.getElementById('single-payment-row').classList.toggle('hidden', isSplit);
    document.getElementById('split-payment-rows').classList.toggle('hidden', !isSplit);
    document.getElementById('split-summary').classList.toggle('hidden', !isSplit);
    document.getElementById('add-split-row-btn').classList.toggle('hidden', !isSplit);
    if (isSplit) updateSplitSummary();
  });

  // Add new split row button
  document.getElementById('add-split-row-btn').addEventListener('click', () => {
    const container = document.getElementById('split-payment-rows');
    const rowCount = container.querySelectorAll('.split-row').length + 1;
    const row = document.createElement('div');
    row.className = 'split-row';
    row.id = `split-row-${rowCount}`;
    row.innerHTML = `
      <select class="split-method">
        <option>Cash</option>
        <option>Card</option>
        <option selected>UPI</option>
        <option>Wallet</option>
      </select>
      <input type="number" class="split-amount" placeholder="Amount (₹)" min="0" step="0.01" />
      <button class="split-remove-btn">✕</button>
    `;
    container.appendChild(row);
    row.querySelector('.split-remove-btn').style.display = '';
    // Show remove on first 2 rows too
    container.querySelectorAll('.split-remove-btn').forEach(btn => { btn.style.display = ''; });
    updateSplitSummary();
  });

  // Remove split row (delegated)
  document.getElementById('split-payment-rows').addEventListener('click', (e) => {
    if (!e.target.classList.contains('split-remove-btn')) return;
    const rows = document.querySelectorAll('#split-payment-rows .split-row');
    if (rows.length <= 2) return; // Keep minimum 2 rows
    e.target.closest('.split-row').remove();
    updateSplitSummary();
  });

  // Live split amount updates
  document.getElementById('split-payment-rows').addEventListener('input', (e) => {
    if (e.target.classList.contains('split-amount') || e.target.classList.contains('split-method')) {
      updateSplitSummary();
    }
  });

  function updateSplitSummary() {
    const cartFinal = cart.reduce((sum, e) => sum + e.qty * e.price, 0);
    const discPct = activeDiscount || 0;
    const profile = state.shopProfile || {};
    const taxRate = Number(profile.taxRate || 0);
    const total = cartFinal * (1 - discPct / 100) * (1 + taxRate / 100);

    const rows = document.querySelectorAll('#split-payment-rows .split-row');
    let entered = 0;
    const breakdown = [];
    rows.forEach(row => {
      const method = row.querySelector('.split-method').value;
      const amt = Number(row.querySelector('.split-amount').value) || 0;
      entered += amt;
      if (amt > 0) breakdown.push(`${method}: ${formatCurrency(amt)}`);
    });

    const remaining = total - entered;
    const summaryEl = document.getElementById('split-summary');
    const isBalanced = Math.abs(remaining) <= 0.01;
    summaryEl.innerHTML = `
      <div class="split-breakdown">${breakdown.join(' + ') || 'No amounts entered'}</div>
      <div class="split-remaining ${isBalanced ? 'split-balanced' : remaining < 0 ? 'split-over' : 'split-under'}">
        ${isBalanced ? '✓ Balanced' : remaining > 0 ? `Remaining: ${formatCurrency(remaining)}` : `Over by: ${formatCurrency(-remaining)}`}
      </div>
    `;
    // Auto-fill last row if only one amount is missing
    const emptyRows = Array.from(rows).filter(r => !Number(r.querySelector('.split-amount').value));
    if (emptyRows.length === 1 && remaining > 0) {
      emptyRows[0].querySelector('.split-amount').placeholder = `Auto: ${formatCurrency(remaining)}`;
    }
  }

  document.getElementById('checkout-btn').addEventListener('click', () => {
    const branchId = document.getElementById('cashier-branch').value;
    const customerPhone = document.getElementById('customer-phone').value;
    const isSplit = document.getElementById('split-payment-toggle').checked;

    let paymentMethod = document.getElementById('payment-method').value;
    let splitPayments = null;

    if (isSplit) {
      const rows = document.querySelectorAll('#split-payment-rows .split-row');
      splitPayments = Array.from(rows).map(row => ({
        method: row.querySelector('.split-method').value,
        amount: Number(row.querySelector('.split-amount').value) || 0
      })).filter(p => p.amount > 0);

      if (!splitPayments.length) {
        alert('Please enter amounts for the split payment methods.');
        return;
      }
      paymentMethod = splitPayments.map(p => p.method).join(' + ');
    }

    const result = checkoutCart(state, branchId, paymentMethod, 'Cashier', activeDiscount, splitPayments);
    if (!result.success) {
      alert(result.message);
      return;
    }
    
    // Save customer transaction if phone was provided
    if (customerPhone && customerPhone.trim()) {
      const customer = getOrCreateCustomer(customerPhone);
      if (customer) {
        addCustomerTransaction(customer.id, result.transaction);
      }
    }
    
    state = result.nextState;
    shopProfile = state.shopProfile || shopProfile;
    lastReceipt = result.transaction;
    const txn = result.transaction;
    logAudit('SALE', AUDIT_CATEGORIES.SALE,
      `Bill ${txn.billNumber}: ${txn.items.map(i => `${i.name} ×${i.qty}`).join(', ')} — ${formatCurrency(txn.total)} via ${txn.paymentMethod}`,
      { billNumber: txn.billNumber, total: txn.total, paymentMethod: txn.paymentMethod }
    );
    saveState(state);
    clearCart();
    activeDiscount = 0;
    priceOverride = null;
    document.getElementById('discount-input').value = '0';
    document.getElementById('price-override-input').value = '';
    document.getElementById('customer-phone').value = '';
    // Reset split payment state
    document.getElementById('split-payment-toggle').checked = false;
    document.getElementById('single-payment-row').classList.remove('hidden');
    document.getElementById('split-payment-rows').classList.add('hidden');
    document.getElementById('split-summary').classList.add('hidden');
    document.getElementById('add-split-row-btn').classList.add('hidden');
    document.querySelectorAll('.split-amount').forEach(i => { i.value = ''; });
    renderView(state);
  });

  // Audit log controls
  document.getElementById('export-audit-btn').addEventListener('click', exportAuditCSV);
  ['audit-search', 'audit-category-filter', 'audit-date-filter'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderAuditLog);
    document.getElementById(id)?.addEventListener('change', renderAuditLog);
  });

  // ─── Employee Management Events ─────────────────────────────────────────────

  // Populate branch select when panel opens
  document.getElementById('add-employee-btn').addEventListener('click', () => {
    selectedEmployeeId = null;
    openEmpForm(null);
    // populate branches in form
    const sel = document.getElementById('emp-branch');
    sel.innerHTML = state.branches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  });

  document.getElementById('emp-cancel-btn').addEventListener('click', () => {
    document.getElementById('emp-form-card').classList.add('hidden');
  });

  document.getElementById('emp-save-btn').addEventListener('click', () => {
    const card = document.getElementById('emp-form-card');
    const editId = card.dataset.editId;
    const fullName = document.getElementById('emp-fullname').value.trim();
    const username = document.getElementById('emp-username').value.trim();
    const password = document.getElementById('emp-password').value;
    const role = document.getElementById('emp-role').value;
    const phone = document.getElementById('emp-phone').value.trim();
    const email = document.getElementById('emp-email').value.trim();
    const position = document.getElementById('emp-position').value.trim();
    const branchId = document.getElementById('emp-branch').value;
    const joiningDate = document.getElementById('emp-joining').value;
    const status = document.getElementById('emp-status').value;
    const notes = document.getElementById('emp-notes').value.trim();
    const errorEl = document.getElementById('emp-form-error');

    if (!fullName || !username) { errorEl.textContent = 'Full name and username are required.'; return; }

    if (editId) {
      // Update existing employee profile
      const idx = employees.findIndex(e => e.id === editId);
      if (idx !== -1) {
        employees[idx] = { ...employees[idx], fullName, role, phone, email, position, branchId, joiningDate, status, notes };
        // If password provided, update auth credentials
        if (password) {
          const authIdx = authUsers.findIndex(u => u.username === employees[idx].username);
          if (authIdx !== -1) { authUsers[authIdx].password = password; persistAuthUsers(authUsers); }
        }
        logAudit('EMPLOYEE_EDIT', AUDIT_CATEGORIES.USER, `Employee "${fullName}" profile updated`, { username });
      }
    } else {
      // New employee — also create auth user
      if (!password) { errorEl.textContent = 'Password is required for new employees.'; return; }
      const authResult = addUser(username, password, role);
      if (!authResult.success) { errorEl.textContent = authResult.message; return; }

      const newEmp = {
        id: `emp-${Date.now()}`,
        username, fullName, role, phone, email, position,
        branchId, joiningDate, status: status || 'active', notes,
        createdAt: new Date().toISOString()
      };
      employees.push(newEmp);
      logAudit('EMPLOYEE_ADD', AUDIT_CATEGORIES.USER, `New employee "${fullName}" (@${username}) added as ${role}`, { username, role });
    }

    saveEmployees();
    card.classList.add('hidden');
    renderEmployees(state);
  });

  // Employee card interactions (delegated)
  document.getElementById('emp-cards-grid').addEventListener('click', (e) => {
    const viewBtn = e.target.closest('.emp-view-btn');
    if (viewBtn) { selectedEmployeeId = viewBtn.dataset.empId; renderEmployees(state); return; }
    const editBtn = e.target.closest('.emp-edit-btn');
    if (editBtn) {
      const emp = employees.find(x => x.id === editBtn.dataset.empId);
      if (emp) {
        const sel = document.getElementById('emp-branch');
        sel.innerHTML = state.branches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
        openEmpForm(emp);
      }
      return;
    }
  });

  // Detail view back + edit + delete (delegated)
  document.getElementById('emp-back-btn').addEventListener('click', () => {
    selectedEmployeeId = null;
    renderEmployees(state);
  });

  document.getElementById('emp-detail-content').addEventListener('click', (e) => {
    const editBtn = e.target.closest('.emp-edit-btn');
    if (editBtn) {
      const emp = employees.find(x => x.id === editBtn.dataset.empId);
      if (emp) {
        const sel = document.getElementById('emp-branch');
        sel.innerHTML = state.branches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
        openEmpForm(emp);
      }
      return;
    }
    const deleteBtn = e.target.closest('.emp-delete-btn');
    if (deleteBtn) {
      const empId = deleteBtn.dataset.empId;
      const empUsername = deleteBtn.dataset.username;
      const emp = employees.find(x => x.id === empId);
      if (!emp) return;
      if (!confirm(`Remove employee "${emp.fullName}"? This will also delete their login account.`)) return;
      employees = employees.filter(x => x.id !== empId);
      deleteUser(empUsername);
      saveEmployees();
      logAudit('EMPLOYEE_REMOVE', AUDIT_CATEGORIES.USER, `Employee "${emp.fullName}" (@${empUsername}) removed`, { username: empUsername });
      selectedEmployeeId = null;
      renderEmployees(state);
      return;
    }
  });

  // Employee search/filter
  ['emp-search', 'emp-status-filter'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => renderEmployees(state));
    document.getElementById(id)?.addEventListener('change', () => renderEmployees(state));
  });

  // ─── End Employee Events ──────────────────────────────────────────────────

  // ─── Backup & Export Events ──────────────────────────────────────────────

  document.getElementById('export-full-backup-btn').addEventListener('click', () => {
    exportFullBackup(state);
  });

  document.getElementById('import-backup-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('backup-restore-status');
    statusEl.textContent = 'Restoring backup...';
    importFromBackup(file, (success, message, newState) => {
      statusEl.textContent = message;
      statusEl.className = `backup-status ${success ? 'backup-success' : 'backup-error'}`;
      if (success) {
        setTimeout(() => location.reload(), 1500);
      }
    });
    e.target.value = ''; // reset so same file can be re-selected
  });

  // CSV Export buttons
  document.getElementById('export-transactions-csv').addEventListener('click', () => exportTransactionsCSV(state));
  document.getElementById('export-inventory-csv').addEventListener('click', () => exportInventoryCSV(state));
  document.getElementById('export-customers-csv').addEventListener('click', () => exportCustomersCSV());
  document.getElementById('export-employees-csv').addEventListener('click', () => exportEmployeesCSV());
  document.getElementById('export-returns-csv').addEventListener('click', () => exportReturnsCSV());
  document.getElementById('export-tax-report-csv').addEventListener('click', () => exportTaxReportCSV(state));

  // CSV Import Inventory
  document.getElementById('import-inventory-csv').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('import-inventory-status');
    statusEl.textContent = 'Importing...';
    importInventoryFromCSV(file, state, (success, message, newState) => {
      statusEl.textContent = message;
      statusEl.className = `backup-status ${success ? 'backup-success' : 'backup-error'}`;
      if (success && newState) {
        state = newState;
        renderView(state);
      }
    });
    e.target.value = '';
  });

  // CSV Template download
  document.getElementById('csv-template-link').addEventListener('click', (e) => {
    e.preventDefault();
    generateInventoryCSVTemplate();
  });

  // ─── End Backup & Export Events ──────────────────────────────────────────

  window.addEventListener('storage', () => {
    const freshState = loadState();
    state = freshState;
    renderView(state);
  });

  if (typeof window.BroadcastChannel !== 'undefined') {
    const channel = new window.BroadcastChannel(REALTIME_CHANNEL);
    channel.addEventListener('message', (event) => {
      if (event.data?.type === 'state-update') {
        state = event.data.state;
        renderView(state);
      }
    });
  }
}

function initializeApp() {
  // Initialize Firebase first so we can load global auth users
  firebaseInit();
  
  // Load auth users synchronously first, then try to sync from Firebase
  authUsers = loadAuthUsers();
  const initialState = loadState();
  let state = initialState;
  shopProfile = state.shopProfile || shopProfile;
  customers = loadCustomers();
  returns = loadReturns();
  auditLog = loadAuditLog();
  employees = loadEmployees();
  
  // Load auth users from Firebase if available (for cross-device sync)
  if (firebaseEnabled) {
    cloudLoadAuthUsers().then((firebaseUsers) => {
      if (firebaseUsers && firebaseUsers.length > 0) {
        authUsers = firebaseUsers;
        persistAuthUsers(authUsers);
        renderUsersList();
      }
    }).catch((e) => console.warn('Failed to load auth users from Firebase', e));
  }
  
  const storedAuth = getStoredAuth();
  const shouldAutoLoginFlag = storedAuth && shouldAutoLogin();
  
  if (shouldAutoLoginFlag && storedAuth) {
    // Auto-login if "Remember Me" was checked
    currentUser = authenticateUser(storedAuth.username, storedAuth.password);
    if (currentUser) {
      firebaseInit();
      if (firebaseEnabled) {
        cloudLoadInitialState(currentUser.username).then((remoteState) => {
          if (remoteState) {
            state = {
              ...state,
              ...remoteState,
              branches: remoteState.branches || state.branches,
              inventory: remoteState.inventory || state.inventory,
              transactions: remoteState.transactions || state.transactions,
              shopProfile: remoteState.shopProfile || state.shopProfile
            };
            saveState(state);
            renderView(state);
          }
        });
        cloudSubscribe(currentUser.username, (remoteState) => {
          try {
            state = {
              ...state,
              ...remoteState,
              branches: remoteState.branches || state.branches,
              inventory: remoteState.inventory || state.inventory,
              transactions: remoteState.transactions || state.transactions,
              shopProfile: remoteState.shopProfile || state.shopProfile
            };
            saveState(state);
            renderView(state);
          } catch (e) { console.warn('Error applying remote state', e); }
        });
        
        // Subscribe to shared held bills for live queue
        cloudLoadHeldBills(shopId).then((bills) => {
          globalHeldBills = bills;
          renderQueue(state);
        });
        cloudSubscribeHeldBills(shopId, (bills) => {
          globalHeldBills = bills;
          renderQueue(state);
        });
      }
    }
  } else {
    currentUser = null;
  }
  
  renderAuth(state);
  bindEvents(state);
  document.getElementById('connectivity').textContent = navigator.onLine ? 'Realtime ready' : 'Offline mode';
  window.addEventListener('online', () => {
    document.getElementById('connectivity').textContent = 'Realtime ready';
  });
  window.addEventListener('offline', () => {
    document.getElementById('connectivity').textContent = 'Offline mode';
  });

  // Hydrate from IndexedDB in the background so other devices with the same
  // app instance can pick up the latest persisted state (local device only).
  (async () => {
    try {
      const raw = await dbGet(STORAGE_KEY);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        state = {
          ...state,
          ...parsed,
          branches: parsed.branches || state.branches,
          inventory: parsed.inventory || state.inventory,
          transactions: parsed.transactions || state.transactions,
          shopProfile: parsed.shopProfile || state.shopProfile
        };

        const storedUsers = await dbGet(AUTH_USERS_STORAGE_KEY);
        if (storedUsers) {
          try { authUsers = typeof storedUsers === 'string' ? JSON.parse(storedUsers) : storedUsers; } catch { authUsers = storedUsers; }
        }

        const authFromDb = await dbGet(AUTH_STORAGE_KEY);
        if (authFromDb && !currentUser) {
          try {
            const parsedAuth = typeof authFromDb === 'string' ? JSON.parse(authFromDb) : authFromDb;
            currentUser = authenticateUser(parsedAuth.username, parsedAuth.password);
          } catch {}
        }

        saveState(state);
        renderAuth(state);
      }
    } catch (e) {
      console.warn('Failed to hydrate from IndexedDB', e);
    }
  })();
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', initializeApp);
}

export { initializeApp };
