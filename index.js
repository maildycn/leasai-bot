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

app.post('/webhook', (req, res) => {
  const sig  = req.headers['x-line-signature'];
  const hash = crypto.createHmac('sha256', LINE_SECRET)
    .update(req.rawBody).digest('base64');
  if (sig !== hash) return res.status(403).send('Bad signature');
  res.sendStatus(200);
  (req.body.events || []).forEach(e => handleEvent(e).catch(console.error));
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'image') return;
  const msgId      = event.message.id;
  const replyToken = event.replyToken;
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
3. ฟิลด์ date ต้องเป็นปีคริสต์ศักราช (ค.ศ.) เสมอ ถ้าวันที่ในสลิปแสดงเป็นปีพุทธศักราช (พ.ศ., ปกติจะเป็นเลข 25xx เช่น 2569) ให้แปลงเป็น ค.ศ. โดยลบ 543 ก่อนตอบ (เช่น พ.ศ. 2569 → ค.ศ. 2026) ห้ามตอบเลขปีพ.ศ.ตรงๆ โดยเด็ดขาด` }
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
        }))
        .filter(c => c.room && c.rent && c.status !== 'ยกเลิก' && c.status !== 'หมดอายุแล้ว');
    }

    // ราคาที่ AssetLiving เก็บไว้ให้เอเจนต์ดูอาจไม่ตรงค่าเช่าจริง — ใช้ราคาจากสัญญาจริงแทนถ้าจับคู่ห้องได้
    const assets = assetPages.map(a => {
      const c = findContractForRoom(a.name, contracts);
      return { name: a.name, rent: c ? c.rent : a.rent, tenant: c ? c.tenant : '' };
    }).filter(a => a.rent > 0);

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
      matched = assets.find(a => a.rent === slip.amount) || null;
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
    if (slip.date) {
      body.properties['วันที่'] = { date: { start: slip.date } };
      body.properties['รอบเดือน'] = { select: { name: slip.date.slice(0, 7) } };
    }
    if (matched)   body.properties['ห้อง / ทรัพย์สิน'] = { rich_text: [{ text: { content: matched.name } }] };

    await axios.post('https://api.notion.com/v1/pages', body,
      { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
    );

    const amt = slip.amount ? `฿${slip.amount.toLocaleString()}` : '?';
    let msg = `✅ รับสลิปแล้วครับ\n━━━━━━━━━━━━━━\n💰 ยอด: ${amt}\n👤 ผู้โอน: ${slip.sender_name||'ไม่ระบุ'}\n📅 วันที่: ${slip.date||'ไม่ระบุ'}\n🔖 อ้างอิง: ${slip.ref_number||'ไม่ระบุ'}\n`;
    msg += matched ? `\n🏠 ห้อง: ${matched.name}\n📝 บันทึก Notion เรียบร้อยแล้วครับ` : `\n❓ ไม่พบห้องที่ตรงกับยอด\n📝 บันทึก Notion แล้ว`;

    await reply(replyToken, msg);

  } catch (err) {
    console.error('ERR:', err.response?.status, JSON.stringify(err.response?.data), err.message);
    await reply(replyToken, `❌ Error ${err.response?.status||''}: ${err.message}`).catch(()=>{});
  }
}

async function reply(token, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply',
    { replyToken: token, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

app.listen(PORT, () => console.log(`LeaseAI Bot port ${PORT}`));
