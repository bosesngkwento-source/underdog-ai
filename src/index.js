require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const Database = require("better-sqlite3");
const { GoogleGenAI } = require("@google/genai");

// =====================================================
// CONFIG
// =====================================================

const REQUIRED_ENV = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "GEMINI_API_KEY",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

// ONLY THESE TWO ROLES CAN CONTROL STAFF FEATURES
const STAFF_ROLE_IDS = new Set([
  "1530288888411852891", // Admin
  "1530288809932099634", // Head Admin
]);

// Actions Underdog is NEVER allowed to perform
const BLOCKED_ACTIONS = [
  "ban",
  "ban member",
  "kick",
  "kick member",
  "timeout",
  "unban",
];

// =====================================================
// GEMINI
// =====================================================

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// =====================================================
// DISCORD CLIENT
// =====================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// =====================================================
// DATABASE
// =====================================================

const db = new Database("underdog.sqlite");

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT,
  content TEXT NOT NULL,
  source_user_id TEXT,
  source_username TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  created_by TEXT,
  channel_id TEXT,
  due_at INTEGER,
  completed INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS indexed_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT,
  indexed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_category
ON memories(category);

CREATE INDEX IF NOT EXISTS idx_memories_created
ON memories(created_at);

CREATE INDEX IF NOT EXISTS idx_tasks_due
ON tasks(due_at);
`);

// =====================================================
// HELPERS
// =====================================================

function clip(text, max = 2000) {
  if (!text) return "";
  return String(text).slice(0, max);
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getSetting(key, fallback = null) {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key);

  return row?.value ?? fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// =====================================================
// STAFF PERMISSIONS
// =====================================================

function isAuthorizedStaff(member) {
  if (!member) return false;

  return member.roles.cache.some((role) =>
    STAFF_ROLE_IDS.has(role.id)
  );
}

function isBotOwnerOrAdmin(member) {
  return isAuthorizedStaff(member);
}

// =====================================================
// MEMORY
// =====================================================

function saveMemory(
  category,
  content,
  userId = null,
  username = null
) {
  if (!content || !content.trim()) return;

  db.prepare(`
    INSERT INTO memories
    (category, content, source_user_id, source_username, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    category || "general",
    clip(content, 4000),
    userId,
    username,
    Date.now()
  );
}

function searchMemories(query, limit = 12) {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 8);

  if (!words.length) {
    return db
      .prepare(`
        SELECT *
        FROM memories
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(limit);
  }

  const conditions = words
    .map(() => "(LOWER(content) LIKE ? OR LOWER(category) LIKE ?)")
    .join(" OR ");

  const params = [];

  for (const word of words) {
    const value = `%${word}%`;
    params.push(value, value);
  }

  params.push(limit);

  return db
    .prepare(`
      SELECT *
      FROM memories
      WHERE ${conditions}
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(...params);
}

function formatMemories(rows) {
  if (!rows.length) return "No relevant memories found.";

  return rows
    .map(
      (row, index) =>
        `${index + 1}. [${row.category}] ${row.content}`
    )
    .join("\n");
}

// =====================================================
// PERSONALITY
// =====================================================

function getPersonality() {
  return getSetting(
    "personality",
    `
You are Underdog AI, the AI assistant for a Roblox boxing Discord server.

Personality:
- Helpful
- Energetic
- Short replies
- Boxing/gaming personality
- Uses casual slang naturally
- Can be sarcastic and slightly mean in a harmless joking way
- Can make harmless jokes
- Can use occasional light dark humor
- Never target protected groups
- Never threaten people
- Never encourage dangerous behavior
- Never make serious abusive statements
- Never pretend to know information you do not have
- If server information is unknown, say you don't know
- Respect authorized staff instructions
- Human staff remain in control

Keep normal responses concise.
`
  );
}

// =====================================================
// GEMINI RESPONSE
// =====================================================

async function generateAnswer({
  userMessage,
  memoryContext = "",
  staffContext = "",
}) {
  const prompt = `
${getPersonality()}

SERVER MEMORY:
${memoryContext || "No relevant memory found."}

STAFF CONTEXT:
${staffContext || "No special staff instruction."}

USER MESSAGE:
${userMessage}

Answer the user.
Do not invent server facts.
If the information is not in the memory or message, say you don't know.
Keep the response short and natural.
`;

  try {
    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        temperature: 0.8,
        maxOutputTokens: 250,
      },
    });

    const text =
      result?.text ||
      result?.response?.text?.() ||
      "";

    return clip(text.trim(), 900) ||
      "My brain just disconnected for a second. 💀";
  } catch (error) {
    console.error("Gemini error:", error);

    return "My AI brain is having a boxing match with the API right now. 💀";
  }
}

