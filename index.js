require("dotenv").config();
const { Telegraf } = require("telegraf");
const Groq = require("groq-sdk");
const { DAVClient } = require("tsdav");
const { v4: uuidv4 } = require("uuid");

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let davClient;

async function initCalendar() {
  davClient = new DAVClient({
    serverUrl: "https://caldav.icloud.com",
    credentials: {
      username: process.env.APPLE_ID,
      password: process.env.APPLE_APP_PASSWORD,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await davClient.login();
  console.log("Календарь подключён");
}

async function parseEvent(text) {
  const today = new Date().toISOString().split("T")[0];
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `Сегодня ${today}. Извлеки детали события из сообщения и верни ТОЛЬКО JSON: {"title": "...", "date": "YYYY-MM-DD", "time": "HH:MM"}. Если время не указано — используй "10:00". Если это не запрос на событие — верни {"error": "not an event"}.`
      },
      { role: "user", content: text }
    ],
  });
  const json = response.choices[0].message.content;
  return JSON.parse(json.replace(/```json|```/g, "").trim());
}

async function addEvent(title, date, time) {
  const calendars = await davClient.fetchCalendars();
  const calendar = calendars[0];
  const dateStr = date.replace(/-/g, "");
  const timeStr = time.replace(/:/g, "") + "00";
  const hour = (parseInt(time.split(":")[0]) + 1).toString().padStart(2, "0");
  const endTimeStr = hour + time.split(":")[1] + "00";
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uuidv4()}@mybot\r\nDTSTART:${dateStr}T${timeStr}\r\nDTEND:${dateStr}T${endTimeStr}\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  await davClient.createCalendarObject({ calendar, filename: `${uuidv4()}.ics`, iCalString: ics });
}

const chats = {};

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  if (!chats[chatId]) chats[chatId] = [];

  if (/(добавь|создай|запланируй)/i.test(text)) {
    try {
      const event = await parseEvent(text);
      if (!event.error) {
        await addEvent(event.title, event.date, event.time);
        await ctx.reply(`✅ Добавлено: ${event.title} — ${event.date} в ${event.time}`);
        return;
      }
    } catch (err) {
      console.error(err);
    }
  }

  chats[chatId].push({ role: "user", content: text });
  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: chats[chatId],
    });
    const reply = response.choices[0].message.content;
    chats[chatId].push({ role: "assistant", content: reply });
    if (chats[chatId].length > 20) chats[chatId] = chats[chatId].slice(-20);
    await ctx.reply(reply);
  } catch (err) {
    console.error(err);
    ctx.reply("Ошибка, попробуй ещё раз.");
  }
});

initCalendar().then(() => {
  bot.launch();
  console.log("Бот запущен...");
});
