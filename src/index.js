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

// =========================
// ENVIRONMENT
// =========================

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  GEMINI_API_KEY,
} = process.env;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!DISCORD_CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID");
if (!DISCORD_GUILD_ID) throw new Error("Missing DISCORD_GUILD_ID");
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

// =========================
// CONFIG
// =========================

const STAFF_ROLE_IDS = new Set([
  "1530288888411852891", // Admin
  "1530288809932099634", // Head Admin
]);

const BOT_PREFIX = "Underdog AI";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.GuildMember,
  ],
});

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

// =========================
// DATABASE
// =========================

const db = new Database("underdog.sqlite");

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (guild_id, key)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  task TEXT NOT NULL,
  created_by TEXT,
  due_at INTEGER,
  completed INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS indexed_messages (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, message_id)
);

CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// =========================
// HELPERS
// =========================

function clip(text, max = 5000) {
  if (!text) return "";
  return String(text).slice(0, max);
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getSetting(guildId, key) {
  return db
    .prepare(
      `SELECT value FROM settings
       WHERE guild_id = ? AND key = ?`
    )
    .get(guildId, key)?.value;
}

function setSetting(guildId, key, value) {
  db.prepare(`
    INSERT INTO settings (guild_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, key)
    DO UPDATE SET value = excluded.value
  `).run(guildId, key, value);
}

function isAuthorizedStaff(member) {
  if (!member) return false;

  return member.roles.cache.some((role) =>
    STAFF_ROLE_IDS.has(role.id)
  );
}

function hasBotPermission(guild, permission) {
  const me = guild.members.me;
  if (!me) return false;

  return me.permissions.has(permission);
}

function cleanBotMention(text) {
  return text
    .replace(/<@!?\d+>/g, "")
    .trim();
}

// =========================
// MEMORY
// =========================

function saveMemory(
  guildId,
  category,
  content,
  createdBy = null
) {
  db.prepare(`
    INSERT INTO memories
    (guild_id, category, content, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    guildId,
    category,
    clip(content, 10000),
    createdBy,
    Date.now()
  );
}

function deleteMemory(guildId, id) {
  return db.prepare(`
    DELETE FROM memories
    WHERE guild_id = ? AND id = ?
  `).run(guildId, id);
}

function searchMemories(guildId, query, limit = 12) {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((x) => x.length > 2)
    .slice(0, 8);

  if (!words.length) {
    return db.prepare(`
      SELECT * FROM memories
      WHERE guild_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(guildId, limit);
  }

  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE guild_id = ?
    ORDER BY created_at DESC
    LIMIT 300
  `).all(guildId);

  const scored = rows.map((row) => {
    const lower = row.content.toLowerCase();

    let score = 0;

    for (const word of words) {
      if (lower.includes(word)) score++;
    }

    return {
      ...row,
      score,
    };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function formatMemories(rows) {
  if (!rows.length) {
    return "I don't have anything relevant stored.";
  }

  return rows
    .map(
      (m) =>
        `[#${m.id}] [${m.category}] ${m.content}`
    )
    .join("\n");
}

// =========================
// GEMINI
// =========================

async function generateAI(prompt, options = {}) {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      temperature:
        options.temperature ?? 0.75,
      maxOutputTokens:
        options.maxOutputTokens ?? 500,
    },
  });

  return response.text?.trim() || "";
}

// =========================
// PERSONALITY
// =========================

function getPersonality(guildId) {
  return (
    getSetting(guildId, "personality") ||
    `
You are Underdog AI, the AI assistant for a Roblox boxing Discord server.

Personality:
- Friendly
- Energetic
- Boxing/gaming style
- Short and natural replies
- Can use casual slang
- Can lightly tease users
- Can make harmless jokes
- Do not become hateful, threatening, or seriously abusive
- Be professional when handling moderation or tickets
- Never invent server information
- If information is unknown, say you do not know
`
  );
}

// =========================
// NORMAL AI ANSWERS
// =========================

