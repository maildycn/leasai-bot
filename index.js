const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

// ── Raw body สำหรับ verify signature ──────────────────────────
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

const PORT = process.env.PORT || 10000;
const LINE_SECRET  = process.env.LINE_CHANNEL_SECRET;
const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const NOTION_INCOME_DB = process.env.NOTION_INCOME_DB_ID;   // 💰 รายรับ-รายจ่าย
const NOTION_ASSET_DB  = process.env.NOTION_ASSET_DB_ID;    // AssetLiving

// ── Health check ───────────────────────────────────────────────
app.get('/', (_req, res) => res.send('LeaseAI Bot is running ✅'));

// ── Webhook ────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  // Verify LINE signature
  const sig = req.headers['x-line-signature'];
  const hash = crypto.createHmac('sha256', LINE_SECRET)
    .update(req.rawBody).digest('base64');
  if (sig !== hash) return res.status(403).send('Invalid signature');

  res.sendStatus(200); // ตอบ LINE ทันที ก่อน process

  const events = req.body.events || [];
  events.forEach(event => handleEvent(event).catch(console.error));
});

// ── Event handler ──────────────────────────────────────────────
async function handleEvent(event) {
  // รับเฉพาะรูปภาพ (สลิป) ในกลุ่มหรือ 1:1
  if (event.type !== 'message') return;
  if (event.message.type !== 'image') return;

  const messageId = event.message.id;
  const replyToken = event.replyToken;
  const sourceType = event.source.type; // 'group' | 'user'
  const groupId = event.source.groupId || null;
  const userId  = event.source.userId;

  console.log(`📩 รับรูปจาก ${sourceType} | messageId: ${messageId}`);

  try {
    // 1) ดึงรูปจาก LINE
    const imageBuffer = await getLineImage(messageId);
    const base64Image = imageBuffer.toString('base64');

    // 2) ให้ Claude อ่านสลิป
    const slipData = await analyzeSlipWithClaude(base64Image);
    console.log('✦ Claude อ่านสลิป:', slipData);

    if (!slipData || !slipData.amount) {
      await replyMessage(replyToken, '⚠️ ไม่สามารถอ่านสลิปได้ กรุณาส่งรูปสลิปที่ชัดเจนขึ้นครับ');
      return;
    }

    // 3) ดึงรายการห้องจาก AssetLiving
    const assets = await getAssetLivingData();

    // 4) จับคู่ห้องจากยอดเงิน
    const matched = matchAsset(slipData.amount, assets);

    // 5) บันทึกลง Notion
    const notionUrl = await saveToNotion(slipData, matched);

    // 6) สร้างข้อความตอบกลับ
    const replyText = buildReplyMessage(slipData, matched, notionUrl);
    await replyMessage(replyToken, replyText);

    console.log('✅ บันทึกเสร็จ:', notionUrl);

  } catch (err) {
    console.error('❌ Error:', err.message);
    await replyMessage(replyToken, '❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งครับ');
  }
}

