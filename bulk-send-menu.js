/* ============================================================
   เมนู "ส่ง SMS / จดหมาย (รวม)" — ใช้ข้อมูลจริงจากระบบติดตามหนี้
   โหลดด้วย <script src="bulk-send-menu.js"> แล้วเรียก BulkSend.init(ctx) จาก index.html
   - รายการ "ต้องส่ง" มาจาก CV.pendingSmsReminders / CV.pendingLetterReminders (กติกาเดียวกับเมนูการแจ้งเตือน) —
     ไม่คำนวณกติกาเองซ้ำ จึงตรงกับระบบเดิมเสมอ (ลูกค้าที่ติดแท็กดำเนินคดี/รอดำเนินคดีถูกตัดออกที่ต้นทางแล้ว)
   - การส่ง/ออกเอกสาร/ส่งอีเมล ใช้ฟังก์ชันหลักตัวเดียวกับปุ่มในหน้ารายละเอียดลูกค้า (ctx.sendSmsGroup / issueLetter / sendMail)
     และบันทึกประวัติลงฟิลด์เดียวกัน (smsHistory / letterHistory / emailHistory) → หน้ารายละเอียดลูกค้าเห็นข้อมูลครบทันที
   - ออกเอกสาร (PDF) กับส่งอีเมลเป็นคนละขั้น: จดหมายที่ออกแล้วยังไม่ส่งอีเมลมี emailPending=true แสดง "รอส่งอีเมล" ในเมนูนี้
   ctx = { reminders(), mails(), orders(), templates(), esc, fmtDate, fmtMoney, can(perm), actor(), nowTimestamp(), todayDmy(),
           isDirty(), render(), active(), smsPreview(group), sendSmsGroup(group), issueLetter(item), sendMail(item), save(), openCustomer(customerId, name) }
   ============================================================ */
