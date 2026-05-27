const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  subscriptions: [],
  linkedAccounts: [
    { bank: 'Chase Sapphire', mask: '•••• 4321', status: 'Active', source: 'Plaid Link' },
    { bank: 'Capital One Venture', mask: '•••• 7812', status: 'Active', source: 'Plaid Link' },
  ],
  mobileAlerts: [],
  auditLog: [],
  filesProcessed: 0,
  mobileUnlocked: false,
};

const storageKey = 'subscription-audit-state';
const demoStatement = `Vendor,Amount,Currency,Cycle,Next Renewal,Status,Category,Source
Netflix,15.49,USD,Monthly,2026-05-28,Active,Entertainment,Card
Spotify,11.99,USD,Monthly,2026-06-01,Active,Entertainment,Card
Adobe,22.99,USD,Monthly,2026-05-28,Paused,Software,Card
Notion,10.00,USD,Monthly,2026-06-03,Active,Software,Card
DoorDash,9.99,USD,Monthly,2026-06-02,Canceled,Food,Card
Google One,9.99,USD,Monthly,2026-06-04,Active,Storage,Card`;

const fallbackCategories = [
  { name: 'Entertainment', color: '#35d0c0' },
  { name: 'Software', color: '#7fb8ff' },
  { name: 'Utilities', color: '#f0b860' },
  { name: 'Food', color: '#ff7e86' },
  { name: 'Storage', color: '#7fcf73' },
];

const vendorRules = [
  { vendor: 'Netflix', keywords: ['NETFLIX'], category: 'Entertainment' },
  { vendor: 'Spotify', keywords: ['SPOTIFY'], category: 'Entertainment' },
  { vendor: 'Adobe', keywords: ['ADOBE', 'PHOTOSHOP'], category: 'Software' },
  { vendor: 'Notion', keywords: ['NOTION'], category: 'Software' },
  { vendor: 'Google One', keywords: ['GOOGLE ONE', 'DRIVE'], category: 'Storage' },
  { vendor: 'DoorDash', keywords: ['DOORDASH'], category: 'Food' },
  { vendor: 'Amazon Prime', keywords: ['AMAZON PRIME', 'PRIME VIDEO'], category: 'Entertainment' },
  { vendor: 'Apple One', keywords: ['APPLE ONE', 'ICLOUD', 'APPLE TV'], category: 'Utilities' },
];

let deferredInstallPrompt = null;

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function parseMoney(value) {
  if (typeof value === 'number') return value;
  const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function daysFromToday(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function normalizeStatus(status) {
  const value = String(status || 'Active').toLowerCase();
  if (value.includes('cancel')) return 'Canceled';
  if (value.includes('pause')) return 'Paused';
  return 'Active';
}

function statusClass(status) {
  if (status === 'Active') return 'good';
  if (status === 'Paused') return 'warn';
  return 'danger';
}

function cycleLabel(value) {
  const cycle = String(value || 'Monthly').toLowerCase();
  if (cycle.includes('year')) return 'Yearly';
  if (cycle.includes('week')) return 'Weekly';
  return 'Monthly';
}

function inferCategory(vendor, text = '') {
  const haystack = `${vendor} ${text}`.toUpperCase();
  for (const rule of vendorRules) {
    if (rule.keywords.some(keyword => haystack.includes(keyword))) {
      return rule.category;
    }
  }
  return 'Utilities';
}

function getVendorMatch(line) {
  const upper = line.toUpperCase();
  return vendorRules.find(rule => rule.keywords.some(keyword => upper.includes(keyword)));
}

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== '\\') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const header = parseCsvLine(lines[0]).map(entry => entry.toLowerCase());
  const structured = header.some(entry => ['vendor', 'merchant', 'amount', 'date', 'next renewal'].some(key => entry.includes(key)));
  if (!structured) return [];

  const mapRow = row => {
    const cells = parseCsvLine(row);
    const record = Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']));
    const vendor = record.vendor || record.merchant || record.name || 'Unknown vendor';
    const amount = parseMoney(record.amount || record.price || record.spent);
    const renewal = isoDate(record['next renewal'] || record.date || record.renewal || daysFromToday(30));
    return {
      vendor,
      amount,
      currency: String(record.currency || 'USD').toUpperCase(),
      cycle: cycleLabel(record.cycle || record.billing || 'Monthly'),
      nextRenewal: renewal,
      status: normalizeStatus(record.status),
      category: record.category || inferCategory(vendor, row),
      source: record.source || 'Upload',
    };
  };

  return lines.slice(1).map(mapRow).filter(item => item.vendor && item.amount > 0);
}