async function answerUser(guild, member, question) {
  const memories = searchMemories(
    guild.id,
    question,
    15
  );

  const memoryText = formatMemories(memories);

  const prompt = `
${getPersonality(guild.id)}

You are answering a Discord user.

Server:
${guild.name}

User:
${member?.displayName || "Unknown"}

Relevant stored server information:
${memoryText}

Question:
${question}

Rules:
- Use stored information when relevant.
- Do not invent facts about this server.
- If the stored information does not answer the question, say you don't know.
- Keep the response reasonably short.
`;

  return generateAI(prompt);
}

// =========================
// MEMORY CLASSIFICATION
// =========================

async function classifyForMemory(message) {
  const prompt = `
Determine whether this Discord message contains important
long-term server information that should be remembered.

Important information includes:
- Rules
- Announcements
- Updates
- Patch notes
- Events
- Tournament information
- Rankings
- P4P rankings
- Fighter records
- Belt holders
- Hall of Fame
- Staff decisions
- Important server procedures

Do NOT save:
- Casual conversation
- Jokes
- Greetings
- Random opinions
- Temporary chatter
- Ordinary questions

Return JSON only:

{
  "save": true or false,
  "category": "rules|announcement|update|event|ranking|fighter|staff|other",
  "reason": "short reason"
}

Message:
${clip(message, 4000)}
`;

  try {
    const text = await generateAI(prompt, {
      temperature: 0.1,
      maxOutputTokens: 200,
    });

    const cleaned = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(cleaned);
  } catch {
    return {
      save: false,
      category: "other",
      reason: "classification failed",
    };
  }
}

// =========================
// CHANNEL INDEXING
// =========================

async function indexChannel(channel, maxMessages = 100) {
  if (!channel?.isTextBased()) {
    return 0;
  }

  let lastId;
  let indexed = 0;

  while (indexed < maxMessages) {
    const remaining = Math.min(
      100,
      maxMessages - indexed
    );

    const messages = await channel.messages.fetch({
      limit: remaining,
      ...(lastId ? { before: lastId } : {}),
    });

    if (!messages.size) break;

    const ordered = [...messages.values()].reverse();

    for (const message of ordered) {
      lastId = message.id;

      if (message.author.bot) continue;

      const exists = db
        .prepare(`
          SELECT 1 FROM indexed_messages
          WHERE guild_id = ? AND message_id = ?
        `)
        .get(
          channel.guild.id,
          message.id
        );

      if (exists) continue;

      const result =
        await classifyForMemory(message.content);

      if (result.save) {
        saveMemory(
          channel.guild.id,
          result.category,
          `[${channel.name}] ${message.content}`,
          message.author.id
        );
      }

      db.prepare(`
        INSERT OR IGNORE INTO indexed_messages
        (guild_id, message_id)
        VALUES (?, ?)
      `).run(
        channel.guild.id,
        message.id
      );

      indexed++;

      if (indexed >= maxMessages) break;
    }

    if (messages.size < remaining) break;
  }

  return indexed;
}

// =========================
// MEMBER INFORMATION
// =========================

function getMemberInformation(member) {
  if (!member) return "Member not found.";

  const roles = member.roles.cache
    .filter((role) => role.id !== member.guild.id)
    .map((role) => role.name)
    .join(", ") || "None";

  const accountCreated =
    `<t:${Math.floor(
      member.user.createdTimestamp / 1000
    )}:F>`;

  const joined =
    member.joinedTimestamp
      ? `<t:${Math.floor(
          member.joinedTimestamp / 1000
        )}:F>`
      : "Unknown";

  return `
👤 **${member.user.tag}**

ID: \`${member.id}\`
Display Name: ${member.displayName}
Account Created: ${accountCreated}
Joined Server: ${joined}
Roles: ${roles}
Bot: ${member.user.bot ? "Yes" : "No"}
Nickname: ${member.nickname || "None"}
`;
}

// =========================
// WARNINGS
// =========================

