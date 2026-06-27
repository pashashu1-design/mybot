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

// Вспомогательные функции
function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

async function getHistory(chatId) {
  try {
    const data = await redis.get("history:" + chatId);
    return data ? JSON.parse(data) : [];
  } catch { return []; }
}

async function saveHistory(chatId, messages) {
  try {
    await redis.set("history:" + chatId, JSON.stringify(messages.slice(-30)));
  } catch {}
}

async function getCorrections(chatId) {
  try {
    const data = await redis.get("corrections:" + chatId);
    return data ? JSON.parse(data) : [];
  } catch { return []; }
}

async function saveCorrection(chatId, text) {
  try {
    const corrections = await getCorrections(chatId);
    corrections.push(text);
    await redis.set("corrections:" + chatId, JSON.stringify(corrections.slice(-20)));
  } catch {}
}

async function parsePDF(buffer) {
  const pdfParse = require("pdf-parse");
  const fn = typeof pdfParse === "function" ? pdfParse : pdfParse.default;
  return fn(buffer);
}

async function transcribeVoice(fileUrl) {
  const oggPath = "/tmp/voice.ogg";
  const mp3Path = "/tmp/voice.mp3";
  const res = await axios({ url: fileUrl, responseType: "stream" });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(oggPath);
    res.data.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });
  await new Promise((resolve, reject) => {
    ffmpeg(oggPath).toFormat("mp3").save(mp3Path).on("end", resolve).on("error", reject);
  });
  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(mp3Path),
    model: "whisper-large-v3",
    language: "ru",
  });
  try { fs.unlinkSync(oggPath); fs.unlinkSync(mp3Path); } catch {}
  return transcription.text;
}

function formatTaskList(tasks) {
  tasks = toArray(tasks);
  if (tasks.length === 0) return "Задач нет.";
  return tasks.map((t, i) => {
    const priority = { 1: "🔴", 2: "🟠", 3: "🔵", 4: "⚪" }[t.priority] || "⚪";
    const time = t.due && t.due.datetime
      ? " — " + new Date(t.due.datetime).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara" })
      : "";
    return `${i + 1}. ${priority} ${t.content}${time}`;
  }).join("\n");
}

async function getTasks(filter) {
  return toArray(await todoist.getTasks({ filter }));
}

async function analyzeIntent(text, context) {
  const now = new Date();
  const todayISO = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Samara" })).toISOString().split("T")[0];
  const todayRU = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Samara" });

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `Сегодня ${todayRU}, ISO: ${todayISO}.
Доступные задачи: ${context.tasks.map((t, i) => `${i + 1}. ${t.content}`).join(", ") || "нет"}.
Проекты: ${context.projects.join(", ") || "нет"}.

Проанализируй сообщение и верни ТОЛЬКО JSON без пояснений:
{
  "action": "add_tasks|complete_tasks|delete_tasks|edit_task|show_today|show_tomorrow|show_overdue|show_urgent|show_all|show_projects|add_project|delete_project|show_labels|correction|chat",
  "task_nums": [список номеров задач или пустой массив],
  "new_title": "новое название или null",
  "new_datetime": "YYYY-MM-DDTHH:MM:00 или null",
  "project_name": "название проекта или null",
  "tasks_to_add": [{"title":"...","due_datetime":"YYYY-MM-DDTHH:MM:00","priority":4,"project_name":null,"labels":[],"description":null}]
}

priority: 1=срочно🔴 2=важно🟠 3=средне🔵 4=обычно⚪
Если пользователь называет задачи словами (первую, вторую...) или числами — включи их номера в task_nums.`
      },
      { role: "user", content: text }
    ],
  });

  const raw = res.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

async function askGroq(messages) {
  const res = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages });
  return res.choices[0].message.content;
}

async function searchWeb(query) {
  try {
    const results = await search(query, { locale: "ru-ru" });
    return toArray(results.results).slice(0, 3).map(r => `${r.title}: ${r.description}`).join("\n\n");
  } catch { return null; }
}