// =====================================================
// MEMORY CLASSIFICATION
// =====================================================

async function classifyForMemory(content) {
  try {
    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: `
Decide whether this Discord message contains important long-term
server information worth remembering.

Save things such as:
- rules
- announcements
- updates
- patch notes
- events
- rankings
- P4P rankings
- champions
- belt holders
- fighter records
- Hall of Fame
- staff decisions
- important server information

Do NOT save:
- casual chat
- greetings
- random jokes
- ordinary conversation
- meaningless messages

Reply exactly:
SAVE|category|reason
or
IGNORE

MESSAGE:
${clip(content, 3000)}
`,
      config: {
        temperature: 0,
        maxOutputTokens: 80,
      },
    });

    const text =
      result?.text ||
      result?.response?.text?.() ||
      "";

    const clean = text.trim();

    if (!clean.startsWith("SAVE|")) {
      return null;
    }

    const parts = clean.split("|");

    return {
      category: parts[1] || "general",
      reason: parts.slice(2).join("|") || content,
    };
  } catch (error) {
    console.error("Memory classification error:", error);
    return null;
  }
}

// =====================================================
// INDEXING
// =====================================================

function messageAlreadyIndexed(messageId) {
  return !!db
    .prepare(
      "SELECT message_id FROM indexed_messages WHERE message_id = ?"
    )
    .get(messageId);
}

function markMessageIndexed(message) {
  db.prepare(`
    INSERT OR IGNORE INTO indexed_messages
    (message_id, channel_id, indexed_at)
    VALUES (?, ?, ?)
  `).run(
    message.id,
    message.channel.id,
    Date.now()
  );
}

async function indexChannel(channel, maxMessages = 100) {
  if (!channel?.isTextBased()) {
    return 0;
  }

  let totalIndexed = 0;
  let lastId;

  while (totalIndexed < maxMessages) {
    const remaining = Math.min(
      100,
      maxMessages - totalIndexed
    );

    const options = {
      limit: remaining,
    };

    if (lastId) {
      options.before = lastId;
    }

    const messages = await channel.messages.fetch(options);

    if (!messages.size) break;

    for (const message of messages.values()) {
      if (message.author.bot) continue;

      if (messageAlreadyIndexed(message.id)) {
        continue;
      }

      if (message.content?.trim()) {
        const classification =
          await classifyForMemory(message.content);

        if (classification) {
          saveMemory(
            classification.category,
            message.content,
            message.author.id,
            message.author.username
          );
        }
      }

      markMessageIndexed(message);
      totalIndexed++;

      // Small delay to reduce API pressure
      await new Promise((resolve) =>
        setTimeout(resolve, 150)
      );
    }

    lastId =
      messages.last()?.id;

    if (messages.size < remaining) break;
  }

  return totalIndexed;
}

// =====================================================
// TASK SYSTEM
// =====================================================

