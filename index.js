require("dotenv").config();
const { Telegraf } = require("telegraf");
const Groq = require("groq-sdk");
const axios = require("axios");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { TodoistApi } = require("@doist/todoist-api-typescript");
const mammoth = require("mammoth");
const Redis = require("ioredis");
const { search } = require("duck-duck-scrape");
ffmpeg.setFfmpegPath(ffmpegPath);
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const todoist = new TodoistApi(process.env.TODOIST_TOKEN);
const redis = new Redis(process.env.REDIS_URL);
const ALLOWED_USER = process.env.ALLOWED_USER_ID;
const docContexts = {};
async function getHistory(chatId) {
  const data = await redis.get("history:" + chatId);
  return data ? JSON.parse(data) : [];
}
async function saveHistory(chatId, messages) {
  await redis.set("history:" + chatId, JSON.stringify(messages.slice(-30)));
}
async function getCorrections(chatId) {
  const data = await redis.get("corrections:" + chatId);
  return data ? JSON.parse(data) : [];
}
async function saveCorrection(chatId, correction) {
  const corrections = await getCorrections(chatId);
  corrections.push(correction);
  await redis.set("corrections:" + chatId, JSON.stringify(corrections.slice(-20)));
}
async function parsePDF(buffer) {
  const pdfParse = require("pdf-parse");
  const fn = typeof pdfParse === "function" ? pdfParse : pdfParse.default;
  return fn(buffer);
}
async function transcribeVoice(fileUrl) {
  const oggPath = "/tmp/voice.ogg";
  const mp3Path = "/tmp/voice.mp3";
  const response = await axios({ url: fileUrl, responseType: "stream" });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(oggPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
  await new Promise((resolve, reject) => {
    ffmpeg(oggPath).toFormat("mp3").save(mp3Path).on("end", resolve).on("error", reject);
  });
  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(mp3Path),
    model: "whisper-large-v3",
    language: "ru",
  });
  fs.unlinkSync(oggPath);
  fs.unlinkSync(mp3Path);
  return transcription.text;
}
async function parseTasks(text) {
  const now = new Date();
  const today = now.toLocaleDateString("ru-RU", {day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Samara"});
  const todayISO = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Samara"})).toISOString().split("T")[0];
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: `Сегодня ${today}, ISO: ${todayISO}. Извлеки ВСЕ задачи. Верни ТОЛЬКО JSON массив: [{"title": "...", "due_datetime": "YYYY-MM-DDTHH:MM:00"}]. Если время не указано используй "09:00". Если дата не указана используй сегодня. Если задач нет верни [].` },
      { role: "user", content: text }
    ],
  });
  const raw = response.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}