async function handleText(ctx, text) {
  const chatId = ctx.chat.id;

  if (ALLOWED_USER && String(chatId) !== String(ALLOWED_USER)) {
    await ctx.reply("Нет доступа.");
    return;
  }

  try {
    const [todayTasks, projects] = await Promise.all([
      getTasks("today"),
      toArray(await todoist.getProjects())
    ]);

    const intent = await analyzeIntent(text, {
      tasks: todayTasks,
      projects: projects.map(p => p.name)
    });

    switch (intent.action) {

      case "add_tasks":
        if (intent.tasks_to_add && intent.tasks_to_add.length > 0) {
          const added = [];
          for (const task of intent.tasks_to_add) {
            const data = {
              content: task.title,
              priority: task.priority || 4,
            };
            if (task.due_datetime) data.dueDatetime = task.due_datetime;
            if (task.description) data.description = task.description;
            if (task.labels && task.labels.length > 0) data.labels = task.labels;
            if (task.project_name) {
              const proj = projects.find(p => p.name.toLowerCase().includes(task.project_name.toLowerCase()));
              if (proj) data.projectId = proj.id;
            }
            await todoist.addTask(data);
            added.push(task.title);
          }
          await ctx.reply("✅ Добавлено:\n" + added.join("\n"));
        }
        break;

      case "complete_tasks":
        if (intent.task_nums && intent.task_nums.length > 0) {
          const done = [];
          for (const num of intent.task_nums) {
            const task = todayTasks[num - 1];
            if (task) {
              await todoist.closeTask(task.id);
              done.push(task.content);
            }
          }
          await ctx.reply(done.length > 0 ? "☑️ Выполнено:\n" + done.join("\n") : "Не нашёл задачи.");
        }
        break;

      case "delete_tasks":
        if (intent.task_nums && intent.task_nums.length > 0) {
          const deleted = [];
          for (const num of intent.task_nums) {
            const task = todayTasks[num - 1];
            if (task) {
              await todoist.deleteTask(task.id);
              deleted.push(task.content);
            }
          }
          await ctx.reply(deleted.length > 0 ? "🗑 Удалено:\n" + deleted.join("\n") : "Не нашёл задачи.");
        }
        break;

      case "edit_task":
        if (intent.task_nums && intent.task_nums[0]) {
          const task = todayTasks[intent.task_nums[0] - 1];
          if (task) {
            const data = {};
            if (intent.new_title) data.content = intent.new_title;
            if (intent.new_datetime) data.dueDatetime = intent.new_datetime;
            await todoist.updateTask(task.id, data);
            await ctx.reply("✏️ Изменено: " + (intent.new_title || task.content));
          } else {
            await ctx.reply("Не нашёл задачу.");
          }
        }
        break;

      case "show_today":
        await ctx.reply("📋 Сегодня:\n" + formatTaskList(todayTasks));
        break;

      case "show_tomorrow":
        await ctx.reply("📋 Завтра:\n" + formatTaskList(await getTasks("tomorrow")));
        break;

      case "show_overdue":
        await ctx.reply("⚠️ Просроченные:\n" + formatTaskList(await getTasks("overdue")));
        break;

      case "show_urgent":
        await ctx.reply("🔴 Срочные:\n" + formatTaskList(await getTasks("p1 | p2")));
        break;

      case "show_all":
        await ctx.reply("📋 Все задачи:\n" + formatTaskList(await getTasks("!completed")));
        break;

      case "show_projects":
        await ctx.reply("📁 Проекты:\n" + projects.map((p, i) => `${i + 1}. ${p.name}`).join("\n"));
        break;

      case "add_project":
        if (intent.project_name) {
          await todoist.addProject({ name: intent.project_name });
          await ctx.reply("📁 Проект создан: " + intent.project_name);
        }
        break;

      case "delete_project":
        if (intent.project_name) {
          const proj = projects.find(p => p.name.toLowerCase().includes(intent.project_name.toLowerCase()));
          if (proj) {
            await todoist.deleteProject(proj.id);
            await ctx.reply("🗑 Проект удалён: " + proj.name);
          } else {
            await ctx.reply("Проект не найден.");
          }
        }
        break;

      case "show_labels":
        const labels = toArray(await todoist.getLabels());
        await ctx.reply("🏷 Метки:\n" + (labels.length > 0 ? labels.map((l, i) => `${i + 1}. ${l.name}`).join("\n") : "Меток нет."));
        break;

      case "correction":
        await saveCorrection(chatId, text);
        await ctx.reply("Запомнил.");
        break;

      default:
        const history = await getHistory(chatId);
        const corrections = await getCorrections(chatId);
        const messages = [...history];
        if (docContexts[chatId]) {
          messages.unshift({ role: "system", content: "Документ:\n\n" + docContexts[chatId] });
        }

        const needsWeb = /(новост|погод|курс|цен|сейчас в мире|последн)/i.test(text);
        let searchContext = "";
        if (needsWeb) {
          const results = await searchWeb(text);
          if (results) searchContext = "\n\nИз интернета:\n" + results;
        }

        const now = new Date();
        const dateStr = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Samara" })
          + " " + now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara" });

        let systemPrompt = `Сейчас: ${dateStr}. Ты личный ассистент. Отвечай кратко и по делу. Без вступлений. Только суть. На русском языке.`;
        if (corrections.length > 0) systemPrompt += "\n\nПоправки от пользователя:\n" + corrections.join("\n");
        if (searchContext) systemPrompt += searchContext;

        messages.unshift({ role: "system", content: systemPrompt });
        messages.push({ role: "user", content: text });

        const reply = await askGroq(messages);
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        await saveHistory(chatId, history);
        await ctx.reply(reply);
    }
  } catch (err) {
    console.error(err);
    await ctx.reply("Ошибка: " + err.message);
  }
}