function createTask(
  task,
  createdBy,
  channelId,
  dueAt = null
) {
  const result = db.prepare(`
    INSERT INTO tasks
    (task, created_by, channel_id, due_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    clip(task, 1000),
    createdBy,
    channelId,
    dueAt,
    Date.now()
  );

  return result.lastInsertRowid;
}

function getActiveTasks() {
  return db
    .prepare(`
      SELECT *
      FROM tasks
      WHERE completed = 0
      ORDER BY
        CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
        due_at ASC,
        created_at DESC
    `)
    .all();
}

function completeTask(id) {
  return db
    .prepare(`
      UPDATE tasks
      SET completed = 1
      WHERE id = ?
    `)
    .run(id);
}

function deleteTask(id) {
  return db
    .prepare(`
      DELETE FROM tasks
      WHERE id = ?
    `)
    .run(id);
}

// =====================================================
// TASK REMINDERS
// =====================================================

async function checkTasks() {
  const now = Date.now();

  const tasks = db
    .prepare(`
      SELECT *
      FROM tasks
      WHERE completed = 0
      AND due_at IS NOT NULL
      AND due_at <= ?
    `)
    .all(now);

  for (const task of tasks) {
    try {
      const channel =
        await client.channels.fetch(task.channel_id);

      if (channel?.isTextBased()) {
        await channel.send(
          `⏰ **TASK REMINDER**\n${task.task}`
        );
      }

      db.prepare(`
        UPDATE tasks
        SET due_at = NULL
        WHERE id = ?
      `).run(task.id);
    } catch (error) {
      console.error(
        `Task reminder error for ${task.id}:`,
        error
      );
    }
  }
}

setInterval(checkTasks, 30_000);

// =====================================================
// STAFF-DIRECTED ANNOUNCEMENT SYSTEM
// =====================================================

async function handleStaffInstruction(message, instruction) {
  if (!isAuthorizedStaff(message.member)) {
    await message.reply(
      "Nice try, champ. 💀 Staff-directed commands are only available to Admin and Head Admin."
    );
    return;
  }

  const lower = instruction.toLowerCase();

  // NEVER allow these actions
  if (
    BLOCKED_ACTIONS.some((action) =>
      lower.includes(action)
    )
  ) {
    await message.reply(
      "I can't perform ban, kick, timeout, or unban actions. Those controls stay with human staff."
    );
    return;
  }

  const wantsAnnouncement =
    lower.includes("announce") ||
    lower.includes("announcement") ||
    lower.includes("post this") ||
    lower.includes("send this");

  if (!wantsAnnouncement) {
    return false;
  }

  const targetChannel =
    message.mentions.channels.first();

  if (!targetChannel) {
    await message.reply(
      "Tell me which channel to post it in, champ. Example: `@Underdog AI announce in #announcements Tournament starts at 8 PM.`"
    );
    return true;
  }

  if (!targetChannel.isTextBased()) {
    await message.reply(
      "That isn't a text channel I can post in."
    );
    return true;
  }

  const botMember = message.guild.members.me;

  const permissions =
    targetChannel.permissionsFor(botMember);

  if (
    !permissions?.has(
      PermissionFlagsBits.ViewChannel
    ) ||
    !permissions?.has(
      PermissionFlagsBits.SendMessages
    )
  ) {
    await message.reply(
      `I don't have permission to send messages in ${targetChannel}.`
    );
    return true;
  }

  let announcement = instruction
    .replace(/<#[0-9]+>/g, "")
    .replace(/<@!?\d+>/g, "")
    .replace(/announce(ment)?/gi, "")
    .replace(/post this/gi, "")
    .replace(/send this/gi, "")
    .trim();

  if (!announcement) {
    await message.reply(
      "You told me to announce something but gave me nothing to announce. 💀"
    );
    return true;
  }

  // Ask Gemini to clean the announcement
  const formattedAnnouncement =
    await generateAnnouncement(announcement);

  try {
    await targetChannel.send({
      content: formattedAnnouncement,
      allowedMentions: {
        parse: [],
      },
    });

    saveMemory(
      "announcement",
      announcement,
      message.author.id,
      message.author.username
    );

    await message.reply(
      `Posted it in ${targetChannel}. 🥊`
    );
  } catch (error) {
    console.error("Announcement error:", error);

    await message.reply(
      "I couldn't post that announcement. Check my permissions in that channel."
    );
  }

  return true;
}

// =====================================================
// ANNOUNCEMENT AI FORMATTER
// =====================================================

async function generateAnnouncement(text) {
  try {
    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: `
Rewrite this into a clean Discord server announcement.

Rules:
- Keep the original meaning.
- Do not invent information.
- Make it easy to read.
- Use a suitable heading.
- Keep it concise.
- You may use a few emojis.
- Do not add @everyone or @here.
- Do not add fake dates, times, rewards, or information.

ANNOUNCEMENT:
${clip(text, 3000)}
`,
      config: {
        temperature: 0.5,
        maxOutputTokens: 180,
      },
    });

    const output =
      result?.text ||
      result?.response?.text?.() ||
      "";

    return clip(
      output.trim() || `📢 **ANNOUNCEMENT**\n\n${text}`,
      1900
    );
  } catch (error) {
    console.error(
      "Announcement formatter error:",
      error
    );

    return `📢 **ANNOUNCEMENT**\n\n${text}`;
  }
}

// =====================================================
// SLASH COMMANDS
// =====================================================