async function needsSearch(text) {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: 'Определи нужен ли поиск в интернете для ответа на вопрос. Верни ТОЛЬКО "yes" или "no". Поиск нужен для: новостей, текущих событий, цен, погоды, актуальной информации. Не нужен для: личных задач, общих знаний, математики.' },
      { role: "user", content: text }
    ],
  });
  return response.choices[0].message.content.trim().toLowerCase() === "yes";
}
async function searchWeb(query) {
  try {
    const results = await search(query, { locale: "ru-ru" });
    return results.results.slice(0, 3).map(r => `${r.title}: ${r.description}`).join("\n\n");
  } catch (err) {
    console.error("Search error:", err);
    return null;
  }
}
async function getTodayTasks() {
  return await todoist.getTasks({ filter: "today" });
}
async function handleText(ctx, text) {
  const chatId = ctx.chat.id;
  if (ALLOWED_USER && String(chatId) !== String(ALLOWED_USER)) {
    await ctx.reply("Нет доступа.");
    return;
  }
  if (/(неправильно|не так|ошибся|исправь|не верно|запомни что|ты не прав)/i.test(text)) {
    await saveCorrection(chatId, text);
    await ctx.reply("Запомнил, учту в следующий раз.");
    return;
  }
  if (/(покажи задачи|мои задачи|задачи на сегодня|что на сегодня)/i.test(text)) {
    try {
      const tasks = await getTodayTasks();
      if (tasks.length === 0) {
        await ctx.reply("На сегодня задач нет.");
      } else {
        const list = tasks.map((t, i) => `${i+1}. ${t.content}${t.due && t.due.datetime ? " — " + new Date(t.due.datetime).toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara"}) : ""}`).join("\n");
        await ctx.reply("📋 Задачи на сегодня:\n" + list);
      }
      return;
    } catch (err) { console.error(err); }
  }
  if (/(задач|запиши|добавь|создай|напомни|встрет|сделать|купить|позвонить|написать|отправить|забрать|съездить|зайти)/i.test(text)) {
    try {
      const tasks = await parseTasks(text);
      if (tasks.length > 0) {
        for (const task of tasks) {
          await todoist.addTask({ content: task.title, dueDatetime: task.due_datetime });
        }
        await ctx.reply("✅ " + tasks.map(t => t.title).join("\n"));
        return;
      }
    } catch (err) { console.error(err); }
  }
  const history = await getHistory(chatId);
  const corrections = await getCorrections(chatId);
  const messages = [...history];
  if (docContexts[chatId]) {
    messages.unshift({ role: "system", content: "Содержимое документа:\n\n" + docContexts[chatId] });
  }
  let searchContext = "";
  if (await needsSearch(text)) {
    const results = await searchWeb(text);
    if (results) searchContext = "\n\nДанные из интернета:\n" + results;
  }
  const now = new Date();
  const dateStr = now.toLocaleDateString("ru-RU", {day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Samara"}) + " " + now.toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara"});
  let systemPrompt = `Сейчас: ${dateStr}. Ты личный ассистент. Отвечай кратко и по делу. Без вступлений. Только суть. На русском языке.`;
  if (corrections.length > 0) {
    systemPrompt += "\n\nПоправки от пользователя:\n" + corrections.join("\n");
  }
  if (searchContext) systemPrompt += searchContext;
  messages.unshift({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: text });
  try {
    const response = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages });
    const reply = response.choices[0].message.content;
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: reply });
    await saveHistory(chatId, history);
    await ctx.reply(reply);
  } catch (err) {
    console.error(err);
    await ctx.reply("Ошибка, попробуй ещё раз.");
  }
}
bot.command("start", async (ctx) => {
  await ctx.reply(`👋 Привет! Я твой личный ассистент.

Что умею:
🎤 Голосовые — распознаю и выполняю
✅ Задачи — добавляю в Todoist
📋 /tasks — задачи на сегодня
🔍 Ищу информацию в интернете
📄 Читаю PDF и Word
🧠 Учусь на твоих поправках
💬 Отвечаю кратко и по делу

Команды:
/tasks — задачи на сегодня
/clear — очистить историю`);
});
bot.command("tasks", async (ctx) => {
  try {
    const tasks = await getTodayTasks();
    if (tasks.length === 0) {
      await ctx.reply("На сегодня задач нет.");
    } else {
      const list = tasks.map((t, i) => `${i+1}. ${t.content}${t.due && t.due.datetime ? " — " + new Date(t.due.datetime).toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara"}) : ""}`).join("\n");
      await ctx.reply("📋 Задачи на сегодня:\n" + list);
    }
  } catch (err) { ctx.reply("Ошибка при получении задач."); }
});
bot.command("clear", async (ctx) => {
  await redis.del("history:" + ctx.chat.id);
  await ctx.reply("История очищена.");
});
bot.on("text", async (ctx) => { await handleText(ctx, ctx.message.text); });
bot.on("voice", async (ctx) => {
  try {
    await ctx.reply("🎤...");
    const fileUrl = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const text = await transcribeVoice(fileUrl.href);
    await ctx.reply("📝 " + text);
    await handleText(ctx, text);
  } catch (err) { console.error(err); ctx.reply("Не удалось распознать голос."); }
});
bot.on("document", async (ctx) => {
  try {
    const doc = ctx.message.document;
    const fileUrl = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios({ url: fileUrl.href, responseType: "arraybuffer" });
    const buffer = Buffer.from(response.data);
    if (doc.mime_type === "application/pdf") {
      await ctx.reply("Читаю PDF...");
      const data = await parsePDF(buffer);
      docContexts[ctx.chat.id] = data.text.slice(0, 8000);
      await ctx.reply("✅ PDF загружен!");
    } else if (doc.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      await ctx.reply("Читаю Word...");
      const data = await mammoth.extractRawText({ buffer });
      docContexts[ctx.chat.id] = data.value.slice(0, 8000);
      await ctx.reply("✅ Word загружен!");
    } else {
      await ctx.reply("Поддерживаются только PDF и Word.");
    }
  } catch (err) { console.error(err); ctx.reply("Не удалось прочитать документ."); }
});
bot.launch();
console.log("Бот запущен...");
