require("dotenv").config();
const { Telegraf } = require("telegraf");
const Groq = require("groq-sdk");
const axios = require("axios");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { TodoistApi } = require("@doist/todoist-api-typescript");
const mammoth = require("mammoth");
ffmpeg.setFfmpegPath(ffmpegPath);
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const todoist = new TodoistApi(process.env.TODOIST_TOKEN);
const chats = {};
const docContexts = {};
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
  const today = new Date().toISOString().split("T")[0];
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: `Сегодня ${today}. Извлеки ВСЕ задачи из сообщения и верни ТОЛЬКО JSON массив: [{"title": "...", "due": "YYYY-MM-DD"}]. Если дата не указана не включай поле due. Если задач нет верни [].` },
      { role: "user", content: text }
    ],
  });
  const raw = response.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}
async function handleText(ctx, text) {
  const chatId = ctx.chat.id;
  if (!chats[chatId]) chats[chatId] = [];
  if (/(задач|запиши|добавь|создай|напомни|встрет|сделать|купить|позвонить|написать|отправить)/i.test(text)) {
    try {
      const tasks = await parseTasks(text);
      if (tasks.length > 0) {
        for (const task of tasks) {
          const taskData = { content: task.title };
          if (task.due) taskData.dueDate = task.due;
          await todoist.addTask(taskData);
        }
        await ctx.reply("✅ Добавлено задач в Todoist: " + tasks.length);
        return;
      }
    } catch (err) { console.error(err); }
  }
  const messages = [...chats[chatId]];
  if (docContexts[chatId]) {
    messages.unshift({ role: "system", content: "Вот содержимое документа пользователя:\n\n" + docContexts[chatId] });
  }
  const now = new Date();
  const dateStr = now.toLocaleDateString("ru-RU", {day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Samara"}) + " " + now.toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara"});
  messages.unshift({ role: "system", content: "Сейчас: " + dateStr + ". Отвечай на русском языке." });
  messages.push({ role: "user", content: text });
  const response = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages });
  const reply = response.choices[0].message.content;
  chats[chatId].push({ role: "user", content: text });
  chats[chatId].push({ role: "assistant", content: reply });
  if (chats[chatId].length > 20) chats[chatId] = chats[chatId].slice(-20);
  await ctx.reply(reply);
}
bot.on("text", async (ctx) => { await handleText(ctx, ctx.message.text); });
bot.on("voice", async (ctx) => {
  try {
    await ctx.reply("Распознаю голос...");
    const fileUrl = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const text = await transcribeVoice(fileUrl.href);
    await ctx.reply("Распознано: " + text);
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
      await ctx.reply("✅ PDF загружен! Задавай вопросы по документу.");
    } else if (doc.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      await ctx.reply("Читаю Word документ...");
      const data = await mammoth.extractRawText({ buffer });
      docContexts[ctx.chat.id] = data.value.slice(0, 8000);
      await ctx.reply("✅ Word документ загружен! Задавай вопросы по документу.");
    } else {
      await ctx.reply("Поддерживаются только PDF и Word (.docx) файлы.");
    }
  } catch (err) { console.error(err); ctx.reply("Не удалось прочитать документ."); }
});
bot.launch();
console.log("Бот запущен...");