function addWarning(
  guildId,
  userId,
  moderatorId,
  reason
) {
  db.prepare(`
    INSERT INTO warnings
    (guild_id, user_id, moderator_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    guildId,
    userId,
    moderatorId,
    clip(reason, 1000),
    Date.now()
  );
}

function getWarnings(guildId, userId) {
  return db.prepare(`
    SELECT *
    FROM warnings
    WHERE guild_id = ?
      AND user_id = ?
    ORDER BY created_at DESC
  `).all(guildId, userId);
}

// =========================
// ROLE MANAGEMENT
// =========================

async function renameRole(
  guild,
  role,
  newName,
  executor
) {
  if (!isAuthorizedStaff(executor)) {
    return {
      ok: false,
      message: "You aren't authorized to manage roles.",
    };
  }

  const botMember = guild.members.me;

  if (!botMember) {
    return {
      ok: false,
      message: "I can't determine my role hierarchy.",
    };
  }

  if (role.managed) {
    return {
      ok: false,
      message: "That role is managed by Discord/integration and cannot be renamed.",
    };
  }

  if (role.position >= botMember.roles.highest.position) {
    return {
      ok: false,
      message: "That role is above or equal to my highest role.",
    };
  }

  try {
    await role.setName(newName);

    return {
      ok: true,
      message: `Renamed **${role.name}** to **${newName}**.`,
    };
  } catch (error) {
    console.error(error);

    return {
      ok: false,
      message: "I couldn't rename that role. Check my Manage Roles permission.",
    };
  }
}

// =========================
// KICK
// =========================

async function kickMember(
  guild,
  target,
  executor,
  reason
) {
  if (!isAuthorizedStaff(executor)) {
    return {
      ok: false,
      message: "You aren't authorized to kick members.",
    };
  }

  const botMember = guild.members.me;

  if (!botMember.permissions.has(
    PermissionFlagsBits.KickMembers
  )) {
    return {
      ok: false,
      message: "I don't have the Kick Members permission.",
    };
  }

  if (!target) {
    return {
      ok: false,
      message: "I couldn't find that member.",
    };
  }

  if (target.id === executor.id) {
    return {
      ok: false,
      message: "You can't kick yourself through me.",
    };
  }

  if (target.id === client.user.id) {
    return {
      ok: false,
      message: "Nice try. I'm not kicking myself.",
    };
  }

  if (
    target.roles.highest.position >=
    botMember.roles.highest.position
  ) {
    return {
      ok: false,
      message: "That member's highest role is above or equal to mine.",
    };
  }

  try {
    await target.kick(reason);

    return {
      ok: true,
      message: `👢 Kicked **${target.user.tag}**.\nReason: ${reason}`,
    };
  } catch (error) {
    console.error(error);

    return {
      ok: false,
      message: "Discord rejected the kick. Check my hierarchy and permissions.",
    };
  }
}

// =========================
// ANNOUNCEMENT
// =========================

async function generateAnnouncement(text) {
  try {
    return await generateAI(
      `
Turn the following into a clean Discord announcement.

Keep the original meaning.
Do not invent information.
Make it readable and energetic.
Use emojis when appropriate.
Do not use @everyone or @here unless the original instruction explicitly requests it.

Message:
${text}
`,
      {
        temperature: 0.5,
        maxOutputTokens: 400,
      }
    );
  } catch {
    return `📢 **ANNOUNCEMENT**\n\n${text}`;
  }
}

async function sendAnnouncement(
  guild,
  channel,
  text,
  executor,
  mentionEveryone = false
) {
  if (!isAuthorizedStaff(executor)) {
    return "You aren't authorized to send staff announcements.";
  }

  if (!channel?.isTextBased()) {
    return "That isn't a text channel.";
  }

  const me = guild.members.me;

  if (
    !me ||
    !channel
      .permissionsFor(me)
      ?.has(PermissionFlagsBits.SendMessages)
  ) {
    return "I don't have permission to send messages there.";
  }

  const announcement =
    await generateAnnouncement(text);

  const allowedMentions = mentionEveryone
    ? {
        parse: ["everyone"],
      }
    : {
        parse: [],
      };

  await channel.send({
    content: announcement,
    allowedMentions,
  });

  saveMemory(
    guild.id,
    "announcement",
    `[${channel.name}] ${text}`,
    executor.id
  );

  return `📢 Announcement posted in ${channel}.`;
}

// =========================
// NATURAL STAFF COMMANDS
// =========================

async function handleStaffInstruction(
  message,
  instruction
) {
  const guild = message.guild;
  const member = message.member;

  if (!isAuthorizedStaff(member)) {
    await message.reply(
      "You can chat with me, but you aren't authorized to give me staff commands."
    );
    return;
  }

  const text = instruction.trim();

  // -------------------------
  // ANNOUNCEMENT
  // -------------------------

  const announcementWords =
    /\b(announce|announcement|post this|send this|publish)\b/i;

  if (announcementWords.test(text)) {
    const channelMatch =
      text.match(/<#(\d+)>/);

    if (!channelMatch) {
      await message.reply(
        "Sure — mention the channel you want me to post it in."
      );
      return;
    }

    const channel =
      guild.channels.cache.get(
        channelMatch[1]
      );

    if (!channel) {
      await message.reply(
        "I couldn't find that channel."
      );
      return;
    }

    let announcementText =
      text
        .replace(/<#\d+>/g, "")
        .replace(
          /\b(announce|announcement|post this|send this|publish)\b/gi,
          ""
        )
        .trim();

    announcementText =
      announcementText
        .replace(
          /^(this|that|saying|say|message)\s*[:,-]?\s*/i,
          ""
        )
        .trim();

    if (!announcementText) {
      await message.reply(
        "What do you want the announcement to say?"
      );
      return;
    }

    const wantsEveryone =
      /@everyone|everyone/i.test(text);

    const result =
      await sendAnnouncement(
        guild,
        channel,
        announcementText,
        member,
        wantsEveryone
      );

    await message.reply(result);
    return;
  }

  // -------------------------
  // WARN
  // -------------------------

  const warnMatch =
    text.match(
      /\b(warn|warning|verbal warn|verbally warn)\b[\s\S]*?<@!?(\d+)>/i
    );

  if (warnMatch) {
    const userId = warnMatch[2];

    const target =
      await guild.members
        .fetch(userId)
        .catch(() => null);

    if (!target) {
      await message.reply(
        "I couldn't find that member."
      );
      return;
    }

    let reason =
      text
        .replace(
          /\b(warn|warning|verbal warn|verbally warn)\b/gi,
          ""
        )
        .replace(
          /<@!?\d+>/g,
          ""
        )
        .replace(
          /^(because|for|reason)\s*/i,
          ""
        )
        .trim();

    if (!reason) {
      reason = "Staff-issued verbal warning.";
    }

    addWarning(
      guild.id,
      target.id,
      member.id,
      reason
    );

    await message.channel.send(
      `⚠️ **Verbal Warning**\n${target} has been verbally warned.\n**Reason:** ${reason}`
    );

    return;
  }

  // -------------------------
  // KICK
  // -------------------------

  const kickMatch =
    text.match(
      /\b(kick|remove)\b[\s\S]*?<@!?(\d+)>/i
    );

  if (kickMatch) {
    const target =
      await guild.members
        .fetch(kickMatch[2])
        .catch(() => null);

    const reason =
      text
        .replace(
          /\b(kick|remove)\b/gi,
          ""
        )
        .replace(
          /<@!?\d+>/g,
          ""
        )
        .trim() ||
      "Staff action.";

    const result =
      await kickMember(
        guild,
        target,
        member,
        reason
      );

    await message.reply(
      result.message
    );

    return;
  }

  // -------------------------
  // ROLE RENAME
  // -------------------------

  const renameMatch =
    text.match(
      /\b(rename|change the name of)\b[\s\S]*?<@&(\d+)>[\s\S]*?\bto\b\s+(.+)/i
    );

  if (renameMatch) {
    const role =
      guild.roles.cache.get(
        renameMatch[2]
      );

    const newName =
      renameMatch[3]
        .trim()
        .replace(/^["']|["']$/g, "");

    if (!role) {
      await message.reply(
        "I couldn't find that role."
      );
      return;
    }

    const result =
      await renameRole(
        guild,
        role,
        newName,
        member
      );

    await message.reply(
      result.message
    );

    return;
  }

  // -------------------------
  // MEMBER INFO
  // -------------------------

  const mentionedUser =
    message.mentions.members.first();

  if (
    mentionedUser &&
    /\b(profile|information|info|about|details|join date|stats)\b/i.test(text)
  ) {
    await message.reply(
      getMemberInformation(
        mentionedUser
      )
    );

    return;
  }

  // -------------------------
  // FALLBACK AI
  // -------------------------

  const answer =
    await answerUser(
      guild,
      member,
      text
    );

  await message.reply(
    answer || "I'm not sure what you want me to do."
  );
}

// =========================
// TICKET ASSISTANT
// =========================

function looksLikeTicket(channel) {
  if (!channel) return false;

  const channelName =
    channel.name?.toLowerCase() || "";

  const parentName =
    channel.parent?.name?.toLowerCase() || "";

  return (
    channelName.includes("ticket") ||
    parentName.includes("ticket") ||
       parentName.includes("support")
  );
}

async function handleTicketCreated(channel) {
  if (!looksLikeTicket(channel)) return;

  await new Promise((resolve) =>
    setTimeout(resolve, 1500)
  );

  try {
    const messages =
      await channel.messages.fetch({
        limit: 10,
      });

    const recent = [...messages.values()]
      .reverse()
      .filter((m) => !m.author.bot)
      .map(
        (m) =>
          `${m.author.tag}: ${clip(m.content, 1000)}`
      )
      .join("\n");

    const summary = recent
      ? await generateAI(
          `
You are assisting staff inside a Discord support ticket.

Summarize the user's issue in 2-4 short bullet points.
Do not make decisions for staff.

Ticket messages:
${recent}
`,
          {
            temperature: 0.2,
            maxOutputTokens: 250,
          }
        )
      : "No issue has been described yet.";

    await channel.send(
      `🎫 **Underdog AI Ticket Assistant**

Hey! I'm here to help with this ticket.

**Current summary:**
${summary}

Please explain what you need help with, and I'll help staff understand the issue.`
    );
  } catch (error) {
    console.error(
      "Ticket assistant error:",
      error
    );
  }
}

