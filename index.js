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
      { role: "system", content: `Сегодня ${today}, ISO: ${todayISO}. Извлеки ВСЕ задачи. Верни ТОЛЬКО JSON массив: [{"title": "...", "due_datetime": "YYYY-MM-DDTHH:MM:00", "priority": 1-4}]. priority: 4=обычная, 3=средняя, 2=высокая, 1=срочная. Если время не указано используй "09:00". Если дата не указана используй сегодня. Если задач нет верни [].` },
      { role: "user", content: text }
    ],
  });
  const raw = response.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}
async function parseTaskAction(text, tasks) {
  const list = tasks.map((t, i) => `${i+1}. ${t.content}`).join(", ");
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: `Из списка задач найди нужную и верни ТОЛЬКО JSON: {"num": номер, "new_title": "новое название или null", "new_datetime": "YYYY-MM-DDTHH:MM:00 или null"}. Список: ${list}` },
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
      { role: "system", content: 'Нужен ли поиск в интернете? Верни ТОЛЬКО "yes" или "no". yes: новости, события, цены, погода, актуальные данные. no: личные задачи, математика, общие знания.' },
      { role: "user", content: text }
    ],
  });
  return response.choices[0].message.content.trim().toLowerCase() === "yes";
}
async function searchWeb(query) {
  try {
    const results = await search(query, { locale: "ru-ru" });
    return results.results.slice(0, 3).map(r => `${r.title}: ${r.description}`).join("\n\n");
  } catch (err) { return null; }
}
async function getFilteredTasks(filter) {
  return await todoist.getTasks({ filter });
}
function formatTaskList(tasks) {
  if (tasks.length === 0) return "Задач нет.";
  return tasks.map((t, i) => {
    const priority = ["", "🔴", "🟠", "🔵", "⚪"][t.priority] || "⚪";
    const time = t.due && t.due.datetime ? " — " + new Date(t.due.datetime).toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara"}) : "";
    return `${i+1}. ${priority} ${t.content}${time}`;
  }).join("\n");
}
async function handleText(ctx, text) {
  const chatId = ctx.chat.id;
  if (ALLOWED_USER && String(chatId) !== String(ALLOWED_USER)) {
    await ctx.reply("Нет доступа.");
    return;
  }
  if (/(неправильно|не так|ошибся|исправь|не верно|запомни что|ты не прав)/i.test(text)) {
    await saveCorrection(chatId, text);
    await ctx.reply("Запомнил.");
    return;
  }
  if (/(выполнено|сделано|завершено|готово|выполнил|сделал)/i.test(text)) {
    try {
      const tasks = await getFilteredTasks("today");
      if (tasks.length === 0) { await ctx.reply("Нет задач на сегодня."); return; }
      const action = await parseTaskAction(text, tasks);
      if (action.num > 0 && tasks[action.num - 1]) {
        await todoist.closeTask(tasks[action.num - 1].id);
        await ctx.reply("✅ Выполнено: " + tasks[action.num - 1].content);
      } else { await ctx.reply("Не нашёл такую задачу."); }
      return;
    } catch (err) { console.error(err); }
  }
  if (/(удали|удалить|убери|убрать задачу)/i.test(text)) {
    try {
      const tasks = await getFilteredTasks("today");
      if (tasks.length === 0) { await ctx.reply("Нет задач на сегодня."); return; }
      const action = await parseTaskAction(text, tasks);
      if (action.num > 0 && tasks[action.num - 1]) {
        await todoist.deleteTask(tasks[action.num - 1].id);
        await ctx.reply("🗑 Удалено: " + tasks[action.num - 1].content);
      } else { await ctx.reply("Не нашёл такую задачу."); }
      return;
    } catch (err) { console.error(err); }
  }
  if (/(измени|перенеси|переименуй|измените время)/i.test(text)) {
    try {
      const tasks = await getFilteredTasks("today");
      if (tasks.length === 0) { await ctx.reply("Нет задач на сегодня."); return; }
      const action = await parseTaskAction(text, tasks);
      if (action.num > 0 && tasks[action.num - 1]) {
        const updateData = {};
        if (action.new_title) updateData.content = action.new_title;
        if (action.new_datetime) updateData.dueDatetime = action.new_datetime;
        await todoist.updateTask(tasks[action.num - 1].id, updateData);
        await ctx.reply("✏️ Изменено: " + (action.new_title || tasks[action.num - 1].content));
      } else { await ctx.reply("Не нашёл такую задачу."); }
      return;
    } catch (err) { console.error(err); }
  }
  if (/(просроченные|просрочен|опоздал)/i.test(text)) {
    try {
      const tasks = await getFilteredTasks("overdue");
      await ctx.reply("⚠️ Просроченные задачи:\n" + formatTaskList(tasks));
      return;
    } catch (err) { console.error(err); }
  }
  if (/(завтра|задачи на завтра)/i.test(text)) {
    try {
      const tasks = await getFilteredTasks("tomorrow");
      await ctx.reply("📋 Задачи на завтра:\n" + formatTaskList(tasks));
      return;
    } catch (err) { console.error(err); }
  }
  if (/(покажи задачи|мои задачи|задачи на сегодня|что на сегодня)/i.test(text)) {
    try {
      const tasks = await getFilteredTasks("today");
      await ctx.reply("📋 Сегодня:\n" + formatTaskList(tasks));
      return;
    } catch (err) { console.error(err); }
  }
  if (/(срочн|важн|приоритет)/i.test(text)) {
    try {
      const tasks = await getFilteredTasks("p1 | p2");
      await ctx.reply("🔴 Срочные и важные:\n" + formatTaskList(tasks));
      return;
    } catch (err) { console.error(err); }
  }
  if (/(задач|запиши|добавь|создай|напомни|встрет|сделать|купить|позвонить|написать|отправить|забрать|съездить|зайти)/i.test(text)) {
    try {
      const tasks = await parseTasks(text);
      if (tasks.length > 0) {
        for (const task of tasks) {
          await todoist.addTask({ content: task.title, dueDatetime: task.due_datetime, priority: task.priority || 4 });
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
  if (corrections.length > 0) systemPrompt += "\n\nПоправки от пользователя:\n" + corrections.join("\n");
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
✅ Задачи — добавляю в Todoist с приоритетом
📋 Просмотр задач на сегодня и завтра
⚠️ Просроченные задачи
✏️ Редактирование и удаление задач
☑️ Отметка задач выполненными
🔴 Срочные и важные задачи
🔍 Поиск в интернете
📄 Читаю PDF и Word
🧠 Учусь на твоих поправках

Команды:
/tasks — задачи на сегодня
/tomorrow — задачи на завтра
/overdue — просроченные
/urgent — срочные и важные
/clear — очистить историю`);
});
bot.command("tasks", async (ctx) => {
  const tasks = await getFilteredTasks("today");
  await ctx.reply("📋 Сегодня:\n" + formatTaskList(tasks));
});
bot.command("tomorrow", async (ctx) => {
  const tasks = await getFilteredTasks("tomorrow");
  await ctx.reply("📋 Завтра:\n" + formatTaskList(tasks));
});
bot.command("overdue", async (ctx) => {
  const tasks = await getFilteredTasks("overdue");
  await ctx.reply("⚠️ Просроченные:\n" + formatTaskList(tasks));
});
bot.command("urgent", async (ctx) => {
  const tasks = await getFilteredTasks("p1 | p2");
  await ctx.reply("🔴 Срочные и важные:\n" + formatTaskList(tasks));
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
