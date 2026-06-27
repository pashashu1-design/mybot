require("dotenv").config();
const { Telegraf } = require("telegraf");
const Groq = require("groq-sdk");
const axios = require("axios");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
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
async function handleText(ctx, text) {
  const chatId = ctx.chat.id;
  if (!chats[chatId]) chats[chatId] = [];
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
