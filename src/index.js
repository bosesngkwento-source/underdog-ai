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

// ======================================================
// CONFIG
// ======================================================

const STAFF_ROLE_IDS = new Set([
  "1530288888411852891", // Admin
  "1530288809932099634", // Head Admin
]);

const BOT_PREFIX = "Underdog AI";

// ======================================================
// DISCORD CLIENT
// ======================================================

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

// ======================================================
// GEMINI
// ======================================================

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

// ======================================================
// DATABASE
// ======================================================

const db = new Database("underdog-ai.sqlite");

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    category TEXT DEFAULT 'general',
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
    channel_id TEXT,
    title TEXT NOT NULL,
    due_at INTEGER,
    created_by TEXT,
    completed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS indexed_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    author_id TEXT,
    content TEXT,
    created_at INTEGER NOT NULL
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

// ======================================================
// HELPERS
// ======================================================

function clip(text, max = 1800) {
  if (!text) return "";

  text = String(text);

  if (text.length <= max) return text;

  return text.slice(0, max - 3) + "...";
}

function getSetting(guildId, key) {
  const row = db
    .prepare(`
      SELECT value
      FROM settings
      WHERE guild_id = ?
      AND key = ?
    `)
    .get(guildId, key);

  return row?.value || null;
}

function setSetting(guildId, key, value) {
  db.prepare(`
    INSERT INTO settings (guild_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, key)
    DO UPDATE SET value = excluded.value
  `).run(
    guildId,
    key,
    String(value)
  );
}

// ======================================================
// STAFF CHECK
// ======================================================

function isAuthorizedStaff(member) {
  if (!member) return false;

  if (
    member.permissions?.has(
      PermissionFlagsBits.Administrator
    )
  ) {
    return true;
  }

  return member.roles?.cache?.some(role =>
    STAFF_ROLE_IDS.has(role.id)
  );
}

// ======================================================
// BOT PERMISSION CHECK
// ======================================================

function hasBotPermission(guild, permission) {
  const me = guild.members.me;

  if (!me) return false;

  return me.permissions.has(permission);
}

// ======================================================
// BOT MENTION CLEANER
// ======================================================