function parseStatementText(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const csv = parseCsv(trimmed);
  if (csv.length) return csv;

  return trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap((line, index) => {
      const vendorMatch = getVendorMatch(line);
      const amountMatch = line.match(/\$?\s?([0-9]+(?:\.[0-9]{2})?)/g);
      const dateMatch = line.match(/(\d{4}-\d{2}-\d{2}|\w{3,9}\s+\d{1,2},?\s+\d{4})/);
      if (!vendorMatch || !amountMatch?.length) return [];
      const amount = parseMoney(amountMatch[0]);
      return [{
        vendor: vendorMatch.vendor,
        amount,
        currency: 'USD',
        cycle: /year/i.test(line) ? 'Yearly' : 'Monthly',
        nextRenewal: isoDate(dateMatch?.[1] || daysFromToday(14 + index)),
        status: /cancel/i.test(line) ? 'Canceled' : /pause/i.test(line) ? 'Paused' : 'Active',
        category: inferCategory(vendorMatch.vendor, line),
        source: 'Statement',
      }];
    });
}

async function parsePdfFile(file) {
  if (!window.pdfjsLib) {
    throw new Error('PDF parsing library unavailable.');
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const bytes = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  let text = '';
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text;
}

function dedupeSubscriptions(subscriptions) {
  const map = new Map();
  for (const item of subscriptions) {
    const key = `${item.vendor}|${item.amount}|${item.nextRenewal}`;
    map.set(key, {
      ...item,
      cycle: cycleLabel(item.cycle),
      status: normalizeStatus(item.status),
      category: item.category || inferCategory(item.vendor, item.source),
    });
  }
  return [...map.values()].sort((a, b) => new Date(a.nextRenewal) - new Date(b.nextRenewal));
}

function seedDemoData() {
  state.subscriptions = dedupeSubscriptions([
    { vendor: 'Netflix', amount: 15.49, currency: 'USD', cycle: 'Monthly', nextRenewal: daysFromToday(1), status: 'Active', category: 'Entertainment', source: 'Bank feed' },
    { vendor: 'Spotify', amount: 11.99, currency: 'USD', cycle: 'Monthly', nextRenewal: daysFromToday(5), status: 'Active', category: 'Entertainment', source: 'Bank feed' },
    { vendor: 'Adobe', amount: 22.99, currency: 'USD', cycle: 'Monthly', nextRenewal: daysFromToday(1), status: 'Paused', category: 'Software', source: 'Upload' },
    { vendor: 'Notion', amount: 10.00, currency: 'USD', cycle: 'Monthly', nextRenewal: daysFromToday(7), status: 'Active', category: 'Software', source: 'Upload' },
    { vendor: 'DoorDash', amount: 9.99, currency: 'USD', cycle: 'Monthly', nextRenewal: daysFromToday(6), status: 'Canceled', category: 'Food', source: 'Upload' },
    { vendor: 'Google One', amount: 9.99, currency: 'USD', cycle: 'Monthly', nextRenewal: daysFromToday(8), status: 'Active', category: 'Storage', source: 'Bank feed' },
  ]);
  state.mobileAlerts = buildAlerts();
  state.auditLog = [
    { title: 'Bank feed synced', detail: '2 accounts refreshed with read-only transactions.', time: '2m ago', tone: 'good' },
    { title: 'PDF parsed', detail: '3 subscriptions extracted from a statement upload.', time: '11m ago', tone: 'warn' },
    { title: 'Renewal alert queued', detail: 'Adobe trial ends tomorrow.', time: '22m ago', tone: 'danger' },
  ];
  state.filesProcessed = 3;
  state.mobileUnlocked = false;
}

function buildAlerts() {
  return state.subscriptions
    .filter(item => ['Active', 'Paused'].includes(item.status))
    .filter(item => {
      const days = Math.round((new Date(item.nextRenewal).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
      return days <= 7;
    })
    .slice(0, 4)
    .map(item => {
      const days = Math.round((new Date(item.nextRenewal).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
      return {
        vendor: item.vendor,
        nextRenewal: item.nextRenewal,
        days,
        amount: item.amount,
      };
    });
}

function getMetrics() {
  const monthlySpend = state.subscriptions.reduce((sum, item) => sum + (item.status === 'Canceled' ? 0 : item.amount), 0);
  const potentialSavings = state.subscriptions.reduce((sum, item) => sum + (item.status === 'Paused' || item.status === 'Canceled' ? item.amount : 0), 0);
  const upcoming = state.subscriptions.filter(item => {
    const diff = Math.round((new Date(item.nextRenewal).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    return diff >= 0 && diff <= 14;
  });
  const linkedAccounts = state.linkedAccounts.length;
  const nextRenewal = [...state.subscriptions]
    .sort((a, b) => new Date(a.nextRenewal) - new Date(b.nextRenewal))[0]?.nextRenewal || '--';
  return {
    monthlySpend,
    potentialSavings,
    upcomingCount: upcoming.length,
    linkedAccounts,
    nextRenewal,
  };
}

function getCategoryTotals() {
  const totals = new Map();
  for (const item of state.subscriptions) {
    if (item.status === 'Canceled') continue;
    const current = totals.get(item.category) || 0;
    totals.set(item.category, current + item.amount);
  }
  return [...totals.entries()]
    .map(([category, value]) => ({ category, value }))
    .sort((a, b) => b.value - a.value);
}

function createDonutChart(items) {
  const size = 260;
  const radius = 86;
  const innerRadius = 54;
  const center = size / 2;
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  let startAngle = -Math.PI / 2;
  const segments = items.map((item, index) => {
    const angle = (item.value / total) * Math.PI * 2;
    const endAngle = startAngle + angle;
    const x1 = center + radius * Math.cos(startAngle);
    const y1 = center + radius * Math.sin(startAngle);
    const x2 = center + radius * Math.cos(endAngle);
    const y2 = center + radius * Math.sin(endAngle);
    const ix1 = center + innerRadius * Math.cos(endAngle);
    const iy1 = center + innerRadius * Math.sin(endAngle);
    const ix2 = center + innerRadius * Math.cos(startAngle);
    const iy2 = center + innerRadius * Math.sin(startAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    const color = fallbackCategories[index % fallbackCategories.length].color;
    const d = [
      `M ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix1} ${iy1}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2} ${iy2}`,
      'Z',
    ].join(' ');
    startAngle = endAngle;
    return `<path d="${d}" fill="${color}" />`;
  }).join('');

  const centerText = items.length
    ? `<text x="${center}" y="${center - 6}" text-anchor="middle" fill="#edf4fb" font-size="22" font-weight="800">${money(total)}</text>
       <text x="${center}" y="${center + 18}" text-anchor="middle" fill="#94a6b8" font-size="12">tracked monthly spend</text>`
    : `<text x="${center}" y="${center}" text-anchor="middle" fill="#94a6b8" font-size="13">No data yet</text>`;

  return `
    <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Category donut chart">
      <circle cx="${center}" cy="${center}" r="${radius}" fill="#0a1018" stroke="#213243" stroke-width="1"></circle>
      ${segments}
      <circle cx="${center}" cy="${center}" r="${innerRadius}" fill="#09111a"></circle>
      ${centerText}
    </svg>
  `;
}

function renderChart() {
  const items = getCategoryTotals();
  $('#categoryChart').innerHTML = createDonutChart(items);
  $('#heroMiniChart').innerHTML = createDonutChart(items);
  $('#categoryLegend').innerHTML = items.length
    ? items.map((item, index) => {
        const swatch = fallbackCategories[index % fallbackCategories.length].color;
        const share = getMetrics().monthlySpend ? ((item.value / getMetrics().monthlySpend) * 100).toFixed(0) : '0';
        return `
          <div class="legend-item">
            <span class="legend-swatch" style="background:${swatch}"></span>
            <div>
              <strong>${item.category}</strong>
              <div class="legend-meta">${money(item.value)} monthly</div>
            </div>
            <span>${share}%</span>
          </div>
        `;
      }).join('')
    : '<p class="legend-meta">Upload a statement to populate the chart.</p>';
}

function renderTimeline() {
  const el = $('#timelineList');
  const items = [...state.subscriptions].sort((a, b) => new Date(a.nextRenewal) - new Date(b.nextRenewal)).slice(0, 6);
  el.innerHTML = items.map(item => {
    const diff = Math.round((new Date(item.nextRenewal).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    const tone = diff <= 1 ? 'danger' : diff <= 3 ? 'warn' : 'good';
    const label = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : `${diff} days`;
    return `
      <article class="timeline-item">
        <strong>${item.vendor} · ${money(item.amount)}</strong>
        <span>${item.nextRenewal} · ${item.cycle} · ${item.source}</span>
        <div class="tag ${tone}">${label}</div>
      </article>
    `;
  }).join('');
}

function renderTable() {
  const tbody = $('#subscriptionTable');
  tbody.innerHTML = state.subscriptions.map(item => `
    <tr>
      <td>
        <strong>${item.vendor}</strong><br>
        <small>${item.category}</small>
      </td>
      <td>${money(item.amount)}</td>
      <td>${item.cycle}</td>
      <td>${item.nextRenewal}</td>
      <td><span class="status-pill ${statusClass(item.status)}">${item.status}</span></td>
      <td><small>${item.source}</small></td>
    </tr>
  `).join('');
}

function renderLinkedAccounts() {
  $('#linkedAccounts').innerHTML = state.linkedAccounts.map(account => `
    <article class="account-item">
      <strong>${account.bank}</strong>
      <span>${account.mask} · ${account.status}</span>
      <div class="tag good">${account.source}</div>
    </article>
  `).join('');
}

function renderActionCenter() {
  const feed = $('#actionCenter');
  const items = buildAlerts();
  state.mobileAlerts = items;
  feed.innerHTML = items.length
    ? items.map(item => `
        <article class="action-item">
          <strong>${item.vendor} renews in ${item.days <= 0 ? 'today' : item.days === 1 ? 'tomorrow' : `${item.days} days`}</strong>
          <span>${money(item.amount)} · ${item.nextRenewal}</span>
          <div class="actions">
            <button type="button" data-action="keep" data-vendor="${item.vendor}">Keep</button>
            <button type="button" data-action="cancel" data-vendor="${item.vendor}">Cancel guide</button>
          </div>
        </article>
      `).join('')
    : '<div class="action-item"><strong>No urgent renewals</strong><span>All upcoming charges are outside the one-week window.</span></div>';
}

function renderMobileApp() {
  const metrics = getMetrics();
  const lockScreen = `
    <div class="lock-screen">
      <div class="lock-badge">◌</div>
      <h3>Face ID required</h3>
      <p>Unlock to see live bank-linked subscriptions, push alerts, and action cards.</p>
      <button class="primary-btn" id="unlockBtn" type="button">Use Face ID</button>
    </div>
  `;
  const homeScreen = `
    <div class="app-home">
      <div class="mobile-app-bar">
        <div>
          <h3>Subscription Audit</h3>
          <p>${state.linkedAccounts.length} linked accounts · background sync ready</p>
        </div>
        <button class="pill-btn" id="lockBtn" type="button">Lock</button>
      </div>
      <div class="mobile-stats">
        <div class="mobile-stat">
          <strong>${money(metrics.potentialSavings)}</strong>
          <span>possible savings</span>
        </div>
        <div class="mobile-stat">
          <strong>${metrics.upcomingCount}</strong>
          <span>renewals soon</span>
        </div>
      </div>
      <div class="alert-stack">
        ${state.mobileAlerts.map(item => `
          <article class="alert-card">
            <strong>${item.vendor}</strong>
            <span>Renews ${item.days <= 0 ? 'today' : item.days === 1 ? 'tomorrow' : `in ${item.days} days`}</span>
            <div class="actions">
              <button type="button" data-mobile-action="keep" data-vendor="${item.vendor}">Keep</button>
              <button type="button" data-mobile-action="cancel" data-vendor="${item.vendor}">Cancel guide</button>
            </div>
          </article>
        `).join('')}
      </div>
    </div>
  `;
  $('#mobileApp').innerHTML = state.mobileUnlocked ? homeScreen : lockScreen;
}

function renderAuditLog() {
  $('#auditLog').innerHTML = state.auditLog.map(item => `
    <article class="audit-item">
      <strong>${item.title}</strong>
      <span>${item.detail}</span>
      <div class="tag ${item.tone}">${item.time}</div>
    </article>
  `).join('');
}

function updateCounters() {
  const metrics = getMetrics();
  $('#savingsCounter').textContent = money(metrics.potentialSavings);
  $('#renewalCounter').textContent = metrics.upcomingCount.toString();
  $('#linkedCounter').textContent = metrics.linkedAccounts.toString();
  $('#fileCounter').textContent = state.filesProcessed.toString();
  $('#monthlySpend').textContent = money(metrics.monthlySpend);
  $('#nextRenewal').textContent = metrics.nextRenewal || '--';
}

function renderSummary(message) {
  $('#parseSummary').textContent = message;
}

function renderAll() {
  updateCounters();
  renderChart();
  renderTimeline();
  renderTable();
  renderLinkedAccounts();
  renderActionCenter();
  renderMobileApp();
  renderAuditLog();
}

function addAuditEntry(title, detail, tone = 'good') {
  state.auditLog.unshift({
    title,
    detail,
    time: 'just now',
    tone,
  });
  state.auditLog = state.auditLog.slice(0, 6);
}

function upsertSubscriptions(items) {
  state.subscriptions = dedupeSubscriptions([...items, ...state.subscriptions]);
  state.filesProcessed += 1;
  state.mobileAlerts = buildAlerts();
  addAuditEntry('Statement processed', `${items.length} subscriptions added from an upload.`, 'good');
  saveState();
  renderAll();
}

async function handleFile(file) {
  if (!file) return;
  try {
    let text = '';
    if (/\.pdf$/i.test(file.name)) {
      text = await parsePdfFile(file);
    } else {
      text = await file.text();
    }
    const parsed = parseStatementText(text).map(item => ({
      ...item,
      nextRenewal: item.nextRenewal || daysFromToday(21),
      category: item.category || inferCategory(item.vendor, text),
      source: file.name,
    }));
    if (!parsed.length) {
      renderSummary(`${file.name} opened, but no subscriptions were recognized.`);
      addAuditEntry('Parser fallback', `No subscription rows matched ${file.name}.`, 'warn');
      return;
    }
    upsertSubscriptions(parsed);
    renderSummary(`${parsed.length} subscriptions extracted from ${file.name}.`);
  } catch (error) {
    renderSummary(`Could not parse ${file.name}: ${error.message}`);
    addAuditEntry('Parse failed', error.message, 'danger');
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify({
    subscriptions: state.subscriptions,
    linkedAccounts: state.linkedAccounts,
    mobileAlerts: state.mobileAlerts,
    auditLog: state.auditLog,
    filesProcessed: state.filesProcessed,
    mobileUnlocked: state.mobileUnlocked,
  }));
}

function loadState() {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    state.subscriptions = dedupeSubscriptions(parsed.subscriptions || []);
    state.linkedAccounts = parsed.linkedAccounts || state.linkedAccounts;
    state.mobileAlerts = parsed.mobileAlerts || buildAlerts();
    state.auditLog = parsed.auditLog || state.auditLog;
    state.filesProcessed = parsed.filesProcessed || state.filesProcessed;
    state.mobileUnlocked = Boolean(parsed.mobileUnlocked);
    return true;
  } catch {
    return false;
  }
}

function loadDemo() {
  const parsed = parseStatementText(demoStatement);
  state.subscriptions = dedupeSubscriptions(parsed);
  state.mobileUnlocked = false;
  state.mobileAlerts = buildAlerts();
  state.auditLog = [
    { title: 'Demo loaded', detail: 'Sample subscriptions and renewal alerts are visible.', time: 'now', tone: 'good' },
    { title: 'Plaid-style link ready', detail: 'Read-only account tokens are represented in the demo.', time: 'now', tone: 'warn' },
  ];
  state.filesProcessed = 1;
  saveState();
  renderSummary('Demo statement loaded.');
  renderAll();
}

function bindEvents() {
  const fileInput = $('#statementFile');
  const dropzone = $('#dropzone');
  const pasteBtn = $('#parseTextBtn');

  $('#scanBtn').addEventListener('click', () => {
    $('#web').scrollIntoView({ behavior: 'smooth', block: 'start' });
    fileInput.click();
  });
  $('#scanNowBtn').addEventListener('click', () => fileInput.click());
  $('#loadDemoBtn').addEventListener('click', loadDemo);

  fileInput.addEventListener('change', async () => {
    await handleFile(fileInput.files?.[0]);
    fileInput.value = '';
  });

  dropzone.addEventListener('dragover', event => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async event => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    const file = event.dataTransfer.files?.[0];
    if (file) await handleFile(file);
  });
  dropzone.addEventListener('click', () => fileInput.click());

  pasteBtn.addEventListener('click', () => {
    const text = $('#statementPaste').value;
    const parsed = parseStatementText(text);
    if (!parsed.length) {
      renderSummary('No subscriptions were recognized in the pasted text.');
      addAuditEntry('Paste ignored', 'Parser could not identify any vendors.', 'warn');
      return;
    }
    upsertSubscriptions(parsed);
    renderSummary(`${parsed.length} subscriptions parsed from pasted text.`);
  });

  $('#mobileApp').addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const vendor = target.dataset.vendor;
    const action = target.dataset.action || target.dataset.mobileAction;
    if (!action || !vendor) return;
    if (action === 'keep') {
      addAuditEntry('Keep chosen', `${vendor} marked as intentionally retained.`, 'good');
    } else {
      addAuditEntry('Cancel guide opened', `Cancellation steps prepared for ${vendor}.`, 'warn');
    }
    state.mobileUnlocked = true;
    renderAll();
    saveState();
  });

  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === 'unlockBtn') {
      state.mobileUnlocked = true;
      addAuditEntry('Mobile unlocked', 'Biometric gate accepted on the demo device.', 'good');
      renderAll();
      saveState();
    }
    if (target.id === 'lockBtn') {
      state.mobileUnlocked = false;
      addAuditEntry('Mobile locked', 'App moved to the background and locked.', 'warn');
      renderAll();
      saveState();
    }
    if (target.dataset.action === 'keep' || target.dataset.action === 'cancel') {
      // Handled above if the action originated inside the phone shell.
    }
  });

  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('#installBtn').disabled = true;
  });

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $('#installBtn').disabled = false;
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function init() {
  if (loadState() && state.subscriptions.length) {
    state.mobileAlerts = buildAlerts();
  } else {
    seedDemoData();
    saveState();
  }
  bindEvents();
  renderSummary('Demo ready. Upload a file or paste text to replace the sample data.');
  renderAll();
  registerServiceWorker();
}

init();
