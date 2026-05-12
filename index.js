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
const NOTION_INCOME_DB = process.env.NOTION_INCOME_DB_ID;
const NOTION_ASSET_DB  = process.env.NOTION_ASSET_DB_ID;

app.get('/', (_req, res) => res.send('LeaseAI Bot OK'));

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
            { type: 'text', text: 'อ่านสลิปโอนเงินธนาคารไทยนี้แล้วตอบ JSON เท่านั้น ห้ามมี markdown: {"sender_name":string_or_null,"amount":number_or_null,"date":"YYYY-MM-DD"_or_null,"time":string_or_null,"ref_number":string_or_null,"bank_from":string_or_null,"bank_to":string_or_null,"is_slip":boolean}' }
          ]
        }]
      },
      { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );

    const raw  = aiRes.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const slip = JSON.parse(raw);
    console.log('Slip:', slip);

    if (!slip.is_slip) return reply(replyToken, 'รูปนี้ไม่ใช่สลิปโอนเงินครับ');

    const nRes = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_ASSET_DB}/query`,
      { page_size: 100 },
      { headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } }
    );
    const assets = nRes.data.results
      .map(p => ({ name: p.properties['ชื่อทรัพย์สิน']?.title?.[0]?.plain_text || '', rent: p.properties['ค่าเช่ารายเดือน']?.number || 0 }))
      .filter(a => a.name && a.rent > 0);

    const matched = assets.find(a => a.rent === slip.amount)
      || assets.map(a => ({ ...a, diff: Math.abs(a.rent - (slip.amount||0)) })).filter(a => a.diff <= 500).sort((a,b) => a.diff-b.diff)[0]
      || null;

    const title = matched ? `ค่าเช่า ${matched.name} ${slip.date||''}` : `โอนเงิน ${slip.amount||0}`;
    const body = {
      parent: { database_id: NOTION_INCOME_DB },
      properties: {
        'รายการ': { title: [{ text: { content: title } }] },
        'ประเภท': { select: { name: 'รายรับ' } },
        'หมวดหมู่': { select: { name: 'ค่าเช่า' } },
        'จำนวนเงิน (บาท)': { number: slip.amount || 0 },
        'สถานะ': { select: { name: 'เสร็จสิ้น' } },
        'หมายเหตุ': { rich_text: [{ text: { content: `ผู้โอน: ${slip.sender_name||'-'} | อ้างอิง: ${slip.ref_number||'-'}` } }] }
      }
    };
    if (slip.date) body.properties['วันที่'] = { date: { start: slip.date } };
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