function cleanBotMention(content) {
  if (!content) return "";

  return content
    .replace(/<@!?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ======================================================
// MEMORY SYSTEM
// ======================================================

function saveMemory(
  guildId,
  category,
  content,
  createdBy = null
) {
  if (!content || !guildId) return;

  db.prepare(`
    INSERT INTO memories (
      guild_id,
      category,
      content,
      created_by,
      created_at
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    guildId,
    category || "general",
    clip(content, 2000),
    createdBy,
    Date.now()
  );
}

function deleteMemory(guildId, id) {
  return db.prepare(`
    DELETE FROM memories
    WHERE guild_id = ?
    AND id = ?
  `).run(guildId, id);
}

function searchMemories(
  guildId,
  query,
  limit = 12
) {
  const rows = db.prepare(`
    SELECT *
    FROM memories
    WHERE guild_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(guildId);

  if (!query) {
    return rows.slice(0, limit);
  }

  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const scored = rows.map(row => {
    const text = (
      `${row.category} ${row.content}`
    ).toLowerCase();

    let score = 0;

    for (const word of words) {
      if (text.includes(word)) {
        score++;
      }
    }

    return {
      ...row,
      score,
    };
  });

  return scored
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function formatMemories(rows) {
  if (!rows.length) {
    return "No relevant memories found.";
  }

  return rows
    .map(row =>
      `[#${row.id}] [${row.category}] ${row.content}`
    )
    .join("\n");
}

// ======================================================
// GEMINI AI
// ======================================================

async function generateAI(
  prompt,
  options = {}
) {
  try {
    const response =
      await ai.models.generateContent({
        model: GEMINI_MODEL,

        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],

        config: {
          temperature:
            options.temperature ?? 0.7,

          maxOutputTokens:
            options.maxOutputTokens ?? 700,
        },
      });

    return response.text?.trim() ||
      "I couldn't generate a response right now.";
  } catch (error) {
    console.error(
      "Gemini error:",
      error
    );

    return "⚠️ My AI system is having trouble right now.";
  }
}

// ======================================================
// PERSONALITY
// ======================================================

function getPersonality(guildId) {
  return (
    getSetting(
      guildId,
      "personality"
    ) ||
    `
You are Underdog AI, the friendly AI assistant for a boxing
gaming Discord server.

Personality:
- Friendly
- Energetic
- Helpful
- Boxing/gaming themed
- Short and natural responses
- Occasionally playful
- Never overly formal
- Do not pretend to know information you do not know

You are an assistant, not the owner of the server.

Respect staff instructions when they are authorized.
Never invent server rules, rankings, records, announcements,
events, or member information.
`
  );
}

// ======================================================
// NORMAL AI ANSWER
// ======================================================

async function answerUser(
  message,
  userPrompt
) {
  const memories =
    searchMemories(
      message.guild.id,
      userPrompt,
      12
    );

  const memoryText =
    formatMemories(memories);

  const prompt = `
${getPersonality(message.guild.id)}

SERVER MEMORY:
${memoryText}

CURRENT USER:
${message.member?.displayName ||
  message.author.username}

USER MESSAGE:
${userPrompt}

Instructions:
- Use server memory when relevant.
- Do not invent missing information.
- If the server memory does not contain something,
  clearly say you do not know.
- Keep the response concise unless more detail is needed.
`;

  return generateAI(prompt);
}

// ======================================================
// AUTOMATIC MEMORY CLASSIFICATION
// ======================================================

async function classifyForMemory(message) {
  if (!message.guild) return;

  const content =
    message.content?.trim();

  if (
    !content ||
    content.length < 20
  ) {
    return;
  }

  const prompt = `
You are analyzing a Discord message for long-term server memory.

Message:
${clip(content, 1500)}

Decide whether this contains useful permanent server information.

Useful examples:
- Rules
- Announcements
- Patch notes
- Updates
- Events
- Rankings
- P4P rankings
- Fighter records
- Belt holders
- Hall of Fame
- Top donators
- Staff decisions
- Important server information

Do NOT save:
- Normal conversations
- Jokes
- Greetings
- Temporary chatter
- Random opinions
- Spam

Return EXACTLY one of:

SAVE|category|important information

or

IGNORE
`;

  const result =
    await generateAI(
      prompt,
      {
        temperature: 0.1,
        maxOutputTokens: 200,
      }
    );

  if (!result.startsWith("SAVE|")) {
    return;
  }

  const parts =
    result.split("|");

  if (parts.length < 3) {
    return;
  }

  const category =
    parts[1]?.trim() ||
    "general";

  const memory =
    parts
      .slice(2)
      .join("|")
      .trim();

  if (!memory) return;

  saveMemory(
    message.guild.id,
    category,
    memory,
    message.author.id
  );
}

// ======================================================
// CHANNEL INDEXING
// ======================================================

async function indexChannel(
  channel,
  maxMessages = 500
) {
  if (!channel?.isTextBased()) {
    return 0;
  }

  let before;
  let total = 0;

  while (
    total < maxMessages
  ) {
    const remaining =
      maxMessages - total;

    const batchSize =
      Math.min(
        100,
        remaining
      );

    const messages =
      await channel.messages.fetch({
        limit: batchSize,
        ...(before
          ? { before }
          : {}),
      });

    if (!messages.size) {
      break;
    }

    for (
      const message
      of messages.values()
    ) {
      if (!message.guild) {
        continue;
      }

      if (
        !message.content ||
        message.author.bot
      ) {
        continue;
      }

      try {
        db.prepare(`
          INSERT OR IGNORE INTO indexed_messages (
            guild_id,
            channel_id,
            message_id,
            author_id,
            content,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          message.guild.id,
          channel.id,
          message.id,
          message.author.id,
          clip(
            message.content,
            2000
          ),
          message.createdTimestamp
        );

        total++;
      } catch (error) {
        console.error(
          "Index message error:",
          error
        );
      }
    }

    before =
      messages.last()?.id;

    if (
      messages.size <
      batchSize
    ) {
      break;
    }
  }

  return total;
}

// ======================================================
// MEMBER INFORMATION
// ======================================================

async function getMemberInformation(
  guild,
  userId
) {
  try {
    const member =
      await guild.members.fetch(
        userId
      );

    const roles =
      member.roles.cache
        .filter(role =>
          role.id !== guild.id
        )
        .map(role =>
          role.name
        );

    return {
      id: member.id,

      username:
        member.user.username,

      tag:
        member.user.tag,

      displayName:
        member.displayName,

      nickname:
        member.nickname ||
        null,

      bot:
        member.user.bot,

      accountCreated:
        new Date(
          member.user.createdTimestamp
        ).toISOString(),

      joinedServer:
        member.joinedTimestamp
          ? new Date(
              member.joinedTimestamp
            ).toISOString()
          : null,

      roles,

      roleCount:
        roles.length,
    };
  } catch (error) {
    console.error(
      "Member information error:",
      error
    );

    return null;
  }
}

// ======================================================
// WARNINGS
// ======================================================

function addWarning(
  guildId,
  userId,
  moderatorId,
  reason
) {
  db.prepare(`
    INSERT INTO warnings (
      guild_id,
      user_id,
      moderator_id,
      reason,
      created_at
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    guildId,
    userId,
    moderatorId,
    clip(reason, 1000),
    Date.now()
  );
}

function getWarnings(
  guildId,
  userId
) {
  return db.prepare(`
    SELECT *
    FROM warnings
    WHERE guild_id = ?
    AND user_id = ?
    ORDER BY created_at DESC
  `).all(
    guildId,
    userId
  );
}

// ======================================================
// ROLE RENAMING
// ======================================================

async function renameRole(
  guild,
  roleId,
  newName
) {
  try {
    const role =
      await guild.roles.fetch(
        roleId
      );

    if (!role) {
      return {
        success: false,
        message:
          "❌ I couldn't find that role.",
      };
    }

    if (role.managed) {
      return {
        success: false,
        message:
          "❌ That role is managed by Discord/integration and cannot be renamed.",
      };
    }

    const botMember =
      guild.members.me;

    if (!botMember) {
      return {
        success: false,
        message:
          "❌ I couldn't determine my role position.",
      };
    }

    if (
      !botMember.permissions.has(
        PermissionFlagsBits.ManageRoles
      )
    ) {
      return {
        success: false,
        message:
          "❌ I don't have Manage Roles permission.",
      };
    }

    if (
      role.position >=
      botMember.roles.highest.position
    ) {
      return {
        success: false,
        message:
          "❌ I can't rename that role because it is equal to or above my highest role.",
      };
    }

    const oldName =
      role.name;

    await role.setName(
      clip(newName, 100)
    );

    return {
      success: true,
      message:
        `✅ Renamed **${oldName}** to **${role.name}**.`,
    };
  } catch (error) {
    console.error(
      "Role rename error:",
      error
    );

    return {
      success: false,
      message:
        "❌ I couldn't rename that role.",
    };
  }
}

// ======================================================
// KICK MEMBER
// ======================================================

async function kickMember(
  guild,
  userId,
  reason
) {
  try {
    const member =
      await guild.members.fetch(
        userId
      );

    const botMember =
      guild.members.me;

    if (!botMember) {
      return {
        success: false,
        message:
          "I couldn't determine my permissions.",
      };
    }

    if (
      !botMember.permissions.has(
        PermissionFlagsBits.KickMembers
      )
    ) {
      return {
        success: false,
        message:
          "I don't have Kick Members permission.",
      };
    }

    if (
      member.id === guild.ownerId
    ) {
      return {
        success: false,
        message:
          "I can't kick the server owner.",
      };
    }

    if (
      member.roles.highest.position >=
      botMember.roles.highest.position
    ) {
      return {
        success: false,
        message:
          "I can't kick that member because their highest role is equal to or above mine.",
      };
    }

    if (!member.kickable) {
      return {
        success: false,
        message:
          "Discord does not allow me to kick that member.",
      };
    }

    await member.kick(
      clip(
        reason || "Staff request",
        500
      )
    );

    return {
      success: true,
      message:
        `👢 Kicked **${member.user.tag}**.`,
    };
  } catch (error) {
    console.error(
      "Kick error:",
      error
    );

    return {
      success: false,
      message:
        "I couldn't kick that member.",
    };
  }
}

// ======================================================
// ANNOUNCEMENT SYSTEM
// ======================================================

async function generateAnnouncement(
  guild,
  request
) {
  const memories =
    searchMemories(
      guild.id,
      request,
      15
    );

  const prompt = `
You are Underdog AI creating a Discord announcement.

SERVER:
${guild.name}

SERVER MEMORY:
${formatMemories(memories)}

STAFF REQUEST:
${request}

Create a clear Discord announcement.

Rules:
- Keep the meaning of the staff request.
- Do not invent dates, events, rules, rewards, or information.
- Make it easy to read.
- Use Discord formatting when useful.
- Emojis are allowed.
- Do not add unnecessary explanations.
`;

  return generateAI(
    prompt,
    {
      temperature: 0.5,
      maxOutputTokens: 600,
    }
  );
}

async function sendAnnouncement(
  message,
  request,
  targetChannel = null
) {
  const channel =
    targetChannel ||
    message.channel;

  if (!channel?.isTextBased()) {
    return "❌ I can't send an announcement there.";
  }

  const announcement =
    await generateAnnouncement(
      message.guild,
      request
    );

  const wantsEveryone =
    /\@(everyone|here)\b/i.test(
      request
    );

  const mentionedUsers =
    [...message.mentions.users.keys()];

  try {
    await channel.send({
      content:
        announcement,

      allowedMentions: {
        parse:
          wantsEveryone
            ? ["everyone"]
            : [],
        users:
          mentionedUsers,
      },
    });

    return `📢 Announcement sent in ${channel}.`;
  } catch (error) {
    console.error(
      "Announcement error:",
      error
    );

    return "❌ I couldn't send the announcement.";
  }
}

// ======================================================
// NATURAL STAFF INSTRUCTIONS
// ======================================================

async function handleStaffInstruction(
  message,
  content
) {
  if (
    !isAuthorizedStaff(
      message.member
    )
  ) {
    return false;
  }

  // ----------------------------------------------------
  // ANNOUNCEMENT
  // ----------------------------------------------------

  const announcementMatch =
    content.match(
      /\b(announce|announcement|post this|send this|publish)\b([\s\S]*)/i
    );

  if (announcementMatch) {
    let request =
      announcementMatch[2]?.trim();

    if (!request) {
      await message.reply(
        "📢 Sure. Tell me what you want announced."
      );

      return true;
    }

    const targetChannel =
      message.mentions.channels.first();

    request =
      request
        .replace(
          /<#\d+>/g,
          ""
        )
        .trim();

    const result =
      await sendAnnouncement(
        message,
        request,
        targetChannel
      );

    await message.reply(
      result
    );

    return true;
  }

  // ----------------------------------------------------
  // VERBAL WARNING
  // ----------------------------------------------------

  const warningMatch =
    content.match(
            /\b(verbal\s+warn|warn|warning)\b[\s\S]*?<@!?(\d+)>([\s\S]*)/i
    );

  if (warningMatch) {
    const userId =
      warningMatch[2];

    let reason =
      warningMatch[3]?.trim();

    if (!reason) {
      reason =
        "Staff verbal warning";
    }

    const member =
      await message.guild.members
        .fetch(userId)
        .catch(() => null);

    if (!member) {
      await message.reply(
        "⚠️ I couldn't find that member."
      );

      return true;
    }

    addWarning(
      message.guild.id,
      member.id,
      message.author.id,
      reason
    );

    await message.reply(
      `⚠️ Verbal warning recorded for ${member}.\n**Reason:** ${clip(reason, 500)}`
    );

    return true;
  }

  // ----------------------------------------------------
  // KICK
  // ----------------------------------------------------

  const kickMatch =
    content.match(
      /\b(kick|remove)\b[\s\S]*?<@!?(\d+)>([\s\S]*)/i
    );

  if (kickMatch) {
    const userId =
      kickMatch[2];

    const reason =
      kickMatch[3]?.trim() ||
      "Staff request";

    const result =
      await kickMember(
        message.guild,
        userId,
        reason
      );

    await message.reply(
      result.message
    );

    return true;
  }

  // ----------------------------------------------------
  // ROLE RENAME
  // ----------------------------------------------------

  const roleMention =
    content.match(
      /<@&(\d+)/
    );

  const renameMatch =
    content.match(
      /\b(rename|change)\b[\s\S]*?(?:role)[\s\S]*?(?:to|into)\s+["“]?([^"”]+)["”]?$/i
    );

  if (
    roleMention &&
    renameMatch
  ) {
    const roleId =
      roleMention[1];

    const newName =
      renameMatch[2].trim();

    const result =
      await renameRole(
        message.guild,
        roleId,
        newName
      );

    await message.reply(
      result.message
    );

    return true;
  }

  // ----------------------------------------------------
  // MEMBER INFORMATION
  // ----------------------------------------------------

  const infoMatch =
    content.match(
      /\b(member\s*info|member\s*information|who\s+is)\b[\s\S]*?<@!?(\d+)>/i
    );

  if (infoMatch) {
    const userId =
      infoMatch[2];

    const info =
      await getMemberInformation(
        message.guild,
        userId
      );

    if (!info) {
      await message.reply(
        "❌ I couldn't retrieve that member's information."
      );

      return true;
    }

    const roles =
      info.roles.length
        ? info.roles
            .map(role => `\`${role}\``)
            .join(", ")
        : "None";

    await message.reply(
      [
        `👤 **Member Information**`,
        ``,
        `**Username:** ${info.tag}`,
        `**Display Name:** ${info.displayName}`,
        `**ID:** \`${info.id}\``,
        `**Nickname:** ${info.nickname || "None"}`,
        `**Bot:** ${info.bot ? "Yes" : "No"}`,
        `**Account Created:** <t:${Math.floor(new Date(info.accountCreated).getTime() / 1000)}:F>`,
        `**Joined Server:** ${
          info.joinedServer
            ? `<t:${Math.floor(new Date(info.joinedServer).getTime() / 1000)}:F>`
            : "Unknown"
        }`,
        `**Roles:** ${roles}`,
      ].join("\n")
    );

    return true;
  }

  // ----------------------------------------------------
  // FALLBACK STAFF AI
  // ----------------------------------------------------

  const memories =
    searchMemories(
      message.guild.id,
      content,
      15
    );

  const prompt = `
${getPersonality(message.guild.id)}

You are handling a request from an authorized server staff member.

SERVER MEMORY:
${formatMemories(memories)}

STAFF REQUEST:
${content}

Understand natural/ad-lib wording.

If the request is asking for an action that the bot does not
have an implemented action for, explain what you can do instead.

Do not claim an action was completed unless the bot actually
completed it.
`;

  const response =
    await generateAI(
      prompt
    );

  await message.reply(
    response
  );

  return true;
}

// ======================================================
// TICKET HELPER
// ======================================================

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

async function handleTicketCreated(
  channel
) {
  if (!looksLikeTicket(channel)) {
    return;
  }

  if (!channel.isTextBased()) {
    return;
  }

  await new Promise(resolve =>
    setTimeout(resolve, 1500)
  );

  try {
    const messages =
      await channel.messages.fetch({
        limit: 25,
      });

    const recentMessages =
      [...messages.values()]
        .reverse()
        .filter(m => !m.author.bot)
        .map(m =>
          `${m.author.username}: ${clip(m.content, 500)}`
        )
        .join("\n");

    const prompt = `
You are Underdog AI helping inside a Discord support ticket.

Ticket channel:
${channel.name}

Recent messages:
${recentMessages || "No messages yet."}

Give a short helpful response.

If the ticket does not contain enough information yet,
ask the user what they need help with.

Do not pretend to be a human staff member.
`;

    const response =
      await generateAI(prompt, {
        temperature: 0.6,
        maxOutputTokens: 400,
      });

    await channel.send({
      content: `🤖 ${response}`,
    });
  } catch (error) {
    console.error(
      "Ticket helper error:",
      error
    );
  }
}

// ======================================================
// SLASH COMMANDS
// ======================================================

const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Underdog AI something")
    .addStringOption(option =>
      option
        .setName("question")
        .setDescription("Your question")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("remember")
    .setDescription("Save important server information")
    .addStringOption(option =>
      option
        .setName("information")
        .setDescription("Information to remember")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("category")
        .setDescription("Memory category")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("forget")
    .setDescription("Delete a server memory")
    .addIntegerOption(option =>
      option
        .setName("id")
        .setDescription("Memory ID")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("memories")
    .setDescription("View server memories"),

  new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Set a bot channel")
    .addStringOption(option =>
      option
        .setName("type")
        .setDescription("Channel setting")
        .setRequired(true)
        .addChoices(
          {
            name: "Announcement",
            value: "announcement_channel",
          },
          {
            name: "Memory Monitor",
            value: "memory_channel",
          }
        )
    )
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("Channel to use")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("personality")
    .setDescription("Change the bot personality")
    .addStringOption(option =>
      option
        .setName("text")
        .setDescription("New personality instructions")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("indexchannel")
    .setDescription("Index messages from a channel")
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("Channel to index")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("indexserver")
    .setDescription("Index accessible server channels"),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send an announcement")
    .addStringOption(option =>
      option
        .setName("message")
        .setDescription("Announcement content")
        .setRequired(true)
    )
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("Announcement channel")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View member warnings")
    .addUserOption(option =>
      option
        .setName("member")
        .setDescription("Member")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("memberinfo")
    .setDescription("View member information")
    .addUserOption(option =>
      option
        .setName("member")
        .setDescription("Member")
        .setRequired(true)
    ),
].map(command =>
  command.toJSON()
);

// ======================================================
// REGISTER COMMANDS
// ======================================================

async function registerCommands() {
  const {
    REST
  } = require("@discordjs/rest");

  const {
    Routes
  } = require("discord-api-types/v10");

  const rest =
    new REST({
      version: "10",
    }).setToken(
      DISCORD_TOKEN
    );

  await rest.put(
    Routes.applicationGuildCommands(
      DISCORD_CLIENT_ID,
      DISCORD_GUILD_ID
    ),
    {
      body: commands,
    }
  );

  console.log(
    "Slash commands registered."
  );
}

// ======================================================
// READY
// ======================================================

client.once(
  "ready",
  async () => {
    console.log(
      `🤖 ${client.user.tag} is online!`
    );

    try {
      await registerCommands();
    } catch (error) {
      console.error(
        "Command registration error:",
        error
      );
    }

    console.log(
      `Using Gemini model: ${GEMINI_MODEL}`
    );
  }
);

// ======================================================
// INTERACTIONS
// ======================================================

client.on(
  "interactionCreate",
  async interaction => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const guild =
      interaction.guild;

    if (!guild) {
      await interaction.reply(
        "This command can only be used inside a server."
      );

      return;
    }

    const command =
      interaction.commandName;

    const staffCommands = new Set([
      "remember",
      "forget",
      "setchannel",
      "personality",
      "indexchannel",
      "indexserver",
      "announce",
      "warnings",
      "memberinfo",
      "memories",
    ]);

    if (
      staffCommands.has(command) &&
      !isAuthorizedStaff(
        interaction.member
      )
    ) {
      await interaction.reply({
        content:
          "❌ You don't have permission to use this command.",
        ephemeral: true,
      });

      return;
    }

    try {
      if (command === "ask") {
        const question =
          interaction.options.getString(
            "question"
          );

        await interaction.deferReply();

        const response =
          await answerUser(
            interaction,
            question
          );

        await interaction.editReply(
          response
        );

        return;
      }

      if (command === "remember") {
        const information =
          interaction.options.getString(
            "information"
          );

        const category =
          interaction.options.getString(
            "category"
          ) || "general";

        saveMemory(
          guild.id,
          category,
          information,
          interaction.user.id
        );

        await interaction.reply(
          `🧠 Saved memory **#${category}**.`
        );

        return;
      }

      if (command === "forget") {
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
            ? `🗑️ Deleted memory #${id}.`
            : `❌ Memory #${id} wasn't found.`
        );

        return;
      }

      if (command === "memories") {
        const memories =
          searchMemories(
            guild.id,
            "",
            25
          );

        await interaction.reply(
          clip(
            `🧠 **Server Memories**\n\n${formatMemories(memories)}`,
            1900
          )
        );

        return;
      }

      if (command === "setchannel") {
        const type =
          interaction.options.getString(
            "type"
          );

        const channel =
          interaction.options.getChannel(
            "channel"
          );

        setSetting(
          guild.id,
          type,
          channel.id
        );

        await interaction.reply(
          `✅ ${type} has been set to ${channel}.`
        );

        return;
      }

      if (command === "personality") {
        const text =
          interaction.options.getString(
            "text"
          );

        setSetting(
          guild.id,
          "personality",
          text
        );

        await interaction.reply(
          "✅ My personality settings have been updated."
        );

        return;
      }

      if (command === "indexchannel") {
        const channel =
          interaction.options.getChannel(
            "channel"
          );

        await interaction.deferReply({
          ephemeral: true,
        });

        const count =
          await indexChannel(
            channel,
            500
          );

        await interaction.editReply(
          `📚 Indexed ${count} messages from ${channel}.`
        );

        return;
      }

      if (command === "indexserver") {
        await interaction.deferReply({
          ephemeral: true,
        });

        let total = 0;

        const channels =
          guild.channels.cache.filter(
            channel =>
              channel.type ===
                ChannelType.GuildText ||
              channel.type ===
                ChannelType.GuildAnnouncement
          );

        for (
          const channel
          of channels.values()
        ) {
          try {
            total +=
              await indexChannel(
                channel,
                300
              );
          } catch (error) {
            console.error(
              `Could not index #${channel.name}:`,
              error
            );
          }
        }

        await interaction.editReply(
          `📚 Server indexing finished. Indexed approximately ${total} messages.`
        );

        return;
      }

      if (command === "announce") {
        const announcement =
          interaction.options.getString(
            "message"
          );

        const selectedChannel =
          interaction.options.getChannel(
            "channel"
          );

        const configuredChannelId =
          getSetting(
            guild.id,
            "announcement_channel"
          );

        const channel =
          selectedChannel ||
          guild.channels.cache.get(
            configuredChannelId
          ) ||
          interaction.channel;

        await interaction.deferReply({
          ephemeral: true,
        });

        const result =
          await sendAnnouncement(
            interaction,
            announcement,
            channel
          );

        await interaction.editReply(
          result
        );

        return;
      }

      if (command === "warnings") {
        const user =
          interaction.options.getUser(
            "member"
          );

        const warnings =
          getWarnings(
            guild.id,
            user.id
          );

        if (!warnings.length) {
          await interaction.reply(
            `⚠️ **${user.tag}** has no recorded verbal warnings.`
          );

          return;
        }

        const lines =
          warnings
            .slice(0, 15)
            .map((warning, index) => {
              const timestamp =
                Math.floor(
                  warning.created_at / 1000
                );

              return [
                `**${index + 1}.** ${warning.reason}`,
                `Moderator: <@${warning.moderator_id}>`,
                `Date: <t:${timestamp}:F>`,
              ].join(" • ");
            });

        await interaction.reply(
          clip(
            `⚠️ **Warnings for ${user.tag}**\n\n${lines.join("\n\n")}`,
            1900
          )
        );

        return;
      }

      if (command === "memberinfo") {
        const user =
          interaction.options.getUser(
            "member"
          );

        const info =
          await getMemberInformation(
            guild,
            user.id
          );

        if (!info) {
          await interaction.reply(
            "❌ I couldn't retrieve that member's information."
          );

          return;
        }

        const roles =
          info.roles.length
            ? info.roles
                .map(role => `\`${role}\``)
                .join(", ")
            : "None";

        const accountTimestamp =
          Math.floor(
            new Date(
              info.accountCreated
            ).getTime() / 1000
          );

        const joinedTimestamp =
          info.joinedServer
            ? Math.floor(
                new Date(
                  info.joinedServer
                ).getTime() / 1000
              )
            : null;

        await interaction.reply(
          [
            `👤 **Member Information**`,
            ``,
            `**Username:** ${info.tag}`,
            `**Display Name:** ${info.displayName}`,
            `**ID:** \`${info.id}\``,
            `**Nickname:** ${info.nickname || "None"}`,
            `**Bot:** ${info.bot ? "Yes" : "No"}`,
            `**Account Created:** <t:${accountTimestamp}:F>`,
            `**Joined Server:** ${
              joinedTimestamp
                ? `<t:${joinedTimestamp}:F>`
                : "Unknown"
            }`,
            `**Roles:** ${roles}`,
          ].join("\n")
        );

        return;
      }
    } catch (error) {
      console.error(
        "Interaction error:",
        error
      );

      if (interaction.deferred) {
        await interaction
          .editReply(
            "❌ Something went wrong while processing that command."
          )
          .catch(() => {});
      } else if (!interaction.replied) {
        await interaction
          .reply({
            content:
              "❌ Something went wrong while processing that command.",
            ephemeral: true,
          })
          .catch(() => {});
      }
    }
  }
);

// ======================================================
// TICKET CREATION
// ======================================================

client.on(
  "channelCreate",
  async channel => {
    try {
      await handleTicketCreated(
        channel
      );
    } catch (error) {
      console.error(
        "Channel create error:",
        error
      );
    }
  }
);

// ======================================================
// MESSAGE CREATE
// ======================================================

client.on(
  "messageCreate",
  async message => {
    if (!message.guild) {
      return;
    }

    if (message.author.bot) {
      return;
    }

    const memoryChannelId =
      getSetting(
        message.guild.id,
        "memory_channel"
      );

    if (
      memoryChannelId &&
      message.channel.id ===
        memoryChannelId
    ) {
      try {
        await classifyForMemory(
          message
        );
      } catch (error) {
        console.error(          "Automatic memory error:",
          error
        );
      }
    }

    const botMentioned =
      message.mentions.has(
        client.user.id
      );

    let repliedToBot = false;

    if (message.reference?.messageId) {
      try {
        const referenced =
          await message.fetchReference();

        if (
          referenced?.author?.id ===
          client.user.id
        ) {
          repliedToBot = true;
        }
      } catch {
        // Ignore unavailable referenced messages.
      }
    }

    if (
      !botMentioned &&
      !repliedToBot
    ) {
      return;
    }

    const content =
      cleanBotMention(
        message.content
      );

    if (!content) {
      await message.reply(
        "🥊 Yo! What's up?"
      );

      return;
    }

    if (
      isAuthorizedStaff(
        message.member
      )
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

    try {
      await message.channel.sendTyping();

      const response =
        await answerUser(
          message,
          content
        );

      await message.reply(
        response
      );
    } catch (error) {
      console.error(
        "Message AI error:",
        error
      );

      await message
        .reply(
          "⚠️ I couldn't process that right now."
        )
        .catch(() => {});
    }
  }
);

// ======================================================
// ERROR HANDLING
// ======================================================

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

// ======================================================
// LOGIN
// ======================================================

client.login(
  DISCORD_TOKEN
);
     
