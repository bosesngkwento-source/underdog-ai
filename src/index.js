require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const Database = require("better-sqlite3");
const { GoogleGenAI, Type } = require("@google/genai");

// =====================================================
// ENVIRONMENT
// =====================================================

const requiredEnv = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "GEMINI_API_KEY",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

// =====================================================
// DATABASE
// =====================================================

const db = new Database("underdog.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    information TEXT NOT NULL,
    category TEXT NOT NULL,
    date TEXT NOT NULL,
    channel TEXT,
    author TEXT,
    importance INTEGER NOT NULL DEFAULT 3
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memories_category
  ON memories(category);

  CREATE INDEX IF NOT EXISTS idx_memories_date
  ON memories(date);
`);

// =====================================================
// GEMINI
// =====================================================

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

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
// SETTINGS
// =====================================================

function getSetting(key) {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key);

  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function getCsvSetting(key) {
  const value = getSetting(key);

  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// =====================================================
// HELPERS
// =====================================================

function clip(text, max = 1800) {
  if (!text) return "";

  text = String(text);

  if (text.length <= max) {
    return text;
  }

  return text.slice(0, max - 3) + "...";
}

function isStaff(member) {
  if (!member) return false;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const roles = getCsvSetting("staffRoles");

  return member.roles.cache.some((role) =>
    roles.includes(role.id)
  );
}

function isHighRank(member) {
  if (!member) return false;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const roles = getCsvSetting("highRankRoles");

  return member.roles.cache.some((role) =>
    roles.includes(role.id)
  );
}

// =====================================================
// MEMORY
// =====================================================

function saveMemory({
  information,
  category,
  channel,
  author,
  importance = 3,
}) {
  if (!information) {
    return;
  }

  db.prepare(`
    INSERT INTO memories
    (
      information,
      category,
      date,
      channel,
      author,
      importance
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    clip(information, 2000),
    category || "general",
    new Date().toISOString(),
    channel || null,
    author || null,
    Math.max(1, Math.min(5, Number(importance) || 3))
  );
}

function searchMemories(query, limit = 10) {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 10);

  if (!words.length) {
    return db
      .prepare(`
        SELECT *
        FROM memories
        ORDER BY importance DESC, id DESC
        LIMIT ?
      `)
      .all(limit);
  }

  const conditions = words
    .map(
      () =>
        `(LOWER(information) LIKE ? OR LOWER(category) LIKE ?)`
    )
    .join(" OR ");

  const params = [];

  for (const word of words) {
    const search = `%${word}%`;
    params.push(search, search);
  }

  params.push(limit);

  return db
    .prepare(`
      SELECT *
      FROM memories
      WHERE ${conditions}
      ORDER BY importance DESC, id DESC
      LIMIT ?
    `)
    .all(...params);
}

function formatMemories(memories) {
  if (!memories.length) {
    return "No relevant memories were found.";
  }

  return memories
    .map(
      (memory, index) =>
        `${index + 1}. [${memory.category}] ${memory.information}`
    )
    .join("\n");
}

// =====================================================
// GEMINI ANSWER
// =====================================================

async function generateAnswer(question, memories = []) {
  const memoryText = formatMemories(memories);

  const systemInstruction = `
You are Underdog AI, the AI assistant for the Underdog Boxing Game Discord server.

Personality:
- Friendly
- Energetic
- Helpful
- Boxing/gaming themed
- You can make harmless jokes
- Do not be hateful, threatening, or seriously abusive

IMPORTANT:
Use the server memories provided below when answering.

If the answer is not contained in the memories and you do not know it,
say that you don't know instead of inventing information.

SERVER MEMORIES:
${memoryText}
`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: question,
      config: {
        systemInstruction,
        temperature: 0.5,
        maxOutputTokens: 500,
      },
    });

    return clip(
      response.text || "I don't know that yet."
    );
  } catch (error) {
    console.error("Gemini error:", error);

    return "I couldn't reach my AI brain right now. Try again in a moment.";
  }
}

// =====================================================
// AUTOMATIC MEMORY CLASSIFICATION
// =====================================================

