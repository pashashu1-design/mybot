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
  try {
    const d = await redis.get("history:" + chatId);
    return d ? JSON.parse(d) : [];
  } catch { return []; }
}

async function saveHistory(chatId, messages) {
  try {
    await redis.set("history:" + chatId, JSON.stringify(messages.slice(-20)));
  } catch {}
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
  const result = await groq.audio.transcriptions.create({
    file: fs.createReadStream(mp3Path),
    model: "whisper-large-v3",
    language: "ru",
  });
  try { fs.unlinkSync(oggPath); fs.unlinkSync(mp3Path); } catch {}
  return result.text;
}

async function parsePDF(buffer) {
  const lib = require("pdf-parse");
  const fn = typeof lib === "function" ? lib : lib.default;
  return fn(buffer);
}

function formatTaskList(tasks) {
  tasks = toArray(tasks);
  if (tasks.length === 0) return "Задач нет.";
  const priority = { 1: "🔴", 2: "🟠", 3: "🔵", 4: "⚪" };
  return tasks.map((t, i) => {
    const p = priority[t.priority] || "⚪";
    const time = t.due && t.due.datetime
      ? " — " + new Date(t.due.datetime).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara" })
      : "";
    return (i + 1) + ". " + p + " " + t.content + time;
  }).join("\n");
}

function getNow() {
  const now = new Date();
  return now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", weekday: "long", timeZone: "Europe/Samara" })
    + ", " + now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara" });
}

async function getTodoistTasks(filter) {
  return toArray(await todoist.getTasks({ filter }));
}

async function analyzeIntent(text, tasks, projects) {
  const taskList = tasks.map((t, i) => (i + 1) + ". " + t.content + (t.due ? " (" + (t.due.date || t.due.datetime || "") + ")" : "")).join("\n");
  const projList = projects.map(p => p.name).join(", ");

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: "Сейчас: " + getNow() + ".\n\n" +
          "Задачи в Todoist:\n" + (taskList || "нет") + "\n\n" +
          "Проекты: " + (projList || "нет") + "\n\n" +
          "Проанализируй сообщение. Верни ТОЛЬКО JSON без лишних слов:\n" +
          "{\"action\": \"add|complete|delete|edit|show_today|show_tomorrow|show_overdue|show_urgent|show_all|show_projects|add_project|delete_project|chat\", " +
          "\"task_nums\": [], " +
          "\"new_title\": null, " +
          "\"new_datetime\": null, " +
          "\"project_name\": null, " +
          "\"tasks_to_add\": [{\"title\": \"\", \"datetime\": \"YYYY-MM-DDTHH:MM:00\", \"priority\": 4, \"project\": null}]}\n\n" +
          "priority: 1=срочно 2=важно 3=средне 4=обычно\n" +
          "Для datetime используй формат YYYY-MM-DDTHH:MM:00\n" +
          "task_nums — номера задач из списка выше"
      },
      { role: "user", content: text }
    ],
  });

  const raw = res.choices[0].message.content.replace(/```json|```/g, "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { action: "chat", task_nums: [], tasks_to_add: [] };
  try { return JSON.parse(match[0]); } catch { return { action: "chat", task_nums: [], tasks_to_add: [] }; }
}

