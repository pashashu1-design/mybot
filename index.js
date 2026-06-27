require("dotenv").config();
const { Telegraf } = require("telegraf");
const Groq = require("groq-sdk");

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const chats = {};

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  if (!chats[chatId]) {
    chats[chatId] = [];
  }

  chats[chatId].push({ role: "user", content: text });

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: chats[chatId],
    });

    const reply = response.choices[0].message.content;
    chats[chatId].push({ role: "assistant", content: reply });

    if (chats[chatId].length > 20) {
      chats[chatId] = chats[chatId].slice(-20);
    }

    await ctx.reply(reply);
  } catch (err) {
    console.error(err);
    ctx.reply("Ошибка, попробуй ещё раз.");
  }
});

bot.launch();
console.log("Бот запущен...");