// =========================
// SLASH COMMANDS
// =========================

const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Underdog AI")
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
    .setDescription("Forget a stored memory")
    .addIntegerOption((option) =>
      option
        .setName("id")
        .setDescription("Memory ID")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("memories")
    .setDescription("View stored server memories"),

  new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Set the automatic AI/memory channel")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("personality")
    .setDescription("Change Underdog AI personality")
    .addStringOption((option) =>
      option
        .setName("personality")
        .setDescription("New personality")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("indexchannel")
    .setDescription("Index a channel")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to index")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("indexserver")
    .setDescription("Index server channels"),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send an announcement")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("Announcement")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View a member's warnings")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("memberinfo")
    .setDescription("View server member information")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Member")
        .setRequired(true)
    ),
].map((command) => command.toJSON());

// =========================
// REGISTER COMMANDS
// =========================

async function registerCommands() {
  const { REST } = require("@discordjs/rest");
  const { Routes } = require("discord-api-types/v10");

  const rest = new REST({
    version: "10",
  }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      DISCORD_CLIENT_ID,
      DISCORD_GUILD_ID
    ),
    {
      body: commands,
    }
  );

  console.log("Slash commands registered.");
}

// =========================
// READY
// =========================

client.once("ready", async () => {
  console.log(
    `🥊 ${client.user.tag} is online.`
  );

  try {
    await registerCommands();
  } catch (error) {
    console.error(
      "Command registration error:",
      error
    );
  }

  // Task reminder loop
  setInterval(async () => {
    const now = Date.now();

    const dueTasks = db.prepare(`
      SELECT *
      FROM tasks
      WHERE completed = 0
        AND due_at IS NOT NULL
        AND due_at <= ?
    `).all(now);

    for (const task of dueTasks) {
      try {
        const guild =
          client.guilds.cache.get(
            task.guild_id
          );

        if (!guild) continue;

        const channelId =
          getSetting(
            task.guild_id,
            "ai_channel"
          );

        if (!channelId) continue;

        const channel =
          guild.channels.cache.get(
            channelId
          );

        if (!channel) continue;

        await channel.send(
          `⏰ **Task Reminder**\n${task.task}`
        );

        db.prepare(`
          UPDATE tasks
          SET completed = 1
          WHERE id = ?
        `).run(task.id);
      } catch (error) {
        console.error(
          "Task reminder error:",
          error
        );
      }
    }
  }, 30000);
});