const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Underdog AI something")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Your question")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("remember")
    .setDescription("Save important server information")
    .addStringOption((option) =>
      option
        .setName("information")
        .setDescription("Information to remember")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("forget")
    .setDescription("Forget a memory")
    .addStringOption((option) =>
      option
        .setName("search")
        .setDescription("Memory to remove")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("memories")
    .setDescription("View saved memories"),

  new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Set the automatic AI memory channel")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to monitor")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("personality")
    .setDescription("Change Underdog AI's personality")
    .addStringOption((option) =>
      option
        .setName("style")
        .setDescription("New personality")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("task")
    .setDescription("Manage Underdog tasks")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create a task")
        .addStringOption((option) =>
          option
            .setName("task")
            .setDescription("Task")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("due")
            .setDescription(
              "Optional ISO date, e.g. 2026-09-20T18:00:00+08:00"
            )
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List active tasks")
    )
    .addSubcommand((sub) =>
      sub
        .setName("complete")
        .setDescription("Complete a task")
        .addIntegerOption((option) =>
          option
            .setName("id")
            .setDescription("Task ID")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete a task")
        .addIntegerOption((option) =>
          option
            .setName("id")
            .setDescription("Task ID")
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName("indexchannel")
    .setDescription("Index important information from a channel")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to index")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("messages")
        .setDescription("Number of messages to scan")
        .setMinValue(10)
        .setMaxValue(1000)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("indexserver")
    .setDescription("Index important information across the server")
    .addIntegerOption((option) =>
      option
        .setName("messages")
        .setDescription(
          "Messages to scan per channel"
        )
        .setMinValue(10)
        .setMaxValue(1000)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send an announcement")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to announce in")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("Announcement")
        .setRequired(true)
    ),
].map((command) => command.toJSON());

// =====================================================
// REGISTER COMMANDS
// =====================================================

async function registerCommands() {
  try {
    const guild =
      await client.guilds.fetch(DISCORD_GUILD_ID);

    await guild.commands.set(commands);

    console.log(
      `Registered ${commands.length} slash commands.`
    );
  } catch (error) {
    console.error(
      "Command registration error:",
      error
    );
  }
}

// =====================================================
// READY
// =====================================================

client.once("ready", async () => {
  console.log(
    `Underdog AI online as ${client.user.tag}`
  );

  console.log(
    `Gemini model: ${GEMINI_MODEL}`
  );

  await registerCommands();
});

// =====================================================
// INTERACTIONS
// =====================================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // =================================================
    // /ASK
    // =================================================

    if (interaction.commandName === "ask") {
      const question =
        interaction.options.getString("question");

      await interaction.deferReply();

      const memories =
        searchMemories(question);

      const answer =
        await generateAnswer({
          userMessage: question,
          memoryContext:
            formatMemories(memories),
        });

      await interaction.editReply(answer);
      return;
    }

    // =================================================
    // STAFF-ONLY COMMAND CHECK
    // =================================================

    if (
      [
        "remember",
        "forget",
        "setchannel",
        "personality",
        "task",
        "indexchannel",
        "indexserver",
        "announce",
      ].includes(interaction.commandName)
    ) {
      if (!isAuthorizedStaff(interaction.member)) {
        await interaction.reply({
          content:
            "This command is restricted to Admin and Head Admin. 💀",
          ephemeral: true,
        });

        return;
      }
    }

    // =================================================
    // /REMEMBER
    // =================================================

    if (interaction.commandName === "remember") {
      const information =
        interaction.options.getString("information");

      saveMemory(
        "manual",
        information,
        interaction.user.id,
        interaction.user.username
      );

      await interaction.reply(
        "Saved. My brain got another upgrade. 🧠"
      );

      return;
    }

    // =================================================
    // /FORGET
    // =================================================

    if (interaction.commandName === "forget") {
      const search =
        interaction.options.getString("search");

      const rows =
        searchMemories(search, 1);

      if (!rows.length) {
        await interaction.reply(
          "Couldn't find that memory. 💀"
        );

        return;
      }

      db.prepare(
        "DELETE FROM memories WHERE id = ?"
      ).run(rows[0].id);

      await interaction.reply(
        "Gone. Like your winning streak. 💀"
      );

      return;
    }

    // =================================================
    // /MEMORIES
    // =================================================

    if (interaction.commandName === "memories") {
      const rows = db
        .prepare(`
          SELECT *
          FROM memories
          ORDER BY created_at DESC
          LIMIT 25
        `)
        .all();

      if (!rows.length) {
        await interaction.reply(
          "Memory vault is empty. 🧠"
        );

        return;
      }

      const output = rows
        .map(
          (row, i) =>
            `**${i + 1}. [${row.category}]** ${clip(
              row.content,
              250
            )}`
        )
        .join("\n\n");

      await interaction.reply(
        clip(
          `🧠 **UNDERDOG MEMORY VAULT**\n\n${output}`,
          1900
        )
      );

      return;
    }

    // =================================================
    // /SETCHANNEL
    // =================================================

    if (interaction.commandName === "setchannel") {
      const channel =
        interaction.options.getChannel("channel");

      setSetting(
        "aiChannel",
        channel.id
      );

      await interaction.reply(
        `AI monitoring channel set to ${channel}.`
      );

      return;
    }

    // =================================================
    // /PERSONALITY
    // =================================================

    if (interaction.commandName === "personality") {
      const style =
        interaction.options.getString("style");

      setSetting(
        "personality",
        style
      );

      await interaction.reply(
        "Personality updated. 💀"
      );

      return;
    }

    // =================================================
    // /TASK
    // =================================================

    if (interaction.commandName === "task") {
      const subcommand =
        interaction.options.getSubcommand();

      // -----------------------------------------------
      // CREATE
      // -----------------------------------------------

      if (subcommand === "create") {
        const task =
          interaction.options.getString("task");

        const due =
          interaction.options.getString("due");

        let dueAt = null;

        if (due) {
          const parsed =
            new Date(due).getTime();

          if (Number.isNaN(parsed)) {
            await interaction.reply(
              "That due date isn't valid. Use an ISO date like `2026-09-20T18:00:00+08:00`."
            );

            return;
          }

          dueAt = parsed;
        }

        const id = createTask(
          task,
          interaction.user.id,
          interaction.channelId,
          dueAt
        );

        await interaction.reply(
          `Task **#${id}** created. Now actually do it. 😭`
        );

        return;
      }

      // -----------------------------------------------
      // LIST
      // -----------------------------------------------

      if (subcommand === "list") {
        const tasks =
          getActiveTasks();

        if (!tasks.length) {
          await interaction.reply(
            "No active tasks. We're either productive or completely cooked. 💀"
          );

          return;
        }

        const output = tasks
          .map((task) => {
            const due = task.due_at
              ? ` — <t:${Math.floor(
                  task.due_at / 1000
                )}:R>`
              : "";

            return `**#${task.id}** ${task.task}${due}`;
          })
          .join("\n");

        await interaction.reply(
          clip(
            `📝 **ACTIVE TASKS**\n\n${output}`,
            1900
          )
        );

        return;
      }

      // -----------------------------------------------
      // COMPLETE
      // -----------------------------------------------

      if (subcommand === "complete") {
        const id =
          interaction.options.getInteger("id");

        const result =
          completeTask(id);

        if (!result.changes) {
          await interaction.reply(
            "That task doesn't exist. 💀"
          );

          return;
        }

        await interaction.reply(
          `Task **#${id}** completed. 🥊`
        );

        return;
      }

      // -----------------------------------------------
      // DELETE
      // -----------------------------------------------

      if (subcommand === "delete") {
        const id =
          interaction.options.getInteger("id");

        const result =
          deleteTask(id);

        if (!result.changes) {
          await interaction.reply(
            "That task doesn't exist. 💀"
          );

          return;
        }

        await interaction.reply(
          `Task **#${id}** deleted.`
        );

        return;
      }
    }

    // =================================================
    // /INDEXCHANNEL
    // =================================================

    if (interaction.commandName === "indexchannel") {
      const channel =
        interaction.options.getChannel("channel");

      const amount =
        interaction.options.getInteger("messages") || 100;

      await interaction.deferReply();

      const count =
        await indexChannel(
          channel,
          amount
        );

      await interaction.editReply(
        `📚 Indexed **${count}** messages from ${channel}.\n\nI only saved information I considered important.`
      );

      return;
    }

    // =================================================
    // /INDEXSERVER
    // =================================================

    if (interaction.commandName === "indexserver") {
      const amount =
        interaction.options.getInteger("messages") || 100;

      await interaction.deferReply();

      let total = 0;
      let channelsScanned = 0;

      const guild =
        interaction.guild;

      const channels =
        guild.channels.cache.filter(
          (channel) =>
            channel.type === ChannelType.GuildText &&
            channel.viewable
        );

      for (const channel of channels.values()) {
        try {
          const count =
            await indexChannel(
              channel,
              amount
            );

          total += count;
          channelsScanned++;

          await new Promise((resolve) =>
            setTimeout(resolve, 500)
          );
        } catch (error) {
          console.error(
            `Index error in ${channel.name}:`,
            error
          );
        }
      }

      await interaction.editReply(
        `🌐 **Server indexing complete.**\n\nChannels scanned: **${channelsScanned}**\nMessages processed: **${total}**`
      );

      return;
    }

    // =================================================
    // /ANNOUNCE
    // =================================================

    if (interaction.commandName === "announce") {
      const channel =
        interaction.options.getChannel("channel");

      const message =
        interaction.options.getString("message");

      if (!channel.isTextBased()) {
        await interaction.reply(
          "That isn't a text channel."
        );

        return;
      }

      const botMember =
        interaction.guild.members.me;

      const permissions =
        channel.permissionsFor(botMember);

      if (
        !permissions?.has(
          PermissionFlagsBits.ViewChannel
        ) ||
        !permissions?.has(
          PermissionFlagsBits.SendMessages
        )
      ) {
        await interaction.reply(
          `I don't have permission to send messages in ${channel}.`
        );

        return;
      }

      const announcement =
        await generateAnnouncement(message);

      await channel.send({
        content: announcement,
        allowedMentions: {
          parse: [],
        },
      });

      saveMemory(
        "announcement",
        message,
        interaction.user.id,
        interaction.user.username
      );

      await interaction.reply(
        `Announcement posted in ${channel}. 📢`
      );

      return;
    }
  } catch (error) {
    console.error(
      "Interaction error:",
      error
    );

    if (
      interaction.replied ||
      interaction.deferred
    ) {
      await interaction.editReply(
        "Something broke on my end. 💀"
      );
    } else {
      await interaction.reply({
        content:
          "Something broke on my end. 💀",
        ephemeral: true,
      });
    }
  }
});

