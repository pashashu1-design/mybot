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

function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

async function getHistory(chatId) {
  try { const d = await redis.get("history:" + chatId); return d ? JSON.parse(d) : []; } catch { return []; }
}
async function saveHistory(chatId, messages) {
  try { await redis.set("history:" + chatId, JSON.stringify(messages.slice(-30))); } catch {}
}
async function getCorrections(chatId) {
  try { const d = await redis.get("corrections:" + chatId); return d ? JSON.parse(d) : []; } catch { return []; }
}
async function saveCorrection(chatId, text) {
  try {
    const c = await getCorrections(chatId);
    c.push(text);
    await redis.set("corrections:" + chatId, JSON.stringify(c.slice(-20)));
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

function formatTask(t, i) {
  const priority = { 1: "🔴", 2: "🟠", 3: "🔵", 4: "⚪" }[t.priority] || "⚪";
  const time = t.due && t.due.datetime
    ? " — " + new Date(t.due.datetime).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara" })
    : t.due && t.due.date ? " — " + t.due.date : "";
  return (i + 1) + ". " + priority + " " + t.content + time;
}

function formatTaskList(tasks) {
  tasks = toArray(tasks);
  if (tasks.length === 0) return "Задач нет.";
  return tasks.map((t, i) => formatTask(t, i)).join("\n");
}

async function loadTodoistContext() {
  const [allTasksRaw, projectsRaw, labelsRaw] = await Promise.all([
    todoist.getTasks(),
    todoist.getProjects(),
    todoist.getLabels(),
  ]);
  return {
    allTasks: toArray(allTasksRaw),
    projects: toArray(projectsRaw),
    labels: toArray(labelsRaw),
  };
}

function getTodayISO() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Samara" })).toISOString().split("T")[0];
}

function filterByDate(tasks, dateISO) {
  return tasks.filter(t => t.due && (t.due.date === dateISO || (t.due.datetime && t.due.datetime.startsWith(dateISO))));
}

async function analyzeIntent(text, ctxData) {
  const todayISO = getTodayISO();
  const now = new Date();
  const todayRU = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Samara" });

  const taskList = ctxData.allTasks.map((t, i) => {
    const proj = ctxData.projects.find(p => p.id === t.projectId);
    const due = t.due ? (t.due.datetime || t.due.date) : "нет";
    return (i + 1) + ". [p" + t.priority + "] " + t.content + " | проект: " + (proj ? proj.name : "Входящие") + " | срок: " + due;
  }).join("\n");

  const systemPrompt = "Сегодня " + todayRU + " (ISO: " + todayISO + ").\n\n" +
    "ВСЕ ЗАДАЧИ:\n" + (taskList || "нет задач") + "\n\n" +
    "ПРОЕКТЫ: " + ctxData.projects.map(p => p.name).join(", ") + "\n" +
    "МЕТКИ: " + ctxData.labels.map(l => l.name).join(", ") + "\n\n" +
    "Верни ТОЛЬКО JSON без пояснений:\n" +
    '{"action":"add_tasks|complete_tasks|delete_tasks|edit_task|reopen_task|add_comment|show_today|show_tomorrow|show_overdue|show_urgent|show_all|show_project_tasks|show_projects|add_project|delete_project|show_labels|add_label|correction|chat",' +
    '"task_nums":[],"new_title":null,"new_datetime":null,"new_priority":null,"project_name":null,"label_name":null,"comment_text":null,' +
    '"tasks_to_add":[{"title":"","due_datetime":"YYYY-MM-DDTHH:MM:00","priority":4,"project_name":null,"labels":[],"description":null}]}\n\n' +
    "priority: 1=срочно 2=важно 3=средне 4=обычно\n" +
    "task_nums — номера из списка ВСЕХ ЗАДАЧ выше.\n" +
    "Если пользователь говорит первую/вторую/третью — это номера 1/2/3.";

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text }
    ],
  });

  const raw = res.choices[0].message.content.replace(/```json|```/g, "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { action: "chat", task_nums: [], tasks_to_add: [] };
  try { return JSON.parse(match[0]); } catch { return { action: "chat", task_nums: [], tasks_to_add: [] }; }
}

async function searchWeb(query) {
  try {
    const results = await search(query, { locale: "ru-ru" });
    return toArray(results.results).slice(0, 3).map(r => r.title + ": " + r.description).join("\n\n");
  } catch { return null; }
}