// Команды
bot.command("start", async (ctx) => {
  await ctx.reply(`👋 Привет! Я твой личный ассистент.

📋 Задачи:
- Добавить одну или несколько
- Удалить одну или несколько
- Отметить выполненными
- Изменить название или время
- Приоритеты: 🔴срочно 🟠важно 🔵средне ⚪обычно

📁 Проекты: создать, удалить, просмотреть
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

bot.command("tasks", async (ctx) => {
  const t = await getTasks("today");
  await ctx.reply("📋 Сегодня:\n" + formatTaskList(t));
});
bot.command("tomorrow", async (ctx) => {
  const t = await getTasks("tomorrow");
  await ctx.reply("📋 Завтра:\n" + formatTaskList(t));
});
bot.command("overdue", async (ctx) => {
  const t = await getTasks("overdue");
  await ctx.reply("⚠️ Просроченные:\n" + formatTaskList(t));
});
bot.command("urgent", async (ctx) => {
  const t = await getTasks("p1 | p2");
  await ctx.reply("🔴 Срочные:\n" + formatTaskList(t));
});
bot.command("projects", async (ctx) => {
  const p = toArray(await todoist.getProjects());
  await ctx.reply("📁 Проекты:\n" + p.map((p, i) => `${i + 1}. ${p.name}`).join("\n"));
});
bot.command("labels", async (ctx) => {
  const l = toArray(await todoist.getLabels());
  await ctx.reply("🏷 Метки:\n" + (l.length > 0 ? l.map((l, i) => `${i + 1}. ${l.name}`).join("\n") : "Меток нет."));
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
  } catch (err) {
    console.error(err);
    ctx.reply("Не удалось распознать голос.");
  }
});

bot.on("document", async (ctx) => {
  try {
    const doc = ctx.message.document;
    const fileUrl = await ctx.telegram.getFileLink(doc.file_id);
    const res = await axios({ url: fileUrl.href, responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);
    if (doc.mime_type === "application/pdf") {
      await ctx.reply("Читаю PDF...");
      const data = await parsePDF(buffer);
      docContexts[chatId] = data.text.slice(0, 8000);
      await ctx.reply("✅ PDF загружен! Задавай вопросы.");
    } else if (doc.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      await ctx.reply("Читаю Word...");
      const data = await mammoth.extractRawText({ buffer });
      docContexts[ctx.chat.id] = data.value.slice(0, 8000);
      await ctx.reply("✅ Word загружен! Задавай вопросы.");
    } else {
      await ctx.reply("Поддерживаются только PDF и Word.");
    }
  } catch (err) {
    console.error(err);
    ctx.reply("Не удалось прочитать документ.");
  }
});

bot.launch();
console.log("Бот запущен...");
