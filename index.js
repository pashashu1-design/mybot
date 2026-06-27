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
const cron = require("node-cron");
const pdfParse = require("pdf-parse");

ffmpeg.setFfmpegPath(ffmpegPath);

// ============ Конфигурация ============
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const todoist = new TodoistApi(process.env.TODOIST_TOKEN);
const redis = new Redis(process.env.REDIS_URL);
const ALLOWED_USER = process.env.ALLOWED_USER_ID;
const MAX_DOC_SIZE = 20 * 1024 * 1024; // 20 МБ
const HISTORY_TTL = 604800; // 7 дней
const LESSONS_LIMIT = 20; // хранить последние 20 уроков на чат

// ============ Middleware проверки доступа ============
bot.use(async (ctx, next) => {
  if (ALLOWED_USER && String(ctx.chat?.id) !== String(ALLOWED_USER)) {
    return ctx.reply("⛔ Нет доступа.");
  }
  await next();
});

// ============ Вспомогательные функции ============
function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

function getNow() {
  const now = new Date();
  return now.toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric", weekday: "long",
    timeZone: "Europe/Samara"
  }) + ", " + now.toLocaleTimeString("ru-RU", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara"
  });
}

function getDateISO(offsetDays) {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Samara" }));
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

function formatTaskList(tasks) {
  tasks = toArray(tasks);
  if (tasks.length === 0) return "Задач нет.";
  const priority = { 1: "🔴", 2: "🟠", 3: "🔵", 4: "⚪" };
  return tasks.map((t, i) => {
    const p = priority[t.priority] || "⚪";
    const time = t.due?.datetime
      ? " — " + new Date(t.due.datetime).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara" })
      : "";
    return (i + 1) + ". " + p + " " + t.content + time;
  }).join("\n");
}

function taskMatchesDate(task, dateISO) {
  if (!task.due) return false;
  const taskDate = task.due.date || (task.due.datetime?.substring(0, 10));
  return taskDate === dateISO;
}

// ============ Кэш задач (5 секунд) ============
let tasksCache = { data: [], timestamp: 0 };
async function getAllTasks() {
  if (Date.now() - tasksCache.timestamp < 5000) return tasksCache.data;
  const tasks = toArray(await todoist.getTasks());
  tasksCache = { data: tasks, timestamp: Date.now() };
  return tasks;
}

// ============ Работа с историей и уроками ============
async function getHistory(chatId) {
  try {
    const d = await redis.get("history:" + chatId);
    return d ? JSON.parse(d) : [];
  } catch { return []; }
}

async function saveHistory(chatId, messages) {
  try {
    await redis.set("history:" + chatId, JSON.stringify(messages.slice(-20)), "EX", HISTORY_TTL);
  } catch {}
}

async function getLessons(chatId) {
  try {
    const lessons = await redis.lrange("lessons:" + chatId, 0, LESSONS_LIMIT - 1);
    return lessons;
  } catch { return []; }
}

async function addLesson(chatId, badQuery, badResponse, correction) {
  try {
    const entry = `Запрос: "${badQuery}" → Ошибка: "${badResponse}" → Исправлено: "${correction}"`;
    await redis.lpush("lessons:" + chatId, entry);
    await redis.ltrim("lessons:" + chatId, 0, LESSONS_LIMIT - 1);
  } catch {}
}

// ============ Оценка качества ответов ============
const pendingFeedback = {}; // chatId -> { query, response, timestamp }

async function evaluateResponse(chatId, userMessage, botResponse) {
  pendingFeedback[chatId] = {
    query: userMessage,
    response: botResponse,
    timestamp: Date.now()
  };
  // Через 2 минуты проверим, не было ли исправления
  setTimeout(async () => {
    const entry = pendingFeedback[chatId];
    if (!entry) return;
    // Если за это время не было нового сообщения, считаем ответ хорошим
    // (запись удалится при следующем запросе или по таймауту)
    // Но мы не знаем, было ли новое сообщение. Можно сохранить как положительный фидбек.
    // Для простоты: если не было исправления - считаем нормой.
    delete pendingFeedback[chatId];
  }, 120000);
}

// ============ Распознавание голоса ============
async function transcribeVoice(fileUrl) {
  const uniqueId = Date.now() + "_" + Math.random().toString(36).slice(2);
  const oggPath = `/tmp/voice_${uniqueId}.ogg`;
  const mp3Path = `/tmp/voice_${uniqueId}.mp3`;
  try {
    const res = await axios({ url: fileUrl, responseType: "stream" });
    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(oggPath);
      res.data.pipe(w);
      w.on("finish", resolve);
      w.on("error", reject);
    });
    await new Promise((resolve, reject) => {
      ffmpeg(oggPath).toFormat("mp3").save(mp3Path)
        .on("end", resolve).on("error", reject);
    });
    const result = await groq.audio.transcriptions.create({
      file: fs.createReadStream(mp3Path),
      model: "whisper-large-v3",
      language: "ru",
    });
    return result.text;
  } finally {
    try { fs.unlinkSync(oggPath); } catch {}
    try { fs.unlinkSync(mp3Path); } catch {}
  }
}