// =========================
// INTERACTIONS
// =========================

client.on(
  "interactionCreate",
  async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const {
      commandName,
      guild,
      member,
    } = interaction;

    if (!guild) return;

    const staffCommands = new Set([
      "remember",
      "forget",
      "setchannel",
      "personality",
      "indexchannel",
      "indexserver",
      "announce",
      "warnings",
    ]);

    if (
      staffCommands.has(commandName) &&
      !isAuthorizedStaff(member)
    ) {
      await interaction.reply({
        content:
          "You don't have permission to use this command.",
        ephemeral: true,
      });

      return;
    }

    try {
      // ASK
      if (commandName === "ask") {
        const question =
          interaction.options.getString(
            "question"
          );

        await interaction.deferReply();

        const answer =
          await answerUser(
            guild,
            member,
            question
          );

        await interaction.editReply(
          answer || "I don't know."
        );

        return;
      }

      // REMEMBER
      if (commandName === "remember") {
        const information =
          interaction.options.getString(
            "information"
          );

        saveMemory(
          guild.id,
          "manual",
          information,
          member.id
        );

        await interaction.reply(
          "🧠 Got it. I'll remember that."
        );

        return;
      }

      // FORGET
      if (commandName === "forget") {
        const id =
          interaction.options.getInteger(
            "id"
          );

        const result =
          deleteMemory(
            guild.id,
            id
          );

        await interaction.reply(
          result.changes
            ? `🗑️ Forgot memory #${id}.`
            : `I couldn't find memory #${id}.`
        );

        return;
      }

      // MEMORIES
      if (commandName === "memories") {
        const rows =
          db.prepare(`
            SELECT *
            FROM memories
            WHERE guild_id = ?
            ORDER BY created_at DESC
            LIMIT 20
          `).all(guild.id);

        await interaction.reply({
          content:
            rows.length
              ? formatMemories(rows)
              : "No memories stored yet.",
          ephemeral: true,
        });

        return;
      }

      // SET CHANNEL
      if (commandName === "setchannel") {
        const channel =
          interaction.options.getChannel(
            "channel"
          );

        setSetting(
          guild.id,
          "ai_channel",
          channel.id
        );

        await interaction.reply(
          `⚙️ AI/memory channel set to ${channel}.`
        );

        return;
      }

      // PERSONALITY
      if (commandName === "personality") {
        const personality =
          interaction.options.getString(
            "personality"
          );

        setSetting(
          guild.id,
          "personality",
          personality
        );

        await interaction.reply(
          "🎭 Personality updated."
        );

        return;
      }

      // INDEX CHANNEL
      if (commandName === "indexchannel") {
        const channel =
          interaction.options.getChannel(
            "channel"
          );

        await interaction.deferReply();

        const count =
          await indexChannel(
            channel,
            100
          );

        await interaction.editReply(
          `📚 Indexed ${count} messages from ${channel}.`
        );

        return;
      }

      // INDEX SERVER
      if (commandName === "indexserver") {
        await interaction.deferReply();

        let total = 0;

        const channels =
          guild.channels.cache.filter(
            (channel) =>
              channel.type ===
              ChannelType.GuildText
          );

        for (const channel of channels.values()) {
          try {
            total += await indexChannel(
              channel,
              50
            );
          } catch (error) {
            console.error(
              `Failed indexing #${channel.name}:`,
              error
            );
          }
        }

        await interaction.editReply(
          `🌐 Server indexing complete. Indexed ${total} messages.`
        );

        return;
      }

      // ANNOUNCE
      if (commandName === "announce") {
        const channel =
          interaction.options.getChannel(
            "channel"
          );

        const message =
          interaction.options.getString(
            "message"
          );

        await interaction.deferReply();

        const result =
          await sendAnnouncement(
            guild,
            channel,
            message,
            member,
            false
          );

        await interaction.editReply(
          result
        );

        return;
      }

      // WARNINGS
      if (commandName === "warnings") {
        const user =
          interaction.options.getUser(
            "user"
          );

        const warnings =
          getWarnings(
            guild.id,
            user.id
          );

        if (!warnings.length) {
          await interaction.reply(
            `✅ ${user.tag} has no recorded warnings.`
          );

          return;
        }

        const output =
          warnings
            .slice(0, 15)
            .map(
              (warning, index) =>
                `**${index + 1}.** ${warning.reason} — <t:${Math.floor(
                  warning.created_at / 1000
                )}:R>`
            )
            .join("\n");

        await interaction.reply({
          content:
            `⚠️ **Warnings for ${user.tag}**\n\n${output}`,
          ephemeral: true,
        });

        return;
      }

      // MEMBER INFO
      if (commandName === "memberinfo") {
        const user =
          interaction.options.getUser(
            "user"
          );

        const target =
          await guild.members
            .fetch(user.id)
            .catch(() => null);

        await interaction.reply(
          getMemberInformation(target)
        );

        return;
      }
    } catch (error) {
      console.error(
        "Interaction error:",
        error
      );

      const response =
        "Something went wrong while processing that.";

      if (interaction.deferred) {
        await interaction.editReply(
          response
        ).catch(() => {});
      } else if (!interaction.replied) {
        await interaction.reply({
          content: response,
          ephemeral: true,
        }).catch(() => {});
      }
    }
  }
);