(function (global) {
  'use strict';
  var CTX = null;
  var UI = { tab: 'ready', q: '', sel: {}, selInit: false, modal: null, run: null, drawer: null };

  function esc(s) { return CTX.esc(s == null ? '' : s); }
  function key(o) { return String(o.customerId || '').trim() + '||' + String(o.customerName || '').trim(); }
  function money(n) { return CTX.fmtMoney(n); }
  function dmyToIso(s) { var m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : ''; }
  function tsNum(s) { var m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/); return m ? Number(m[3]) * 1e8 + Number(m[2]) * 1e6 + Number(m[1]) * 1e4 + Number(m[4] || 0) * 100 + Number(m[5] || 0) : 0; }
  function latest(arr) { return (arr || []).slice().sort(function (a, b) { return tsNum(b.at) - tsNum(a.at); })[0] || null; }
  function dpart(at) { return String(at || '').slice(0, 10); }

  /* ---------- รวมรายการต่อลูกค้า ---------- */
  function build() {
    var orders = {}; CTX.orders().forEach(function (o) { orders[o.orderId] = o; });
    var rows = {}, order = [];
    function row(o) {
      var k = key(o);
      if (!rows[k]) { rows[k] = { k: k, name: o.customerName, cid: o.customerId, so: [], sms: [], letters: [], mails: [], orders: [], phone: '', email: '', amt: 0, due: '', trackSeen: {} }; order.push(k); }
      var r = rows[k];
      if (r.orders.indexOf(o) < 0) {
        r.orders.push(o); r.so.push(o.soDisplay || o.orderId);
        if (!r.phone) r.phone = CTX.firstPhone(o.phone); if (!r.email) r.email = CTX.firstEmail(o.email);
      }
      return r;
    }
    function addAmt(r, o, track) {
      var tk = o.orderId + '|' + track; if (r.trackSeen[tk]) return; r.trackSeen[tk] = 1;
      r.amt += Number(track === 'accessory' ? o.accessoryOverdueRaw : o.mainOverdueRaw) || 0;
    }
    // SMS: รวมเป็นกลุ่ม (ออเดอร์ + แทร็ก + ขั้น + occasion) = ส่ง 1 ข้อความ ครอบคลุมทุกงวดที่ถึงกำหนดขั้นเดียวกัน
    var smsG = {};
    CTX.reminders().sms.forEach(function (x) {
      var o = orders[x.orderId]; if (!o) return;
      var r = row(o), gk = [x.orderId, x.track, x.stage, x.occasion || ''].join('|');
      if (!smsG[gk]) { smsG[gk] = { gk: gk, orderId: x.orderId, track: x.track, stage: x.stage, occasion: x.occasion, templateId: x.templateId, templateName: x.templateName, items: [], trigger: x.triggerDateIso, cust: r }; r.sms.push(smsG[gk]); }
      smsG[gk].items.push(x); if (x.triggerDateIso < smsG[gk].trigger) smsG[gk].trigger = x.triggerDateIso;
      addAmt(r, o, x.track);
    });
    CTX.reminders().letters.forEach(function (x) {
      var o = orders[x.orderId]; if (!o) return;
      var r = row(o); r.letters.push(x); addAmt(r, o, x.track);
    });
    CTX.mails().forEach(function (m) {
      var o = orders[m.orderId]; if (!o) return;
      row(o).mails.push(m);
    });
    var list = order.map(function (k) { return rows[k]; });
    list.forEach(function (r) {
      r.sms.forEach(function (g) { var p = CTX.smsPreview(g); g.p = p; });
      r.issues = [];
      if (r.sms.length && r.sms.some(function (g) { return !g.p.ok; })) r.issues.push('SMS: ' + r.sms.filter(function (g) { return !g.p.ok; })[0].p.why);
      if ((r.letters.length) && !r.email) r.issues.push('ไม่มีอีเมล — ออกจดหมาย PDF ได้ แต่ส่งอีเมลไม่ได้ (พิมพ์ส่งไปรษณีย์)');
      r.mails = r.mails.filter(function (m) { return !!m.to; });
      var dueDates = [];
      Object.keys(r.trackSeen).forEach(function (tk) { var pr = tk.split('|'), o = orders[pr[0]]; var d = o && CTX.earliestDue(o, pr[1]); if (d) dueDates.push(d); });
      r.due = dueDates.sort()[0] || '';
      var ls = null, ll = null;
      r.orders.forEach(function (o) {
        var s1 = latest((o.smsHistory || []).concat(o.accessorySmsHistory || []));
        (o.installments || []).concat(o.accessoryInstallments || []).forEach(function (i) { var s2 = latest(i.smsHistory); if (s2 && (!s1 || tsNum(s2.at) > tsNum(s1.at))) s1 = s2; });
        if (s1 && (!ls || tsNum(s1.at) > tsNum(ls.at))) ls = s1;
        // จดหมายล่าสุด = ที่ "จัดการเสร็จแล้ว" เท่านั้น — ฉบับที่ออก PDF แล้วแต่รอส่งอีเมล (emailPending) ไม่นับ
        [['letterHistory', 'emailHistory'], ['accessoryLetterHistory', 'accessoryEmailHistory']].forEach(function (f) {
          var l1 = latest((o[f[0]] || []).filter(function (h) { return !h.emailPending; }));
          if (l1 && (!ll || tsNum(l1.at) > tsNum(ll.h.at))) {
            var em = (o[f[1]] || []).filter(function (e) { return e.letterNo === l1.no; })[0];
            ll = { h: l1, email: em || null };
          }
        });
      });
      r.lastSms = ls; r.lastLetter = ll;
      r.ready = r.sms.length + r.letters.length + r.mails.length > 0;
    });
    return list;
  }
  // ส่งแล้ววันนี้: ลูกค้าที่มีบันทึก SMS/จดหมาย/อีเมลลงวันนี้ และไม่มีรายการค้างส่งเหลือ
  function doneToday(readyKeys) {
    var today = CTX.todayDmy(), rows = {};
    CTX.orders().forEach(function (o) {
      var acts = [];
      function chk(arr, label) { (arr || []).forEach(function (h) { if (dpart(h.at) === today) acts.push({ at: h.at, by: h.by, t: label(h) }); }); }
      chk(o.smsHistory, function (h) { return '📱 SMS ' + (h.template || ''); }); chk(o.accessorySmsHistory, function (h) { return '📱 SMS ' + (h.template || ''); });
      (o.installments || []).concat(o.accessoryInstallments || []).forEach(function (i) { chk(i.smsHistory, function (h) { return '📱 SMS ' + (h.template || ''); }); });
      chk(o.letterHistory, function (h) { return '📄 จดหมายฉบับที่ ' + (h.cycleNo || h.no) + (h.docNo ? ' · ' + h.docNo : ''); }); chk(o.accessoryLetterHistory, function (h) { return '📄 จดหมาย (อุปกรณ์เสริม) ฉบับที่ ' + (h.cycleNo || h.no); });
      chk(o.emailHistory, function (h) { return '✉️ ส่งอีเมลจดหมายฉบับที่ ' + h.letterNo; }); chk(o.accessoryEmailHistory, function (h) { return '✉️ ส่งอีเมลจดหมาย (อุปกรณ์เสริม) ฉบับที่ ' + h.letterNo; });
      if (!acts.length) return;
      var k = key(o); if (readyKeys[k]) return;
      if (!rows[k]) rows[k] = { k: k, name: o.customerName, so: [], acts: [] };
      rows[k].so.push(o.soDisplay || o.orderId); rows[k].acts = rows[k].acts.concat(acts);
    });
    return Object.keys(rows).map(function (k) { return rows[k]; });
  }

  /* ---------- งานที่จะส่ง ---------- */
  function tasksFor(rows) {
    var t = [];
    rows.forEach(function (r) {
      if (!UI.sel[r.k]) return;
      if (CTX.can('send_sms')) r.sms.forEach(function (g) { if (g.p.ok) t.push({ kind: 'sms', r: r, g: g, label: '📱 SMS ' + g.templateName + (g.occasion ? ' (ซ้ำรอบใหม่)' : '') }); });
      if (CTX.can('send_letter')) {
        r.letters.forEach(function (x) { t.push({ kind: 'letter', r: r, x: x, label: '📄 ออกจดหมายฉบับที่ ' + x.letterNo + (x.track === 'accessory' ? ' (อุปกรณ์เสริม)' : '') + (r.email ? ' + ✉️ ส่งอีเมล' : ' (PDF)') }); });
        r.mails.forEach(function (m) { t.push({ kind: 'mail', r: r, m: m, label: '✉️ ส่งอีเมลจดหมายฉบับที่ ' + (m.cycleNo || m.no) + ' (' + m.docNo + ')' }); });
      }
    });
    return t;
  }

  /* ---------- วาดหน้า ---------- */
  var CSS = '<style>.bs-k{background:#fff;border:1px solid #eceef2;border-top:4px solid var(--c,#adb5bd);border-radius:16px;padding:13px 16px}.bs-k small{color:#6b7280;font-size:12px;display:block}.bs-k b{font-family:Prompt,sans-serif;font-size:22px;display:block;margin-top:3px}.bs-k span{font-size:11.5px;color:#8d93a0}' +
    '.bs-tab{padding:8px 16px;border-radius:12px;font-size:13px;font-weight:600;background:#fff;color:#6b7280;border:1px solid rgba(247,130,59,.25);cursor:pointer;display:inline-flex;gap:8px;align-items:center}.bs-tab.on{background:linear-gradient(135deg,#ff951d,#f08000);color:#fff;border-color:transparent;box-shadow:0 6px 16px rgba(247,130,59,.3)}.bs-tab i{font-style:normal;background:rgba(0,0,0,.08);border-radius:20px;padding:1px 8px;font-size:11.5px}.bs-tab.on i{background:rgba(255,255,255,.3)}' +
    '.bs-t{width:100%;border-collapse:collapse;font-size:13px}.bs-t th{text-align:left;padding:9px 10px;font-size:11.5px;color:#6b7280;border-bottom:1px solid #eee;white-space:nowrap;background:#fafafa}.bs-t td{padding:10px;border-bottom:1px solid #f1f1f1;vertical-align:top}.bs-t tr:hover td{background:#fffaf4}' +
    '.bs-m{font-size:11.5px;color:#8d93a0}.bs-p{display:inline-block;border-radius:20px;padding:2px 10px;font-size:11.5px;font-weight:600;white-space:nowrap}.bs-ok{background:rgba(18,184,134,.12);color:#0b7a5b}.bs-red{background:rgba(224,49,49,.1);color:#e03131}.bs-am{background:rgba(240,140,0,.14);color:#a5620d}.bs-g{background:#eef0f3;color:#6b7280}' +
    '.bs-it{border-radius:10px;padding:6px 9px;border:1px solid;font-size:12.5px;line-height:1.35;margin-bottom:6px}.bs-sms{background:rgba(247,130,59,.06);border-color:rgba(247,130,59,.25)}.bs-let{background:rgba(31,58,95,.05);border-color:rgba(31,58,95,.2)}.bs-mail{background:#fff8ec;border-color:#f0a35c}' +
    '.bs-b{border:none;background:linear-gradient(135deg,#ff951d,#f08000);color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}.bs-b.g{background:#fff;color:#6b7280;border:1px solid rgba(247,130,59,.25)}.bs-b.sm{padding:5px 11px;font-size:12px;border-radius:9px}.bs-b.big{padding:13px 26px;font-size:15.5px;border-radius:14px;background:linear-gradient(135deg,#20c997,#0b7a5b)}.bs-b:disabled{opacity:.45;cursor:not-allowed}' +
    '.bs-bar{position:sticky;bottom:0;z-index:20;background:rgba(255,255,255,.98);border-top:1px solid rgba(247,130,59,.14);padding:12px 18px;display:flex;gap:16px;align-items:center;justify-content:space-between;box-shadow:0 -8px 24px rgba(0,0,0,.06);border-radius:14px 14px 0 0;margin-top:14px}' +
    '.bs-mask{position:fixed;inset:0;z-index:10000;background:rgba(33,37,41,.4);display:flex;align-items:center;justify-content:center;padding:20px}.bs-box{background:#fff;border-radius:20px;padding:24px 26px;width:100%;max-width:620px;max-height:90vh;overflow-y:auto;box-shadow:0 24px 60px rgba(33,37,41,.3)}' +
    '.bs-prog{height:10px;background:#eceef2;border-radius:10px;overflow:hidden;margin:10px 0 6px}.bs-prog i{display:block;height:100%;background:linear-gradient(90deg,#20c997,#0b7a5b)}.bs-log{max-height:230px;overflow-y:auto;border:1px solid #eee;border-radius:12px;padding:8px 12px;font-size:12.5px;background:#fafafa}.bs-log div{padding:3px 0;border-bottom:1px dashed #eee}</style>';

  function fmtAt(h) { return h ? esc(h.at) + (h.by ? ' · ' + esc(h.by) : '') : ''; }
  function nextCell(r) {
    var o = '';
    r.mails.forEach(function (m) { o += '<div class="bs-it bs-mail"><b>📄 จดหมายฉบับที่ ' + esc(m.cycleNo || m.no) + (m.track === 'accessory' ? ' (อุปกรณ์เสริม)' : '') + ' ออกเอกสารแล้ว → ✉️ รอส่งอีเมล</b><br><span class="bs-m">' + esc(m.docNo) + ' · ยังไม่ได้ส่งอีเมลให้ลูกค้า</span><div style="margin-top:5px"><span class="bs-p bs-red">✉️ ออก PDF แล้ว (รอส่งอีเมล)</span></div></div>'; });
    r.sms.forEach(function (g) { o += '<div class="bs-it bs-sms"><b>📱 SMS ' + esc(g.templateName) + (g.occasion ? ' (รอบใหม่)' : '') + '</b>' + (g.items.length > 1 ? ' <span class="bs-m">· ครอบคลุม ' + g.items.length + ' งวด</span>' : '') + '<br><span class="bs-m">ถึงกำหนด ' + esc(CTX.fmtDate(g.trigger)) + (g.p.ok ? '' : ' · <span style="color:#e03131">' + esc(g.p.why) + '</span>') + '</span></div>'; });
    r.letters.forEach(function (x) { o += '<div class="bs-it bs-let"><b>📄 จดหมายฉบับที่ ' + esc(x.letterNo) + (x.track === 'accessory' ? ' (อุปกรณ์เสริม)' : '') + ' + ✉️ อีเมล</b><br><span class="bs-m">ถึงกำหนด ' + esc(x.dueSinceDisp) + '</span></div>'; });
    return o || '<span class="bs-m">ไม่มีรายการถัดไป</span>';
  }
  function actionsCell(r) {
    var b = '<button class="bs-b g sm" data-bs="view" data-k="' + esc(r.k) + '">ดูข้อความ/ประวัติ</button>';
    if (CTX.can('send_letter')) {
      r.letters.forEach(function (x) { b += '<br><button class="bs-b sm" style="margin-top:5px" data-bs="issue1" data-k="' + esc(r.k) + '" data-o="' + esc(x.orderId) + '" data-t="' + esc(x.track) + '">📄 ออกจดหมายฉบับที่ ' + esc(x.letterNo) + '</button>'; });
      if (r.email) r.mails.forEach(function (m) { b += '<br><button class="bs-b sm" style="margin-top:5px" data-bs="mail1" data-k="' + esc(r.k) + '" data-o="' + esc(m.orderId) + '" data-t="' + esc(m.track) + '" data-n="' + esc(m.no) + '">✉️ ส่งอีเมลจดหมายฉบับที่ ' + esc(m.cycleNo || m.no) + '</button>'; });
    }
    return b;
  }
  function render() {
    var rows = build(), q = UI.q.trim().toLowerCase();
    var ready = rows.filter(function (r) { return r.ready; });
    var readyKeys = {}; ready.forEach(function (r) { readyKeys[r.k] = 1; });
    var done = doneToday(readyKeys);
    // ไม่เลือกรายการไว้ล่วงหน้า — ต้องติ๊กเองหรือกด "เลือกทั้งหมด" (กันกดส่งพลาดทีเดียวทั้งหมด)
    var tasks = tasksFor(ready);
    var nSms = tasks.filter(function (t) { return t.kind === 'sms'; }).length, nLet = tasks.filter(function (t) { return t.kind === 'letter'; }).length, nMail = tasks.filter(function (t) { return t.kind === 'mail'; }).length;
    var nIssue = ready.filter(function (r) { return r.issues.length; }).length;
    var h = CSS + '<div>' +
      '<div style="font-family:Prompt,sans-serif;font-weight:700;font-size:20px;color:#212529;margin-bottom:4px">📨 ส่ง SMS / จดหมายติดตามหนี้ (ส่งรวม)</div>' +
      '<div style="font-size:13px;color:#6b7280;margin-bottom:16px">รวมรายการที่ถึงกำหนดส่งวันนี้ตามกติกาเดียวกับเมนูการแจ้งเตือน — ตรวจรายการแล้วกดปุ่มเดียวเพื่อส่งให้ทุกคน · ไม่แสดงลูกค้าที่ติดแท็กดำเนินคดี/รอดำเนินคดี/ปิดยอด/ยกเลิก · ออกเอกสาร (PDF) กับส่งอีเมลเป็นคนละขั้น</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:16px">' +
      '<div class="bs-k" style="--c:#12b886"><small>ถึงกำหนดส่งวันนี้</small><b>' + ready.length + ' ราย</b><span>เลือกแล้ว ' + ready.filter(function (r) { return UI.sel[r.k]; }).length + ' ราย</span></div>' +
      '<div class="bs-k" style="--c:#f7823b"><small>📱 SMS ที่จะส่ง</small><b>' + nSms + ' ข้อความ</b><span>1 ข้อความ/ขั้น/บิล (ครอบคลุมหลายงวด)</span></div>' +
      '<div class="bs-k" style="--c:#1f3a5f"><small>📄 จดหมาย + ✉️ อีเมล</small><b>' + (nLet + nMail) + ' ฉบับ</b><span>ออกใหม่ ' + nLet + ' · รอส่งอีเมล ' + nMail + '</span></div>' +
      '<div class="bs-k" style="--c:#e03131"><small>ข้อมูลไม่ครบ / ติดเงื่อนไข</small><b>' + nIssue + ' ราย</b><span>ต้องตรวจก่อนส่ง</span></div>' +
      '<div class="bs-k" style="--c:#339af0"><small>ส่งแล้ววันนี้</small><b>' + done.length + ' ราย</b><span>กันส่งซ้ำอัตโนมัติ</span></div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center">' +
      [['ready', 'พร้อมส่งติดตามหนี้', ready.length], ['done', 'ส่งแล้ววันนี้', done.length]].map(function (d) { return '<div class="bs-tab ' + (UI.tab === d[0] ? 'on' : '') + '" data-bs="tab" data-v="' + d[0] + '">' + d[1] + ' <i>' + d[2] + '</i></div>'; }).join('') +
      '<input type="text" data-bs-bind="q" id="bsQ" placeholder="ค้นหาชื่อ / เลข SO" value="' + esc(UI.q) + '" style="margin-left:8px;width:240px;padding:9px 11px;border-radius:10px;border:1px solid rgba(247,130,59,.25);font-size:13.5px;outline:none"></div>';
    if (UI.tab === 'ready') {
      var vis = ready.filter(function (r) { return !q || (r.name + ' ' + r.so.join(' ')).toLowerCase().indexOf(q) >= 0; }).sort(function (a, b) { return (a.due || 'z') < (b.due || 'z') ? -1 : 1; });
      h += '<div style="background:rgba(255,255,255,.97);border:1px solid #eceef2;border-radius:20px;overflow:hidden"><div style="overflow-x:auto"><table class="bs-t"><thead><tr><th style="width:34px"><input type="checkbox" data-bs-bind="all"' + (ready.length && ready.every(function (r) { return UI.sel[r.k]; }) ? ' checked' : '') + '></th><th>ลูกค้า</th><th>ยอดค้างชำระ</th><th>SMS ล่าสุด</th><th>จดหมาย / อีเมล ล่าสุด</th><th style="min-width:300px">ต้องส่งถัดไป</th><th>ตรวจสอบ</th><th></th></tr></thead><tbody>' +
        (vis.map(function (r) {
          var ls = r.lastSms, ll = r.lastLetter;
          return '<tr><td><input type="checkbox" data-bs-bind="sel" data-k="' + esc(r.k) + '"' + (UI.sel[r.k] ? ' checked' : '') + '></td>' +
            '<td><b>' + esc(r.name) + '</b><div class="bs-m">' + esc(r.so.join(', ')) + '</div><div class="bs-m">' + (r.phone ? '📱 ' + esc(r.phone) : '<span style="color:#e03131">📱 ไม่มีเบอร์</span>') + ' · ' + (r.email ? '✉️ ' + esc(r.email) : '<span style="color:#e03131">✉️ ไม่มีอีเมล</span>') + '</div></td>' +
            '<td><b style="color:#e03131">฿' + money(r.amt) + '</b><div class="bs-m">ครบกำหนด ' + (r.due ? esc(CTX.fmtDate(r.due)) : '-') + '</div></td>' +
            '<td>' + (ls ? '<b>' + esc(ls.template || 'SMS') + '</b><div class="bs-m">' + fmtAt(ls) + '</div>' : '<span class="bs-m">ยังไม่เคยส่ง</span>') + '</td>' +
            '<td>' + (ll ? '<b>ฉบับที่ ' + esc(ll.h.cycleNo || ll.h.no) + '</b><div class="bs-m">' + fmtAt(ll.h) + '</div>' + (ll.email ? '<span class="bs-p bs-ok">✉️ ส่งอีเมลแล้ว</span>' : '<span class="bs-p bs-g">ยังไม่ได้ส่งอีเมล</span>') : '<span class="bs-m">ยังไม่เคยออก</span>') + '</td>' +
            '<td>' + nextCell(r) + '</td><td>' + (r.issues.length ? r.issues.map(function (t) { return '<div class="bs-p bs-am" style="margin-bottom:3px;white-space:normal">⚠ ' + esc(t) + '</div>'; }).join('') : '<span class="bs-p bs-ok">พร้อมส่ง</span>') + '</td>' +
            '<td>' + actionsCell(r) + '</td></tr>';
        }).join('') || '<tr><td colspan="8" style="text-align:center;color:#8d93a0;padding:30px">ไม่มีรายการ</td></tr>') + '</tbody></table></div></div>';
    } else {
      var dv = done.filter(function (r) { return !q || (r.name + ' ' + r.so.join(' ')).toLowerCase().indexOf(q) >= 0; });
      h += '<div style="background:rgba(255,255,255,.97);border:1px solid #eceef2;border-radius:20px;overflow:hidden"><table class="bs-t"><thead><tr><th>ลูกค้า</th><th>ที่ส่ง/ออกเอกสารวันนี้</th></tr></thead><tbody>' +
        (dv.map(function (r) { return '<tr><td><b>' + esc(r.name) + '</b><div class="bs-m">' + esc(r.so.join(', ')) + '</div></td><td>' + r.acts.sort(function (a, b) { return tsNum(a.at) - tsNum(b.at); }).map(function (a) { return '<div>' + a.t + ' <span class="bs-m">· ' + esc(a.at) + (a.by ? ' · ' + esc(a.by) : '') + '</span></div>'; }).join('') + '</td></tr>'; }).join('') || '<tr><td colspan="2" style="text-align:center;color:#8d93a0;padding:30px">ยังไม่มีรายการที่ส่งวันนี้</td></tr>') + '</tbody></table></div>';
    }
    h += '<div class="bs-bar"><div style="font-size:13.5px">' + (tasks.length ? 'เลือกแล้ว <b style="font-size:17px">' + ready.filter(function (r) { return UI.sel[r.k]; }).length + '</b> ราย · 📱 SMS <b>' + nSms + '</b> · 📄 จดหมายใหม่ <b>' + nLet + '</b> (✉️ อีเมล ' + tasks.filter(function (t) { return t.kind === 'letter' && t.r.email; }).length + ')' + (nMail ? ' · ✉️ รอส่งอีเมล <b>' + nMail + '</b>' : '') : 'ยังไม่ได้เลือกรายการ') + '</div>' +
      '<div style="display:flex;gap:10px;align-items:center"><span class="bs-m">ส่งแล้วย้อนกลับไม่ได้ — ตรวจรายการก่อน</span><button class="bs-b big" data-bs="send"' + (tasks.length && !UI.run ? '' : ' disabled') + '>🚀 ส่งทั้งหมด' + (tasks.length ? ' (' + tasks.length + ' รายการ)' : '') + '</button></div></div></div>';
    if (UI.modal) h += UI.modal.html(tasks);
    if (UI.drawer) h += drawerHtml(ready, rows);
    return h;
  }
  function drawerHtml(ready, rows) {
    var r = rows.filter(function (x) { return x.k === UI.drawer; })[0]; if (!r) return '';
    var ev = [];
    r.orders.forEach(function (o) {
      (o.smsHistory || []).concat(o.accessorySmsHistory || []).forEach(function (h) { ev.push({ at: h.at, by: h.by, t: '📱 SMS ' + (h.template || '') }); });
      (o.installments || []).concat(o.accessoryInstallments || []).forEach(function (i) { (i.smsHistory || []).forEach(function (h) { ev.push({ at: h.at, by: h.by, t: '📱 SMS ' + (h.template || '') + ' (งวดที่ ' + i.no + ')' }); }); });
      (o.letterHistory || []).concat(o.accessoryLetterHistory || []).forEach(function (h) { ev.push({ at: h.at, by: h.by, t: '📄 จดหมายฉบับที่ ' + (h.cycleNo || h.no) + (h.docNo ? ' · ' + h.docNo : '') + (h.emailPending ? ' · รอส่งอีเมล' : '') }); });
      (o.emailHistory || []).concat(o.accessoryEmailHistory || []).forEach(function (h) { ev.push({ at: h.at, by: h.by, t: '✉️ ส่งอีเมลจดหมายฉบับที่ ' + h.letterNo + ' → ' + (h.to || '') }); });
    });
    ev.sort(function (a, b) { return tsNum(a.at) - tsNum(b.at); });
    var msgs = r.sms.map(function (g) { return '<div style="margin-bottom:8px"><span class="bs-p bs-sms" style="background:rgba(247,130,59,.12);color:#c2650a">📱 SMS ' + esc(g.templateName) + '</span><div style="background:#f7f8fa;border:1px solid #e6e8ec;border-radius:12px;padding:10px 12px;font-size:13px;line-height:1.55;white-space:pre-wrap;margin-top:6px">' + esc(g.p.message || g.p.why) + '</div>' + (g.p.message ? '<div class="bs-m">' + g.p.message.length + ' ตัวอักษร ≈ ' + g.p.segs + ' ข้อความ → ' + esc(g.p.phone) + '</div>' : '') + '</div>'; }).join('');
    return '<div class="bs-mask" data-bs="drawerMask"><div class="bs-box" style="max-width:520px"><div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">' + esc(r.name) + '</h3><span><button class="bs-b sm" data-bs="openCust" data-k="' + esc(r.k) + '">👤 รายละเอียดลูกค้า</button> <button class="bs-b g sm" data-bs="drawerClose">ปิด ✕</button></span></div>' +
      '<div class="bs-m" style="margin:2px 0 12px">' + esc(r.so.join(', ')) + ' · ค้าง ฿' + money(r.amt) + '</div>' +
      '<div style="font-weight:700;margin:6px 0">ประวัติการส่ง</div>' + (ev.length ? ev.map(function (e) { return '<div style="font-size:12.5px;margin-bottom:8px;border-left:2px solid #e3e6ea;padding-left:10px"><b>' + e.t + '</b><div class="bs-m">' + esc(e.at) + ' · ' + esc(e.by || '') + '</div></div>'; }).join('') : '<span class="bs-m">ยังไม่เคยส่งอะไร</span>') +
      '<div style="font-weight:700;margin:14px 0 6px">ข้อความที่จะส่ง</div>' + (msgs || '<span class="bs-m">ไม่มี SMS ที่จะส่ง</span>') + '</div></div>';
  }

  /* ---------- ส่ง ---------- */
  function openConfirm(rows) {
    var tasks = tasksFor(rows.filter(function (r) { return r.ready; }));
    if (!tasks.length) return;
    if (CTX.isDirty()) { window.alert('มีการแก้ไขที่ยังไม่ได้บันทึกในระบบ — กรุณากด "💾 บันทึกการเปลี่ยนแปลง" ก่อน แล้วค่อยส่ง (เพื่อกันประวัติการส่งชนกับการแก้ไขอื่น)'); return; }
    var segs = 0, cnt = {}, custs = {}, mails = 0, post = 0;
    tasks.forEach(function (t) {
      custs[t.r.k] = 1;
      if (t.kind === 'sms') { segs += t.g.p.segs; cnt['📱 SMS ' + t.g.templateName] = (cnt['📱 SMS ' + t.g.templateName] || 0) + 1; }
      else if (t.kind === 'letter') { var l = '📄 ออกจดหมายฉบับที่ ' + t.x.letterNo + (t.r.email ? ' + ✉️ ส่งอีเมล' : ' (PDF — ไม่มีอีเมล)'); cnt[l] = (cnt[l] || 0) + 1; if (t.r.email) mails++; else post++; }
      else { var l2 = '✉️ ส่งอีเมลจดหมายที่ออกเอกสารไว้แล้ว'; cnt[l2] = (cnt[l2] || 0) + 1; mails++; }
    });
    UI.modal = { tasks: tasks, custN: Object.keys(custs).length, html: function () {
      return '<div class="bs-mask"><div class="bs-box"><h3 style="margin:0 0 12px;font-size:18px">ยืนยันการส่งทั้งหมด</h3><div style="font-size:13.5px;margin-bottom:10px">ลูกค้า <b>' + Object.keys(custs).length + '</b> ราย — ระบบจะส่งตามรายการด้านล่าง และบันทึกประวัติลงรายละเอียดลูกค้าโดยอัตโนมัติ (ใช้ฟังก์ชันเดียวกับปุ่มส่งปกติ)</div>' +
        '<table class="bs-t" style="margin-bottom:12px"><thead><tr><th>รายการ</th><th style="text-align:right">จำนวน</th></tr></thead><tbody>' + Object.keys(cnt).map(function (k) { return '<tr><td>' + esc(k) + '</td><td style="text-align:right"><b>' + cnt[k] + '</b></td></tr>'; }).join('') + '</tbody></table>' +
        '<div style="padding:12px 14px;margin-bottom:12px;background:#fffaf2;border:1px solid #fbe3c2;border-radius:14px;font-size:13px">ประมาณการค่าใช้จ่าย: SMS <b>' + segs + '</b> ข้อความ (ภาษาไทย ~67–70 ตัวอักษร/ข้อความ) · อีเมล <b>' + mails + '</b> ฉบับ' + (post ? ' · <span style="color:#c2650a">จดหมาย ' + post + ' ฉบับไม่มีอีเมล — ออก PDF เท่านั้น ต้องพิมพ์ส่งเอง</span>' : '') + '</div>' +
        (Object.keys(custs).length > 20 ? '<div style="padding:10px 14px;margin-bottom:12px;background:#fff0f0;border:1px solid #f3b6b6;border-radius:12px;font-size:13px;color:#a61e1e"><b>⚠ ส่งจำนวนมาก</b> — พิมพ์จำนวนลูกค้า <b>' + Object.keys(custs).length + '</b> เพื่อยืนยัน: <input type="text" id="bsCnt" inputmode="numeric" style="width:90px;padding:5px 8px;border:1px solid #f3b6b6;border-radius:8px"></div>' : '') + '<label style="font-size:13.5px;display:block;margin-bottom:14px"><input type="checkbox" id="bsAck"> ฉันตรวจสอบรายการแล้ว และเข้าใจว่าส่งแล้วย้อนกลับไม่ได้ (SMS/อีเมลถึงลูกค้าจริง)</label>' +
        '<div style="display:flex;justify-content:flex-end;gap:10px"><button class="bs-b g" data-bs="modalClose">ยกเลิก</button><button class="bs-b big" id="bsGo" disabled style="padding:10px 22px;font-size:14px" data-bs="go">📤 ยืนยันส่ง</button></div></div></div>'; } };
    CTX.render();
  }
  function runTasks(tasks) {
    var run = UI.run = { total: tasks.length, done: 0, ok: 0, fail: [], log: [], finished: false, tasks: tasks };
    UI.modal = { html: function () { return runHtml(); } };
    CTX.render();
    var i = 0;
    function next() {
      if (i >= tasks.length) { run.finished = true; CTX.render(); return; }
      var t = tasks[i++], p;
      try {
        if (t.kind === 'sms') p = CTX.sendSmsGroup(t.g);
        else if (t.kind === 'letter') p = CTX.issueLetter(t.x).then(function (res) { if (!t.r.email) return res; return CTX.sendMail({ orderId: t.x.orderId, track: t.x.track, no: res.no, to: t.r.email }).then(function () { return res; }, function (e) { throw new Error('ออกจดหมายแล้ว (' + res.docNo + ') แต่ส่งอีเมลไม่สำเร็จ: ' + e.message + ' — ลูกค้ารายนี้จะอยู่ใน "รอส่งอีเมล"'); }); });
        else p = CTX.sendMail({ orderId: t.m.orderId, track: t.m.track, no: t.m.no, to: t.m.to });
      } catch (e) { p = Promise.reject(e); }
      p.then(function () { return CTX.save(); }).then(function () { run.ok++; run.log.push({ ok: true, t: t.label + ' → ' + t.r.name }); }, function (e) { run.fail.push(t); run.log.push({ ok: false, t: t.label + ' → ' + t.r.name + ' — ' + (e && e.message ? e.message : e) }); })
        .then(function () { run.done++; patchRun(); setTimeout(next, 120); });
    }
    next();
  }
  // อัปเดตแถบความคืบหน้าตรงๆ ที่ DOM — ไม่เรียก render() ทั้งระบบทุกงาน (ข้อมูลหลายหมื่นออเดอร์คำนวณหน้าใหม่ครั้งละหลายวินาที)
  function patchRun() {
    var r = UI.run, box = document.querySelector('.bs-box'); if (!r || !box) return;
    var bar = box.querySelector('.bs-prog i'), cnt = box.querySelector('.bs-m'), log = document.getElementById('bsLog');
    if (bar) bar.style.width = Math.round(r.done / r.total * 100) + '%';
    if (cnt) cnt.textContent = r.done + ' / ' + r.total + ' · สำเร็จ ' + r.ok + ' · ล้มเหลว ' + r.fail.length;
    if (log) { log.innerHTML = r.log.map(function (l) { return '<div style="color:' + (l.ok ? '#0b7a5b' : '#e03131') + '">' + (l.ok ? '✓ ' : '✗ ') + esc(l.t) + '</div>'; }).join(''); log.scrollTop = log.scrollHeight; }
  }
  function runHtml() {
    var r = UI.run;
    return '<div class="bs-mask"><div class="bs-box"><h3 style="margin:0 0 12px;font-size:18px">' + (r.finished ? (r.fail.length ? 'ส่งเสร็จ — มีบางรายการล้มเหลว' : 'ส่งเสร็จสมบูรณ์ ✓') : 'กำลังส่ง… (อย่าปิดหน้านี้)') + '</h3><div class="bs-prog"><i style="width:' + Math.round(r.done / r.total * 100) + '%"></i></div><div class="bs-m">' + r.done + ' / ' + r.total + ' · สำเร็จ ' + r.ok + ' · ล้มเหลว ' + r.fail.length + '</div>' +
      '<div class="bs-log" id="bsLog">' + r.log.map(function (l) { return '<div style="color:' + (l.ok ? '#0b7a5b' : '#e03131') + '">' + (l.ok ? '✓ ' : '✗ ') + esc(l.t) + '</div>'; }).join('') + '</div>' +
      (r.finished ? '<div style="margin-top:14px;text-align:right"><button class="bs-b g sm" data-bs="csv">⬇ ดาวน์โหลดรายงานผล (CSV)</button> ' + (r.fail.length ? '<button class="bs-b sm" style="background:#e03131" data-bs="retry">↻ ส่งซ้ำเฉพาะที่ล้มเหลว (' + r.fail.length + ')</button> ' : '') + '<button class="bs-b sm" data-bs="runClose">ปิด</button></div>' : '') + '</div></div>';
  }
  function csv() {
    var r = UI.run; if (!r) return;
    var rows = r.log.map(function (l) { return ['"' + (l.ok ? 'สำเร็จ' : 'ล้มเหลว') + '"', '"' + String(l.t).replace(/"/g, '""') + '"'].join(','); });
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿ผล,รายการ\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' })); a.download = 'รายงานผลการส่ง_' + CTX.todayDmy().split('/').reverse().join('-') + '.csv'; a.click();
  }

  /* ---------- events ---------- */
  function rerender() { CTX.render(); }
  function onClick(e) {
    if (!CTX || !CTX.active()) return;
    var t = e.target.closest && e.target.closest('[data-bs]'); if (!t) return;
    var a = t.getAttribute('data-bs'), k = t.getAttribute('data-k');
    if (a === 'drawerMask') { if (e.target !== t) return; UI.drawer = null; return rerender(); }
    if (a === 'tab') { UI.tab = t.getAttribute('data-v'); return rerender(); }
    if (a === 'view') { UI.drawer = k; return rerender(); }
    if (a === 'drawerClose') { UI.drawer = null; return rerender(); }
    if (a === 'openCust') { var rr = build().filter(function (x) { return x.k === k; })[0]; UI.drawer = null; if (rr) CTX.openCustomer(rr.cid, rr.name); return; }
    if (a === 'send') return openConfirm(build());
    if (a === 'modalClose') { UI.modal = null; return rerender(); }
    if (a === 'go') { if (document.getElementById('bsGo').disabled) return; var tk = UI.modal.tasks; UI.modal = null; return runTasks(tk); }
    if (a === 'runClose') { UI.run = null; UI.modal = null; UI.selInit = false; return rerender(); }
    if (a === 'csv') return csv();
    if (a === 'retry') { var again = UI.run.fail.slice(); return runTasks(again); }
    if (a === 'issue1' || a === 'mail1') {
      if (UI.run) return;
      if (CTX.isDirty()) { window.alert('มีการแก้ไขที่ยังไม่ได้บันทึก — กรุณากด "💾 บันทึกการเปลี่ยนแปลง" ก่อน'); return; }
      var r = build().filter(function (x) { return x.k === k; })[0]; if (!r) return;
      var oid = t.getAttribute('data-o'), trk = t.getAttribute('data-t'), p, lab;
      if (a === 'issue1') {
        var x = r.letters.filter(function (l) { return l.orderId === oid && l.track === trk; })[0]; if (!x) return;
        if (!window.confirm('ยืนยันออกจดหมายทวงถามหนี้ฉบับที่ ' + x.letterNo + ' ให้ ' + r.name + ' ?\n\n(ออกเป็น PDF และบันทึกประวัติ — ยังไม่ส่งอีเมล ส่งภายหลังด้วยปุ่ม "ส่งอีเมลจดหมาย" หรือ "ส่งทั้งหมด")')) return;
        lab = 'ออกจดหมาย'; p = CTX.issueLetter(x);
      } else {
        var m = r.mails.filter(function (l) { return l.orderId === oid && l.track === trk && String(l.no) === t.getAttribute('data-n'); })[0]; if (!m) return;
        if (!window.confirm('ยืนยันส่งอีเมลจดหมายฉบับที่ ' + (m.cycleNo || m.no) + ' (' + m.docNo + ')\nถึง ' + m.to + ' ?\n\n(ส่งเป็นลิงก์ดาวน์โหลด PDF อายุ 30 วัน)')) return;
        lab = 'ส่งอีเมล'; p = CTX.sendMail({ orderId: oid, track: trk, no: m.no, to: m.to });
      }
      t.disabled = true; t.textContent = '⏳ กำลังดำเนินการ…';
      p.then(function () { return CTX.save(); }).then(function () { window.alert(lab + 'สำเร็จ — บันทึกประวัติแล้ว'); rerender(); }, function (er) { window.alert(lab + 'ไม่สำเร็จ: ' + (er && er.message ? er.message : er)); rerender(); });
    }
  }
  function goCheck() {
    var g = document.getElementById('bsGo'), a = document.getElementById('bsAck'), c = document.getElementById('bsCnt'); if (!g || !a || !UI.modal) return;
    g.disabled = !(a.checked && (!c || c.value.trim() === String(UI.modal.custN)));
  }
  function onInput(e) {
    if (!CTX || !CTX.active()) return;
    var t = e.target; if (t.id === 'bsCnt') { goCheck(); return; } if (t.getAttribute && t.getAttribute('data-bs-bind') === 'q') { UI.q = t.value; rerender(); var el = document.getElementById('bsQ'); if (el) { el.focus(); el.setSelectionRange(t.value.length, t.value.length); } }
  }
  function onChange(e) {
    if (!CTX || !CTX.active()) return;
    var t = e.target, b = t.getAttribute && t.getAttribute('data-bs-bind');
    if (t.id === 'bsAck') { goCheck(); return; }
    if (b === 'sel') { UI.sel[t.getAttribute('data-k')] = t.checked; rerender(); }
    else if (b === 'all') { build().forEach(function (r) { if (r.ready) UI.sel[r.k] = t.checked; }); rerender(); }
  }
  function init(ctx) {
    if (CTX) { CTX = ctx; return; }
    CTX = ctx;
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
  }
  global.BulkSend = { init: init, render: render, _build: function () { return build(); } };
})(typeof window !== 'undefined' ? window : globalThis);
