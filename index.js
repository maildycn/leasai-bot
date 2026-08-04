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
        id: p.id,
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
      contractPageId: c ? c.id : null,
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

// รวมยอดค่าเช่าที่ได้รับจริง + รายจ่ายที่หักได้ (ซ่อมแซม/ค่าน้ำ-ไฟ) ของห้องหนึ่งในเดือนหนึ่ง — เรียกสดทุกครั้งที่ต้องเช็คว่าขาดอยู่เท่าไหร่
// (ไม่ cache ผลจาก checkRentDue เพราะต้องเช็ค ณ เวลาจริงตอนมีสลิป/กดปุ่มเข้ามา ไม่ใช่แค่ตอน cron รันรอบเดียวต่อวัน)
async function getRoomMonthTotal(roomName, monthKey) {
  let results = [];
  let startCursor;
  do {
    const res = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_INCOME_DB}/query`,
      {
        page_size: 100,
        start_cursor: startCursor,
        filter: { and: [
          { property: 'รอบเดือน', select: { equals: monthKey } },
          { property: 'ห้อง / ทรัพย์สิน', rich_text: { equals: roomName } },
        ] },
      },
      { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
    );
    results = results.concat(res.data.results);
    startCursor = res.data.has_more ? res.data.next_cursor : undefined;
  } while (startCursor);

  let received = 0, offset = 0;
  for (const p of results) {
    const amount   = p.properties['จำนวนเงิน (บาท)']?.number || 0;
    const type     = p.properties['ประเภท']?.select?.name;
    const category = p.properties['หมวดหมู่']?.select?.name;
    if (type === 'รายรับ' && category === 'ค่าเช่า') received += amount;
    else if (type === 'รายจ่าย' && (category === 'ซ่อมแซม' || category === 'ค่าน้ำ-ไฟ')) offset += amount;
  }
  return { received, offset };
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

  // รวมยอดต่อห้องแทนการเช็คแค่ "มีรายการไหม" — ผู้เช่าบางคนหักค่าซ่อมที่จ่ายเองออกจากค่าเช่าตรงๆ แล้วส่งใบเสร็จค่าซ่อมแยกมาต่างหาก
  // ถือว่าจ่ายครบถ้า (ค่าเช่าที่ได้รับจริง + ค่าซ่อมที่ห้องนั้นสำรองจ่ายไปในเดือนเดียวกัน) >= ค่าเช่าเต็ม ไม่ใช่แค่เช็คว่ามีรายการห้องนั้นโผล่มาหรือเปล่า
  // เทียบด้วย normRoomKey แทน exact match กันเคสพิมพ์ชื่อห้องใน Income DB เพี้ยนจาก AssetLiving DB นิดหน่อย (ช่องว่าง/ตัวพิมพ์) แล้วระบบมองว่ายังไม่จ่าย ทั้งที่จ่ายแล้ว
  const roomTotals = {};
  for (const p of incomeResults) {
    const roomKey = normRoomKey(p.properties['ห้อง / ทรัพย์สิน']?.rich_text?.[0]?.plain_text);
    if (!roomKey) continue;
    const amount   = p.properties['จำนวนเงิน (บาท)']?.number || 0;
    const type     = p.properties['ประเภท']?.select?.name;
    const category = p.properties['หมวดหมู่']?.select?.name;
    if (!roomTotals[roomKey]) roomTotals[roomKey] = { received: 0, repairOffset: 0 };
    if (type === 'รายรับ' && category === 'ค่าเช่า') roomTotals[roomKey].received += amount;
    // ผู้เช่าสำรองจ่ายเองแล้วหักจากค่าเช่าได้ทั้งค่าซ่อมและค่าน้ำ-ไฟ (สองหมวดที่พบบ่อยสุด)
    else if (type === 'รายจ่าย' && (category === 'ซ่อมแซม' || category === 'ค่าน้ำ-ไฟ')) roomTotals[roomKey].repairOffset += amount;
  }
  const isPaid = a => {
    const t = roomTotals[normRoomKey(a.name)];
    return !!t && (t.received + t.repairOffset) >= a.rent;
  };

  // ซิงก์ "สถานะการชำระ" ในสัญญาทุกวัน ให้ตรงกับ Income DB จริง — ไม่ใช่แค่ตอนสลิปเข้าใหม่
  // เผื่อกรณีจ่ายไม่ครบ (sync ทันทีตอนรับสลิปมองโลกในแง่ดีไปก่อน) และคืนค่าเป็น "รอชำระ" อัตโนมัติทุกต้นเดือนเพราะ roomTotals คำนวณจากเดือนปัจจุบันเท่านั้น
  for (const a of assets) {
    const status = isPaid(a) ? 'ชำระแล้ว' : (day > a.dueDay ? 'ค้างชำระ' : 'รอชำระ');
    await syncContractPaymentStatus(a.contractPageId, status);
  }

  // ห้องที่ติ๊ก "ใช้บอทขุนทองอยู่แล้ว" ข้ามไปเลย กันแจ้งซ้ำซ้อนกับอีกบอท
  // day > dueDay (ไม่ใช่ >=) เพราะหลายสัญญามี grace period ในตัว (เช่น "ชำระภายในวันที่ 1-4") — วันครบกำหนดพอดียังไม่ถือว่าค้างชำระ
  const overdue = assets.filter(a => day > a.dueDay && !isPaid(a) && !a.skipReminder);
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

  // ผู้เช่ากดปุ่มยืนยันห้องจาก quick reply ที่ส่งไปตอนจับคู่ห้องไม่ได้ — แก้ property ห้องของรายการที่สร้างไว้แล้ว ไม่สร้างรายการใหม่ซ้อน
  if (event.type === 'postback') {
    const data = event.postback.data || '';
    const to   = event.source.groupId || event.source.roomId || event.source.userId;
    if (data.startsWith('confirm_room|')) {
      const [, kind, pageId, roomNameEnc] = data.split('|');
      const roomName = decodeURIComponent(roomNameEnc);
      try {
        // ดึงหมวดหมู่+รอบเดือนเดิมมาตั้งชื่อ "รายการ" ใหม่ให้ตรงห้องที่เพิ่งยืนยัน — ไม่งั้นชื่อจะค้างเป็น "โอนเงิน X" ตลอดไปทั้งที่รู้ห้องแล้ว ดูสับสนเวลาเปิดดูรายเดือน
        const pageRes = await axios.get(`https://api.notion.com/v1/pages/${pageId}`,
          { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' } }
        );
        const cat   = pageRes.data.properties['หมวดหมู่']?.select?.name || 'ค่าเช่า';
        const cycle = pageRes.data.properties['รอบเดือน']?.select?.name || '';
        await axios.patch(`https://api.notion.com/v1/pages/${pageId}`,
          { properties: {
              'ห้อง / ทรัพย์สิน': { rich_text: [{ text: { content: roomName } }] },
              'รายการ':           { title: [{ text: { content: `${cat} ${roomName} ${cycle}`.trim() } }] },
            } },
          { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
        );
        // แค่ค่าเช่าเท่านั้นที่ยืนยันห้องแล้วถือว่า "ชำระแล้ว" — ใบเสร็จซ่อมไม่ใช่การจ่ายค่าเช่า ไม่ควรไปทับสถานะการชำระ
        if (kind === 'rent') {
          const assets = await fetchAssetsWithContracts();
          const room = assets.find(a => a.name === roomName);
          if (room) await syncContractPaymentStatus(room.contractPageId, 'ชำระแล้ว');
        }
        await push(to, `✅ ยืนยันแล้วครับ บันทึกเป็นห้อง ${roomName}`);
      } catch (err) {
        console.error('Confirm-room ERR:', err.response?.data || err.message);
        await push(to, `❌ ยืนยันห้องไม่สำเร็จ: ${err.message}`).catch(()=>{});
      }
    }

    // กดยืนยันเหตุผลที่ยอดค่าเช่าขาด (ค่าซ่อม/ค่าน้ำ-ไฟ) — คำนวณส่วนต่างใหม่ ณ ตอนกดเสมอ ไม่ใช้ตัวเลขเก่าตอนส่งปุ่ม
    // กันยอดซ้ำกับกรณีที่ผู้เช่าส่งใบเสร็จแยกมาต่างหากแล้ว (handleDeductionReceipt) — ถ้ายอดครบแล้วจะไม่สร้างรายการซ้ำให้
    if (data.startsWith('deduct_shortfall|')) {
      const [, category, roomNameEnc, monthKey] = data.split('|');
      const roomName = decodeURIComponent(roomNameEnc);
      try {
        const assets = await fetchAssetsWithContracts();
        const room = assets.find(a => a.name === roomName);
        if (!room) { await push(to, `❌ ไม่พบห้อง ${roomName} แล้วครับ`); return; }

        const { received, offset } = await getRoomMonthTotal(roomName, monthKey);
        const shortfall = room.rent - (received + offset);
        if (shortfall <= 0) {
          await syncContractPaymentStatus(room.contractPageId, 'ชำระแล้ว');
          await push(to, `✅ ยอดครบแล้วครับ ไม่ต้องเพิ่มรายการซ้ำนะครับ`);
          return;
        }

        await ensureMonthOption(monthKey);
        await axios.post('https://api.notion.com/v1/pages', {
          parent: { database_id: NOTION_INCOME_DB },
          properties: {
            'รายการ':           { title: [{ text: { content: `${category} ${roomName} ${monthKey}` } }] },
            'ประเภท':            { select: { name: 'รายจ่าย' } },
            'หมวดหมู่':          { select: { name: category } },
            'จำนวนเงิน (บาท)':  { number: shortfall },
            'สถานะ':             { select: { name: 'เสร็จสิ้น' } },
            'รอบเดือน':          { select: { name: monthKey } },
            'ห้อง / ทรัพย์สิน':  { rich_text: [{ text: { content: roomName } }] },
            'หมายเหตุ':          { rich_text: [{ text: { content: `หักส่วนต่างค่าเช่าที่ขาดจากสลิป — ยืนยันเป็น${category}ผ่านปุ่มกด` } }] },
          }
        }, { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } });

        await syncContractPaymentStatus(room.contractPageId, 'ชำระแล้ว');
        await push(to, `✅ บันทึกส่วนต่าง ฿${shortfall.toLocaleString()} เป็น${category}แล้วครับ ตอนนี้ห้อง ${roomName} ครบค่าเช่าเดือน ${monthKey} แล้ว`);
      } catch (err) {
        console.error('deduct_shortfall ERR:', err.response?.data || err.message);
        await push(to, `❌ บันทึกไม่สำเร็จ: ${err.message}`).catch(()=>{});
      }
    }
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
            { type: 'text', text: `อ่านภาพนี้ให้ละเอียดที่สุด ภาพอาจเป็น (1) สลิปโอนเงินธนาคารไทยที่ผู้เช่าโอนค่าเช่า หรือ (2) ใบเสร็จ/บิล/ใบแจ้งหนี้ที่ผู้เช่าสำรองจ่ายเองแล้วจะหักออกจากค่าเช่า (ค่าซ่อมแซม-ซ่อมบำรุง หรือค่าน้ำ-ไฟ) แล้วตอบ JSON เท่านั้น ห้ามมี markdown:
{"doc_type":"rent_slip"_or_"deduction_receipt"_or_"other","sender_name":string_or_null,"amount":number_or_null,"date":"YYYY-MM-DD"_or_null,"time":string_or_null,"ref_number":string_or_null,"bank_from":string_or_null,"bank_to":string_or_null,"memo":string_or_null,"deduction_category":"ซ่อมแซม"_or_"ค่าน้ำ-ไฟ"_or_null,"deduction_description":string_or_null}

กติกาสำคัญ:
1. doc_type = "rent_slip" เฉพาะภาพที่เป็น "สลิปโอนเงินจากผู้เช่าเข้าบัญชีเจ้าของห้อง/นิติบุคคล เพื่อจ่ายค่าเช่า" เท่านั้น
2. doc_type = "deduction_receipt" สำหรับใบเสร็จ/บิล/ใบแจ้งหนี้ที่ผู้เช่าเป็นคนจ่ายเองแล้วจะหักออกจากค่าเช่า — deduction_category = "ซ่อมแซม" สำหรับค่าซ่อมแซม-ซ่อมบำรุง (เช่น ช่างซ่อมท่อน้ำ, ซ่อมแอร์, เปลี่ยนหลอดไฟ) หรือ "ค่าน้ำ-ไฟ" สำหรับบิลค่าไฟ/ค่าน้ำ (เช่น MEA/PEA/กฟน./กฟภ./MEA Connect) ที่ผู้เช่าจ่ายเองแล้วจะหักจากเจ้าของห้อง — amount คือยอดรวมทั้งบิล, deduction_description คือรายละเอียดสั้นๆ ว่าเป็นค่าอะไร
3. doc_type = "other" สำหรับภาพอื่นทั้งหมดที่ไม่เข้าเกณฑ์ข้อ 1-2 เช่น บิลค่าไฟ/ค่าน้ำ/เติมเงินมือถือ/ชำระบัตรเครดิตที่**เจ้าของห้องเป็นฝ่ายจ่ายเอง**ไม่ใช่ผู้เช่าสำรองจ่าย, ใบเสร็จซื้อของทั่วไปที่ไม่เกี่ยวกับห้องเช่า แม้ภาพนั้นจะมีเครื่องหมายถูก/คำว่า "สำเร็จ"/"ยืนยัน" ก็ตาม
4. memo (เฉพาะตอน doc_type เป็น rent_slip) คือข้อความบันทึกช่วยจำ/หมายเหตุที่ผู้โอนพิมพ์เอง (ถ้ามี) เช่น "ค่าเช่าห้อง 841" หรือชื่อห้อง/เลขห้อง — อ่านให้ครบทุกตัวอักษรที่เห็น ถ้าไม่มีข้อความแบบนี้ให้ตอบ null
5. วันที่บนสลิป/ใบเสร็จไทยเป็นรูปแบบ วัน/เดือน/ปี (DD/MM/YYYY) เสมอ ห้ามอ่านสลับเป็นเดือน/วัน (MM/DD) แบบสากลอเมริกันเด็ดขาด เช่น 01/07/2569 หมายถึงวันที่ 1 เดือนกรกฎาคม ไม่ใช่วันที่ 1 เดือนมกราคม
6. ฟิลด์ date ต้องเป็นปีคริสต์ศักราช (ค.ศ.) เสมอ ถ้าวันที่ในภาพแสดงเป็นปีพุทธศักราช (พ.ศ., ปกติจะเป็นเลข 25xx เช่น 2569) ให้แปลงเป็น ค.ศ. โดยลบ 543 ก่อนตอบ (เช่น พ.ศ. 2569 → ค.ศ. 2026) ห้ามตอบเลขปีพ.ศ.ตรงๆ โดยเด็ดขาด` }
          ]
        }]
      },
      { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );

    const raw = aiRes.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const doc = JSON.parse(raw);
    console.log('Doc:', doc);

    if (doc.doc_type === 'deduction_receipt') { await handleDeductionReceipt(doc, to); return; }
    if (doc.doc_type !== 'rent_slip') { console.log('ไม่ใช่สลิปหรือใบเสร็จที่หักได้ — ไม่ตอบกลับ'); return; }
    const slip = doc;

    const fixedDate = normalizeSlipDate(slip.date);
    if (fixedDate && fixedDate !== slip.date) console.log('Date corrected:', slip.date, '->', fixedDate);
    slip.date = fixedDate;

    // กันสลิปซ้ำ — ถ้าเลขอ้างอิงตรงกับรายการที่เคยบันทึกไว้แล้ว (เช่น ผู้เช่าส่งซ้ำเพราะคิดว่าบอทไม่ตอบ ก่อนแก้เรื่อง replyToken หมดอายุ) ไม่สร้างรายการใหม่ซ้อน
    if (slip.ref_number) {
      const dupRes = await axios.post(
        `https://api.notion.com/v1/databases/${NOTION_INCOME_DB}/query`,
        { page_size: 1, filter: { property: 'เลขอ้างอิง', rich_text: { equals: slip.ref_number } } },
        { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
      );
      if (dupRes.data.results.length) {
        const prevRoom = dupRes.data.results[0].properties['ห้อง / ทรัพย์สิน']?.rich_text?.[0]?.plain_text || 'ไม่ระบุห้อง';
        await push(to, `⚠️ สลิปนี้บันทึกไปแล้วก่อนหน้านี้ครับ (เลขอ้างอิง ${slip.ref_number} — ห้อง ${prevRoom}) ไม่ได้บันทึกซ้ำให้นะครับ`);
        return;
      }
    }

    const assets = await fetchAssetsWithContracts();

    // จับคู่ห้อง เรียงตามความน่าเชื่อถือ: 1) กลุ่มไลน์ของห้องนั้นเอง (ตั้งไว้ใน Contract DB) — แต่ยังต้องเช็คว่ายอด/ชื่อผู้โอนสมเหตุสมผลกับผู้เช่าห้องนั้นด้วย
    // ไม่ใช่เชื่อกลุ่มอย่างเดียว เพราะมีเคสที่ภาพซึ่งไม่ใช่ค่าเช่าห้องนั้นจริงถูกส่งเข้ากลุ่มผิด (คนละชื่อคนละยอดกับผู้เช่าห้องนั้นเลย) แล้วบอทเชื่อกลุ่มเฉยๆจนบันทึกผิดห้อง
    // 2) โน้ตในสลิปที่ระบุห้องตรงๆ 3) ชื่อผู้เช่า 4) ยอดเงินตรงเป๊ะเท่านั้น
    // ไม่เดาจาก "ยอดใกล้เคียง" อีกต่อไป — เคยจับผิดห้องเวลาผู้เช่าหักค่าใช้จ่ายอื่นออกจากยอดโอนแล้วยอดไปใกล้ห้องอื่นโดยบังเอิญ
    // ถ้ายังจับคู่ไม่ได้ชัดเจน (ไม่เจอเลย หรือเจอมากกว่า 1 ห้องพอดี) ส่ง quick reply ให้กดยืนยันเอง ดีกว่าเดาแล้วผิดแบบไม่มีใครสังเกต
    let matched = null;
    const groupRoom = assets.find(a => a.tenantGroupId && a.tenantGroupId === to) || null;
    if (groupRoom) {
      const sameRent = slip.amount != null && groupRoom.rent === slip.amount;
      const sn = slip.sender_name ? normName(slip.sender_name) : '';
      const tn = groupRoom.tenant ? normName(groupRoom.tenant) : '';
      const sameSender = !!(sn && tn && (sn.includes(tn) || tn.includes(sn)));
      if (sameRent || sameSender) matched = groupRoom;
      // ถ้ายอดและชื่อผู้โอนไม่ตรงกับผู้เช่าห้องที่กลุ่มนี้ผูกไว้เลยสักอย่าง ปล่อยผ่านไปให้ขั้นตอนอื่นข้างล่างจับคู่ต่อแทนที่จะเชื่อกลุ่มอย่างเดียว
    }
    let candidates = [];
    if (!matched && slip.memo) {
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
      if (rentMatches.length === 1) matched = rentMatches[0];
      else if (rentMatches.length > 1) candidates = rentMatches;
      else candidates = assets.slice(0, 13); // LINE quick reply จำกัด 13 ปุ่ม
    }

    // ตอนจับคู่ห้องไม่ได้ ตั้งชื่อ "รายการ" ชั่วคราวไปก่อน — ยืนยันห้องทีหลังผ่านปุ่มแล้วจะเปลี่ยนชื่อให้ตรงห้อง+รอบเดือนอัตโนมัติ (ดูตอนรับ postback "confirm_room")
    const title = matched ? `ค่าเช่า ${matched.name}` : `โอนเงิน ${slip.amount||0}`;
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

    // ค่าเช่าจ่ายล่วงหน้าเสมอ (จ่ายก่อนเข้าอยู่เดือนถัดไป ไม่ใช่จ่ายย้อนหลังของเดือนที่อยู่แล้ว) — ถ้าวันที่โอนเลยวันครบชำระของห้องนั้นในเดือนนั้นไปแล้ว
    // แปลว่ากำลังจ่ายล่วงหน้าให้เดือนถัดไป เช่น ห้องครบชำระทุกวันที่ 1 โอนวันที่ 31 ก.ค. คือค่าเช่าเดือนสิงหาคม ไม่ใช่กรกฎาคม
    let cycleMonth = recordDate.slice(0, 7);
    if (matched && matched.dueDay) {
      const d = new Date(recordDate + 'T00:00:00Z');
      if (d.getUTCDate() > matched.dueDay) {
        d.setUTCMonth(d.getUTCMonth() + 1);
        cycleMonth = d.toISOString().slice(0, 7);
      }
    }
    await ensureMonthOption(cycleMonth);
    body.properties['รอบเดือน'] = { select: { name: cycleMonth } };
    // ตั้งชื่อ "รายการ" ด้วยรอบเดือน (ไม่ใช่วันที่โอนดิบๆ) ให้ตรงกับคอลัมน์ที่มันจะไปอยู่ในมุมมองแยกตามเดือนเสมอ — กันสับสนเวลาสลิปจ่ายล่วงหน้าข้ามเดือน
    if (matched) {
      body.properties['รายการ']       = { title: [{ text: { content: `ค่าเช่า ${matched.name} ${cycleMonth}` } }] };
      body.properties['ห้อง / ทรัพย์สิน'] = { rich_text: [{ text: { content: matched.name } }] };
    }
    if (slip.ref_number)  body.properties['เลขอ้างอิง'] = { rich_text: [{ text: { content: slip.ref_number } }] };

    const createRes = await axios.post('https://api.notion.com/v1/pages', body,
      { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
    );

    const amt = slip.amount ? `฿${slip.amount.toLocaleString()}` : '?';
    let msg = `✅ รับสลิปแล้วครับ\n━━━━━━━━━━━━━━\n💰 ยอด: ${amt}\n👤 ผู้โอน: ${slip.sender_name||'ไม่ระบุ'}\n📅 วันที่: ${slip.date||'ไม่ระบุ'}\n🔖 อ้างอิง: ${slip.ref_number||'ไม่ระบุ'}\n`;

    if (matched) {
      msg += `\n🏠 ห้อง: ${matched.name}\n📝 บันทึก Notion เรียบร้อยแล้วครับ`;
      // เช็คยอดรวมทั้งเดือนสด ๆ ไม่ใช่แค่สลิปใบนี้ใบเดียว เผื่อมีรายจ่ายหักไว้ก่อนแล้วจากใบเสร็จอื่น
      const { received, offset } = await getRoomMonthTotal(matched.name, cycleMonth);
      const shortfall = matched.rent - (received + offset);
      if (shortfall > 0) {
        msg += `\n\n⚠️ ยอดรวมเดือนนี้ยังขาดอยู่ ฿${shortfall.toLocaleString()} จากค่าเช่าเต็ม ฿${matched.rent.toLocaleString()} ถ้าขาดเพราะหักค่าซ่อม/ค่าน้ำ-ไฟ กดยืนยันด้านล่างได้เลยครับ`;
        await pushShortfallConfirm(to, msg, matched.name, cycleMonth);
      } else {
        await syncContractPaymentStatus(matched.contractPageId, 'ชำระแล้ว');
        await push(to, msg);
      }
    } else {
      msg += `\n❓ ไม่พบห้องที่ตรงกับยอดชัดเจน กดยืนยันห้องด้านล่างนี้ได้เลยครับ\n📝 บันทึกไว้ชั่วคราวแล้ว`;
      await pushRoomConfirm(to, msg, createRes.data.id, candidates, 'rent');
    }

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

// ผู้เช่าสำรองจ่ายเอง (ค่าซ่อมแซม หรือ ค่าน้ำ-ไฟ) แล้วหักออกจากค่าเช่าที่โอนมา — บันทึกเป็นรายจ่ายของห้องนั้นตามหมวดที่ AI แยกให้
// checkRentDue() จะรวมยอดนี้เข้ากับค่าเช่าที่ได้รับจริง ถ้ารวมกันครบเท่าค่าเช่าเต็มก็ถือว่าเดือนนั้นจ่ายครบ ไม่เตือนซ้ำ
async function handleDeductionReceipt(doc, to) {
  const fixedDate  = normalizeSlipDate(doc.date);
  const recordDate = fixedDate || doc.date || new Date().toISOString().slice(0, 10);
  const monthKey   = recordDate.slice(0, 7);
  await ensureMonthOption(monthKey);

  const assets  = await fetchAssetsWithContracts();
  const matched = assets.find(a => a.tenantGroupId && a.tenantGroupId === to) || null;
  const candidates = matched ? [] : assets.slice(0, 13);

  const amount   = doc.amount || 0;
  const category = doc.deduction_category === 'ค่าน้ำ-ไฟ' ? 'ค่าน้ำ-ไฟ' : 'ซ่อมแซม';
  const desc     = doc.deduction_description || category;
  const title    = matched ? `${category} ${matched.name} ${monthKey}` : `${category} ${desc}`;
  const body = {
    parent: { database_id: NOTION_INCOME_DB },
    properties: {
      'รายการ':           { title: [{ text: { content: title } }] },
      'ประเภท':            { select: { name: 'รายจ่าย' } },
      'หมวดหมู่':          { select: { name: category } },
      'จำนวนเงิน (บาท)':  { number: amount },
      'สถานะ':             { select: { name: 'เสร็จสิ้น' } },
      'วันที่':            { date: { start: recordDate } },
      'รอบเดือน':          { select: { name: monthKey } },
      'หมายเหตุ':          { rich_text: [{ text: { content: `${desc} — ผู้เช่าสำรองจ่ายเอง (หักจากค่าเช่า)` } }] },
    }
  };
  if (matched) body.properties['ห้อง / ทรัพย์สิน'] = { rich_text: [{ text: { content: matched.name } }] };

  const createRes = await axios.post('https://api.notion.com/v1/pages', body,
    { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
  );

  const amt = amount ? `฿${amount.toLocaleString()}` : '?';
  let msg = `🧾 รับใบเสร็จ${category}แล้วครับ\n━━━━━━━━━━━━━━\n💰 ยอด: ${amt}\n📝 รายการ: ${desc}\n📅 วันที่: ${recordDate}\n`;
  if (matched) {
    msg += `\n🏠 ห้อง: ${matched.name}\n📝 บันทึกเป็นรายจ่าย${category}แล้วครับ — ถ้ายอดค่าเช่าที่โอนมา + รายการนี้รวมกันครบค่าเช่าเต็ม จะถือว่าเดือนนี้จ่ายครบแล้ว`;
    await push(to, msg);
  } else {
    msg += `\n❓ ไม่พบห้องที่ตรงกับกลุ่มนี้ชัดเจน กดยืนยันห้องด้านล่างนี้ได้เลยครับ\n📝 บันทึกไว้ชั่วคราวแล้ว`;
    await pushRoomConfirm(to, msg, createRes.data.id, candidates, 'repair');
  }
}

// ส่งข้อความพร้อมปุ่ม quick reply ให้กดยืนยันห้อง — แต่ละปุ่มเป็น postback คู่กับ pageId ของรายการที่สร้างไว้แล้ว
// เพื่อให้กดแล้วไปแก้ property ห้องของรายการเดิม ไม่ใช่สร้างรายการใหม่ซ้อน
async function pushRoomConfirm(to, text, pageId, candidates, kind) {
  const items = candidates.slice(0, 13).map(a => ({
    type: 'action',
    action: {
      type: 'postback',
      label: a.name.slice(0, 20),
      data: `confirm_room|${kind}|${pageId}|${encodeURIComponent(a.name)}`,
      displayText: `ยืนยันห้อง ${a.name}`
    }
  }));
  const messages = [{ type: 'text', text }];
  if (items.length) messages[0].quickReply = { items };
  await axios.post('https://api.line.me/v2/bot/message/push',
    { to, messages },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ส่งปุ่มให้เลือกเหตุผลที่ยอดค่าเช่าขาด — กดแล้วไปสร้างรายจ่ายหักส่วนต่างให้อัตโนมัติ (ดูตอนรับ postback "deduct_shortfall")
async function pushShortfallConfirm(to, text, roomName, monthKey) {
  const items = [
    { type: 'action', action: { type: 'postback', label: 'ค่าซ่อม', data: `deduct_shortfall|ซ่อมแซม|${encodeURIComponent(roomName)}|${monthKey}`, displayText: 'ขาดเพราะหักค่าซ่อม' } },
    { type: 'action', action: { type: 'postback', label: 'ค่าน้ำ-ไฟ', data: `deduct_shortfall|ค่าน้ำ-ไฟ|${encodeURIComponent(roomName)}|${monthKey}`, displayText: 'ขาดเพราะหักค่าน้ำ-ไฟ' } },
  ];
  await axios.post('https://api.line.me/v2/bot/message/push',
    { to, messages: [{ type: 'text', text, quickReply: { items } }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// อัปเดต "สถานะการชำระ" ในสัญญาให้ตรงกับความจริง — ฟิลด์นี้แต่ก่อนตั้งเป็น "รอชำระ" ตอนสร้างสัญญาแล้วไม่มีอะไรอัปเดตอีกเลย
// ทำให้หน้า Notion สัญญาเช่าไม่เคยสะท้อนว่าเดือนนี้จ่ายแล้วหรือยัง ทั้งที่ Income DB มีรายการจริงอยู่
async function syncContractPaymentStatus(contractPageId, status) {
  if (!contractPageId) return;
  try {
    await axios.patch(`https://api.notion.com/v1/pages/${contractPageId}`,
      { properties: { 'สถานะการชำระ': { select: { name: status } } } },
      { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('syncContractPaymentStatus ERR:', contractPageId, status, err.response?.data || err.message);
  }
}

app.listen(PORT, () => console.log(`LeaseAI Bot port ${PORT}`));
