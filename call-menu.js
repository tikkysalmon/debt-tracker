/* ============================================================
   เมนู "การโทรติดตามหนี้" — ใช้ข้อมูลจริงจาก state.orders ของระบบติดตามหนี้
   โหลดด้วย <script src="call-menu.js"> แล้วเรียก CallMenu.init(ctx) จาก index.html
   ctx = { orders(), patchOrder(orderId, fn), actor(), isAdmin(), render(), fmtMoney(n), esc(s), nowTimestamp() }
   - ไม่มี state ถาวรของตัวเอง: ข้อมูลทั้งหมดอยู่ที่ order (callHistory, installments[].callLog/note/feeWaived, callOwner, callOwnerLog)
     จึงซิงก์ผ่านกลไกบันทึกของระบบเดิม (state.hasUnsavedChanges → บันทึกขึ้น cloud)
   - ยอดค้างที่แสดง = ยอดที่ "ตัดรอบ" ล่าสุดตามวันครบกำหนด (ดู CUT_RULES) ไม่ลดลงแม้ลูกค้าชำระหลังตัดรอบ
   ============================================================ */
(function (global) {
  'use strict';
  var CTX = null;
  var UI = { tab: 'work', bucket: 'all', month: 'latest', dueDay: 'all', q: '', staff: 'all', page: 1, pageSize: 50, modal: null, draft: null, xfer: null };

  /* ---------- ค่าคงที่ ---------- */
  var CALL_RESULTS = [
    { key: 'reschedule', label: 'ติดต่อได้ - ขอเลื่อน', needDate: true },
    { key: 'cancel', label: 'ติดต่อได้ - ขอยกเลิกคืนเครื่อง' },
    { key: 'busy', label: 'ติดต่อไม่ได้ - สายไม่ว่าง' },
    { key: 'unreachable', label: 'ติดต่อไม่ได้ - ปิดเครื่อง/เบอร์ผิด' },
    { key: 'reference', label: 'ติดต่อได้ - ติดต่อกับบุคคลอ้างอิง' },
    { key: 'no_answer', label: 'ติดต่อไม่ได้ - ไม่รับสาย' },
    { key: 'voicemail', label: 'ฝากข้อความ' }
  ];
  var RES_LABEL = { reference: 'ติดต่อได้ - ติดต่อกับบุคคลอ้างอิง', ptp: 'ติดต่อได้ - รับปากจะจ่าย', reschedule: 'ติดต่อได้ - ขอเลื่อน', cancel: 'ติดต่อได้ - ขอยกเลิกคืนเครื่อง', refuse: 'ติดต่อได้ - ปฏิเสธจ่าย', dispute: 'ติดต่อได้ - โต้แย้งยอดหนี้', busy: 'ติดต่อไม่ได้ - สายไม่ว่าง', unreachable: 'ติดต่อไม่ได้ - ปิดเครื่อง/เบอร์ผิด', no_answer: 'ติดต่อไม่ได้ - ไม่รับสาย', voicemail: 'ฝากข้อความ' };
  var NEED_DATE = { reschedule: true, ptp: true };
  var RECALL_DAYS = { reference: 1, busy: 1, no_answer: 1, voicemail: 1, unreachable: 2, cancel: 3, refuse: 3, dispute: 3 };
  var DUE_DAYS = [1, 5, 15, 25, 30];
  // รอบตัดยอดลูกหนี้เข้าเมนู: ดึงเวลา 00:00 น. ของวันโทร (= วันตัดยอด + 1) โดยใช้ยอดค้าง ณ สิ้นวันตัดยอด
  var CUT_RULES = {
    1:  { cut: 15, next: false, label: 'ทุกวันที่ 15', call: 'วันที่ 16' },
    5:  { cut: 20, next: false, label: 'ทุกวันที่ 20', call: 'วันที่ 21' },
    15: { cut: 29, next: false, label: 'ทุกวันที่ 29', call: 'วันที่ 30' },
    25: { cut: 10, next: true, label: 'ทุกวันที่ 10 ของเดือนถัดไป', call: 'วันที่ 11 ของเดือนถัดไป' },
    30: { cut: 15, next: true, label: 'ทุกวันที่ 15 ของเดือนถัดไป', call: 'วันที่ 16 ของเดือนถัดไป' }
  };
  var FINE_AMT = 500, SYSFEE_AMT = 500, FINE_AFTER_DAYS = 3;
  var LOCK_STATUSES = ['ล็อคเครื่อง', 'ล็อคเครื่อง (ระบบ)'];
  var BUCKETS = [
    { key: 'b1', label: '16-50 วัน', min: 16, max: 50, stage: 'St2 · เฝ้าระวัง' },
    { key: 'b2', label: '51-60 วัน', min: 51, max: 60, stage: 'St2 · เฝ้าระวัง' },
    { key: 'b3', label: '61-90 วัน', min: 61, max: 90, stage: 'St3 · หนี้เสีย' },
    { key: 'b4', label: '91-120 วัน', min: 91, max: 120, stage: 'St3 · หนี้เสีย' },
    { key: 'b5', label: 'เกิน 120 วัน', min: 121, max: 99999, stage: 'St3 · NPL 120+' }
  ];

  /* ---------- วันที่/ตัวเลข ---------- */
  var TODAY, TODAY_ISO;
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = String(s).slice(0, 10).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function diffDays(a, b) { return Math.round((parse(a) - parse(b)) / 86400000); }
  function refreshToday() { TODAY = new Date(); TODAY.setHours(0, 0, 0, 0); TODAY_ISO = iso(TODAY); }
  function fmtD(s) { return s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '-'; }
  function fmtDT(s) { return fmtD(s) + ' ' + (s.slice(11, 16) || ''); }
  function money(n) { return CTX.fmtMoney(n); }
  function esc(s) { return CTX.esc(s == null ? '' : s); }
  // ระบบเดิมเก็บเวลาแบบ "dd/mm/yyyy HH:mm" — แปลงเป็น ISO เพื่อเทียบ/เรียงลำดับ
  function toIsoAt(s) {
    s = String(s || '').trim();
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s*(\d{1,2}):(\d{2})/);
    if (m) { var y = +m[3]; if (y < 100) y += 2000; return y + '-' + pad(+m[2]) + '-' + pad(+m[1]) + 'T' + pad(+m[4]) + ':' + pad(+m[5]); }
    return s;
  }
  function dayGroup(d) { return d <= 3 ? 1 : d <= 9 ? 5 : d <= 20 ? 15 : d <= 27 ? 25 : 30; }   // วันครบกำหนดจริงที่ไม่ตรง 1/5/15/25/30 (เช่น 28 ของเดือน ก.พ.) จัดเข้ากลุ่มที่ใกล้ที่สุด

  /* ---------- แปลง order จริง → แถวของเมนู ---------- */
  function mkInst(i, track) {
    var due = i.dueDate || '';
    return {
      raw: i, track: track, no: i.no, key: (track === 'accessory' ? 'A' : '') + i.no, due: due,
      amt: Math.max(0, Number(i.amountDue || 0) - Number(i.discount || 0)), paid: Number(i.amountPaid || 0), paidDate: i.paidDate || '',
      status: i.effectiveStatus || i.status || '', waived: !!i.feeWaived,
      notes: i.note ? String(i.note).split('\n').filter(Boolean) : [], calls: i.callLog || []
    };
  }
  var REFS = {};   // บุคคลอ้างอิงอาจกรอกไว้ที่ order อื่นของลูกค้าคนเดียวกัน → ใช้เป็นค่าสำรอง
  function toRow(o) {
    var insts = (o.installments || []).map(function (i) { return mkInst(i, 'main'); }).concat((o.accessoryInstallments || []).map(function (i) { return mkInst(i, 'accessory'); }));
    if (!insts.length) return null;
    var firstDue = o.firstDueDate || (insts[0] && insts[0].due) || '';
    var day = Number(o.payDay) || (firstDue ? parse(firstDue).getDate() : 0);
    if (!day) return null;
    var calls = (o.callHistory || []).map(function (h) {
      return { at: toIsoAt(h.at), by: h.by || '', result: h.result || '', note: h.note || '', ptpDate: h.ptpDate || '', ptpAmt: h.ptpAmount || null, nos: h.insts || [], plan: h.plan || null };
    }).sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    var payments = [];
    insts.forEach(function (i) { if (i.paid > 0 && i.paidDate) payments.push({ date: i.paidDate, amt: i.paid }); });
    return { id: o.customerId, name: o.customerName, so: o.orderId, phone: o.phone || '', refName: o.referenceName || (REFS[o.customerId] || {}).n || '', refPhone: o.referencePhone || (REFS[o.customerId] || {}).p || '', insts: insts, dueDay: dayGroup(day), calls: calls, payments: payments, owner: o.callOwner || null, ownerLog: o.callOwnerLog || [], order: o };
  }
  function buildRows() {
    REFS = {};
    CTX.orders().forEach(function (o) { if (o.customerId && (o.referenceName || o.referencePhone)) { var x = REFS[o.customerId] || (REFS[o.customerId] = { n: '', p: '' }); if (!x.n) x.n = o.referenceName || ''; if (!x.p) x.p = o.referencePhone || ''; } });
    return CTX.orders().map(toRow).filter(Boolean); }

  /* ---------- รอบตัดยอด / ยอดค้างที่ดึงมา ---------- */
  function cutoffFor(dd, y, m) {
    var ru = CUT_RULES[dd], b = new Date(y, m + (ru.next ? 1 : 0), 1), last = new Date(b.getFullYear(), b.getMonth() + 1, 0).getDate();
    return new Date(b.getFullYear(), b.getMonth(), Math.min(ru.cut, last));
  }
  function lastCutoff(dd) {   // รอบล่าสุดที่ดึงแล้ว (วันตัดยอดต้องผ่านมาแล้ว เพราะดึงตอน 00:00 ของวันถัดไป)
    var best = null;
    if (!CUT_RULES[dd]) return null;
    for (var k = -3; k <= 1; k++) { var c = cutoffFor(dd, TODAY.getFullYear(), TODAY.getMonth() + k); if (c < TODAY && (!best || c > best)) best = c; }
    return best;
  }
  // เลือกยอดค้างตาม "เดือนครบกำหนดชำระ" (2026-11-18, แก้ให้ตรงกับกราฟ Dashboard 'ยอดรวมหนี้ทั้งหมดแยกตามเดือนวันครบกำหนดชำระ'):
  // UI.month = 'YYYY-MM' → เฉพาะงวดที่ครบกำหนดในเดือนนั้น ยอดคงเหลือปัจจุบัน (ค้างชำระ/ชำระบางส่วน/หนี้สงสัยจะสูญ ที่ถึงกำหนดแล้ว) แยกตามกลุ่มวันครบกำหนดของลูกค้า
  // ไม่รวมลูกค้าดำเนินคดี/จำหน่ายชื่อ/ยกเลิก (ซึ่ง Dashboard นับรวม) · UI.month = 'latest' = รอบล่าสุดที่ดึงแล้วต่อกลุ่ม ยอดสะสม ณ วันตัดยอด (พฤติกรรมเดิม)
  var FIRST_MONTH = '2026-10';
  function monthOptions() {
    var cur = TODAY.getFullYear() + '-' + pad(TODAY.getMonth() + 1), out = [], y = Number(FIRST_MONTH.slice(0, 4)), m = Number(FIRST_MONTH.slice(5, 7));
    while ((y + '-' + pad(m)) <= cur && out.length < 36) { out.push(y + '-' + pad(m)); m++; if (m > 12) { m = 1; y++; } }
    return out;
  }
  var TH_M = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  function monthLabel(mk) { return TH_M[Number(mk.slice(5, 7)) - 1] + ' ' + (Number(mk.slice(0, 4)) + 543); }
  function dueMonthOf(dd, mk) {   // เดือนที่งวดครบกำหนด ของกลุ่มวัน dd เมื่อเลือกเดือนที่โทร mk
    var y = Number(mk.slice(0, 4)), m = Number(mk.slice(5, 7)) - 1;
    if (dd === 1 || dd === 5) return { y: y, m: m };
    return m === 0 ? { y: y - 1, m: 11 } : { y: y, m: m - 1 };
  }
  function cutoffSel(dd) {
    if (!CUT_RULES[dd]) return null;
    return UI.month === 'latest' ? lastCutoff(dd) : null;
  }
  var NOT_OWED_STATUS = ['ชำระแล้ว', 'ยังไม่ถึงกำหนดชำระ', 'ถึงกำหนดชำระ', 'ยกเลิกบิล', 'ยกเลิกสัญญา คืนเครื่อง'];
  // ระบบเก็บวันที่ชำระล่าสุดของแต่ละงวดเพียงค่าเดียว — ถือว่างวดที่ชำระหลังวันตัดยอดยังค้างอยู่ ณ วันตัดยอด
  function paidAsOf(i, c) { return (i.paidDate && i.paidDate <= c) ? i.paid : 0; }
  function snap(r) {
    if (r._snap) return r._snap;   // แถวถูกสร้างใหม่ทุกครั้งที่ render จึงเก็บผลไว้ในแถวได้ (ข้อมูลหลายหมื่นงวด)
    return (r._snap = snapCalc(r));
  }
  function snapCalc(r) {
    if (UI.month !== 'latest') {   // มุมมองตามเดือนครบกำหนด (ตรงกับ Dashboard): ยอดคงเหลือปัจจุบันของงวดที่ครบกำหนดในเดือนนั้น
      var its = [];
      r.insts.forEach(function (i) {
        if (!i.due || i.due.slice(0, 7) !== UI.month || i.due > TODAY_ISO || NOT_OWED_STATUS.indexOf(i.status) !== -1) return;
        var out = i.amt - i.paid; if (out > 0.005) its.push({ i: i, out: out, since: 0 });
      });
      return { cut: TODAY_ISO, call: TODAY_ISO, items: its, total: its.reduce(function (a, x) { return a + x.out; }, 0), paid: 0 };
    }
    var c = cutoffSel(r.dueDay);
    if (!c) return { cut: null, call: null, items: [], total: 0, paid: 0 };
    var ci = iso(c), items = [];
    r.insts.forEach(function (i) {
      if (i.due && i.due <= ci) { var was = paidAsOf(i, ci), out = i.amt - was; if (out > 0.005) items.push({ i: i, out: out, since: Math.max(0, i.paid - was) }); }
    });
    return { cut: ci, call: iso(addDays(c, 1)), items: items, total: items.reduce(function (a, x) { return a + x.out; }, 0), paid: items.reduce(function (a, x) { return a + x.since; }, 0) };
  }
  function rem(i) { return Math.max(0, i.amt - i.paid); }
  function chaseInsts(r) { return snap(r).items.map(function (x) { return x.i; }); }
  function unpaid(r) { return chaseInsts(r).filter(function (i) { return rem(i) > 0.005; }); }
  function rowSnap(r) { return snap(r).total; }
  function rowRemain(r) { return unpaid(r).reduce(function (s, i) { return s + rem(i); }, 0); }
  function rowPaid(r) { return snap(r).paid; }
  function oldestDue(r) { var u = unpaid(r).map(function (i) { return i.due; }).sort(); return u[0]; }
  function rowAge(r) { var d = oldestDue(r); return d ? diffDays(TODAY_ISO, d) : 0; }
  function bucketOf(age) { return (BUCKETS.filter(function (b) { return age >= b.min && age <= b.max; })[0] || BUCKETS[0]).key; }
  function stageOf(age) { return (BUCKETS.filter(function (b) { return age >= b.min && age <= b.max; })[0] || BUCKETS[0]).stage; }
  function rowPaidDate(r) { return chaseInsts(r).filter(function (i) { return i.paidDate && i.paid > 0; }).map(function (i) { return i.paidDate; }).sort().pop() || ''; }
  function lastCall(r) { return r.calls[r.calls.length - 1]; }
  function isActive(r) { return rowSnap(r) > 0.005 && rowRemain(r) > 0.005; }
  function isPaidRow(r) { return rowSnap(r) > 0.005 && rowRemain(r) <= 0.005; }

  /* ---------- ค่าปรับ / ค่าธรรมเนียมระบบ ---------- */
  function feeInsts(r) { return unpaid(r).filter(function (i) { return !i.waived; }); }
  function rowFine(r) { return feeInsts(r).some(function (i) { return i.due && diffDays(TODAY_ISO, i.due) > FINE_AFTER_DAYS; }) ? FINE_AMT : 0; }
  function rowSysFee(r) { return feeInsts(r).some(function (i) { return LOCK_STATUSES.indexOf(i.status) !== -1; }) ? SYSFEE_AMT : 0; }
  function rowGrand(r) { return rowSnap(r) + rowFine(r) + rowSysFee(r); }

  /* ---------- สถานะ ---------- */
  function statusCls(label) {
    if (label === 'ชำระแล้ว') return 'p-green';
    if (label === 'ชำระบางส่วน') return 'p-amber';
    if (label === 'ยังไม่ถึงกำหนดชำระ' || label === 'ถึงกำหนดชำระ' || !label) return 'p-gray';
    return 'p-red';
  }
  function instStatus(i) {
    if (rem(i) <= 0.005) return { label: 'ชำระแล้ว', cls: 'p-green' };
    var l = i.status || (i.due && i.due < TODAY_ISO ? 'ค้างชำระ' : 'ยังไม่ถึงกำหนดชำระ');
    if (l === 'ชำระแล้ว') l = i.paid > 0.005 ? 'ชำระบางส่วน' : 'ค้างชำระ';
    return { label: l, cls: statusCls(l) };
  }
  function payStatus(r) {
    var ci = chaseInsts(r), done = ci.filter(function (i) { return rem(i) <= 0.005; }).length, sub = done + '/' + ci.length + ' งวด';
    if (done === ci.length) return { label: 'ชำระครบแล้ว', cls: 'p-green', sub: sub };
    var old = unpaid(r).sort(function (a, b) { return a.due < b.due ? -1 : 1; })[0], s = instStatus(old);
    return { label: s.label, cls: s.cls, sub: sub };
  }
  function payTiming(r) {   // ชำระ "ก่อน/หลัง" การโทรครั้งแรก — ใช้ตัดสินยอดที่นับค่าคอมมิชชั่น
    var fc = r.calls[0], cd = fc ? fc.at.slice(0, 10) : null;
    var before = r.payments.filter(function (x) { return !cd || x.date < cd; }).reduce(function (a, x) { return a + x.amt; }, 0);
    var after = r.payments.filter(function (x) { return cd && x.date >= cd; }).reduce(function (a, x) { return a + x.amt; }, 0);
    var label, cls;
    if (!cd) { label = 'ยังไม่เคยโทร'; cls = 'p-gray'; }
    else if (after > 0 && before > 0) { label = 'ก่อนและหลังโทร'; cls = 'p-blue'; }
    else if (after > 0) { label = 'ชำระหลังโทร'; cls = 'p-green'; }
    else { label = 'ชำระก่อนโทร'; cls = 'p-amber'; }
    return { label: label, cls: cls, before: before, after: after, firstCall: cd };
  }
  function instLabel(list) {
    function rng(nos) {
      nos = nos.slice().sort(function (a, b) { return a - b; }); var parts = [], s = nos[0], p = nos[0];
      for (var k = 1; k <= nos.length; k++) { if (nos[k] === p + 1) { p = nos[k]; continue; } parts.push(s === p ? '' + s : s + '-' + p); s = nos[k]; p = nos[k]; }
      return parts.join(',');
    }
    var m = list.filter(function (i) { return i.track === 'main'; }).map(function (i) { return i.no; }), a = list.filter(function (i) { return i.track === 'accessory'; }).map(function (i) { return i.no; });
    var out = [];
    if (m.length) out.push('งวดที่ ' + rng(m));
    if (a.length) out.push('อุปกรณ์เสริม งวดที่ ' + rng(a));
    return out.join(' · ');
  }
  function keysLabel(keys, r) { return instLabel(r.insts.filter(function (i) { return keys.indexOf(i.key) !== -1; })); }

  /* ---------- เงื่อนไขการขอเลื่อนชำระ ---------- */
  function reschedulePlan(r, ptpDate) {
    var u = unpaid(r).sort(function (a, b) { return a.due < b.due ? -1 : 1; }), n = u.length, fees = rowFine(r) + rowSysFee(r);
    var items = [], now = 0, waive = false, tier = '';
    function feeItem() { if (fees > 0) items.push({ t: 'ค่าปรับชำระล่าช้า + ค่าธรรมเนียมระบบ (ณ วันที่นัด)', a: fees, due: ptpDate }); }
    function nm(i) { return instLabel([i]); }
    if (n >= 4) {
      tier = 'ค้างเกิน 3 งวด'; now = rem(u[0]); waive = true;
      items.push({ t: 'ชำระ ' + nm(u[0]) + ' (ค้างนานสุด 1 งวด) ณ วันที่นัด', a: rem(u[0]), due: ptpDate });
      items.push({ t: 'ยกเว้นค่าปรับชำระล่าช้า + ค่าธรรมเนียมระบบ (ลงประวัติในตารางงวด) — หากชำระงวดถัดไปล่าช้า จะคิดตามปกติ ไม่ได้รับการยกเว้น', a: 0 });
    } else if (n === 3) {
      tier = 'ค้างมากกว่า 2 งวด ไม่เกิน 3 งวด'; now = rem(u[0]) + rem(u[1]) + fees;
      items.push({ t: 'ชำระ ' + instLabel([u[0], u[1]]) + ' (ค้างนานสุด 2 งวด) ณ วันที่นัด', a: rem(u[0]) + rem(u[1]), due: ptpDate }); feeItem();
      var snapKeys = {}; chaseInsts(r).forEach(function (i) { snapKeys[i.key] = true; });
      var nx = r.insts.filter(function (i) { return i.due > TODAY_ISO && rem(i) > 0.005 && !snapKeys[i.key]; }).sort(function (a, b) { return a.due < b.due ? -1 : 1; })[0];
      items.push({ t: nm(u[2]) + ' (งวดที่ค้างปัจจุบัน) ทะยอยชำระก่อนครบกำหนดงวดถัดไป' + (nx ? ' (' + nm(nx) + ')' : ''), a: rem(u[2]), later: true, due: nx ? nx.due : '' });
    } else if (n === 2) {
      tier = 'ค้างมากกว่า 1 งวด ไม่เกิน 2 งวด'; now = rem(u[0]) + fees;
      items.push({ t: 'ชำระ ' + nm(u[0]) + ' (ค้างนานสุด 1 งวด) ณ วันที่นัด', a: rem(u[0]), due: ptpDate }); feeItem();
      items.push({ t: nm(u[1]) + ' (งวดที่ค้างปัจจุบัน) ชำระ 70% ของค่างวด ภายใน 7 วันหลังวันที่นัดชำระ', a: Math.round(u[1].amt * 0.7), later: true, due: ptpDate ? iso(addDays(parse(ptpDate), 7)) : '', needPtp: !ptpDate });
    } else {
      tier = 'ค้าง 1 งวด (ยังไม่มีเงื่อนไขพิเศษ)'; now = n ? rem(u[0]) : 0;
      if (n) items.push({ t: 'ชำระ ' + nm(u[0]) + ' ณ วันที่นัด', a: rem(u[0]), due: ptpDate });
    }
    // เงื่อนไขรายงวด — ใช้ลงหมายเหตุ/ประวัติการโทรของแต่ละงวดให้ตรงกับงวดนั้น
    var per = {}, pd = ptpDate ? fmtD(ptpDate) : '';
    function setPer(i, text, amt, due) { per[i.key] = { text: text, amt: amt, due: due || '' }; }
    if (n >= 4) {
      setPer(u[0], 'ชำระ ฿' + money(rem(u[0])) + ' ณ วันที่นัด ' + pd + ' (ยกเว้นค่าปรับชำระล่าช้า + ค่าธรรมเนียมระบบ)', rem(u[0]), ptpDate);
      u.slice(1).forEach(function (i) { setPer(i, 'ยังไม่ต้องชำระ ณ วันที่นัด — ยกเว้นค่าปรับชำระล่าช้า + ค่าธรรมเนียมระบบ (หากชำระล่าช้าคิดตามปกติ)', 0, ''); });
    } else if (n === 3) {
      setPer(u[0], 'ชำระ ฿' + money(rem(u[0])) + ' ณ วันที่นัด ' + pd, rem(u[0]), ptpDate);
      setPer(u[1], 'ชำระ ฿' + money(rem(u[1])) + ' ณ วันที่นัด ' + pd, rem(u[1]), ptpDate);
      var l3 = items[items.length - 1];
      setPer(u[2], 'ทะยอยชำระ ฿' + money(rem(u[2])) + ' ก่อนครบกำหนดงวดถัดไป' + (l3.due ? ' (ภายใน ' + fmtD(l3.due) + ')' : ''), rem(u[2]), l3.due);
    } else if (n === 2) {
      var l2 = items[items.length - 1];
      setPer(u[0], 'ชำระ ฿' + money(rem(u[0])) + ' ณ วันที่นัด ' + pd, rem(u[0]), ptpDate);
      setPer(u[1], 'ชำระ 70% ของค่างวด ฿' + money(l2.a) + ' ภายใน 7 วันหลังวันที่นัด' + (l2.due ? ' (ภายใน ' + fmtD(l2.due) + ')' : ''), l2.a, l2.due);
    } else if (n === 1) {
      setPer(u[0], 'ชำระ ฿' + money(rem(u[0])) + ' ณ วันที่นัด ' + pd, rem(u[0]), ptpDate);
    }
    return { n: n, tier: tier, items: items, now: now, waive: waive, per: per };
  }

  /* ---------- แจ้งเตือนติดตามซ้ำ ---------- */
  function repeatAlert(r) {
    if (rowRemain(r) <= 0.005 || !r.calls.length) return null;
    var c = lastCall(r), cd = c.at.slice(0, 10), due, why;
    var paidAfter = r.payments.filter(function (p) { return p.date >= cd; }).reduce(function (s, p) { return s + p.amt; }, 0);
    if (NEED_DATE[c.result]) {
      if (paidAfter >= (c.ptpAmt || 0.01)) return null;
      due = c.ptpDate; why = 'ถึงวันที่ลูกค้านัด แต่ยังไม่พบยอดชำระตามเงื่อนไข';
    } else {
      if (!RECALL_DAYS[c.result]) return null;
      due = iso(addDays(parse(cd), RECALL_DAYS[c.result]));
      why = { reference: 'ติดต่อผ่านบุคคลอ้างอิงแล้ว — โทรหาลูกค้าซ้ำ', busy: 'สายไม่ว่าง — โทรซ้ำ', no_answer: 'ไม่รับสาย — โทรซ้ำ', voicemail: 'ฝากข้อความไว้ — โทรซ้ำ', unreachable: 'ปิดเครื่อง/เบอร์ผิด — หาเบอร์ใหม่/โทรซ้ำ', cancel: 'ขอยกเลิกคืนเครื่อง — ส่งเรื่องให้ฝ่ายสัญญา/หัวหน้า แล้วติดตามผล', refuse: 'ปฏิเสธจ่าย — ติดตามซ้ำ/รายงานหัวหน้า', dispute: 'โต้แย้งยอด — ตรวจสอบแล้วโทรกลับ' }[c.result];
    }
    if (!due || due > TODAY_ISO) return null;
    return { r: r, c: c, due: due, why: why, late: diffDays(TODAY_ISO, due) };
  }

  /* ---------- สิทธิ์ ---------- */
  function me() { return CTX.actor(); }
  function isAdmin() { return CTX.isAdmin(); }

  /* ---------- Views ---------- */
  function ownerCell(r) {
    var key = r.so, last = lastCall(r), admin = isAdmin(), mine = r.owner && r.owner === me();
    var sub = last ? '<div class="muted">โทรล่าสุด ' + fmtDT(last.at) + (last.by !== r.owner ? ' · ' + esc(last.by) : '') + '</div>' : '';
    var xfs = r.ownerLog.filter(function (o) { return o.xfer; }), xf = xfs[xfs.length - 1];
    var xfTxt = xf ? '<div class="muted" style="color:#7048e8;white-space:normal;max-width:210px">🔄 โอนมาจาก ' + esc(xf.from) + ' · ' + esc(String(xf.at).slice(0, 10)) + '<br>เหตุผล: ' + esc(xf.reason || '-') + '</div>' : '';
    if (!r.owner) return '<div class="pill p-amber" style="margin-bottom:5px">ยังไม่มีผู้รับผิดชอบ</div><br><button class="btn green sm" data-cm-act="claim" data-v="' + esc(key) + '">✋ รับเป็นของฉัน</button>' + sub + xfTxt;
    var btn = (mine || admin) ? '<div style="margin-top:5px"><button class="btn ghost sm" data-cm-act="xferOpen" data-v="' + esc(key) + '">🔄 โอนเคส</button></div>' : '';
    return '<b>' + esc(r.owner) + '</b> <span title="ล็อกแล้ว — โอนได้เฉพาะเจ้าของเคสหรือ Admin">🔒</span>' + (mine ? ' <span class="pill p-green">ของฉัน</span>' : '') + sub + xfTxt + btn;
  }
  function rowHtml(r) {
    var u = unpaid(r), c = lastCall(r), ra = repeatAlert(r), paidView = UI.bucket === 'paid';
    var nos = u.length ? instLabel(u) : instLabel(chaseInsts(r)) + ' (ชำระครบ)';
    var rm = rowSnap(r), cur = rowRemain(r), pd = rowPaid(r), age = rowAge(r), ps = payStatus(r);
    var t = paidView ? payTiming(r) : null;
    return '<tr class="click" data-cm-act="open" data-v="' + esc(r.so) + '">' +
      '<td class="code">' + esc(r.id) + '</td><td style="font-weight:600;white-space:nowrap">' + esc(r.name) + '</td><td class="nowrap" style="color:var(--o2);font-weight:600">' + esc(r.so) + '</td>' +
      '<td class="nowrap"><span class="pill p-red" style="' + (u.length ? '' : 'background:rgba(18,184,134,.12);color:#0b7a5b') + '">' + esc(nos) + '</span></td>' +
      '<td class="nowrap">ทุกวันที่ ' + r.dueDay + '</td>' +
      '<td class="nowrap">' + (u.length ? '<b style="color:' + (age > 90 ? '#e03131' : age > 50 ? '#c2650a' : '#495057') + '">' + age + ' วัน</b><div class="muted">' + stageOf(age) + '</div>' : '-') + '</td>' +
      '<td class="right nowrap" style="font-weight:700;color:' + (cur > 0 ? '#e03131' : '#12b886') + '">฿' + money(rm) + (pd > 0 && cur > 0 ? '<div class="muted" style="font-weight:400">คงเหลือ ฿' + money(cur) + '</div>' : '') + '</td>' +
      '<td class="right nowrap" style="color:' + (pd > 0 ? '#0b7a5b' : '#adb5bd') + ';font-weight:' + (pd > 0 ? 700 : 400) + '">' + (pd > 0 ? '฿' + money(pd) : '-') + '</td>' +
      '<td class="nowrap">' + fmtD(rowPaidDate(r)) + '</td>' +
      '<td class="nowrap"><span class="pill ' + ps.cls + '">' + esc(ps.label) + '</span><div class="muted">ชำระแล้ว ' + ps.sub + '</div></td>' +
      (paidView ? '<td class="nowrap"><span class="pill ' + t.cls + '">' + t.label + '</span><div class="muted">โทรครั้งแรก ' + (t.firstCall ? fmtD(t.firstCall) : '-') + '</div><div class="muted">ชำระล่าสุด ' + fmtD(rowPaidDate(r)) + '</div></td><td class="right nowrap"><b style="color:' + (t.after > 0 ? '#0b7a5b' : '#adb5bd') + '">' + (t.after > 0 ? '฿' + money(t.after) : '-') + '</b>' + (t.before > 0 ? '<div class="muted">ก่อนโทร ฿' + money(t.before) + ' (ไม่นับ)</div>' : '') + '</td>' : '') +
      '<td class="nowrap">' + ownerCell(r) + '</td>' +
      '<td><div style="display:flex;flex-direction:column;align-items:flex-start;gap:5px">' + (c ? '<span class="pill ' + (/^(busy|no_answer|unreach|voicem)/.test(c.result) ? 'p-amber' : c.result === 'reschedule' ? 'p-green' : 'p-blue') + '">' + esc(RES_LABEL[c.result] || c.result || '-') + '</span>' : '') + (ra && cur > 0 ? '<span class="pill p-violet">🔔 โทรซ้ำ</span>' : '') +
      '<button class="btn sm" data-cm-act="open" data-v="' + esc(r.so) + '">📞 บันทึก</button></div></td></tr>';
  }
  function viewWork(rowsAll, alerts) {
    var active = rowsAll.filter(isActive), paidRows = rowsAll.filter(isPaidRow);
    var belowN = rowsAll.filter(function (r) { return rowSnap(r) <= 0.005 && r.insts.some(function (i) { return i.due && i.due < TODAY_ISO && rem(i) > 0.005 && i.status !== 'ชำระแล้ว'; }); }).length;
    var per = BUCKETS.map(function (b) { var rs = active.filter(function (r) { return bucketOf(rowAge(r)) === b.key; }); return { b: b, rows: rs, amt: rs.reduce(function (s, r) { return s + rowSnap(r); }, 0) }; });
    var maxAmt = Math.max(1, Math.max.apply(null, per.map(function (p) { return p.amt; })));
    var total = per.reduce(function (s, p) { return s + p.amt; }, 0);
    var callsToday = rowsAll.reduce(function (s, r) { return s + r.calls.filter(function (c) { return c.at.slice(0, 10) === TODAY_ISO; }).length; }, 0);
    var unowned = active.filter(function (r) { return !r.owner; }), mine = active.filter(function (r) { return r.owner && r.owner === me(); });
    var h = '';
    h += '<div class="card" style="padding:16px 20px;background:#fff8e6"><b>รอบตัดยอดลูกหนี้เข้าเมนูโทรติดตาม</b> <span class="muted">— ระบบดึงยอดค้างชำระ เวลา 00:00 น. ของวันโทร (ใช้ยอดค้าง ณ สิ้นวันตัดยอด)</span>' +
      '<div style="overflow-x:auto;margin:10px 0"><table style="font-size:12.5px;background:#fff;border-radius:10px"><thead><tr><th>วันครบกำหนดชำระ</th><th>ตัดยอด</th><th>เริ่มโทรติดตาม</th><th>' + (UI.month === 'latest' ? 'รอบล่าสุดที่ดึงแล้ว' : 'รอบตัดยอด') + ' (วันตัดยอด)</th><th>ลูกค้าในรอบ</th></tr></thead><tbody>' +
      DUE_DAYS.map(function (d) { var lc = cutoffSel(d); return '<tr><td><b>ทุกวันที่ ' + d + '</b></td><td>' + CUT_RULES[d].label + '</td><td>' + CUT_RULES[d].call + '</td><td>' + (lc ? fmtD(iso(lc)) : (UI.month === 'latest' ? '-' : 'ไม่ใช้ (นับตามเดือนครบกำหนด)')) + '</td><td>' + active.filter(function (r) { return r.dueDay === d; }).length + ' ราย</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<div class="rule">• <b>ยอดที่ดึงมาจะแสดงคงเดิม</b> แม้ลูกค้าชำระหลังดึงยอด — ยอดที่ชำระหลังตัดรอบแสดงแยกในคอลัมน์ "ยอดที่ชำระ" · <b>รอบถัดไปยอดค้างบวกสะสม</b> (ยอดค้างเดิมที่ยังไม่ชำระ + งวดใหม่ที่ครบกำหนด) · ลูกค้าที่ค้างแต่ยังไม่ถึงรอบตัดยอด (' + belowN + ' ราย) ยังอยู่ในขั้น SMS/จดหมาย/ล็อคเครื่อง จึงไม่แสดงในรายการนี้<br>• <b>ลูกค้าถูกล็อกเป็นของพนักงานคนแรกที่กดรับหรือบันทึกการโทร</b> — คนอื่นโทรแทนไม่ได้ ยอดชำระนับให้ผู้รับผิดชอบ (Admin โอนเคสได้)</div></div>';
    h += '<div class="card" style="padding:12px 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><b>📅 ยอดค้างชำระตามเดือนครบกำหนดชำระ</b>' +
      '<select data-cm-bind="monthSel"><option value="latest"' + (UI.month === 'latest' ? ' selected' : '') + '>รอบล่าสุดที่ดึงแล้ว — ยอดสะสม (ค่าเริ่มต้น)</option>' + monthOptions().slice().reverse().map(function (mk) { return '<option value="' + mk + '"' + (UI.month === mk ? ' selected' : '') + '>' + esc(monthLabel(mk)) + '</option>'; }).join('') + '</select>' +
      '<span class="muted">' + (UI.month === 'latest' ? 'ยอดสะสม ณ วันตัดยอดล่าสุดของแต่ละวันครบกำหนด (รวมค้างเดือนก่อนๆ)' : 'เฉพาะงวดที่ครบกำหนดเดือน' + esc(monthLabel(UI.month)) + ' ยอดคงเหลือปัจจุบัน — ตรงกับกราฟ Dashboard แต่ไม่รวมลูกค้าดำเนินคดี/จำหน่ายชื่อ/ยกเลิก · ยังแยกตามวันครบกำหนดเหมือนเดิม') + '</span></div>';
    var tabsDef = [['all', 'ทั้งหมด', active.length], ['due', 'วันครบกำหนดชำระ', active.length], ['unowned', 'ยังไม่มีผู้รับผิดชอบ', unowned.length], ['mine', 'ลูกค้าของฉัน', mine.length]];
    if (isAdmin()) tabsDef.push(['paid', '✅ ชำระแล้ว', paidRows.length]);
    if (!tabsDef.some(function (t) { return t[0] === UI.bucket; })) UI.bucket = 'all';
    h += '<div class="tabs">' + tabsDef.map(function (t) { return '<div class="tab sub ' + (UI.bucket === t[0] ? 'on' : '') + '" data-cm-act="bucket" data-v="' + t[0] + '">' + t[1] + ' <span class="n">' + t[2] + '</span></div>'; }).join('') + '</div>';
    var rows = UI.bucket === 'paid' ? paidRows : UI.bucket === 'unowned' ? unowned : UI.bucket === 'mine' ? mine : active;
    if (UI.bucket === 'due' || UI.bucket === 'mine') {
      var sumOf = function (rs) { return rs.reduce(function (a, r) { return a + rowSnap(r); }, 0); };
      var CALL_STAT_FROM = '2026-11-18'; // นับเฉพาะการโทรตั้งแต่วันนี้ (ข้อมูลการโทรที่ใช้คำนวณค่าคอม)
      var calledOf = function (rs) { return rs.filter(function (r) { return r.calls.some(function (c) { return String(c.at).slice(0, 10) >= CALL_STAT_FROM; }); }).length; };
      var dsub = [['all', 'ทุกวัน', rows.length, sumOf(rows), calledOf(rows)]].concat(DUE_DAYS.map(function (d) { var rs = rows.filter(function (r) { return r.dueDay === d; }); return [String(d), 'ทุกวันที่ ' + d, rs.length, sumOf(rs), calledOf(rs)]; }));
      if (UI.bucket === 'due') {
        var totAmt = Math.max(1, dsub[0][3]);
        h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px">' + dsub.map(function (t) {
          var on = String(UI.dueDay) === t[0], pct = t[0] === 'all' ? 100 : t[3] / totAmt * 100;
          return '<div data-cm-act="dueDay" data-v="' + t[0] + '" style="cursor:pointer;border-radius:16px;padding:14px 16px;border:1px solid ' + (on ? 'transparent' : 'var(--line)') + ';background:' + (on ? 'linear-gradient(135deg,var(--o1),var(--o2))' : '#fff') + ';color:' + (on ? '#fff' : 'var(--ink)') + ';box-shadow:' + (on ? '0 8px 20px rgba(255,149,29,.35)' : '0 2px 8px rgba(0,0,0,.04)') + '">' +
            '<div style="font-size:12.5px;font-weight:600;opacity:' + (on ? 0.95 : 0.7) + '">' + (t[0] === 'all' ? 'ทุกวันครบกำหนด' : t[1]) + '</div>' +
            '<div class="pf" style="font-size:20px;font-weight:700;margin:6px 0 2px;color:' + (on ? '#fff' : '#e03131') + '">฿' + money(t[3]) + '</div>' +
            '<div style="font-size:12px;opacity:' + (on ? 0.95 : 0.7) + '">' + t[2] + ' ราย' + (t[0] === 'all' ? '' : ' · ' + pct.toFixed(1) + '% ของยอดรวม') + '</div>' +
            '<div style="height:5px;border-radius:5px;background:' + (on ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.07)') + ';margin-top:8px;overflow:hidden"><i style="display:block;height:100%;width:' + pct + '%;border-radius:5px;background:' + (on ? '#fff' : 'linear-gradient(90deg,#ff951d,#e03131)') + '"></i></div>' +
            (function () { var n = t[2], c = t[4], cp = n ? c / n * 100 : 0; return '<div style="font-size:11.5px;margin-top:8px;line-height:1.5;opacity:' + (on ? 0.95 : 0.85) + '">📞 โทรแล้ว (ตั้งแต่ 18/11/2026) <b>' + cp.toFixed(1) + '%</b> (' + c + '/' + n + ' ราย)<br>เหลือ <b>' + (n ? 100 - cp : 0).toFixed(1) + '%</b> (' + (n - c) + ' ราย)</div>'; })() + '</div>';
        }).join('') + '</div>';
      } else {
        h += '<div class="tabs" style="margin-top:-6px"><span class="muted" style="align-self:center">วันครบกำหนดชำระ:</span>' + dsub.map(function (t) { return '<div class="tab sub ' + (String(UI.dueDay) === t[0] ? 'on' : '') + '" data-cm-act="dueDay" data-v="' + t[0] + '">' + t[1] + ' <span class="n">' + t[2] + '</span></div>'; }).join('') + '</div>';
      }
      if (UI.dueDay !== 'all') rows = rows.filter(function (r) { return String(r.dueDay) === String(UI.dueDay); });
    }
    var q = UI.q.trim().toLowerCase();
    if (q) rows = rows.filter(function (r) { return (r.id + r.name + r.so).toLowerCase().indexOf(q) !== -1; });
    if (UI.staff !== 'all') rows = rows.filter(function (r) { return r.owner === UI.staff; });
    // เรียงรอบตัดยอดล่าสุดก่อน (เช่น รอบ 11/2026 ขึ้นก่อนรอบ 10/2026) แล้วในรอบเดียวกันเรียงงวดที่ค้างเก่าสุดใหม่ก่อน
    rows = rows.slice().sort(function (a, b) {
      var ca = snap(a).cut || '', cb = snap(b).cut || '';
      if (ca !== cb) return ca < cb ? 1 : -1;
      var da = oldestDue(a) || '', db = oldestDue(b) || '';
      return da < db ? 1 : da > db ? -1 : 0;
    });
    var owners = {}; rowsAll.forEach(function (r) { if (r.owner) owners[r.owner] = true; });
    var paidSum = UI.bucket === 'paid' ? rows.reduce(function (a, r) { var t = payTiming(r); a.after += t.after; a.before += t.before; return a; }, { after: 0, before: 0 }) : null;
    var pages = Math.max(1, Math.ceil(rows.length / UI.pageSize));
    if (UI.page > pages) UI.page = pages;
    if (UI.page < 1) UI.page = 1;
    var from = (UI.page - 1) * UI.pageSize, shown = rows.slice(from, from + UI.pageSize);
    function pager() {
      if (!rows.length) return '';
      var nums = [], lo = Math.max(1, UI.page - 2), hi = Math.min(pages, lo + 4); lo = Math.max(1, hi - 4);
      for (var n = lo; n <= hi; n++) nums.push(n);
      return '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-top:14px">' +
        '<span class="muted">แสดงรายการที่ ' + (from + 1) + '-' + (from + shown.length) + ' จาก ' + rows.length + ' รายการ · หน้า ' + UI.page + '/' + pages + '</span>' +
        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn ghost sm" data-cm-act="page" data-v="1" ' + (UI.page <= 1 ? 'disabled style="opacity:.4;cursor:default"' : '') + '>« หน้าแรก</button>' +
        '<button class="btn ghost sm" data-cm-act="page" data-v="' + (UI.page - 1) + '" ' + (UI.page <= 1 ? 'disabled style="opacity:.4;cursor:default"' : '') + '>‹ ก่อนหน้า</button>' +
        nums.map(function (n) { return '<button class="btn sm' + (n === UI.page ? '' : ' ghost') + '" data-cm-act="page" data-v="' + n + '">' + n + '</button>'; }).join('') +
        '<button class="btn ghost sm" data-cm-act="page" data-v="' + (UI.page + 1) + '" ' + (UI.page >= pages ? 'disabled style="opacity:.4;cursor:default"' : '') + '>ถัดไป ›</button>' +
        '<button class="btn ghost sm" data-cm-act="page" data-v="' + pages + '" ' + (UI.page >= pages ? 'disabled style="opacity:.4;cursor:default"' : '') + '>หน้าสุดท้าย »</button>' +
        '<span class="muted" style="margin-left:8px">รายการต่อหน้า</span><select data-cm-bind="pageSize">' + [50, 100, 200].map(function (n) { return '<option ' + (UI.pageSize === n ? 'selected' : '') + '>' + n + '</option>'; }).join('') + '</select></div></div>';
    }
    h += '<div class="card">' + (paidSum ? '<div class="rule" style="background:#f1faf6;border-radius:12px;padding:10px 14px;margin-bottom:14px">💰 <b>ยอดที่นับค่าคอมมิชชั่น (ชำระหลังโทร): ฿' + money(paidSum.after) + '</b> · ยอดที่ลูกค้าชำระก่อนโทร (ไม่นับค่าคอม): ฿' + money(paidSum.before) + '<br><span class="muted">เกณฑ์: เทียบวันที่ชำระกับวันที่โทรติดตามครั้งแรก — ชำระวันเดียวกับวันที่โทรหรือหลังจากนั้นนับเป็น "หลังโทร"</span></div>' : '') +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">' +
      '<input type="text" id="cmQBox" data-cm-bind="q" placeholder="ค้นหารหัสลูกค้า, ชื่อ หรือคำสั่งซื้อ" value="' + esc(UI.q) + '" style="flex:1;min-width:240px">' +
      '<select data-cm-bind="staffF"><option value="all">พนักงานที่ติดตาม: ทั้งหมด</option>' + Object.keys(owners).sort().map(function (s) { return '<option ' + (UI.staff === s ? 'selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>' +
      '<span class="muted">พบ ' + rows.length + ' รายการ</span></div>' +
      '<div style="overflow-x:auto"><table><thead><tr><th>รหัสลูกค้า</th><th>ชื่อลูกค้า</th><th>คำสั่งซื้อ</th><th>งวดที่ค้าง</th><th>วันครบกำหนด</th><th>อายุลูกหนี้</th><th class="right">ยอดค้างชำระ (ที่ดึงมา)</th><th class="right">ยอดที่ชำระ</th><th>วันที่ชำระ</th><th>สถานะการชำระเงิน</th>' + (UI.bucket === 'paid' ? '<th>ชำระก่อน/หลังโทร</th><th class="right">ยอดที่นับค่าคอม</th>' : '') + '<th>พนักงานที่ติดตาม</th><th>บันทึกการโทร</th></tr></thead><tbody>' +
      (shown.length ? shown.map(rowHtml).join('') : '<tr><td colspan="' + (UI.bucket === 'paid' ? 14 : 12) + '" style="text-align:center;padding:32px;color:#8d93a0">ไม่พบรายการ</td></tr>') + '</tbody></table></div>' + pager() + '</div>';
    return h;
  }
  function viewAlert(alerts) {
    return '<div class="card"><h3>เกณฑ์การแจ้งเตือนติดตามซ้ำ</h3><div class="rule">' +
      '• <b>ติดต่อได้ - ขอเลื่อน</b> → แจ้งเตือนเมื่อถึงวันที่ลูกค้านัด หากยังไม่พบยอดชำระตามเงื่อนไขการขอเลื่อน<br>' +
      '• <b>สายไม่ว่าง / ไม่รับสาย / ฝากข้อความ</b> → โทรซ้ำภายใน 1 วัน &nbsp;·&nbsp; <b>ปิดเครื่อง/เบอร์ผิด</b> → 2 วัน (หาเบอร์ใหม่จากบุคคลอ้างอิง)<br>' +
      '• <b>ติดต่อได้ - ขอยกเลิกคืนเครื่อง</b> → ติดตามซ้ำหลัง 3 วัน (ส่งเรื่องให้ฝ่ายสัญญา/หัวหน้า)<br>' +
      '• รายการจะหายไปเมื่อลูกค้าชำระครบ หรือชำระตามที่นัด หรือมีการบันทึกการโทรครั้งใหม่ที่ยังไม่ถึงกำหนดติดตาม</div></div>' +
      '<div class="card"><h3>รายการที่ต้องติดตามซ้ำ (' + alerts.length + ')</h3><div style="overflow-x:auto"><table><thead><tr><th>รหัสลูกค้า</th><th>ชื่อลูกค้า</th><th>คำสั่งซื้อ</th><th>งวดที่ค้าง</th><th class="right">ยอดค้างชำระ (ที่ดึงมา)</th><th>ผู้รับผิดชอบ</th><th>ผลโทรล่าสุด</th><th>เหตุผลที่ต้องติดตาม</th><th>กำหนดติดตาม</th><th></th></tr></thead><tbody>' +
      (alerts.length ? alerts.map(function (a) {
        return '<tr class="click" data-cm-act="open" data-v="' + esc(a.r.so) + '"><td class="code">' + esc(a.r.id) + '</td><td style="font-weight:600">' + esc(a.r.name) + '</td><td class="nowrap" style="color:var(--o2);font-weight:600">' + esc(a.r.so) + '</td>' +
          '<td class="nowrap"><span class="pill p-red">' + esc(instLabel(unpaid(a.r))) + '</span></td><td class="right nowrap" style="font-weight:700;color:#e03131">฿' + money(rowSnap(a.r)) + '</td>' +
          '<td class="nowrap">' + (a.r.owner ? '<b>' + esc(a.r.owner) + '</b>' : '<span class="pill p-amber">ยังไม่มีผู้รับผิดชอบ</span>') + '</td>' +
          '<td><span class="pill p-blue">' + esc(RES_LABEL[a.c.result] || a.c.result) + '</span><div class="muted">' + fmtDT(a.c.at) + ' · ' + esc(a.c.by) + '</div>' + (a.c.ptpDate ? '<div class="muted" style="color:#c2650a">นัด ' + fmtD(a.c.ptpDate) + (a.c.ptpAmt ? ' ฿' + money(a.c.ptpAmt) : '') + '</div>' : '') + '</td>' +
          '<td style="max-width:230px">' + esc(a.why) + '</td>' +
          '<td class="nowrap"><span class="pill ' + (a.late > 0 ? 'p-red' : 'p-amber') + '">' + (a.late > 0 ? 'เลยมา ' + a.late + ' วัน' : 'ครบกำหนดวันนี้') + '</span><div class="muted">' + fmtD(a.due) + '</div></td>' +
          '<td><button class="btn sm" data-cm-act="open" data-v="' + esc(a.r.so) + '">📞 โทรซ้ำ</button></td></tr>';
      }).join('') : '<tr><td colspan="10" style="text-align:center;padding:32px;color:#8d93a0">ไม่มีรายการที่ต้องติดตามซ้ำ 🎉</td></tr>') + '</tbody></table></div></div>';
  }
  var PLAN_COLORS = [{ bg: '#e7f1ff', bd: '#339af0' }, { bg: '#ffe9e9', bd: '#e03131' }, { bg: '#e6f8f0', bd: '#12b886' }, { bg: '#f1ebff', bd: '#7048e8' }];
  var REF_SHOW = { no_answer: true, busy: true, unreachable: true, voicemail: true, reference: true };
  function refBox(r) {   // ลูกค้าติดต่อไม่ได้ → แสดงบุคคลอ้างอิงให้โทรต่อ
    var has = r.refName || r.refPhone;
    return '<div style="background:#f1ebff;border:1px solid #d0bfff;border-left:4px solid #7048e8;border-radius:10px;padding:8px 12px;margin-bottom:12px;font-size:12.5px"><b>👤 บุคคลอ้างอิง</b>' +
      (has ? '<div style="margin-top:4px">ชื่อ: <b>' + esc(r.refName || '-') + '</b></div><div>เบอร์โทร: ' + (r.refPhone ? '<a href="tel:' + esc(String(r.refPhone).replace(/[^0-9+]/g, '')) + '" style="color:#7048e8;font-weight:700">' + esc(r.refPhone) + '</a>' : '<b>-</b>') + '</div>' : '<div class="muted" style="margin-top:4px">ไม่มีข้อมูลบุคคลอ้างอิงในระบบ</div>') + '</div>';
  }
  function planBox(p) {
    return '<div style="background:#fff8e6;border:1px solid #f0d9a0;border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:12.5px"><b>เงื่อนไขการขอเลื่อนชำระ</b> <span class="pill p-amber">' + esc(p.tier) + '</span>' +
      p.items.map(function (x, ix) { var c = PLAN_COLORS[ix % PLAN_COLORS.length]; return '<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 8px;margin:4px 0;border-radius:8px;background:' + c.bg + ';border-left:4px solid ' + c.bd + '"><span style="flex:1;min-width:0">' + (x.later ? '⏱ ' : '• ') + esc(x.t) + (x.due ? '<br><span class="pill p-amber" style="white-space:normal">📅 ครบกำหนดชำระ ' + fmtD(x.due) + '</span>' : x.needPtp ? '<br><span class="muted">📅 ระบุวันที่นัดชำระ เพื่อให้ระบบคำนวณวันครบกำหนด</span>' : '') + '</span>' + (x.a ? '<b class="nowrap" style="flex-shrink:0">฿' + money(x.a) + '</b>' : '') + '</div>'; }).join('') +
      '<div style="display:flex;justify-content:space-between;padding-top:6px"><b>ยอดที่ต้องชำระ ณ วันที่นัด</b><b style="color:#e03131">฿' + money(p.now) + '</b></div></div>';
  }
  function modalHtml(rowsAll) {
    var r = findRow(rowsAll, UI.modal); if (!r) return '';
    var d = UI.draft, u = unpaid(r), needDate = d.result && NEED_DATE[d.result], ra = repeatAlert(r), sn = snap(r);
    var locked = !!r.owner && r.owner !== me() && !isAdmin(), canXfer = r.owner && (r.owner === me() || isAdmin());
    var snapKeys = {}; chaseInsts(r).forEach(function (i) { snapKeys[i.key] = true; });
    var callBox;
    if (locked) callBox = '<div class="muted" style="color:#c2650a">🔒 ลูกค้ารายนี้เป็นของ <b>' + esc(r.owner) + '</b> — บันทึกการโทรได้เฉพาะเจ้าของ (Admin โอนเคสได้)</div>';
    else if (!u.length) callBox = '<div class="muted">ไม่มียอดค้างชำระแล้ว</div>';
    else callBox = '<div class="field"><label>เลือกงวดที่โทรติดตาม (บันทึกการโทรลงหมายเหตุของแต่ละงวดที่เลือก)</label>' + u.map(function (i) {
      return '<label class="instrow"><input type="checkbox" data-cm-bind="nos" value="' + esc(i.key) + '" ' + (d.nos.indexOf(i.key) !== -1 ? 'checked' : '') + '><span><b>' + esc(instLabel([i])) + '</b> · ครบกำหนด ' + fmtD(i.due) + ' · ค้าง ' + diffDays(TODAY_ISO, i.due) + ' วัน<br><span style="color:#e03131;font-weight:600">฿' + money(rem(i)) + '</span></span></label>';
    }).join('') + '</div>' +
      '<div class="field"><label>ผลการโทร</label><select data-cm-bind="result"><option value="">— เลือกผลการโทร —</option>' + CALL_RESULTS.map(function (o) { return '<option value="' + o.key + '" ' + (d.result === o.key ? 'selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select></div>' +
      (needDate ? '<div style="display:flex;gap:8px"><div class="field" style="flex:1"><label>วันที่ลูกค้าขอเลื่อนไป (วันที่นัดชำระ)</label><input type="date" data-cm-bind="ptpDate" value="' + esc(d.ptpDate) + '"></div><div class="field" style="flex:1"><label>ยอดที่ต้องชำระ ณ วันนัด (บาท)</label><input type="number" min="0" step="0.01" data-cm-bind="ptpAmt" value="' + esc(d.ptpAmt) + '"></div></div>' : '') +
      (d.result === 'reschedule' ? planBox(reschedulePlan(r, d.ptpDate)) : '') +
      (REF_SHOW[d.result] ? refBox(r) : '') +
      '<div class="field"><label>บันทึกเพิ่มเติม (ไม่บังคับ)</label><input type="text" data-cm-bind="note" value="' + esc(d.note) + '"></div><button class="btn" data-cm-act="saveCall" style="width:100%">บันทึกการโทร</button>';
    var summary = '<div style="background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:13px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b>สรุปยอดที่ต้องชำระ</b><span class="pill ' + payStatus(r).cls + '">' + esc(payStatus(r).label) + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;padding:3px 0"><span>ยอดค้างชำระรวม <span class="muted">(ที่ดึงมา)</span></span><b>฿' + money(rowSnap(r)) + '</b></div>' +
      '<div style="display:flex;justify-content:space-between;padding:3px 0"><span>ค่าปรับชำระล่าช้า</span><b>฿' + money(rowFine(r)) + '</b></div>' +
      '<div style="display:flex;justify-content:space-between;padding:3px 0"><span>ค่าธรรมเนียมระบบ</span><b>฿' + money(rowSysFee(r)) + '</b></div>' +
      '<div style="display:flex;justify-content:space-between;padding:6px 0 0;margin-top:4px;border-top:1px solid var(--line)"><b>ยอดรวมทั้งสิ้น</b><b style="color:' + (rowGrand(r) > 0 ? '#e03131' : '#12b886') + ';font-size:15px">฿' + money(rowGrand(r)) + '</b></div>' +
      (sn.cut ? '<div class="muted" style="margin-top:8px;line-height:1.7">📌 ดึงยอดรอบตัดยอด <b>' + fmtD(sn.cut) + '</b> (เข้าเมนู 00:00 น. ' + fmtD(sn.call) + ') · ยอดสะสม ' + sn.items.length + ' งวด: ' + sn.items.map(function (x) { return instLabel([x.i]) + ' ฿' + money(x.out); }).join(' + ') + '<br>ชำระหลังตัดรอบ <b style="color:#0b7a5b">฿' + money(sn.paid) + '</b> · คงเหลือปัจจุบัน <b>฿' + money(rowRemain(r)) + '</b> <span>(ยอดที่ดึงมาไม่ถูกหักออก)</span></div>' : '') + '</div>';
    var hist = r.calls.length ? r.calls.slice().reverse().map(function (c) {
      return '<div class="hist"><b style="color:#f58a0a">' + fmtDT(c.at) + ' · ' + esc(c.by) + '</b> · ' + esc(RES_LABEL[c.result] || c.result || '-') + '<br><span class="muted">' + (c.nos && c.nos.length ? esc(keysLabel(c.nos, r)) : '') + (c.ptpDate ? ' · นัด ' + fmtD(c.ptpDate) + (c.ptpAmt ? ' ฿' + money(c.ptpAmt) : '') : '') + '</span>' +
        (c.plan ? '<div class="muted" style="color:#c2650a">' + c.plan.map(esc).join('<br>') + '</div>' : '') + (c.note ? '<div class="muted">' + esc(c.note) + '</div>' : '') + '</div>';
    }).join('') : '<div class="muted">ยังไม่เคยบันทึกการโทร</div>';
    var ownerLogHtml = r.ownerLog.length ? '<div class="box"><h4>🔒 ประวัติผู้รับผิดชอบ</h4>' + r.ownerLog.slice().reverse().map(function (o) {
      return '<div class="hist" style="background:#f1f3f5;border-color:#e9ecef">' + esc(o.at) + ' · ' + esc(o.by) + '<br><span class="muted">' + esc(o.from || 'ไม่มี') + ' → <b>' + esc(o.to || 'ไม่มี') + '</b>' + (o.why ? ' · ' + esc(o.why) : '') + '</span></div>';
    }).join('') + '</div>' : '';
    var instRows = r.insts.map(function (i) {
      var od = !!snapKeys[i.key] && rem(i) > 0.005, is = instStatus(i), il = i.calls[i.calls.length - 1];
      var cs = il ? '<span class="pill p-amber" style="white-space:normal">📞 โทรแล้ว ' + esc(il.at) + '<br>' + esc(il.by) + ' · ' + esc(RES_LABEL[il.result] || il.result || '') + '</span>' : (od ? '<span class="pill p-gray">📞 ยังไม่ได้โทรติดตาม</span>' : '<span class="muted">-</span>');
      return '<tr style="' + (od ? 'background:rgba(224,49,49,.04)' : '') + '"><td><b>' + esc(i.key) + '</b></td><td class="nowrap">' + fmtD(i.due) + '</td><td class="right nowrap">' + money(i.amt) + '</td><td class="right nowrap">' + (i.paid ? money(i.paid) : '-') + '</td><td><span class="pill ' + is.cls + '">' + esc(is.label) + '</span></td><td style="min-width:170px">' + cs + '</td><td class="note" style="min-width:220px">' + (i.notes.length ? i.notes.map(function (n) { return '<div>' + esc(n) + '</div>'; }).join('') : '<span class="muted">-</span>') + '</td></tr>';
    }).join('');
    return '<div class="mask" data-cm-act="closeMask"><div class="modal">' +
      '<div class="mh"><div><h2 style="margin:0;font-size:19px">' + esc(r.name) + ' <span class="code" style="font-size:14px">' + esc(r.id) + '</span></h2>' +
      '<div class="muted" style="margin-top:4px">คำสั่งซื้อ <b style="color:var(--o2)">' + esc(r.so) + '</b> · โทร ' + esc(r.phone) + ' · ผู้บันทึก: <b>' + esc(me()) + '</b> (ระบบบันทึกชื่อพนักงานให้อัตโนมัติ)</div>' +
      '<div class="muted" style="margin-top:3px">👤 บุคคลอ้างอิง: <b style="color:#7048e8">' + esc(r.refName || '-') + '</b> · โทร ' + (r.refPhone ? '<a href="tel:' + esc(String(r.refPhone).replace(/[^0-9+]/g, '')) + '" style="color:#7048e8;font-weight:700">' + esc(r.refPhone) + '</a>' : '-') + '</div>' +
      '<div style="margin-top:8px">' + (u.length ? '<span class="pill p-red">' + esc(instLabel(u)) + ' · ยอดค้างที่ดึงมา ฿' + money(rowSnap(r)) + '</span>' : '<span class="pill p-green">ชำระครบแล้ว</span>') + ' ' + (ra ? '<span class="pill p-violet">🔔 ' + esc(ra.why) + '</span>' : '') + ' ' + (r.owner ? '<span class="pill p-blue">🔒 ผู้รับผิดชอบ: ' + esc(r.owner) + '</span>' : '<span class="pill p-amber">ยังไม่มีผู้รับผิดชอบ — ผู้ที่บันทึกการโทรก่อนจะเป็นเจ้าของ</span>') + '</div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' + (canXfer ? '<button class="btn ghost sm" data-cm-act="xferOpen" data-v="' + esc(r.so) + '">🔄 โอนเคส</button>' : '') + '<button class="btn ghost sm" data-cm-act="close">✕ ปิด</button></div></div>' +
      '<div class="cols"><div><div class="box"><h4>📞 บันทึกการโทร</h4>' + summary + callBox + '</div>' + ownerLogHtml + '<div class="box"><h4>🕐 ประวัติการโทร (' + r.calls.length + ')</h4>' + hist + '</div></div>' +
      '<div><div class="box" style="background:#fff"><h4>📋 รายละเอียดลูกค้า — ตารางงวด (หมายเหตุและสถานะการโทรอัปเดตอัตโนมัติ)</h4><div style="overflow-x:auto"><table><thead><tr><th>งวดที่</th><th>ครบกำหนด</th><th class="right">ยอดงวด</th><th class="right">ชำระแล้ว</th><th>สถานะ</th><th>สถานะการโทรติดตาม</th><th>หมายเหตุ</th></tr></thead><tbody>' + instRows + '</tbody></table></div></div></div></div></div></div>';
  }
  function xferHtml(rowsAll) {
    if (!UI.xfer) return '';
    var r = findRow(rowsAll, UI.xfer.v); if (!r) return '';
    return '<div class="mask" data-cm-act="xferMask" style="z-index:70"><div class="modal" style="max-width:480px"><h2 style="margin:0 0 4px;font-size:18px">🔄 โอนลูกค้าให้พนักงานคนอื่น</h2>' +
      '<div class="muted" style="margin-bottom:12px">' + esc(r.name) + ' · <span class="code">' + esc(r.id) + '</span> · ' + esc(r.so) + '<br>ยอดค้าง ฿' + money(rowSnap(r)) + ' · ผู้รับผิดชอบปัจจุบัน: <b>' + esc(r.owner) + '</b></div>' +
      '<div class="field"><label>เหตุผลที่โอน (จำเป็น)</label><select data-cm-bind="xferWhyS"><option value="">— เลือกเหตุผล —</option>' + ['ลาหยุด/ไม่อยู่', 'ภาระงานเต็ม', 'ลูกค้าติดต่อกับพนักงานอีกคนได้ดีกว่า', 'ย้ายหน้าที่', 'อื่นๆ'].map(function (x) { return '<option ' + (UI.xfer.whyS === x ? 'selected' : '') + '>' + x + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>รายละเอียดเพิ่มเติม / ข้อมูลส่งต่อ (ไม่บังคับ)</label><input type="text" data-cm-bind="xferWhy" value="' + esc(UI.xfer.why) + '" placeholder="เช่น ลูกค้าขอให้โทรหลัง 18:00"></div>' +
      '<div class="rule" style="background:#fff8e6;border-radius:10px;padding:8px 12px;margin-bottom:12px">• เมื่อกดโอน เคสนี้จะกลับไปเป็น <b>"ยังไม่มีผู้รับผิดชอบ"</b> เพื่อให้พนักงานคนอื่นกด "รับเป็นของฉัน"<br>• ระบบบันทึกประวัติว่าโอนจาก <b>' + esc(r.owner) + '</b> พร้อมเหตุผลและวันเวลา<br>• ประวัติการโทร/หมายเหตุงวดทั้งหมดยังอยู่ครบ · ยอดชำระที่เก็บได้ก่อนโอนยังนับให้ <b>' + esc(r.owner) + '</b></div>' +
      '<div style="display:flex;gap:8px"><button class="btn ghost" data-cm-act="xferClose" style="flex:1">ยกเลิก</button><button class="btn" data-cm-act="xferConfirm" style="flex:1">ยืนยันโอนเคส</button></div></div></div>';
  }

  /* ---------- CSS (ใช้คลาสนำหน้า cm- ไม่ปนกับ CSS ของระบบเดิม) ---------- */
  var CSS = '.cm{--o1:#ff951d;--o2:#f08000;--ink:#212529;--mute:#6b7280;--line:rgba(255,149,29,.14);--red:#e03131;--green:#12b886;--amber:#f08c00;--blue:#339af0;--violet:#7048e8;font-family:Sarabun,Prompt,sans-serif;color:var(--ink);font-size:14px}' +
    '.cm *{box-sizing:border-box}.cm .pf{font-family:Prompt,sans-serif}.cm h2,.cm h3,.cm h4{font-family:Prompt,sans-serif}' +
    '.cm .card{background:rgba(255,255,255,.97);border:1px solid rgba(255,255,255,.85);border-radius:20px;padding:22px 24px;margin-bottom:20px;box-shadow:0 8px 26px rgba(255,149,29,.08)}.cm .card h3{margin:0 0 14px;font-size:15px;font-weight:600}' +
    '.cm select,.cm input[type=text],.cm input[type=number],.cm input[type=date]{font-family:inherit;padding:9px 11px;border-radius:10px;border:1px solid rgba(255,149,29,.25);background:#fff;font-size:13.5px;color:var(--ink);outline:none}.cm select:focus,.cm input:focus{border-color:var(--o1)}' +
    '.cm button{font-family:inherit;cursor:pointer}.cm .btn{border:none;background:linear-gradient(135deg,var(--o1),var(--o2));color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 5px 14px rgba(255,149,29,.28)}' +
    '.cm .btn.ghost{background:#fff;color:var(--mute);border:1px solid rgba(255,149,29,.25);box-shadow:none}.cm .btn.sm{padding:6px 11px;font-size:12px;border-radius:9px}.cm .btn.green{background:linear-gradient(135deg,#20c997,#12b886);box-shadow:0 5px 14px rgba(18,184,134,.28)}' +
    '.cm .tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}.cm .tab{padding:9px 18px;border-radius:12px;font-size:13.5px;font-weight:600;background:#fff;color:var(--mute);border:1px solid rgba(255,149,29,.25);cursor:pointer;display:flex;gap:8px;align-items:center}' +
    '.cm .tab.on{background:linear-gradient(135deg,var(--o1),var(--o2));color:#fff;border-color:transparent;box-shadow:0 6px 16px rgba(255,149,29,.3)}.cm .tab .n{background:rgba(0,0,0,.08);border-radius:20px;padding:1px 8px;font-size:11.5px}.cm .tab.on .n{background:rgba(255,255,255,.3)}.cm .tab.sub{padding:8px 14px;font-size:13px}' +
    '.cm .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}.cm .kpi{background:#fff;border-radius:16px;border:1px solid var(--line);border-left:4px solid var(--c,#f58a0a);padding:14px 16px;box-shadow:0 2px 8px rgba(0,0,0,.04)}' +
    '.cm .kpi small{color:var(--mute);font-size:12px}.cm .kpi b{display:block;font-family:Prompt;font-size:21px;color:var(--c,#f58a0a);margin-top:4px}.cm .kpi span{font-size:11.5px;color:#8d93a0}' +
    '.cm table{width:100%;border-collapse:collapse;font-size:13px}.cm th{text-align:left;padding:11px 9px;color:var(--o1);font-weight:700;font-size:12px;white-space:nowrap;border-bottom:1px solid var(--line)}.cm td{padding:11px 9px;border-bottom:1px solid rgba(0,0,0,.05);vertical-align:middle}' +
    '.cm tbody tr.click{cursor:pointer}.cm tbody tr.click:hover{background:rgba(255,149,29,.05)}.cm .code{color:var(--o2);font-weight:700;white-space:nowrap}' +
    '.cm .pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11.5px;font-weight:600;white-space:nowrap}.cm .p-red{background:rgba(224,49,49,.1);color:var(--red)}.cm .p-green{background:rgba(18,184,134,.12);color:#0b7a5b}.cm .p-amber{background:rgba(240,140,0,.12);color:#c2650a}.cm .p-gray{background:#f1f3f5;color:var(--mute)}.cm .p-blue{background:rgba(51,154,240,.12);color:#1c7ed6}.cm .p-violet{background:rgba(112,72,232,.12);color:var(--violet)}' +
    '.cm .bars{display:flex;align-items:flex-end;gap:18px;min-height:230px;padding:6px 6px 0}.cm .bar{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:230px}.cm .bar .v{font-size:11.5px;font-weight:700;color:#495057;margin-bottom:5px;white-space:nowrap}' +
    '.cm .bar .col{position:relative;width:100%;max-width:64px}.cm .bar .col::before{content:"";position:absolute;top:-8px;left:6px;right:-6px;bottom:0;background:#ffa8a8;opacity:.45;border-radius:999px}.cm .bar .col i{position:absolute;inset:0 6px 0 0;border-radius:999px;background:linear-gradient(180deg,#ff8787,#e03131);box-shadow:0 5px 10px rgba(224,49,49,.25)}' +
    '.cm .bar .l{font-size:12px;color:var(--mute);font-weight:600;margin-top:9px;white-space:nowrap}.cm .bar .c{font-size:11px;color:#8d93a0}' +
    '.cm .mask{position:fixed;inset:0;z-index:50;background:rgba(33,37,41,.4);display:flex;align-items:flex-start;justify-content:center;padding:26px 16px;overflow-y:auto}.cm .modal{background:#fff;border-radius:22px;width:100%;max-width:1180px;padding:24px 26px;box-shadow:0 20px 60px rgba(0,0,0,.25)}' +
    '.cm .mh{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:16px}.cm .cols{display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:22px}@media (max-width:980px){.cm .cols{grid-template-columns:minmax(0,1fr)}}' +
    '.cm .box{border:1px solid var(--line);border-radius:16px;padding:14px 16px;margin-bottom:14px;background:rgba(255,149,29,.025)}.cm .box h4{margin:0 0 10px;font-size:13.5px}.cm .instrow{display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed rgba(0,0,0,.08);font-size:12.5px}' +
    '.cm .field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;min-width:0}.cm .field input,.cm .field select{width:100%;min-width:0;max-width:100%}.cm .field label{font-size:12px;color:var(--mute);font-weight:600}' +
    '.cm .hist{background:rgba(245,138,10,.05);border:1px solid rgba(245,138,10,.12);border-radius:10px;padding:8px 10px;font-size:12px;margin-bottom:7px}.cm .note{font-size:11.5px;color:#495057;line-height:1.5}.cm .note div{padding:2px 0}' +
    '.cm .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#212529;color:#fff;padding:11px 20px;border-radius:12px;font-size:13px;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.3)}' +
    '.cm .muted{color:var(--mute);font-size:12px}.cm .right{text-align:right}.cm .nowrap{white-space:nowrap}.cm .rule{font-size:12.5px;color:#495057;line-height:1.8}';
  var CSS_PREFIXED = CSS.replace(/\.(?!cm\b)([a-zA-Z][\w-]*)/g, '.cm-$1').replace(/\.cm\b(?![-\w])/g, '.cm');
  function prefixClasses(html) { return html.replace(/class="([^"]*)"/g, function (m, c) { return 'class="' + c.split(/\s+/).filter(Boolean).map(function (x) { return 'cm-' + x; }).join(' ') + '"'; }); }
  // .cm → .cm-root เพื่อให้ตัวห่อชั้นนอกใช้ชื่อเดียวกับที่ prefixClasses สร้าง
  CSS_PREFIXED = CSS_PREFIXED.replace(/\.cm(?![-\w])/g, '.cm-root').replace(/\.cm-cm-/g, '.cm-');

  /* ---------- Render / Events ---------- */
  function findRow(rows, so) { for (var k = 0; k < rows.length; k++) if (rows[k].so === so) return rows[k]; return null; }
  function freshDraft(r) { return { nos: unpaid(r).map(function (i) { return i.key; }), result: '', ptpDate: '', ptpAmt: '', note: '' }; }
  var cache = null;
  function render() {
    refreshToday();
    var rows = buildRows(); cache = rows;
    var alerts = rows.filter(function (r) { return rowSnap(r) > 0.005; }).map(repeatAlert).filter(Boolean).sort(function (a, b) { return b.late - a.late; });
    var h = '<style>' + CSS_PREFIXED + '</style>' +
      '<div class="root"><div style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px"><h1 style="margin:0;font-size:21px;font-family:Prompt">การโทรติดตามหนี้</h1><div class="muted">วันนี้ ' + fmtD(TODAY_ISO) + ' · ผู้ใช้ปัจจุบัน: <b>' + esc(me()) + '</b></div></div>' +
      '<div class="tabs"><div class="tab ' + (UI.tab === 'work' ? 'on' : '') + '" data-cm-act="tab" data-v="work">📞 รายการโทรติดตาม</div><div class="tab ' + (UI.tab === 'alert' ? 'on' : '') + '" data-cm-act="tab" data-v="alert">🔔 ต้องติดตามซ้ำ <span class="n">' + alerts.length + '</span></div></div>' +
      (UI.tab === 'alert' ? viewAlert(alerts) : viewWork(rows, alerts)) + (UI.modal ? modalHtml(rows) : '') + xferHtml(rows) + '</div>';
    return prefixClasses(h);
  }
  function rerender() { CTX.render(); }
  function toast(msg) { var w = document.createElement('div'); w.className = 'cm-root'; var t = document.createElement('div'); t.className = 'cm-toast'; t.textContent = msg; w.appendChild(t); document.body.appendChild(w); setTimeout(function () { if (w.parentNode) w.parentNode.removeChild(w); }, 3200); }
  function appendLog(o, entry) { return (o.callOwnerLog || []).concat([entry]); }
  function claim(so) {
    var r = findRow(cache, so); if (!r) return;
    if (r.owner) { toast('ลูกค้ารายนี้มีผู้รับผิดชอบแล้ว: ' + r.owner); rerender(); return; }
    CTX.patchOrder(so, function (o) { return Object.assign({}, o, { callOwner: me(), callOwnerLog: appendLog(o, { at: CTX.nowTimestamp(), by: me(), from: null, to: me(), why: 'พนักงานกดรับเป็นของตัวเอง', xfer: false }) }); });
    toast('✓ ลูกค้ารายนี้เป็นของ ' + me() + ' แล้ว');
  }
  function saveCall() {
    var r = findRow(cache, UI.modal), d = UI.draft; if (!r) return;
    if (!d.nos.length) return toast('กรุณาเลือกงวดที่โทรติดตามอย่างน้อย 1 งวด');
    if (!d.result) return toast('กรุณาเลือกผลการโทร');
    if (r.owner && r.owner !== me() && !isAdmin()) return toast('ลูกค้ารายนี้เป็นของ ' + r.owner + ' — โทรได้เฉพาะเจ้าของ');
    var entry = { at: CTX.nowTimestamp(), by: me(), result: d.result, note: d.note.trim(), insts: d.nos.slice() };
    if (d.result === 'reference') { entry.refName = r.refName; entry.refPhone = r.refPhone; }
    var plan = null;
    if (NEED_DATE[d.result]) {
      if (!d.ptpDate) return toast('กรุณาระบุวันที่นัดชำระ');
      entry.ptpDate = d.ptpDate; entry.ptpAmount = Number(d.ptpAmt) > 0 ? Number(d.ptpAmt) : null;
      plan = reschedulePlan(r, d.ptpDate); entry.plan = plan.items.map(function (x) { return x.t + (x.due ? ' [ครบกำหนด ' + fmtD(x.due) + ']' : '') + (x.a ? ' ฿' + money(x.a) : ''); });
    }
    var label = 'โทร' + (RES_LABEL[entry.result] || '').replace(/\s*-\s*/g, '-') + (entry.ptpDate ? ' นัด ' + fmtD(entry.ptpDate) + (entry.ptpAmount ? ' ฿' + money(entry.ptpAmount) : '') : '') + (d.result === 'reference' ? ' [' + (r.refName || '-') + ' ' + (r.refPhone || '-') + ']' : '') + (entry.note ? ' — ' + entry.note : '') + ' (' + entry.at + ' โดย ' + entry.by + ')';
    var selected = {}; d.nos.forEach(function (k) { selected[k] = true; });
    var waiveKeys = {}; if (plan && plan.waive) unpaid(r).forEach(function (i) { waiveKeys[i.key] = true; });
    function patchList(list, track) {
      return (list || []).map(function (i) {
        var k = (track === 'accessory' ? 'A' : '') + i.no, p = {};
        if (selected[k]) {
          var pr = plan && plan.per[k], lg = { at: entry.at, by: entry.by, result: entry.result, note: entry.note, ptpDate: entry.ptpDate, ptpAmount: entry.ptpAmount }, lb = label;
          if (pr) {   // ลงข้อมูลเลื่อนให้ตรงงวด: วันครบกำหนด/ยอดของงวดนี้โดยเฉพาะ
            lg.ptpDate = pr.due || ''; lg.ptpAmount = pr.amt > 0 ? pr.amt : null; lg.plan = pr.text;
            lb = 'โทร' + (RES_LABEL[entry.result] || '').replace(/\s*-\s*/g, '-') + ' → ' + pr.text + (entry.note ? ' — ' + entry.note : '') + ' (' + entry.at + ' โดย ' + entry.by + ')';
          }
          p.callLog = (i.callLog || []).concat([lg]); p.note = i.note ? i.note + '\n' + lb : lb;
        }
        if (waiveKeys[k]) p.feeWaived = true;
        return Object.keys(p).length ? Object.assign({}, i, p) : i;
      });
    }
    var claimLog = !r.owner;
    CTX.patchOrder(r.so, function (o) {
      var patch = { callHistory: (o.callHistory || []).concat([entry]), installments: patchList(o.installments, 'main'), accessoryInstallments: patchList(o.accessoryInstallments, 'accessory') };
      if (claimLog) { patch.callOwner = me(); patch.callOwnerLog = appendLog(o, { at: entry.at, by: me(), from: null, to: me(), why: 'รับผิดชอบอัตโนมัติจากการบันทึกโทรครั้งแรก', xfer: false }); }
      return Object.assign({}, o, patch);
    });
    UI.draft = null; UI.modal = null;
    toast('บันทึกแล้ว → อัปเดตหมายเหตุของ ' + keysLabel(d.nos, r) + (claimLog ? ' · ล็อกลูกค้าเป็นของ ' + me() : ''));
  }
  function xferConfirm() {
    var x = UI.xfer, r = findRow(cache, x.v); if (!r) return;
    if (!(isAdmin() || r.owner === me())) return toast('โอนได้เฉพาะเจ้าของเคสหรือ Admin');
    if (!x.whyS) return toast('กรุณาเลือกเหตุผลที่โอน');
    var reason = x.whyS + (x.why.trim() ? ' — ' + x.why.trim() : ''), from = r.owner;
    CTX.patchOrder(r.so, function (o) { return Object.assign({}, o, { callOwner: '', callOwnerLog: appendLog(o, { at: CTX.nowTimestamp(), by: me(), from: from, to: null, why: 'โอนเคสคืนให้ทีม โดย ' + me() + ' — ' + reason, xfer: true, reason: reason }) }); });
    UI.xfer = null; toast('✓ โอนเคสแล้ว — บันทึกประวัติของ ' + from + ' ไว้ และเปิดให้พนักงานคนอื่นรับเป็นของฉัน');
  }
  function root(e) { return e.target && e.target.closest && e.target.closest('.cm-root'); }
  function onClick(e) {
    if (!CTX || !CTX.active()) return;
    var t = e.target.closest('[data-cm-act]'); if (!t || !root(e)) return;
    var a = t.getAttribute('data-cm-act'), v = t.getAttribute('data-v');
    if (a === 'tab') { UI.tab = v; rerender(); }
    else if (a === 'page') { if (!t.disabled) { UI.page = Math.max(1, parseInt(v, 10) || 1); rerender(); } }
    else if (a === 'bucket') { UI.bucket = v; UI.dueDay = 'all'; UI.page = 1; UI.tab = 'work'; rerender(); }
    else if (a === 'dueDay') { UI.dueDay = v; UI.page = 1; rerender(); }
    else if (a === 'claim') claim(v);
    else if (a === 'open') { var r = findRow(cache, v); if (r) { UI.modal = v; UI.draft = freshDraft(r); rerender(); } }
    else if (a === 'close') { UI.modal = null; UI.draft = null; rerender(); }
    else if (a === 'closeMask') { if (e.target === t) { UI.modal = null; UI.draft = null; rerender(); } }
    else if (a === 'saveCall') saveCall();
    else if (a === 'xferOpen') { UI.xfer = { v: v, whyS: '', why: '' }; rerender(); }
    else if (a === 'xferClose') { UI.xfer = null; rerender(); }
    else if (a === 'xferMask') { if (e.target === t) { UI.xfer = null; rerender(); } }
    else if (a === 'xferConfirm') xferConfirm();
  }
  function onInput(e) {
    if (!CTX || !CTX.active()) return;
    var t = e.target, b = t.getAttribute && t.getAttribute('data-cm-bind'); if (!b) return;
    if (b === 'q') { UI.q = t.value; UI.page = 1; rerender(); var el = document.getElementById('cmQBox'); if (el) { el.focus(); el.setSelectionRange(t.value.length, t.value.length); } return; }
    if (b === 'xferWhy' && UI.xfer) UI.xfer.why = t.value;
    else if (UI.draft && (b === 'note' || b === 'ptpAmt')) UI.draft[b] = t.value;
  }
  function onChange(e) {
    if (!CTX || !CTX.active()) return;
    var t = e.target, b = t.getAttribute && t.getAttribute('data-cm-bind'); if (!b) return;
    if (b === 'monthSel') { UI.month = t.value; UI.page = 1; UI.dueDay = 'all'; rerender(); }
    else if (b === 'staffF') { UI.staff = t.value; UI.page = 1; rerender(); }
    else if (b === 'pageSize') { UI.pageSize = parseInt(t.value, 10) || 50; UI.page = 1; rerender(); }
    else if (b === 'nos') { var i = UI.draft.nos.indexOf(t.value); if (t.checked && i === -1) UI.draft.nos.push(t.value); if (!t.checked && i !== -1) UI.draft.nos.splice(i, 1); }
    else if (b === 'result') { UI.draft.result = t.value; if (t.value === 'reschedule') { var r = findRow(cache, UI.modal); UI.draft.ptpAmt = r ? (reschedulePlan(r, UI.draft.ptpDate).now || '') : ''; } rerender(); }
    else if (b === 'ptpDate') { UI.draft.ptpDate = t.value; rerender(); }
    else if (b === 'xferWhyS') { UI.xfer.whyS = t.value; }
  }
  function init(ctx) {
    CTX = ctx;
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
  }
  global.CallMenu = { init: init, render: render, _test: { toRow: toRow, snap: snap, reschedulePlan: reschedulePlan, rowFine: rowFine, rowSysFee: rowSysFee, payTiming: payTiming, setCtx: function (c) { CTX = c; }, refreshToday: refreshToday, rowsOf: buildRows, isActive: isActive, isPaidRow: isPaidRow, lastCutoff: lastCutoff } };
})(typeof window !== 'undefined' ? window : globalThis);