// =========================
// NEW CHANNEL / TICKET
// =========================

client.on(
  "channelCreate",
  async (channel) => {
    if (
      channel.type !==
      ChannelType.GuildText
    ) {
      return;
    }

    await handleTicketCreated(
      channel
    );
  }
);

// =========================
// MESSAGE HANDLER
// =========================

client.on(
  "messageCreate",
  async (message) => {
    if (
      message.author.bot ||
      !message.guild
    ) {
      return;
    }

    const guild =
      message.guild;

    // AUTOMATIC MEMORY CHANNEL
    const aiChannel =
      getSetting(
        guild.id,
        "ai_channel"
      );

    if (
      aiChannel === message.channel.id &&
      message.content.length > 10
    ) {
      try {
        const result =
          await classifyForMemory(
            message.content
          );

        if (result.save) {
          saveMemory(
            guild.id,
            result.category,
            `[${message.channel.name}] ${message.content}`,
            message.author.id
          );
        }
      } catch (error) {
        console.error(
          "Automatic memory error:",
          error
        );
      }
    }

    // BOT MENTION / REPLY
    const mentioned =
      message.mentions.users.has(
        client.user.id
      );

    const isReplyToBot =
      message.reference?.messageId
        ? await message.channel.messages
            .fetch(
              message.reference.messageId
            )
            .then(
              (msg) =>
                msg.author.id ===
                client.user.id
            )
            .catch(() => false)
        : false;

    if (!mentioned && !isReplyToBot) {
      return;
    }

    const instruction =
      cleanBotMention(
        message.content
      );

    if (!instruction) {
      await message.reply(
        "Yo? 😭 What do you need?"
      );
      return;
    }

    try {
      if (
        isAuthorizedStaff(
          message.member
        )
      ) {
        await handleStaffInstruction(
          message,
          instruction
        );

        return;
      }

      await message.channel.sendTyping();

      const answer =
        await answerUser(
          guild,
          message.member,
          instruction
        );

      await message.reply(
        answer || "I don't know that one."
      );
    } catch (error) {
      console.error(
        "Message AI error:",
        error
      );

      await message.reply(
        "My brain just fumbled that one 😭 Try again."
      );
    }
  }
);

// =========================
// ERRORS
// =========================

client.on(
  "error",
  (error) => {
    console.error(
      "Discord client error:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

// =========================
// LOGIN
// =========================

client.login(DISCORD_TOKEN); 