async function classifyForMemory(message) {
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: message.content.slice(0, 5000),

      config: {
        systemInstruction: `
You classify Discord messages for long-term server memory.

Only remember information that is genuinely useful later.

Examples worth remembering:
- Announcements
- Rules
- Updates
- Patch notes
- Events
- Rankings
- P4P rankings
- Fighter records
- Belt holders
- Hall of Fame information
- Staff decisions
- Important server information

Do NOT remember:
- Normal conversations
- Greetings
- Jokes
- Random messages
- Temporary personal chatter

Return JSON only.
`,
        temperature: 0,
        maxOutputTokens: 250,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            remember: {
              type: Type.BOOLEAN,
            },
            category: {
              type: Type.STRING,
            },
            importance: {
              type: Type.INTEGER,
            },
            information: {
              type: Type.STRING,
            },
          },
          required: [
            "remember",
            "category",
            "importance",
            "information",
          ],
        },
      },
    });

    const text = response.text;

    if (!text) {
      return null;
    }

    const result = JSON.parse(text);

    if (!result.remember) {
      return null;
    }

    return result;
  } catch (error) {
    console.error(
      "Memory classification error:",
      error?.message || error
    );

    return null;
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
    )
    .addStringOption((option) =>
      option
        .setName("category")
        .setDescription("Memory category")
        .setRequired(false)
    )
    .addIntegerOption((option) =>
      option
        .setName("importance")
        .setDescription("Importance from 1 to 5")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(5)
    ),

  new SlashCommandBuilder()
    .setName("forget")
    .setDescription("Forget a memory")
    .addIntegerOption((option) =>
      option
        .setName("id")
        .setDescription("Memory ID")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("memories")
    .setDescription("View saved memories"),

  new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Set the AI chat channel")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel for AI conversations")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("personality")
    .setDescription("Set Underdog AI personality")
    .addStringOption((option) =>
      option
        .setName("text")
        .setDescription("Personality instructions")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("task")
    .setDescription("Create a staff task")
    .addStringOption((option) =>
      option
        .setName("task")
        .setDescription("Task description")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send an announcement")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("Announcement")
        .setRequired(true)
    ),
];

// =====================================================
// REGISTER COMMANDS
// =====================================================

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_TOKEN
  );

  try {
    console.log("Registering slash commands...");

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      {
        body: commands.map((command) =>
          command.toJSON()
        ),
      }
    );

    console.log("Slash commands registered.");
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

  await registerCommands();
});

