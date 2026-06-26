require("dotenv").config();
const { Telegraf } = require("telegraf");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const chats = {};

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  if (!chats[chatId]) {
    chats[chatId] = model.startChat();
  }

  try {
    const result = await chats[chatId].sendMessage(text);
    const reply = result.response.text();
    await ctx.reply(reply);
  } catch (err) {
    console.error(err);
    ctx.reply("Ошибка, попробуй ещё раз.");
  }
});

bot.launch();
console.log("Бот запущен...");