async function handleText(ctx, text) {
  const chatId = ctx.chat.id;
  if (ALLOWED_USER && String(chatId) !== String(ALLOWED_USER)) { await ctx.reply("Нет доступа."); return; }

  try {
    const { allTasks, projects, labels } = await loadTodoistContext();
    const intent = await analyzeIntent(text, { allTasks, projects, labels });
    const todayISO = getTodayISO();

    switch (intent.action) {

      case "add_tasks":
        if (intent.tasks_to_add && intent.tasks_to_add.length > 0) {
          const added = [];
          for (const task of intent.tasks_to_add) {
            const data = { content: task.title, priority: task.priority || 4 };
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
          await ctx.reply("Добавлено:\n" + added.join("\n"));
        }
        break;

      case "complete_tasks":
        if (intent.task_nums && intent.task_nums.length > 0) {
          const done = [];
          for (const num of intent.task_nums) {
            const task = allTasks[num - 1];
            if (task) { await todoist.closeTask(task.id); done.push(task.content); }
          }
          await ctx.reply(done.length > 0 ? "Выполнено:\n" + done.join("\n") : "Не нашёл задачи.");
        }
        break;

      case "reopen_task":
        if (intent.task_nums && intent.task_nums[0]) {
          const task = allTasks[intent.task_nums[0] - 1];
          if (task) { await todoist.reopenTask(task.id); await ctx.reply("Переоткрыто: " + task.content); }
        }
        break;

      case "delete_tasks":
        if (intent.task_nums && intent.task_nums.length > 0) {
          const deleted = [];
          for (const num of intent.task_nums) {
            const task = allTasks[num - 1];
            if (task) { await todoist.deleteTask(task.id); deleted.push(task.content); }
          }
          await ctx.reply(deleted.length > 0 ? "Удалено:\n" + deleted.join("\n") : "Не нашёл задачи.");
        }
        break;

      case "edit_task":
        if (intent.task_nums && intent.task_nums[0]) {
          const task = allTasks[intent.task_nums[0] - 1];
          if (task) {
            const data = {};
            if (intent.new_title) data.content = intent.new_title;
            if (intent.new_datetime) data.dueDatetime = intent.new_datetime;
            if (intent.new_priority) data.priority = intent.new_priority;
            await todoist.updateTask(task.id, data);
            await ctx.reply("Изменено: " + (intent.new_title || task.content));
          } else { await ctx.reply("Не нашёл задачу."); }
        }
        break;

      case "add_comment":
        if (intent.task_nums && intent.task_nums[0] && intent.comment_text) {
          const task = allTasks[intent.task_nums[0] - 1];
          if (task) {
            await todoist.addComment({ taskId: task.id, content: intent.comment_text });
            await ctx.reply("Комментарий добавлен к: " + task.content);
          }
        }
        break;

      case "show_today":
        await ctx.reply("Сегодня:\n" + formatTaskList(filterByDate(allTasks, todayISO)));
        break;

      case "show_tomorrow":
        const tomorrow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Samara" }));
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowISO = tomorrow.toISOString().split("T")[0];
        await ctx.reply("Завтра:\n" + formatTaskList(filterByDate(allTasks, tomorrowISO)));
        break;

      case "show_overdue":
        const overdue = allTasks.filter(t => t.due && t.due.date < todayISO);
        await ctx.reply("Просроченные:\n" + formatTaskList(overdue));
        break;

      case "show_urgent":
        const urgent = allTasks.filter(t => t.priority === 1 || t.priority === 2);
        await ctx.reply("Срочные и важные:\n" + formatTaskList(urgent));
        break;

      case "show_all":
        await ctx.reply("Все задачи (" + allTasks.length + "):\n" + formatTaskList(allTasks));
        break;

      case "show_project_tasks":
        if (intent.project_name) {
          const proj = projects.find(p => p.name.toLowerCase().includes(intent.project_name.toLowerCase()));
          if (proj) {
            const projTasks = allTasks.filter(t => t.projectId === proj.id);
            await ctx.reply(proj.name + ":\n" + formatTaskList(projTasks));
          } else { await ctx.reply("Проект не найден."); }
        }
        break;

      case "show_projects":
        const projList = projects.map((p, i) => (i + 1) + ". " + p.name + " (" + allTasks.filter(t => t.projectId === p.id).length + " задач)").join("\n");
        await ctx.reply("Проекты:\n" + projList);
        break;

      case "add_project":
        if (intent.project_name) {
          await todoist.addProject({ name: intent.project_name });
          await ctx.reply("Проект создан: " + intent.project_name);
        }
        break;

      case "delete_project":
        if (intent.project_name) {
          const proj = projects.find(p => p.name.toLowerCase().includes(intent.project_name.toLowerCase()));
          if (proj) { await todoist.deleteProject(proj.id); await ctx.reply("Проект удалён: " + proj.name); }
          else { await ctx.reply("Проект не найден."); }
        }
        break;

      case "show_labels":
        await ctx.reply("Метки:\n" + (labels.length > 0 ? labels.map((l, i) => (i + 1) + ". " + l.name).join("\n") : "Меток нет."));
        break;

      case "add_label":
        if (intent.label_name) {
          await todoist.addLabel({ name: intent.label_name });
          await ctx.reply("Метка создана: " + intent.label_name);
        }
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
        const needsWeb = /(новост|погод|курс|цен|сейчас в мире|последн)/i.test(text);
        let searchCtx = "";
        if (needsWeb) { const r = await searchWeb(text); if (r) searchCtx = "\n\nИз интернета:\n" + r; }
        const nowDate = new Date();
        const dateStr = nowDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Samara" }) + " " + nowDate.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara" });
        let sys = "Сейчас: " + dateStr + ". Ты личный ассистент. Кратко. По делу. Без вступлений. На русском.";
        if (corrections.length > 0) sys += "\n\nПоправки:\n" + corrections.join("\n");
        if (searchCtx) sys += searchCtx;
        messages.unshift({ role: "system", content: sys });
        messages.push({ role: "user", content: text });
        const res = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages });
        const reply = res.choices[0].message.content;
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

