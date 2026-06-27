require("dotenv").config();
const { Telegraf } = require("telegraf");
const Groq = require("groq-sdk");
const axios = require("axios");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { TodoistApi } = require("@doist/todoist-api-typescript");
ffmpeg.setFfmpegPath(ffmpegPath);
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const todoist = new TodoistApi(process.env.TODOIST_TOKEN);
const chats = {};
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
async function parseTask(text) {
  const today = new Date().toISOString().split("T")[0];
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `Сегодня ${today}. Извлеки задачу из сообщения и верни ТОЛЬКО JSON: {"title": "...", "due": "YYYY-MM-DD"}. Если дата не указана — не включай поле due. Если это не задача — верни {"error": "not a task"}.`
      },
      { role: "user", content: text }
    ],
  });
  const json = response.choices[0].message.content;
  return JSON.parse(json.replace(/```json|```/g, "").trim());
}
async function handleText(ctx, text) {
  const chatId = ctx.chat.id;
  if (!chats[chatId]) chats[chatId] = [];
  if (/(добавь задачу|создай задачу|напомни|задача)/i.test(text)) {
    try {
      const task = await parseTask(text);
      if (!task.error) {
        const taskData = { content: task.title };
        if (task.due) taskData.dueDate = task.due;
        await todoist.addTask(taskData);
        await ctx.reply("✅ Задача добавлена в Todoist: " + task.title);
        return;
      }
    } catch (err) {
      console.error(err);
    }
  }
  chats[chatId].push({ role: "user", content: text });
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: chats[chatId],
  });
  const reply = response.choices[0].message.content;
  chats[chatId].push({ role: "assistant", content: reply });
  if (chats[chatId].length > 20) chats[chatId] = chats[chatId].slice(-20);
  await ctx.reply(reply);
}
bot.on("text", async (ctx) => {
  await handleText(ctx, ctx.message.text);
});
bot.on("voice", async (ctx) => {
  try {
    await ctx.reply("Распознаю голос...");
    const fileId = ctx.message.voice.file_id;
    const fileUrl = await ctx.telegram.getFileLink(fileId);
    const text = await transcribeVoice(fileUrl.href);
    await ctx.reply("Распознано: " + text);
    await handleText(ctx, text);
  } catch (err) {
    console.error(err);
    ctx.reply("Не удалось распознать голос.");
  }
});
bot.launch();
console.log("Бот запущен...");