// =====================================================
// INTERACTIONS
// =====================================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    // -----------------------------------------------
    // /ask
    // -----------------------------------------------

    if (interaction.commandName === "ask") {
      const question =
        interaction.options.getString("question");

      await interaction.deferReply();

      const memories = searchMemories(question, 10);

      const answer = await generateAnswer(
        question,
        memories
      );

      await interaction.editReply(answer);
      return;
    }

    // -----------------------------------------------
    // /remember
    // -----------------------------------------------

    if (interaction.commandName === "remember") {
      if (!isStaff(interaction.member)) {
        await interaction.reply({
          content:
            "You need staff permissions to manage memories.",
          ephemeral: true,
        });

        return;
      }

      const information =
        interaction.options.getString("information");

      const category =
        interaction.options.getString("category") ||
        "general";

      const importance =
        interaction.options.getInteger("importance") ||
        3;

      saveMemory({
        information,
        category,
        importance,
        channel: interaction.channelId,
        author: interaction.user.tag,
      });

      await interaction.reply(
        `🧠 Remembered: **${clip(information, 500)}**`
      );

      return;
    }

    // -----------------------------------------------
    // /forget
    // -----------------------------------------------

    if (interaction.commandName === "forget") {
      if (!isStaff(interaction.member)) {
        await interaction.reply({
          content:
            "You need staff permissions to manage memories.",
          ephemeral: true,
        });

        return;
      }

      const id =
        interaction.options.getInteger("id");

      const result = db
        .prepare("DELETE FROM memories WHERE id = ?")
        .run(id);

      if (result.changes === 0) {
        await interaction.reply(
          `I couldn't find memory #${id}.`
        );
      } else {
        await interaction.reply(
          `🗑️ Forgot memory #${id}.`
        );
      }

      return;
    }

    // -----------------------------------------------
    // /memories
    // -----------------------------------------------

    if (interaction.commandName === "memories") {
      if (!isStaff(interaction.member)) {
        await interaction.reply({
          content:
            "You need staff permissions to view memories.",
          ephemeral: true,
        });

        return;
      }

      const memories = db
        .prepare(`
          SELECT *
          FROM memories
          ORDER BY importance DESC, id DESC
          LIMIT 20
        `)
        .all();

      if (!memories.length) {
        await interaction.reply(
          "🧠 There are no saved memories yet."
        );

        return;
      }

      const text = memories
        .map(
          (memory) =>
            `**#${memory.id}** [${memory.category}] ${clip(
              memory.information,
              250
            )}`
        )
        .join("\n");

      await interaction.reply(
        `🧠 **Underdog AI Memories**\n\n${clip(text, 1900)}`
      );

      return;
    }

    // -----------------------------------------------
    // /setchannel
    // -----------------------------------------------

    if (interaction.commandName === "setchannel") {
      if (!isStaff(interaction.member)) {
        await interaction.reply({
          content:
            "You need staff permissions to configure the bot.",
          ephemeral: true,
        });

        return;
      }

      const channel =
        interaction.options.getChannel("channel");

      setSetting("aiChannel", channel.id);

      await interaction.reply(
        `✅ AI chat channel set to <#${channel.id}>.`
      );

      return;
    }

    // -----------------------------------------------
    // /personality
    // -----------------------------------------------

    if (interaction.commandName === "personality") {
      if (!isHighRank(interaction.member)) {
        await interaction.reply({
          content:
            "Only high-ranking staff can change my personality.",
          ephemeral: true,
        });

        return;
      }

      const personality =
        interaction.options.getString("text");

      setSetting("personality", personality);

      await interaction.reply(
        "✅ My personality instructions have been updated."
      );

      return;
    }

    // -----------------------------------------------
    // /task
    // -----------------------------------------------

    if (interaction.commandName === "task") {
      if (!isHighRank(interaction.member)) {
        await interaction.reply({
          content:
            "Only high-ranking staff can create AI tasks.",
          ephemeral: true,
        });

        return;
      }

      const task =
        interaction.options.getString("task");

      saveMemory({
        information: `Staff task: ${task}`,
        category: "staff task",
        importance: 4,
        channel: interaction.channelId,
        author: interaction.user.tag,
      });

      await interaction.reply(
        `📋 **Task saved:** ${task}`
      );

      return;
    }

    // -----------------------------------------------
    // /announce
    // -----------------------------------------------

    if (interaction.commandName === "announce") {
      if (!isHighRank(interaction.member)) {
        await interaction.reply({
          content:
            "Only high-ranking staff can create announcements.",
          ephemeral: true,
        });

        return;
      }

      const announcement =
        interaction.options.getString("message");

      saveMemory({
        information: announcement,
        category: "announcement",
        importance: 5,
        channel: interaction.channelId,
        author: interaction.user.tag,
      });

      await interaction.reply(
        `📢 **Announcement saved:**\n${announcement}`
      );

      return;
    }
  } catch (error) {
    console.error(
      "Interaction error:",
      error
    );

    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(
        "Something went wrong while processing that command."
      );
    } else {
      await interaction.reply({
        content:
          "Something went wrong while processing that command.",
        ephemeral: true,
      });
    }
  }
});

// =====================================================
// NORMAL MESSAGE HANDLING
// =====================================================

client.on("messageCreate", async (message) => {
  if (message.author.bot) {
    return;
  }

  if (!message.guild) {
    return;
  }

  // -----------------------------------------------
  // Automatic memory
  // -----------------------------------------------

  const aiChannel = getSetting("aiChannel");

  const shouldMonitor =
    aiChannel && message.channel.id === aiChannel;

  if (shouldMonitor) {
    const result = await classifyForMemory(message);

    if (result?.remember && result.information) {
      saveMemory({
        information: result.information,
        category: result.category || "general",
        importance: result.importance || 3,
        channel: message.channelId,
        author: message.author.tag,
      });

      console.log(
        `Saved memory: ${result.information}`
      );
    }
  }

  // -----------------------------------------------
  // Respond when mentioned
  // -----------------------------------------------

  const mentioned =
    message.mentions.has(client.user);

  if (!mentioned && !shouldMonitor) {
    return;
  }

  let question = message.content
    .replace(`<@${client.user.id}>`, "")
    .trim();

  if (!question) {
    question = "Say hello to the server.";
  }

  const memories = searchMemories(question, 10);

  const answer = await generateAnswer(
    question,
    memories
  );

  await message.reply(answer);
});
// =====================================================
// ERRORS
// =====================================================

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

process.on("unhandledRejection", (error) => {
  console.error(
    "Unhandled rejection:",
    error?.message || error
  );
});

// =====================================================
// LOGIN
// =====================================================

client.login(process.env.DISCORD_TOKEN);