// ============ Анализ намерений с уроками ============
async function analyzeIntent(text, tasks, projects, chatId) {
  const lessons = await getLessons(chatId);
  const lessonText = lessons.length ? "\n\nИсправь свои прошлые ошибки:\n" + lessons.join("\n") : "";

  const taskList = tasks.map((t, i) =>
    (i + 1) + ". " + t.content + (t.due?.date || t.due?.datetime ? " (" + (t.due.date || t.due.datetime) + ")" : "")
  ).join("\n");

  const projList = projects.map(p => p.name).join(", ");

  const system = `Сейчас: ${getNow()}.
Задачи в Todoist:
${taskList || "нет"}

Проекты: ${projList || "нет"}

Проанализируй сообщение. Верни ТОЛЬКО JSON без лишних слов:
{
  "action": "add|complete|delete|edit|show_today|show_tomorrow|show_overdue|show_urgent|show_all|show_projects|add_project|delete_project|chat",
  "task_ids": [],          // ID задач (для complete/delete/edit)
  "new_title": null,
  "new_datetime": null,    // формат YYYY-MM-DDTHH:MM:00
  "project_name": null,
  "tasks_to_add": [{"title": "", "datetime": null, "priority": 4, "project": null}]
}
priority: 1=срочно 2=важно 3=средне 4=обычно
task_ids — бери из списка выше, где перед названием стоит номер, но возвращай реальный ID задачи (не номер).
Если действие относится к задаче, укажи её ID (в списке я дал номера, но ты должен вернуть сам ID, как он записан в системе — я не показал ID, так что возвращай номер, а я преобразую в ID).` + lessonText;

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: system },
      { role: "user", content: text }
    ],
  });

  const raw = res.choices[0].message.content.replace(/```json|```/g, "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { action: "chat", task_ids: [], tasks_to_add: [] };
  try {
    const parsed = JSON.parse(match[0]);
    // Преобразуем номера в ID, если пришли номера
    if (parsed.task_ids && parsed.task_ids.length) {
      parsed.task_ids = parsed.task_ids.map(num => {
        const idx = parseInt(num) - 1;
        return tasks[idx]?.id || num;
      });
    }
    return parsed;
  } catch { return { action: "chat", task_ids: [], tasks_to_add: [] }; }
}