// =====================================================
// MESSAGE HANDLER
// =====================================================

client.on("messageCreate", async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const aiChannel =
    getSetting("aiChannel");

  // =================================================
  // AUTOMATIC MEMORY
  // =================================================

  if (
    aiChannel &&
    message.channel.id === aiChannel &&
    message.content.trim()
  ) {
    try {
      const classification =
        await classifyForMemory(
          message.content
        );

      if (classification) {
        saveMemory(
          classification.category,
          message.content,
          message.author.id,
          message.author.username
        );
      }
    } catch (error) {
      console.error(
        "Automatic memory error:",
        error
      );
    }
  }

  // =================================================
  // BOT MENTION
  // =================================================

  const mentioned =
    message.mentions.users.has(
      client.user.id
    );

  // =================================================
  // DIRECT REPLY TO BOT
  // =================================================

  let repliedToBot = false;

  if (message.reference?.messageId) {
    try {
      const referenced =
        await message.channel.messages.fetch(
          message.reference.messageId
        );

      repliedToBot =
        referenced.author.id ===
        client.user.id;
    } catch {
      repliedToBot = false;
    }
  }

  if (!mentioned && !repliedToBot) {
    return;
  }

  // =================================================
  // REMOVE BOT MENTION
  // =================================================

  let content =
    message.content;

  const mentionRegex =
    new RegExp(
      `<@!?${client.user.id}>`,
      "g"
    );

  content = content
    .replace(mentionRegex, "")
    .trim();

  if (!content) {
    await message.reply(
      randomItem([
        "What do you want, champ? 💀",
        "You called?",
        "I'm listening. Make it quick. 🥊",
        "Bro summoned me just to say nothing. 😭",
      ])
    );

    return;
  }

  // =================================================
  // STAFF-DIRECTED INSTRUCTION
  // =================================================

  if (
    mentioned &&
    isAuthorizedStaff(message.member)
  ) {
    const handled =
      await handleStaffInstruction(
        message,
        content
      );

    if (handled) {
      return;
    }
  }

  // =================================================
  // NORMAL AI CHAT
  // =================================================

  try {
    await message.channel.sendTyping();

    const memories =
      searchMemories(content);

    const staffContext =
      isAuthorizedStaff(
        message.member
      )
        ? "The user is an authorized Admin or Head Admin."
        : "";

    const answer =
      await generateAnswer({
        userMessage: content,
        memoryContext:
          formatMemories(memories),
        staffContext,
      });

    await message.reply(answer);
  } catch (error) {
    console.error(
      "Message AI error:",
      error
    );

    await message.reply(
      "My brain just got countered. Try again. 💀"
    );
  }
});

// =====================================================
// ERRORS
// =====================================================

client.on("error", (error) => {
  console.error(
    "Discord client error:",
    error
  );
});

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

// =====================================================
// LOGIN
// =====================================================

client.login(DISCORD_TOKEN);