const startMsg = "Привет! Я твой личный ассистент.\n\n" +
  "Задачи: добавить, удалить, изменить, выполнить\n" +
  "Приоритеты: срочно, важно, средне, обычно\n" +
  "Просмотр: сегодня, завтра, просроченные, срочные, все\n" +
  "Проекты и метки: создать, удалить, просмотреть\n" +
  "Голосовые сообщения\n" +
  "Поиск в интернете\n" +
  "PDF и Word документы\n" +
  "Запоминаю поправки\n\n" +
  "Команды:\n" +
  "/tasks — сегодня\n" +
  "/tomorrow — завтра\n" +
  "/overdue — просроченные\n" +
  "/urgent — срочные\n" +
  "/all — все задачи\n" +
  "/projects — проекты\n" +
  "/labels — метки\n" +
  "/clear — очистить историю";

bot.command("debug", async (ctx) => {
  try {
    const allD = toArray(await todoist.getTasks());
    const todayD = toArray(await todoist.getTasks({ filter: "today" }));
    const lines = allD.slice(0, 5).map(t => {
      const d = t.due ? (t.due.date || t.due.datetime || "no date") : "null";
      return t.content + " | " + d;
    });
    const msg = "Всего: " + allD.length + " | Today: " + todayD.length + "\n" + lines.join("\n");
    await ctx.reply(msg);
  } catch(e) { await ctx.reply("Ошибка: " + e.message); }
});
bot.command("start", async (ctx) => { await ctx.reply(startMsg); });
bot.command("help", async (ctx) => { await ctx.reply(startMsg); });

bot.command("tasks", async (ctx) => {
  const { allTasks } = await loadTodoistContext();
  await ctx.reply("Сегодня:\n" + formatTaskList(filterByDate(allTasks, getTodayISO())));
});
bot.command("tomorrow", async (ctx) => {
  const { allTasks } = await loadTodoistContext();
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Samara" }));
  d.setDate(d.getDate() + 1);
  await ctx.reply("Завтра:\n" + formatTaskList(filterByDate(allTasks, d.toISOString().split("T")[0])));
});
bot.command("overdue", async (ctx) => {
  const { allTasks } = await loadTodoistContext();
  const t = allTasks.filter(task => task.due && task.due.date < getTodayISO());
  await ctx.reply("Просроченные:\n" + formatTaskList(t));
});
bot.command("urgent", async (ctx) => {
  const { allTasks } = await loadTodoistContext();
  const t = allTasks.filter(task => task.priority === 1 || task.priority === 2);
  await ctx.reply("Срочные:\n" + formatTaskList(t));
});
bot.command("all", async (ctx) => {
  const { allTasks } = await loadTodoistContext();
  await ctx.reply("Все задачи (" + allTasks.length + "):\n" + formatTaskList(allTasks));
});
bot.command("projects", async (ctx) => {
  const { projects, allTasks } = await loadTodoistContext();
  await ctx.reply("Проекты:\n" + projects.map((p, i) => (i + 1) + ". " + p.name + " (" + allTasks.filter(t => t.projectId === p.id).length + " задач)").join("\n"));
});
bot.command("labels", async (ctx) => {
  const { labels } = await loadTodoistContext();
  await ctx.reply("Метки:\n" + (labels.length > 0 ? labels.map((l, i) => (i + 1) + ". " + l.name).join("\n") : "Меток нет."));
});
bot.command("clear", async (ctx) => {
  await redis.del("history:" + ctx.chat.id);
  await ctx.reply("История очищена.");
});

bot.on("text", async (ctx) => { await handleText(ctx, ctx.message.text); });

bot.on("voice", async (ctx) => {
  try {
    await ctx.reply("...");
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
    const res = await axios({ url: fileUrl.href, responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);
    if (doc.mime_type === "application/pdf") {
      await ctx.reply("Читаю PDF...");
      const data = await parsePDF(buffer);
      docContexts[ctx.chat.id] = data.text.slice(0, 8000);
      await ctx.reply("PDF загружен! Задавай вопросы.");
    } else if (doc.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      await ctx.reply("Читаю Word...");
      const data = await mammoth.extractRawText({ buffer });
      docContexts[ctx.chat.id] = data.value.slice(0, 8000);
      await ctx.reply("Word загружен! Задавай вопросы.");
    } else {
      await ctx.reply("Поддерживаются только PDF и Word.");
    }
  } catch (err) { console.error(err); ctx.reply("Не удалось прочитать документ."); }
});

bot.launch();
console.log("Бот запущен...");