// ============ Основной обработчик текста ============
async function handleText(ctx, text) {
  const chatId = ctx.chat.id;

  // Проверяем, не является ли сообщение исправлением предыдущего ответа
  const feedback = pendingFeedback[chatId];
  if (feedback && (text.match(/^(нет|не так|исправь|неправильно|ошибка)/i) || text.includes(feedback.query))) {
    // Сохраняем урок
    await addLesson(chatId, feedback.query, feedback.response, text);
    delete pendingFeedback[chatId];
    // Продолжаем обработку как обычный запрос
  }

  try {
    const allTasks = await getAllTasks();
    const projects = toArray(await todoist.getProjects());
    const intent = await analyzeIntent(text, allTasks, projects, chatId);

    let reply = "";

    switch (intent.action) {
      case "add": {
        if (intent.tasks_to_add?.length) {
          const added = [];
          for (const t of intent.tasks_to_add) {
            const data = { content: t.title, priority: t.priority || 4 };
            if (t.datetime) data.dueDatetime = t.datetime;
            if (t.project) {
              const proj = projects.find(p => p.name.toLowerCase() === t.project.toLowerCase());
              if (proj) data.projectId = proj.id;
            }
            await todoist.addTask(data);
            added.push(t.title);
          }
          reply = "✅ Добавлено:\n" + added.join("\n");
        }
        break;
      }
      case "complete": {
        if (intent.task_ids?.length) {
          const done = [];
          for (const id of intent.task_ids) {
            const task = allTasks.find(t => t.id === id);
            if (task) { await todoist.closeTask(id); done.push(task.content); }
          }
          reply = done.length ? "✅ Выполнено:\n" + done.join("\n") : "❌ Задачи не найдены.";
        }
        break;
      }
      case "delete": {
        if (intent.task_ids?.length) {
          const toDelete = intent.task_ids.map(id => allTasks.find(t => t.id === id)).filter(Boolean);
          if (toDelete.length) {
            pendingDeletes[chatId] = toDelete.map(t => t.id);
            const names = toDelete.map(t => t.content).join("\n");
            await ctx.reply("🗑 Удалить эти задачи?\n" + names, {
              reply_markup: {
                inline_keyboard: [[
                  { text: "Да, удалить", callback_data: "confirm_delete" },
                  { text: "Отмена", callback_data: "cancel_delete" }
                ]]
              }
            });
            return;
          } else reply = "❌ Задачи не найдены.";
        }
        break;
      }
      case "edit": {
        if (intent.task_ids?.length) {
          const task = allTasks.find(t => t.id === intent.task_ids[0]);
          if (task) {
            const data = {};
            if (intent.new_title) data.content = intent.new_title;
            if (intent.new_datetime) data.dueDatetime = intent.new_datetime;
            await todoist.updateTask(task.id, data);
            reply = "✏️ Изменено: " + (intent.new_title || task.content);
          } else reply = "❌ Задача не найдена.";
        }
        break;
      }
      case "show_today": {
        const tasks = await getTodoistTasks("today");
        reply = getNow() + "\n\n📋 Задачи на сегодня:\n" + formatTaskList(tasks);
        break;
      }
      case "show_tomorrow": {
        const tasks = await getTodoistTasks("tomorrow");
        reply = "📅 Задачи на завтра:\n" + formatTaskList(tasks);
        break;
      }
      case "show_overdue": {
        const tasks = await getTodoistTasks("overdue");
        reply = "⚠️ Просроченные:\n" + formatTaskList(tasks);
        break;
      }
      case "show_urgent": {
        const tasks = await getTodoistTasks("p1 | p2");
        reply = "🔴 Срочные и важные:\n" + formatTaskList(tasks);
        break;
      }
      case "show_all": {
        const tasks = await getAllTasks();
        reply = "📋 Все задачи (" + tasks.length + "):\n" + formatTaskList(tasks);
        break;
      }
      case "show_projects": {
        const projList = projects.map((p, i) => {
          const count = allTasks.filter(t => t.projectId === p.id).length;
          return (i + 1) + ". " + p.name + " (" + count + " задач)";
        }).join("\n");
        reply = "📁 Проекты:\n" + projList;
        break;
      }
      case "add_project": {
        if (intent.project_name) {
          await todoist.addProject({ name: intent.project_name });
          reply = "✅ Проект создан: " + intent.project_name;
        }
        break;
      }
      case "delete_project": {
        if (intent.project_name) {
          const proj = projects.find(p => p.name.toLowerCase() === intent.project_name.toLowerCase());
          if (proj) {
            await todoist.deleteProject(proj.id);
            reply = "🗑 Проект удалён: " + proj.name;
          } else reply = "❌ Проект не найден.";
        }
        break;
      }
      default: {
        // Обычный чат
        const history = await getHistory(chatId);
        const messages = [...history];
        if (docContexts[chatId]) {
          messages.unshift({ role: "system", content: "Документ:\n\n" + docContexts[chatId] });
        }
        messages.unshift({
          role: "system",
          content: `Сейчас: ${getNow()}. Ты личный ассистент. Отвечай кратко, по делу, на русском языке.`
        });
        messages.push({ role: "user", content: text });
        const res = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages });
        reply = res.choices[0].message.content;

        // Сохраняем историю
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        await saveHistory(chatId, history);

        // Запоминаем для оценки
        await evaluateResponse(chatId, text, reply);
      }
    }

    if (reply) await ctx.reply(reply);

  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Ошибка: " + err.message);
  }
}

// ============ Получение задач по фильтру ============
async function getTodoistTasks(filter) {
  const all = await getAllTasks();
  const todayISO = getDateISO(0);
  const tomorrowISO = getDateISO(1);

  if (filter === "today") return all.filter(t => taskMatchesDate(t, todayISO));
  if (filter === "tomorrow") return all.filter(t => taskMatchesDate(t, tomorrowISO));
  if (filter === "overdue") return all.filter(t => {
    if (!t.due) return false;
    const taskDate = t.due.date || (t.due.datetime?.substring(0, 10));
    return taskDate && taskDate < todayISO;
  });
  if (filter === "p1 | p2") return all.filter(t => t.priority === 1 || t.priority === 2);
  return all;
}

// ============ Контексты документов ============
const docContexts = {};

// ============ Подтверждение удаления ============
const pendingDeletes = {};