// ── ดึงรูปจาก LINE ────────────────────────────────────────────
async function getLineImage(messageId) {
  const res = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` },
      responseType: 'arraybuffer'
    }
  );
  return Buffer.from(res.data);
}

// ── Claude อ่านสลิป ────────────────────────────────────────────
async function analyzeSlipWithClaude(base64Image) {
  const prompt = `คุณเป็น AI ผู้เชี่ยวชาญอ่านสลิปโอนเงินธนาคารไทย
วิเคราะห์สลิปนี้แล้วตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น ไม่มี markdown:
{
  "sender_name": "ชื่อผู้โอน (string หรือ null)",
  "amount": ตัวเลขจำนวนเงิน เช่น 22000 (number หรือ null),
  "date": "วันที่ เช่น 2026-05-12 (string หรือ null)",
  "time": "เวลา เช่น 14:30 (string หรือ null)",
  "ref_number": "เลขอ้างอิง/เลขที่รายการ (string หรือ null)",
  "bank_from": "ธนาคารผู้โอน (string หรือ null)",
  "bank_to": "ธนาคารผู้รับ (string หรือ null)",
  "receiver_name": "ชื่อผู้รับ (string หรือ null)",
  "is_slip": true ถ้าเป็นสลิปโอนเงิน false ถ้าไม่ใช่
}`;

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
          { type: 'text', text: prompt }
        ]
      }]
    },
    { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' } }
  );

  const text = res.data.content[0].text.trim();
  return JSON.parse(text);
}

// ── ดึงรายการห้องจาก AssetLiving ──────────────────────────────
async function getAssetLivingData() {
  const res = await axios.post(
    `https://api.notion.com/v1/databases/${NOTION_ASSET_DB}/query`,
    { page_size: 100 },
    {
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data.results.map(page => ({
    id: page.id,
    name: page.properties['ชื่อทรัพย์สิน']?.title?.[0]?.plain_text || '',
    rent: page.properties['ค่าเช่ารายเดือน']?.number || 0,
    status: page.properties['สถานะการเช่า']?.status?.name || '',
    endDate: page.properties['วันที่สิ้นสุดสัญญา']?.date?.start || null
  })).filter(a => a.name && a.rent > 0);
}

// ── จับคู่ห้องจากยอดเงิน ───────────────────────────────────────
function matchAsset(amount, assets) {
  // หาห้องที่ค่าเช่าตรงกันพอดี
  const exact = assets.find(a => a.rent === amount);
  if (exact) return { ...exact, matchType: 'exact' };

  // หาที่ใกล้เคียงที่สุด (ต่างกันไม่เกิน 500 บาท)
  const close = assets
    .map(a => ({ ...a, diff: Math.abs(a.rent - amount) }))
    .filter(a => a.diff <= 500)
    .sort((a, b) => a.diff - b.diff)[0];
  if (close) return { ...close, matchType: 'close' };

  return null;
}

// ── บันทึกลง Notion รายรับ-รายจ่าย ───────────────────────────
async function saveToNotion(slipData, matched) {
  const title = matched
    ? `ค่าเช่า ${matched.name} - ${slipData.date || 'ไม่ระบุวันที่'}`
    : `โอนเงิน ฿${slipData.amount?.toLocaleString()} - ${slipData.date || 'ไม่ระบุ'}`;

  const body = {
    parent: { database_id: NOTION_INCOME_DB },
    properties: {
      'รายการ': { title: [{ text: { content: title } }] },
      'ประเภท': { select: { name: 'รายรับ' } },
      'หมวดหมู่': { select: { name: 'ค่าเช่า' } },
      'จำนวนเงิน (บาท)': { number: slipData.amount || 0 },
      'สถานะ': { select: { name: 'เสร็จสิ้น' } },
      'หมายเหตุ': { rich_text: [{ text: { content: `ผู้โอน: ${slipData.sender_name || '-'} | อ้างอิง: ${slipData.ref_number || '-'} | ${slipData.bank_from || ''} → ${slipData.bank_to || ''}` } }] }
    }
  };

  // ใส่วันที่ถ้ามี
  if (slipData.date) {
    body.properties['วันที่'] = { date: { start: slipData.date } };
  }

  // ใส่ห้อง/ทรัพย์สิน
  if (matched) {
    body.properties['ห้อง / ทรัพย์สิน'] = { rich_text: [{ text: { content: matched.name } }] };
  }

  const res = await axios.post(
    'https://api.notion.com/v1/pages',
    body,
    {
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data.url;
}

// ── สร้างข้อความตอบกลับ ────────────────────────────────────────
function buildReplyMessage(slipData, matched, notionUrl) {
  const amount = slipData.amount ? `฿${slipData.amount.toLocaleString()}` : 'ไม่ทราบยอด';
  const date   = slipData.date   ? slipData.date   : 'ไม่ระบุ';
  const sender = slipData.sender_name || 'ไม่ระบุ';
  const ref    = slipData.ref_number   || 'ไม่ระบุ';

  if (!slipData.is_slip) {
    return '📋 รูปนี้ไม่ใช่สลิปโอนเงินครับ กรุณาส่งรูปสลิปจากแอปธนาคาร';
  }

  let msg = `✅ รับสลิปแล้วครับ\n`;
  msg += `━━━━━━━━━━━━━━\n`;
  msg += `💰 ยอด: ${amount}\n`;
  msg += `👤 ผู้โอน: ${sender}\n`;
  msg += `📅 วันที่: ${date}\n`;
  msg += `🔖 อ้างอิง: ${ref}\n`;

  if (matched) {
    if (matched.matchType === 'exact') {
      msg += `\n🏠 ห้อง: ${matched.name} ✓\n`;
      msg += `📝 บันทึก Notion เรียบร้อยแล้วครับ`;
    } else {
      msg += `\n⚠️ ใกล้เคียงกับห้อง: ${matched.name}\n`;
      msg += `   (ค่าเช่า ฿${matched.rent.toLocaleString()})\n`;
      msg += `📝 บันทึก Notion แล้วครับ`;
    }
  } else {
    msg += `\n❓ ไม่พบห้องที่ตรงกับยอด ${amount}\n`;
    msg += `📝 บันทึก Notion แล้ว (รอตรวจสอบ)`;
  }

  return msg;
}

// ── ส่ง Reply ──────────────────────────────────────────────────
async function replyMessage(replyToken, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    {
      replyToken,
      messages: [{ type: 'text', text }]
    },
    { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ── สรุปรายเดือน (เรียกผ่าน GET /summary) ─────────────────────
app.get('/summary', async (_req, res) => {
  try {
    const assets = await getAssetLivingData();
    const paid   = []; // TODO: query จาก Notion ว่าเดือนนี้จ่ายแล้วกี่ห้อง

    const activeAssets = assets.filter(a => a.status === 'เต็ม');
    const totalRent    = activeAssets.reduce((s, a) => s + a.rent, 0);

    res.json({
      totalRooms:  activeAssets.length,
      totalRent:   totalRent,
      assets:      activeAssets
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 LeaseAI Bot running on port ${PORT}`));
