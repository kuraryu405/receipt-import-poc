/** @OnlyCurrentDoc */

// このGASは台帳に紐付けて使う。Geminiや外部サーバーは呼ばない。
function onOpen() {
  SpreadsheetApp.getUi().createMenu('小口出納')
    .addItem('レシートを登録', 'showReceiptDialog').addToUi();
}

function showReceiptDialog() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutputFromFile('ReceiptDialog').setWidth(820).setHeight(720),
    'レシートの確認・登録'
  );
}

function getLedgerOptions() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var settings = ss.getSheetByName('設定');
  if (!settings) throw new Error('設定タブがありません。架空台帳で実行してください。');
  return {
    categories: settings.getRange('D2:D6').getValues().map(function (r) { return r[0]; }).filter(Boolean),
    months: ss.getSheets().map(function (s) { return s.getName(); }).filter(function (n) { return /^\d{4}-\d{2}$/.test(n); })
  };
}

// 確認画面の「確認して登録」からのみ呼ぶ。入力と登録IDはサーバー側でも検証する。
function registerApprovedReceipt(input) {
  var data = validateEntry_(input);
  var lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(15000)) throw new Error('別の登録を処理中です。少し待って同じ登録IDで再度お試しください。');
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var options = getLedgerOptions();
    if (options.categories.indexOf(data.category) === -1) throw new Error('設定タブにある費目を選んでください。');
    var month = data.date.slice(0, 7);
    if (options.months.indexOf(month) === -1) throw new Error(month + ' のタブがありません。今回の架空台帳は2026-10・2026-11を使用してください。');
    var sheets = ss.getSheets().filter(function (s) { return /^\d{4}-\d{2}$/.test(s.getName()); });
    for (var i = 0; i < sheets.length; i++) {
      var s = sheets[i];
      var last = lastEntryRow_(s);
      if (last < 6) continue;
      var match = s.getRange(6, 11, last - 5, 1).createTextFinder(data.registrationId).matchEntireCell(true).findNext();
      if (match) {
        var existing = s.getRange(match.getRow(), 1, 1, 11).getValues()[0];
        var oldDate = existing[0] instanceof Date ? Utilities.formatDate(existing[0], 'Asia/Tokyo', 'yyyy-MM-dd') : String(existing[0]);
        if (oldDate !== data.date || String(existing[1]) !== data.merchant || String(existing[2]) !== data.description || String(existing[3]) !== data.category || existing[5] !== data.total || existing[7] !== data.tax || String(existing[8]) !== data.paymentMethod || String(existing[9]) !== data.invoiceRegistrationNumber) {
          throw new Error('この登録IDは別の内容で登録済みです。台帳の既存行を確認してください。');
        }
        return { duplicate: true, sheet: s.getName(), row: match.getRow(), url: ss.getUrl() + '#gid=' + s.getSheetId() + '&range=A' + match.getRow() + ':L' + match.getRow() };
      }
    }
    var sheet = ss.getSheetByName(month);
    var expected = ['取引日','支払先','摘要','費目','入金（円）','出金（円）','残高（円）','消費税（円）','支払方法','登録番号','登録ID','登録日時'];
    var actual = sheet.getRange(5, 1, 1, 12).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('台帳の列構成が試作と異なります。登録を中止しました。');
    var row = Math.max(6, lastEntryRow_(sheet) + 1);
    if (row > 505) throw new Error('この試作の上限500行に達しました。');
    var date = new Date(data.date + 'T12:00:00+09:00');
    var balanceFormula = '=$B$2+SUM(E$6:E' + row + ')-SUM(F$6:F' + row + ')';
    var range = sheet.getRange(row, 1, 1, 12);
    range.setValues([[date, literal_(data.merchant), literal_(data.description), data.category, 0, data.total, balanceFormula, data.tax, literal_(data.paymentMethod), literal_(data.invoiceRegistrationNumber), data.registrationId, new Date()]]);
    sheet.getRange(row, 1).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(row, 5, 1, 4).setNumberFormat('#,##0');
    sheet.getRange(row, 12).setNumberFormat('yyyy-mm-dd hh:mm');
    SpreadsheetApp.flush();
    return { duplicate: false, sheet: month, row: row, url: ss.getUrl() + '#gid=' + sheet.getSheetId() + '&range=A' + row + ':L' + row };
  } finally {
    lock.releaseLock();
  }
}

function lastEntryRow_(sheet) {
  // 手動編集で取引日だけが消えても、入力済みの行を上書きしない。
  var rows = sheet.getRange(6, 1, 500, 12).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i].some(function (value) { return value !== ''; })) return i + 6;
  }
  return 5;
}

function validateEntry_(x) {
  if (!x || x.approved !== true) throw new Error('内容を確認してから登録してください。');
  var result = {};
  ['merchant','description','category','paymentMethod','invoiceRegistrationNumber','registrationId','date'].forEach(function (key) {
    if (typeof x[key] !== 'string' || x[key].length > 500) throw new Error('入力内容を確認してください。');
    result[key] = x[key].trim();
  });
  if (!result.merchant || !result.description || !result.category) throw new Error('支払先・摘要・費目は必須です。');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(result.registrationId)) throw new Error('登録IDが不正です。JSONを取り込み直してください。');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(result.date)) throw new Error('取引日を正しく入力してください。');
  var d = new Date(result.date + 'T12:00:00+09:00');
  if (isNaN(d.getTime()) || Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd') !== result.date) throw new Error('存在する日付を入力してください。');
  if (!Number.isSafeInteger(x.total) || x.total <= 0 || x.total > 10000000) throw new Error('出金額は1〜10,000,000円の整数にしてください。');
  if (x.tax !== null && (!Number.isSafeInteger(x.tax) || x.tax < 0 || x.tax > x.total)) throw new Error('消費税額は空欄か、出金額以下の整数にしてください。');
  if (result.paymentMethod !== '現金') throw new Error('この台帳は小口現金用です。現金払いであることを確認してください。');
  if (result.invoiceRegistrationNumber && !/^T\d{13}$/.test(result.invoiceRegistrationNumber)) throw new Error('登録番号は空欄か、Tと13桁の数字で入力してください。');
  result.total = x.total;
  result.tax = x.tax === null ? '' : x.tax;
  return result;
}

// スプレッドシートの数式として解釈させない。
function literal_(text) {
  return /^[=+\-@']/.test(text) ? "'" + text : text;
}