// ============ Меню ============
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ["📋 Задачи сегодня", "📅 Задачи завтра"],
        ["⚠️ Просроченные", "🔴 Срочные"],
        ["📁 Проекты", "📋 Все задачи"],
      ],
      resize_keyboard: true,
      persistent: true,
    }
  };
}

// ============ Команды ============
const helpText = `🤖 Я твой личный ассистент.
Что умею:
• Добавлять задачи в Todoist голосом или текстом
• Удалять, изменять, выполнять задачи
• Показывать задачи на сегодня, завтра, просроченные, срочные, все
• Читать PDF и Word документы и отвечать по ним
• Отвечать на вопросы с учётом истории

Команды:
/tasks — задачи на сегодня
/tomorrow — на завтра
/overdue — просроченные
/urgent — срочные
/all — все задачи
/projects — проекты
/clear — очистить историю
/feedback — оставить отзыв о последнем ответе
/reset_learning — сбросить мои "уроки"`;

bot.command("start", async (ctx) => {
  await ctx.reply(helpText, mainMenu());
});
bot.command("help", async (ctx) => {
  await ctx.reply(helpText, mainMenu());
});

bot.command("tasks", async (ctx) => {
  try {
    const t = await getTodoistTasks("today");
    await ctx.reply(getNow() + "\n\n📋 Задачи на сегодня:\n" + formatTaskList(t));
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.command("tomorrow", async (ctx) => {
  try {
    const t = await getTodoistTasks("tomorrow");
    await ctx.reply("📅 Задачи на завтра:\n" + formatTaskList(t));
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.command("overdue", async (ctx) => {
  try {
    const t = await getTodoistTasks("overdue");
    await ctx.reply("⚠️ Просроченные:\n" + formatTaskList(t));
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.command("urgent", async (ctx) => {
  try {
    const t = await getTodoistTasks("p1 | p2");
    await ctx.reply("🔴 Срочные и важные:\n" + formatTaskList(t));
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.command("all", async (ctx) => {
  try {
    const t = await getAllTasks();
    await ctx.reply("📋 Все задачи (" + t.length + "):\n" + formatTaskList(t));
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.command("projects", async (ctx) => {
  try {
    const projects = toArray(await todoist.getProjects());
    const allTasks = await getAllTasks();
    const list = projects.map((p, i) => {
      const count = allTasks.filter(t => t.projectId === p.id).length;
      return (i + 1) + ". " + p.name + " (" + count + " задач)";
    }).join("\n");
    await ctx.reply("📁 Проекты:\n" + list);
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.command("clear", async (ctx) => {
  await redis.del("history:" + ctx.chat.id);
  await ctx.reply("🧹 История очищена.");
});
bot.command("reset_learning", async (ctx) => {
  await redis.del("lessons:" + ctx.chat.id);
  await ctx.reply("🧠 Мои уроки сброшены.");
});
bot.command("feedback", async (ctx) => {
  const fb = pendingFeedback[ctx.chat.id];
  if (!fb) return ctx.reply("Нет недавнего ответа для оценки.");
  await ctx.reply("Оцени мой последний ответ:",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👍 Хорошо", callback_data: "fb_good" },
            { text: "👎 Плохо", callback_data: "fb_bad" }
          ]
        ]
      }
    }
  );
});

// ============ Кнопки ============
bot.hears("📋 Задачи сегодня", async (ctx) => {
  try {
    const t = await getTodoistTasks("today");
    await ctx.reply(getNow() + "\n\n📋 Задачи на сегодня:\n" + formatTaskList(t), mainMenu());
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.hears("📅 Задачи завтра", async (ctx) => {
  try {
    const t = await getTodoistTasks("tomorrow");
    await ctx.reply("📅 Задачи на завтра:\n" + formatTaskList(t), mainMenu());
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.hears("⚠️ Просроченные", async (ctx) => {
  try {
    const t = await getTodoistTasks("overdue");
    await ctx.reply("⚠️ Просроченные:\n" + formatTaskList(t), mainMenu());
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.hears("🔴 Срочные", async (ctx) => {
  try {
    const t = await getTodoistTasks("p1 | p2");
    await ctx.reply("🔴 Срочные и важные:\n" + formatTaskList(t), mainMenu());
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.hears("📁 Проекты", async (ctx) => {
  try {
    const projects = toArray(await todoist.getProjects());
    const allTasks = await getAllTasks();
    const list = projects.map((p, i) => {
      const count = allTasks.filter(t => t.projectId === p.id).length;
      return (i + 1) + ". " + p.name + " (" + count + " задач)";
    }).join("\n");
    await ctx.reply("📁 Проекты:\n" + list, mainMenu());
  } catch (e) { await ctx.reply("❌ " + e.message); }
});
bot.hears("📋 Все задачи", async (ctx) => {
  try {
    const t = await getAllTasks();
    await ctx.reply("📋 Все задачи (" + t.length + "):\n" + formatTaskList(t), mainMenu());
  } catch (e) { await ctx.reply("❌ " + e.message); }
});

// ============ Обработка callback-запросов ============
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;

  if (data === "confirm_delete") {
    const ids = pendingDeletes[chatId];
    if (ids) {
      for (const id of ids) await todoist.deleteTask(id);
      delete pendingDeletes[chatId];
      await ctx.editMessageText("🗑 Удалено.");
    }
  } else if (data === "cancel_delete") {
    delete pendingDeletes[chatId];
    await ctx.editMessageText("Отменено.");
  } else if (data === "fb_good") {
    const fb = pendingFeedback[chatId];
    if (fb) {
      // Сохраняем позитивный фидбек (можно в лог)
      await redis.lpush("feedback:good:" + chatId, JSON.stringify(fb));
      delete pendingFeedback[chatId];
      await ctx.editMessageText("👍 Спасибо за оценку!");
    }
  } else if (data === "fb_bad") {
    const fb = pendingFeedback[chatId];
    if (fb) {
      await ctx.editMessageText("👎 Извините, я учту это. Напишите, как надо было ответить?");
      // Ждём исправления
      // Можно сохранить как "ожидание исправления" и затем обработать в handleText
      // Упростим: сохраним в специальный ключ
      await redis.set("awaiting_correction:" + chatId, JSON.stringify(fb), "EX", 300);
      delete pendingFeedback[chatId];
    }
  }
  await ctx.answerCbQuery();
});

// ============ Текстовые сообщения ============
bot.on("text", async (ctx) => {
  await handleText(ctx, ctx.message.text);
});

// ============ Голосовые сообщения ============
bot.on("voice", async (ctx) => {
  try {
    await ctx.reply("🎤 Распознаю голос...");
    const fileUrl = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const text = await transcribeVoice(fileUrl.href);
    await ctx.reply("📝 Распознано: " + text);
    await handleText(ctx, text);
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Не удалось распознать голос.");
  }
});

// ============ Документы ============
bot.on("document", async (ctx) => {
  try {
    const doc = ctx.message.document;
    if (doc.file_size > MAX_DOC_SIZE) {
      return ctx.reply("❌ Файл слишком большой (макс. 20 МБ)");
    }
    const fileUrl = await ctx.telegram.getFileLink(doc.file_id);
    const res = await axios({ url: fileUrl.href, responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);

    if (doc.mime_type === "application/pdf") {
      await ctx.reply("📄 Читаю PDF...");
      const data = await pdfParse(buffer);
      docContexts[ctx.chat.id] = data.text.slice(0, 8000);
      await ctx.reply("✅ PDF загружен! Задавай вопросы.");
    } else if (doc.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      await ctx.reply("📄 Читаю Word...");
      const data = await mammoth.extractRawText({ buffer });
      docContexts[ctx.chat.id] = data.value.slice(0, 8000);
      await ctx.reply("✅ Word загружен! Задавай вопросы.");
    } else {
      await ctx.reply("❌ Поддерживаются только PDF и Word.");
    }
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Не удалось прочитать документ.");
  }
});

// ============ Утреннее резюме (cron) ============
// Самара UTC+4, запуск в 8:00 по Самаре = 4:00 UTC
// node-cron не поддерживает timezone, поэтому используем смещение вручную:
// Запускаем каждый час и проверяем текущее время в Самаре
cron.schedule("0 * * * *", async () => {
  const now = new Date();
  const samaraTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Samara" }));
  if (samaraTime.getHours() === 8 && samaraTime.getMinutes() === 0) {
    try {
      const today = await getTodoistTasks("today");
      const overdue = await getTodoistTasks("overdue");
      const nowStr = getNow();
      let msg = "🌅 Доброе утро! " + nowStr + "\n\n";
      if (overdue.length) {
        msg += "⚠️ Просроченные (" + overdue.length + "):\n" + formatTaskList(overdue) + "\n\n";
      }
      msg += "📋 Задачи на сегодня (" + today.length + "):\n" + formatTaskList(today);
      await bot.telegram.sendMessage(ALLOWED_USER, msg);
    } catch (err) { console.error("Cron error:", err); }
  }
});

// ============ Запуск ============
bot.launch();
console.log("🚀 Бот запущен...");