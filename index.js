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
async function analyzeIntent(text, context) {
  const now = new Date();
  const today = now.toLocaleDateString("ru-RU", {day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Samara"});
  const todayISO = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Samara"})).toISOString().split("T")[0];
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: `Сегодня ${today}, ISO: ${todayISO}. Контекст: ${JSON.stringify(context)}. Проанализируй сообщение и верни ТОЛЬКО JSON:
{
  "action": "add_task|complete_task|delete_task|edit_task|show_tasks|show_tomorrow|show_overdue|show_urgent|show_projects|add_project|delete_project|add_subtask|show_labels|search_web|correction|chat",
  "tasks": [{"title": "...", "due_datetime": "YYYY-MM-DDTHH:MM:00", "priority": 1-4, "project_name": "название или null", "labels": ["метка1"], "description": "описание или null"}],
  "task_num": номер_задачи_или_null,
  "new_title": "новое_название_или_null",
  "new_datetime": "YYYY-MM-DDTHH:MM:00_или_null",
  "project_name": "название_проекта_или_null",
  "search_query": "запрос_или_null"
}` },
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
      { role: "system", content: 'Нужен ли поиск в интернете? Верни ТОЛЬКО "yes" или "no".' },
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
  try {
    const todayTasks = await todoist.getTasks({ filter: "today" });
    const projects = await todoist.getProjects();
    const labels = await todoist.getLabels();
    const context = {
      today_tasks: todayTasks.map((t, i) => `${i+1}. ${t.content}`),
      projects: projects.map(p => p.name),
      labels: labels.map(l => l.name)
    };
    const intent = await analyzeIntent(text, context);
    switch (intent.action) {
      case "add_task":
        if (intent.tasks && intent.tasks.length > 0) {
          const added = [];
          for (const task of intent.tasks) {
            const taskData = { content: task.title, priority: task.priority || 4 };
            if (task.due_datetime) taskData.dueDatetime = task.due_datetime;
            if (task.description) taskData.description = task.description;
            if (task.labels && task.labels.length > 0) taskData.labels = task.labels;
            if (task.project_name) {
              const proj = projects.find(p => p.name.toLowerCase() === task.project_name.toLowerCase());
              if (proj) taskData.projectId = proj.id;
            }
            await todoist.addTask(taskData);
            added.push(task.title);
          }
          await ctx.reply("✅ Добавлено:\n" + added.join("\n"));
        }
        break;
      case "complete_task":
        if (intent.task_num && todayTasks[intent.task_num - 1]) {
          await todoist.closeTask(todayTasks[intent.task_num - 1].id);
          await ctx.reply("☑️ Выполнено: " + todayTasks[intent.task_num - 1].content);
        } else { await ctx.reply("Не нашёл задачу."); }
        break;
      case "delete_task":
        if (intent.task_num && todayTasks[intent.task_num - 1]) {
          await todoist.deleteTask(todayTasks[intent.task_num - 1].id);
          await ctx.reply("🗑 Удалено: " + todayTasks[intent.task_num - 1].content);
        } else { await ctx.reply("Не нашёл задачу."); }
        break;
      case "edit_task":
        if (intent.task_num && todayTasks[intent.task_num - 1]) {
          const updateData = {};
          if (intent.new_title) updateData.content = intent.new_title;
          if (intent.new_datetime) updateData.dueDatetime = intent.new_datetime;
          await todoist.updateTask(todayTasks[intent.task_num - 1].id, updateData);
          await ctx.reply("✏️ Изменено: " + (intent.new_title || todayTasks[intent.task_num - 1].content));
        } else { await ctx.reply("Не нашёл задачу."); }
        break;
      case "show_tasks":
        await ctx.reply("📋 Сегодня:\n" + formatTaskList(todayTasks));
        break;
      case "show_tomorrow":
        const tomorrowTasks = await todoist.getTasks({ filter: "tomorrow" });
        await ctx.reply("📋 Завтра:\n" + formatTaskList(tomorrowTasks));
        break;
      case "show_overdue":
        const overdueTasks = await todoist.getTasks({ filter: "overdue" });
        await ctx.reply("⚠️ Просроченные:\n" + formatTaskList(overdueTasks));
        break;
      case "show_urgent":
        const urgentTasks = await todoist.getTasks({ filter: "p1 | p2" });
        await ctx.reply("🔴 Срочные и важные:\n" + formatTaskList(urgentTasks));
        break;
      case "show_projects":
        const projList = projects.map((p, i) => `${i+1}. 📁 ${p.name}`).join("\n");
        await ctx.reply("📁 Проекты:\n" + projList);
        break;
      case "add_project":
        if (intent.project_name) {
          await todoist.addProject({ name: intent.project_name });
          await ctx.reply("📁 Проект создан: " + intent.project_name);
        }
        break;
      case "delete_project":
        if (intent.project_name) {
          const proj = projects.find(p => p.name.toLowerCase() === intent.project_name.toLowerCase());
          if (proj) {
            await todoist.deleteProject(proj.id);
            await ctx.reply("🗑 Проект удалён: " + intent.project_name);
          } else { await ctx.reply("Проект не найден."); }
        }
        break;
      case "show_labels":
        const labelList = labels.map((l, i) => `${i+1}. 🏷 ${l.name}`).join("\n");
        await ctx.reply("🏷 Метки:\n" + (labelList || "Меток нет."));
        break;
      case "correction":
        await saveCorrection(chatId, text);
        await ctx.reply("Запомнил.");
        break;
      default:
        const history = await getHistory(chatId);
        const corrections = await getCorrections(chatId);
        const messages = [...history];
        if (docContexts[chatId]) messages.unshift({ role: "system", content: "Документ:\n\n" + docContexts[chatId] });
        let searchContext = "";
        if (await needsSearch(text)) {
          const results = await searchWeb(text);
          if (results) searchContext = "\n\nИз интернета:\n" + results;
        }
        const now = new Date();
        const dateStr = now.toLocaleDateString("ru-RU", {day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Samara"}) + " " + now.toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara"});
        let systemPrompt = `Сейчас: ${dateStr}. Ты личный ассистент. Отвечай кратко. Только суть. На русском языке.`;
        if (corrections.length > 0) systemPrompt += "\n\nПоправки:\n" + corrections.join("\n");
        if (searchContext) systemPrompt += searchContext;
        messages.unshift({ role: "system", content: systemPrompt });
        messages.push({ role: "user", content: text });
        const response = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages });
        const reply = response.choices[0].message.content;
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        await saveHistory(chatId, history);
        await ctx.reply(reply);
    }
  } catch (err) {
    console.error(err);
    await ctx.reply("Ошибка, попробуй ещё раз.");
  }
}
bot.command("start", async (ctx) => {
  await ctx.reply(`👋 Привет! Я твой личный ассистент.

📋 Задачи:
- Добавить, удалить, изменить, выполнить
- Указать проект, метку, приоритет
- Просмотр на сегодня, завтра, просроченные

📁 Проекты: создать, удалить, просмотреть
🏷 Метки: просмотреть
🎤 Голосовые сообщения
🔍 Поиск в интернете
📄 PDF и Word документы
🧠 Запоминаю поправки

Команды:
/tasks — сегодня
/tomorrow — завтра
/overdue — просроченные
/urgent — срочные
/projects — проекты
/labels — метки
/clear — очистить историю`);
});
bot.command("tasks", async (ctx) => { const t = await todoist.getTasks({ filter: "today" }); await ctx.reply("📋 Сегодня:\n" + formatTaskList(t)); });
bot.command("tomorrow", async (ctx) => { const t = await todoist.getTasks({ filter: "tomorrow" }); await ctx.reply("📋 Завтра:\n" + formatTaskList(t)); });
bot.command("overdue", async (ctx) => { const t = await todoist.getTasks({ filter: "overdue" }); await ctx.reply("⚠️ Просроченные:\n" + formatTaskList(t)); });
bot.command("urgent", async (ctx) => { const t = await todoist.getTasks({ filter: "p1 | p2" }); await ctx.reply("🔴 Срочные:\n" + formatTaskList(t)); });
bot.command("projects", async (ctx) => { const p = await todoist.getProjects(); await ctx.reply("📁 Проекты:\n" + p.map((p,i) => `${i+1}. ${p.name}`).join("\n")); });
bot.command("labels", async (ctx) => { const l = await todoist.getLabels(); await ctx.reply("🏷 Метки:\n" + (l.map((l,i) => `${i+1}. ${l.name}`).join("\n") || "Меток нет.")); });
bot.command("clear", async (ctx) => { await redis.del("history:" + ctx.chat.id); await ctx.reply("История очищена."); });
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
