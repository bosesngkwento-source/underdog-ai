# Underdog AI

A real Discord bot for the **Underdog Boxing Game** community.

It uses:
- Node.js 20+
- discord.js v14
- OpenAI API
- SQLite (`better-sqlite3`) for persistent server memory
- Slash commands
- Discord permissions/roles
- Automatic memory classification in configured channels
- Mention-based AI responses
- Optional direct AI responses in configured channels

## 1. Discord bot credentials

Create/use your existing bot application in the Discord Developer Portal.

Put these values in Replit **Secrets** (do not post them in Discord):

- `DISCORD_TOKEN` — your bot token
- `DISCORD_CLIENT_ID` — your application's Application ID
- `DISCORD_GUILD_ID` — your Underdog Boxing Game server ID

## 2. AI API key

Add:

- `OPENAI_API_KEY` — your OpenAI API key
- `OPENAI_MODEL` — optional model name; defaults to `gpt-4o-mini`

Never commit `.env` or expose the API key.

## 3. Install

In Replit Shell:

```bash
npm install
```

## 4. Start

```bash
npm start
```

You should see:

```text
Underdog AI online as ...
Guild slash commands registered.
```

The bot automatically creates `data/underdog.sqlite`.

## 5. Invite the bot

In Discord Developer Portal:

1. Open your application.
2. Go to OAuth2 → URL Generator.
3. Select:
   - `bot`
   - `applications.commands`
4. Grant the bot only the permissions it needs:
   - View Channels
   - Send Messages
   - Read Message History
   - optionally Embed Links
5. Use the generated invite URL to add it to your server.

## 6. Required intents

In Developer Portal → Bot → Privileged Gateway Intents, enable:

- **Message Content Intent**

The code requests these gateway intents:

- Guilds
- Guild Messages
- Message Content

The bot cannot read channels Discord does not permit it to read.

## 7. Staff access

Administrators automatically have access to memory/settings commands.

You can also specify staff roles with:

```text
STAFF_ROLE_IDS=123456789012345678,987654321098765432
```

Use Discord role IDs separated by commas.

## 8. AI response behavior

The bot responds when:

- A user mentions `@Underdog AI`
- A user uses `/ask`
- A configured AI channel receives a direct request beginning with `Underdog` or `Underdog AI`

Mention responses have a 5-second per-user cooldown to reduce spam.

To enable direct responses in a channel, add its ID to:

```text
AI_CHANNELS=123456789012345678
```

Multiple channel IDs can be comma-separated.

## 9. Configure automatic memory channels

Staff can use:

```text
/setchannel channel:#announcements type:announcements
/setchannel channel:#updates type:updates
/setchannel channel:#patch-notes type:patch-notes
/setchannel channel:#events type:events
/setchannel channel:#staff-updates type:staff-updates
```

The bot analyzes messages posted in these configured channels and asks the AI whether the message contains durable server knowledge.

It does **not** save every normal conversation.

Examples of information suitable for memory:

- Patch notes
- Game updates
- Events
- Server rules
- Rankings
- P4P rankings
- Fighter records
- Belt holders
- Hall of Fame information
- Staff decisions
- Important community announcements

Only messages the bot can actually see are analyzed. It does not automatically import old messages.

## 10. Staff commands

### `/remember`

Manually save important information.

Example:

```text
/remember information:"Update 1.5 added the Lightweight Championship." category:update
```

### `/forget`

Delete a memory by its ID.

```text
/forget memory:12
```

### `/memories`

List recent memories:

```text
/memories
```

Search memories:

```text
/memories query:"Update 1.5 Lightweight"
```

### `/ask`

Ask the AI a question using relevant server memories:

```text
/ask question:"What was added in Update 1.5?"
```

If the stored memory does not support the answer, Underdog AI is instructed to say that it does not know instead of inventing a server fact.

### `/setchannel`

Enable automatic memory classification for a channel:

```text
/setchannel channel:#patch-notes type:patch-notes
```

### `/personality`

Shows the current personality configuration.

### `/task`

High-rank staff only. This is intentionally conservative: it does not claim to execute unsupported actions. Destructive, permission-changing, moderation, and channel-deletion tasks are denied.

### `/announce`

High-rank staff only. Posts an exact announcement to the selected text channel. User mentions are disabled in the posted content to prevent accidental mass pings.

## 11. High-rank authority and personality

Set `HIGH_RANK_ROLE_IDS` to the role IDs for the people who should be allowed to give Underdog AI serious server-management instructions.

Normal members are limited to asking questions. If a normal member tells the bot to announce something, change channels, change permissions, or perform similar management actions, the bot refuses instead of treating the message as an authorized command.

Underdog AI can have a sharper boxing-community personality: occasional sarcasm, playful roasting, and mild dark humor are allowed. It still avoids hateful content, real threats, serious abuse, protected-trait attacks, and encouragement of real-world harm. If a conversation becomes genuinely sensitive, it switches to a respectful/helpful tone.

## 12. Database

The SQLite database stores:

- information
- category
- date
- channel
- author/source
- importance

Database file:

```text
data/underdog.sqlite
```

Replit deployments should use persistent storage if you need the SQLite file to survive rebuilds or replacement of the runtime.

## 13. Security

- Discord token is never hardcoded.
- OpenAI API key is never hardcoded.
- `.env` is ignored by Git.
- Error logs do not intentionally print secrets.
- Staff-only commands are permission protected.
- The bot only receives Discord information available through its granted permissions.
- AI prompts instruct the bot not to reveal credentials or internal implementation details.

## 14. Important production note

OpenAI API calls cost money according to the selected model/provider pricing. Automatic memory classification sends configured-channel messages to the AI API, so only configure channels whose content you want processed.

For a larger server, consider adding a monthly AI budget/rate limit and a more advanced semantic/vector search layer.