async function handleText(ctx, text) {
  const chatId = ctx.chat.id;

  if (ALLOWED_USER && String(chatId) !== String(ALLOWED_USER)) {
    await ctx.reply("Нет доступа.");
    return;
  }

  try {
    const allTasks = toArray(await todoist.getTasks());
    const projects = toArray(await todoist.getProjects());
    const intent = await analyzeIntent(text, allTasks, projects);

    switch (intent.action) {

      case "add":
        if (intent.tasks_to_add && intent.tasks_to_add.length > 0) {
          const added = [];
          for (const t of intent.tasks_to_add) {
            const data = { content: t.title, priority: t.priority || 4 };
            if (t.datetime) data.dueDatetime = t.datetime;
            if (t.project) {
              const proj = projects.find(p => p.name.toLowerCase().includes(t.project.toLowerCase()));
              if (proj) data.projectId = proj.id;
            }
            await todoist.addTask(data);
            added.push(t.title);
          }
          await ctx.reply("Добавлено:\n" + added.join("\n"));
        }
        break;

      case "complete":
        if (intent.task_nums && intent.task_nums.length > 0) {
          const done = [];
          for (const num of intent.task_nums) {
            const task = allTasks[num - 1];
            if (task) { await todoist.closeTask(task.id); done.push(task.content); }
          }
          await ctx.reply(done.length > 0 ? "Выполнено:\n" + done.join("\n") : "Задача не найдена.");
        }
        break;

      case "delete":
        if (intent.task_nums && intent.task_nums.length > 0) {
          const deleted = [];
          for (const num of intent.task_nums) {
            const task = allTasks[num - 1];
            if (task) { await todoist.deleteTask(task.id); deleted.push(task.content); }
          }
          await ctx.reply(deleted.length > 0 ? "Удалено:\n" + deleted.join("\n") : "Задача не найдена.");
        }
        break;

      case "edit":
        if (intent.task_nums && intent.task_nums[0]) {
          const task = allTasks[intent.task_nums[0] - 1];
          if (task) {
            const data = {};
            if (intent.new_title) data.content = intent.new_title;
            if (intent.new_datetime) data.dueDatetime = intent.new_datetime;
            await todoist.updateTask(task.id, data);
            await ctx.reply("Изменено: " + (intent.new_title || task.content));
          } else { await ctx.reply("Задача не найдена."); }
        }
        break;

      case "show_today":
        const todayTasks = await getTodoistTasks("today");
        await ctx.reply(getNow() + "\n\nЗадачи на сегодня:\n" + formatTaskList(todayTasks));
        break;

      case "show_tomorrow":
        const tomorrowTasks = await getTodoistTasks("tomorrow");
        await ctx.reply("Задачи на завтра:\n" + formatTaskList(tomorrowTasks));
        break;

      case "show_overdue":
        const overdueTasks = await getTodoistTasks("overdue");
        await ctx.reply("Просроченные:\n" + formatTaskList(overdueTasks));
        break;

      case "show_urgent":
        const urgentTasks = await getTodoistTasks("p1 | p2");
        await ctx.reply("Срочные и важные:\n" + formatTaskList(urgentTasks));
        break;

      case "show_all":
        await ctx.reply("Все задачи (" + allTasks.length + "):\n" + formatTaskList(allTasks));
        break;

      case "show_projects":
        const projList = projects.map((p, i) => {
          const count = allTasks.filter(t => t.projectId === p.id).length;
          return (i + 1) + ". " + p.name + " (" + count + " задач)";
        }).join("\n");
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

      default:
        const history = await getHistory(chatId);
        const messages = [...history];
        if (docContexts[chatId]) {
          messages.unshift({ role: "system", content: "Документ:\n\n" + docContexts[chatId] });
        }
        messages.unshift({
          role: "system",
          content: "Сейчас: " + getNow() + ". Ты личный ассистент. Отвечай кратко, по делу, на русском языке."
        });
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

const helpText = "Привет! Я твой личный ассистент.\n\n" +
  "Что умею:\n" +
  "Добавлять задачи в Todoist голосом или текстом\n" +
  "Удалять, изменять, выполнять задачи\n" +
  "Показывать задачи на сегодня, завтра, просроченные\n" +
  "Читать PDF и Word документы\n" +
  "Отвечать на вопросы\n\n" +
  "Команды:\n" +
  "/tasks — задачи на сегодня\n" +
  "/tomorrow — задачи на завтра\n" +
  "/overdue — просроченные\n" +
  "/urgent — срочные\n" +
  "/all — все задачи\n" +
  "/projects — проекты\n" +
  "/clear — очистить историю";

bot.command("start", async (ctx) => { await ctx.reply(helpText); });
bot.command("help", async (ctx) => { await ctx.reply(helpText); });

bot.command("tasks", async (ctx) => {
  const t = await getTodoistTasks("today");
  await ctx.reply(getNow() + "\n\nЗадачи на сегодня:\n" + formatTaskList(t));
});

bot.command("tomorrow", async (ctx) => {
  const t = await getTodoistTasks("tomorrow");
  await ctx.reply("Задачи на завтра:\n" + formatTaskList(t));
});

bot.command("overdue", async (ctx) => {
  const t = await getTodoistTasks("overdue");
  await ctx.reply("Просроченные:\n" + formatTaskList(t));
});

bot.command("urgent", async (ctx) => {
  const t = await getTodoistTasks("p1 | p2");
  await ctx.reply("Срочные и важные:\n" + formatTaskList(t));
});

bot.command("all", async (ctx) => {
  const t = toArray(await todoist.getTasks());
  await ctx.reply("Все задачи (" + t.length + "):\n" + formatTaskList(t));
});

bot.command("projects", async (ctx) => {
  const projects = toArray(await todoist.getProjects());
  const allTasks = toArray(await todoist.getTasks());
  const list = projects.map((p, i) => {
    const count = allTasks.filter(t => t.projectId === p.id).length;
    return (i + 1) + ". " + p.name + " (" + count + " задач)";
  }).join("\n");
  await ctx.reply("Проекты:\n" + list);
});

bot.command("clear", async (ctx) => {
  await redis.del("history:" + ctx.chat.id);
  await ctx.reply("История очищена.");
});

bot.on("text", async (ctx) => {
  await handleText(ctx, ctx.message.text);
});

bot.on("voice", async (ctx) => {
  try {
    await ctx.reply("...");
    const fileUrl = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const text = await transcribeVoice(fileUrl.href);
    await ctx.reply("Распознано: " + text);
    await handleText(ctx, text);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось распознать голос.");
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
  } catch (err) {
    console.error(err);
    await ctx.reply("Не удалось прочитать документ.");
  }
});

bot.launch();
console.log("Бот запущен...");
