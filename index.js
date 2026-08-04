const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

const PORT = process.env.PORT || 3000;
const LINE_SECRET   = process.env.LINE_CHANNEL_SECRET;
const LINE_TOKEN    = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const NOTION_INCOME_DB    = process.env.NOTION_INCOME_DB_ID;
const NOTION_ASSET_DB     = process.env.NOTION_ASSET_DB_ID;
const NOTION_CONTRACT_DB  = process.env.NOTION_CONTRACT_DB_ID;
const LINE_GROUP_ID       = process.env.LINE_GROUP_ID;
const CRON_SECRET         = process.env.CRON_SECRET;

app.get('/', (_req, res) => res.send('LeaseAI Bot OK'));

// เผื่อ AI อ่านปีจากสลิปผิด (พ.ศ./ค.ศ. สลับกัน) — ตรวจสอบและแก้ปีให้ถูกต้องอีกชั้นก่อนบันทึก Notion
function normalizeSlipDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
  if (!m) return null;
  let y = +m[1];
  const [, , mo, d] = m;
  const nowY = new Date().getFullYear();
  if (y > 2400) y -= 543; // พ.ศ. เต็ม (25xx) -> ค.ศ.
  if (y < nowY - 3 || y > nowY + 3) {
    const guess = 2500 + (y % 100) - 543; // ปีเพี้ยน เดาจาก 2 หลักท้ายแบบ พ.ศ.
    if (guess >= nowY - 3 && guess <= nowY + 3) y = guess;
  }
  return `${y}-${mo}-${d}`;
}

// จับคู่ห้อง — ราคาที่ AssetLiving เก็บไว้ใช้โชว์เอเจนต์ อาจไม่ตรงค่าเช่าจริง และหลายห้องราคาซ้ำกัน
// จับคู่ตามสัญญาจริง (Contract DB) แทน โดยพยายามจับชื่อผู้เช่าก่อน แล้วค่อย fallback เป็นยอดเงิน
function normRoomKey(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '').replace(/[\/\-_.,()（）]/g, '')
    .replace(/ห้อง/g, '').replace(/ชั้น/g, '').replace(/อาคาร/g, '').replace(/ตึก/g, '').replace(/คอนโด/g, '')
    .replace(/condominium|condo|room|floor|bldg|building/gi, '');
}
function roomNumTag(name) {
  const m = /(\d{2,4}(?:\/\d{1,4})?)\s*$/.exec((name || '').trim());
  return m ? m[1] : null;
}
function normName(s) {
  return (s || '').replace(/\s+/g, '').replace(/^(นาย|นาง|นางสาว|น\.ส\.|คุณ|ร\.ต\.|ด\.ต\.|ดร\.)/, '').toLowerCase();
}
function findContractForRoom(assetName, contracts) {
  const tag = roomNumTag(assetName);
  let cands = tag ? contracts.filter(c => c.room.includes(tag)) : [];
  if (!cands.length) {
    const nk = normRoomKey(assetName);
    if (nk) cands = contracts.filter(c => { const ck = normRoomKey(c.room); return ck && (ck.includes(nk) || nk.includes(ck)); });
  }
  return cands[0] || null;
}

// รวมห้องจาก AssetLiving กับสัญญาจริง (Contract DB) เป็นรายการเดียว — ใช้ทั้งตอนจับคู่สลิปและตอนเช็คค่าเช่าค้าง
async function fetchAssetsWithContracts() {
  const nRes = await axios.post(
    `https://api.notion.com/v1/databases/${NOTION_ASSET_DB}/query`,
    { page_size: 100 },
    { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
  );
  const assetPages = nRes.data.results
    .map(p => ({ name: p.properties['ชื่อทรัพย์สิน']?.title?.[0]?.plain_text || '', rent: p.properties['ค่าเช่ารายเดือน']?.number || 0 }))
    .filter(a => a.name);

  let contracts = [];
  if (NOTION_CONTRACT_DB) {
    const cRes = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_CONTRACT_DB}/query`,
      { page_size: 100 },
      { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
    );
    contracts = cRes.data.results
      .map(p => ({
        tenant: p.properties['ชื่อผู้เช่า']?.title?.[0]?.plain_text || '',
        room: p.properties['ทรัพย์สิน / ห้อง']?.rich_text?.[0]?.plain_text || '',
        rent: p.properties['ค่าเช่า (บาท/เดือน)']?.number || 0,
        status: p.properties['สถานะสัญญา']?.select?.name || '',
        dueDay: p.properties['วันครบชำระ']?.number || null,
        tenantGroupId: p.properties['LINE Group ID']?.rich_text?.[0]?.plain_text || '',
        skipReminder: p.properties['ใช้บอทขุนทองอยู่แล้ว']?.checkbox === true,
      }))
      .filter(c => c.room && c.rent && c.status !== 'ยกเลิก' && c.status !== 'หมดอายุแล้ว');
  }

  // ราคาที่ AssetLiving เก็บไว้ให้เอเจนต์ดูอาจไม่ตรงค่าเช่าจริง — ใช้ราคาจากสัญญาจริงแทนถ้าจับคู่ห้องได้
  return assetPages.map(a => {
    const c = findContractForRoom(a.name, contracts);
    return {
      name: a.name,
      rent: c ? c.rent : a.rent,
      tenant: c ? c.tenant : '',
      dueDay: c ? c.dueDay : null,
      tenantGroupId: c ? c.tenantGroupId : '',
      skipReminder: c ? c.skipReminder : false,
    };
  }).filter(a => a.rent > 0);
}

// เดือนใหม่ทุกเดือนต้องมี option "YYYY-MM" นี้อยู่ใน property "รอบเดือน" ของ Income DB ก่อน ไม่งั้น query filter ด้วย select.equals จะพัง 400
// (ต่างจากตอนสร้างเพจใหม่ที่ Notion auto-add option ให้เองได้ — query filter ไม่ auto-add ให้) เรียกก่อน query ทุกครั้งเพื่อกันไม่ให้ cron พังตอนต้นเดือน
async function ensureMonthOption(monthKey) {
  const dbRes = await axios.get(
    `https://api.notion.com/v1/databases/${NOTION_INCOME_DB}`,
    { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' } }
  );
  const prop = dbRes.data.properties['รอบเดือน'];
  const exists = prop?.select?.options?.some(o => o.name === monthKey);
  if (exists) return;

  await axios.patch(
    `https://api.notion.com/v1/databases/${NOTION_INCOME_DB}`,
    { properties: { 'รอบเดือน': { select: { options: [...prop.select.options, { name: monthKey }] } } } },
    { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
  );
}

// เช็คค่าเช่าค้างชำระวันนี้ แล้วส่งแจ้งเตือนเข้ากลุ่ม LINE — คืนค่าสรุปผลกลับไปด้วยเพื่อใช้ debug ผ่าน HTTP response โดยตรง ไม่ต้องพึ่ง server log
async function checkRentDue() {
  const summary = {
    lineGroupIdConfigured: !!LINE_GROUP_ID,
    assetsWithDueDay: 0,
    overdueRooms: [],
    directSent: [],
    directFailed: [],
    fallbackSent: false,
    fallbackSkippedReason: null,
  };

  const assets = (await fetchAssetsWithContracts()).filter(a => a.dueDay);
  summary.assetsWithDueDay = assets.length;
  if (!assets.length) return summary;

  const today = new Date();
  const day = today.getDate();
  const monthKey = today.toISOString().slice(0, 7); // YYYY-MM

  await ensureMonthOption(monthKey);

  // page_size:100 เดียวไม่พอ — เดือนที่มีรายการ (รวมรายจ่าย) เกิน 100 แถว จะดึงมาไม่ครบ ทำให้ห้องที่จ่ายแล้วหลุดจากเช็ค ต้องวนดึงทุกหน้า
  let incomeResults = [];
  let startCursor;
  do {
    let iRes;
    try {
      iRes = await axios.post(
        `https://api.notion.com/v1/databases/${NOTION_INCOME_DB}/query`,
        { page_size: 100, start_cursor: startCursor, filter: { property: 'รอบเดือน', select: { equals: monthKey } } },
        { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      // เผื่อ ensureMonthOption เพิ่ง add option ไปแต่ Notion ยัง propagate ไม่ทัน — ถือว่าเดือนนี้ยังไม่มีใครจ่ายแทนที่จะพังทั้ง cron
      if (err.response?.data?.code === 'validation_error') { incomeResults = []; break; }
      throw err;
    }
    incomeResults = incomeResults.concat(iRes.data.results);
    startCursor = iRes.data.has_more ? iRes.data.next_cursor : undefined;
  } while (startCursor);

  // เทียบด้วย normRoomKey แทน exact match กันเคสพิมพ์ชื่อห้องใน Income DB เพี้ยนจาก AssetLiving DB นิดหน่อย (ช่องว่าง/ตัวพิมพ์) แล้วระบบมองว่ายังไม่จ่าย ทั้งที่จ่ายแล้ว
  const paidRoomKeys = new Set(
    incomeResults
      .map(p => normRoomKey(p.properties['ห้อง / ทรัพย์สิน']?.rich_text?.[0]?.plain_text))
      .filter(Boolean)
  );

  // ห้องที่ติ๊ก "ใช้บอทขุนทองอยู่แล้ว" ข้ามไปเลย กันแจ้งซ้ำซ้อนกับอีกบอท
  // day > dueDay (ไม่ใช่ >=) เพราะหลายสัญญามี grace period ในตัว (เช่น "ชำระภายในวันที่ 1-4") — วันครบกำหนดพอดียังไม่ถือว่าค้างชำระ
  const overdue = assets.filter(a => day > a.dueDay && !paidRoomKeys.has(normRoomKey(a.name)) && !a.skipReminder);
  summary.overdueRooms = overdue.map(a => a.name);
  if (!overdue.length) return summary;

  // ห้องที่มี LINE Group ID ของตัวเอง -> ทวงตรงเข้ากลุ่มผู้เช่าคนนั้นเลย
  // ห้องที่ยังไม่ได้ตั้ง Group ID ไว้ -> รวมเป็นสรุปเดียวส่งเข้ากลุ่มหลัก กันตกหล่น
  const direct = overdue.filter(a => a.tenantGroupId);
  const fallback = overdue.filter(a => !a.tenantGroupId);

  for (const a of direct) {
    const msg = `🔔 แจ้งเตือนค่าเช่าค้างชำระ\n━━━━━━━━━━━━━━\n🏠 ห้อง: ${a.name}\n💰 ค่าเช่า: ฿${a.rent.toLocaleString()}\n📅 ครบกำหนดชำระทุกวันที่ ${a.dueDay}\n\nรบกวนโอนค่าเช่าและส่งสลิปเข้ากลุ่มนี้ได้เลยครับ ขอบคุณครับ 🙏`;
    try {
      await axios.post('https://api.line.me/v2/bot/message/push',
        { to: a.tenantGroupId, messages: [{ type: 'text', text: msg }] },
        { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      summary.directSent.push(a.name);
    } catch (err) {
      summary.directFailed.push({ name: a.name, error: err.response?.data || err.message });
    }
  }

  if (!fallback.length) {
    // nothing to do
  } else if (!LINE_GROUP_ID) {
    summary.fallbackSkippedReason = 'LINE_GROUP_ID env var is not set (empty/undefined)';
    summary.fallbackRooms = fallback.map(a => a.name);
  } else {
    const lines = fallback.map(a => `• ${a.name} — ${a.tenant || 'ไม่ระบุผู้เช่า'} (ครบกำหนดวันที่ ${a.dueDay}, ค่าเช่า ฿${a.rent.toLocaleString()})`);
    const msg = `🔔 แจ้งเตือนค่าเช่าค้างชำระ (ยังไม่ได้ตั้งกลุ่มผู้เช่า) (${today.toLocaleDateString('th-TH')})\n━━━━━━━━━━━━━━\n${lines.join('\n')}`;
    try {
      await axios.post('https://api.line.me/v2/bot/message/push',
        { to: LINE_GROUP_ID, messages: [{ type: 'text', text: msg }] },
        { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      summary.fallbackSent = true;
      summary.fallbackRooms = fallback.map(a => a.name);
    } catch (err) {
      summary.fallbackSkippedReason = 'push failed: ' + JSON.stringify(err.response?.data || err.message);
      summary.fallbackRooms = fallback.map(a => a.name);
    }
  }

  return summary;
}

// endpoint ให้ external cron (เช่น cron-job.org) เรียกทุกวันเพื่อเช็คค่าเช่าค้าง — คืน JSON สรุปผลให้ debug ได้ทันทีจาก response
app.get('/cron/check-rent', async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET) return res.status(403).send('Forbidden');
  try {
    const summary = await checkRentDue();
    res.json(summary);
  } catch (err) {
    console.error('Cron error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post('/webhook', (req, res) => {
  const sig  = req.headers['x-line-signature'];
  const hash = crypto.createHmac('sha256', LINE_SECRET)
    .update(req.rawBody).digest('base64');
  if (sig !== hash) return res.status(403).send('Bad signature');
  res.sendStatus(200);
  (req.body.events || []).forEach(e => handleEvent(e).catch(console.error));
});

async function handleEvent(event) {
  // พิมพ์ "กลุ่มไอดี" ในแชท เพื่อดึง ID ของกลุ่ม/ห้อง/ผู้ใช้ — เอาไปตั้งเป็น env var LINE_GROUP_ID สำหรับส่งแจ้งเตือนค่าเช่าค้าง
  if (event.type === 'message' && event.message.type === 'text' && event.message.text.trim() === 'กลุ่มไอดี') {
    const src = event.source;
    const id = src.groupId || src.roomId || src.userId || 'ไม่พบ';
    await reply(event.replyToken, `ID: ${id}`);
    return;
  }
  if (event.type !== 'message' || event.message.type !== 'image') return;
  const msgId = event.message.id;
  const to    = event.source.groupId || event.source.roomId || event.source.userId;
  console.log('IMAGE msgId:', msgId);

  try {
    const imgRes = await axios.get(
      `https://api-data.line.me/v2/bot/message/${msgId}/content`,
      { headers: { Authorization: `Bearer ${LINE_TOKEN}` }, responseType: 'arraybuffer' }
    );
    console.log('IMG status:', imgRes.status);

    const b64  = Buffer.from(imgRes.data).toString('base64');
    const mime = (imgRes.headers['content-type'] || 'image/jpeg').split(';')[0];

    const aiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
            { type: 'text', text: `อ่านสลิปโอนเงินธนาคารไทยนี้ให้ละเอียดที่สุด อ่านข้อความทุกส่วนที่ปรากฏในภาพ รวมถึงข้อความบันทึกช่วยจำ/โน้ตที่ผู้โอนอาจพิมพ์แนบไว้ (ถ้ามี) แล้วตอบ JSON เท่านั้น ห้ามมี markdown:
{"sender_name":string_or_null,"amount":number_or_null,"date":"YYYY-MM-DD"_or_null,"time":string_or_null,"ref_number":string_or_null,"bank_from":string_or_null,"bank_to":string_or_null,"memo":string_or_null,"is_slip":boolean}

กติกาสำคัญ:
1. memo คือข้อความบันทึกช่วยจำ/หมายเหตุที่ผู้โอนพิมพ์เอง (ถ้ามี) เช่น "ค่าเช่าห้อง 841" หรือชื่อห้อง/เลขห้อง — อ่านให้ครบทุกตัวอักษรที่เห็น ถ้าไม่มีข้อความแบบนี้ในสลิปให้ตอบ null
2. วันที่บนสลิปธนาคารไทยเป็นรูปแบบ วัน/เดือน/ปี (DD/MM/YYYY) เสมอ ห้ามอ่านสลับเป็นเดือน/วัน (MM/DD) แบบสากลอเมริกันเด็ดขาด เช่น 01/07/2569 หมายถึงวันที่ 1 เดือนกรกฎาคม ไม่ใช่วันที่ 1 เดือนมกราคม
3. ฟิลด์ date ต้องเป็นปีคริสต์ศักราช (ค.ศ.) เสมอ ถ้าวันที่ในสลิปแสดงเป็นปีพุทธศักราช (พ.ศ., ปกติจะเป็นเลข 25xx เช่น 2569) ให้แปลงเป็น ค.ศ. โดยลบ 543 ก่อนตอบ (เช่น พ.ศ. 2569 → ค.ศ. 2026) ห้ามตอบเลขปีพ.ศ.ตรงๆ โดยเด็ดขาด
4. is_slip ต้องเป็น true เฉพาะภาพที่เป็น "สลิปโอนเงินจากผู้เช่าเข้าบัญชีเจ้าของห้อง/นิติบุคคล เพื่อจ่ายค่าเช่า" เท่านั้น ถ้าเป็นภาพอื่นที่ไม่ใช่การโอนเงินเข้าเพื่อจ่ายค่าเช่าโดยตรง เช่น หน้าจอยืนยันชำระค่าไฟ (MEA/PEA/กฟน./กฟภ./MEA Connect), ค่าน้ำ, เติมเงินมือถือ, ชำระบัตรเครดิต, ใบเสร็จซื้อของ, หรือรายการที่เจ้าของห้องเป็นฝ่ายจ่ายเงินออกเอง (ไม่ใช่ผู้เช่าโอนเข้ามา) ให้ตอบ is_slip เป็น false เสมอ แม้ภาพนั้นจะมีเครื่องหมายถูก/คำว่า "สำเร็จ"/"ยืนยัน" ก็ตาม` }
          ]
        }]
      },
      { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );

    const raw  = aiRes.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const slip = JSON.parse(raw);
    console.log('Slip:', slip);

    if (!slip.is_slip) { console.log('ไม่ใช่สลิป — ไม่ตอบกลับ'); return; }

    const fixedDate = normalizeSlipDate(slip.date);
    if (fixedDate && fixedDate !== slip.date) console.log('Date corrected:', slip.date, '->', fixedDate);
    slip.date = fixedDate;

    const assets = await fetchAssetsWithContracts();

    // จับคู่ห้อง เรียงตามความน่าเชื่อถือ: 1) โน้ตในสลิปที่ระบุห้องตรงๆ 2) ชื่อผู้เช่า 3) ยอดเงินตรงเป๊ะเท่านั้น
    // ไม่เดาจาก "ยอดใกล้เคียง" อีกต่อไป — เคยจับผิดห้องเวลาผู้เช่าหักค่าใช้จ่ายอื่นออกจากยอดโอนแล้วยอดไปใกล้ห้องอื่นโดยบังเอิญ
    // ปล่อยว่างไว้ (ไม่ระบุห้อง) ให้คนมาเลือกเองทีหลัง ดีกว่าเดาแล้วผิดแบบไม่มีใครสังเกต
    let matched = null;
    if (slip.memo) {
      const memoKey = normRoomKey(slip.memo);
      matched = assets.find(a => {
        const tag = roomNumTag(a.name);
        if (tag && slip.memo.includes(tag)) return true;
        const nk = normRoomKey(a.name);
        return nk && memoKey.includes(nk);
      }) || null;
    }
    if (!matched && slip.sender_name) {
      const sn = normName(slip.sender_name);
      if (sn) matched = assets.find(a => a.tenant && (normName(a.tenant).includes(sn) || sn.includes(normName(a.tenant)))) || null;
    }
    if (!matched) {
      // ห้ามเดาถ้ามีมากกว่า 1 ห้องค่าเช่าเท่ากันพอดี (เช่น 464/4 กับ 466/166 ค่าเช่า 9,500 เท่ากัน)
      // เดิม .find() คว้าห้องแรกในลิสต์เงียบๆ โดยไม่เช็คว่ายอดชนกับห้องอื่นด้วย ทำให้จับผิดห้องแบบไม่มีใครสังเกต
      const rentMatches = assets.filter(a => a.rent === slip.amount);
      matched = rentMatches.length === 1 ? rentMatches[0] : null;
    }

    const title = matched ? `ค่าเช่า ${matched.name} ${slip.date||''}` : `โอนเงิน ${slip.amount||0}`;
    const body = {
      parent: { database_id: NOTION_INCOME_DB },
      properties: {
        'รายการ': { title: [{ text: { content: title } }] },
        'ประเภท': { select: { name: 'รายรับ' } },
        'หมวดหมู่': { select: { name: 'ค่าเช่า' } },
        'จำนวนเงิน (บาท)': { number: slip.amount || 0 },
        'สถานะ': { select: { name: 'เสร็จสิ้น' } },
        'หมายเหตุ': { rich_text: [{ text: { content: `ผู้โอน: ${slip.sender_name||'-'} | อ้างอิง: ${slip.ref_number||'-'}${slip.memo?' | โน้ต: '+slip.memo:''}` } }] }
      }
    };
    // ถ้า AI อ่านวันที่จากสลิปไม่ได้ ใช้วันที่ที่ระบบได้รับรูปแทน — กันไม่ให้ "รอบเดือน" หายไปเฉยๆ จนเช็คค่าเช่าค้างมองไม่เห็นการจ่ายเงินนี้ทั้งเดือน
    const recordDate = slip.date || new Date().toISOString().slice(0, 10);
    body.properties['วันที่'] = { date: { start: recordDate } };
    body.properties['รอบเดือน'] = { select: { name: recordDate.slice(0, 7) } };
    if (matched)   body.properties['ห้อง / ทรัพย์สิน'] = { rich_text: [{ text: { content: matched.name } }] };

    await axios.post('https://api.notion.com/v1/pages', body,
      { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
    );

    const amt = slip.amount ? `฿${slip.amount.toLocaleString()}` : '?';
    let msg = `✅ รับสลิปแล้วครับ\n━━━━━━━━━━━━━━\n💰 ยอด: ${amt}\n👤 ผู้โอน: ${slip.sender_name||'ไม่ระบุ'}\n📅 วันที่: ${slip.date||'ไม่ระบุ'}\n🔖 อ้างอิง: ${slip.ref_number||'ไม่ระบุ'}\n`;
    msg += matched ? `\n🏠 ห้อง: ${matched.name}\n📝 บันทึก Notion เรียบร้อยแล้วครับ` : `\n❓ ไม่พบห้องที่ตรงกับยอด\n📝 บันทึก Notion แล้ว`;

    await push(to, msg);

  } catch (err) {
    console.error('ERR:', err.response?.status, JSON.stringify(err.response?.data), err.message);
    await push(to, `❌ Error ${err.response?.status||''}: ${err.message}`).catch(()=>{});
  }
}

async function reply(token, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply',
    { replyToken: token, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// replyToken หมดอายุใน ~60 วิ และใช้ได้ครั้งเดียว — สลิปที่ประมวลผลช้า (cold start + Claude vision + Notion)
// มักเกินเวลานั้น ทำให้ reply เงียบ ไม่มีใครเห็นว่าทำงานสำเร็จ ต้องส่งสลิปซ้ำจนกลายเป็นบันทึกซ้ำใน Notion
// ใช้ push แทนสำหรับข้อความผลลัพธ์ เพราะ push ผูกกับ group/room/user id ไม่มีวันหมดอายุ
async function push(to, text) {
  await axios.post('https://api.line.me/v2/bot/message/push',
    { to, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

app.listen(PORT, () => console.log(`LeaseAI Bot port ${PORT}`));
