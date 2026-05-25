require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const TEAM_OWNER_ROLE_ID = process.env.TEAM_OWNER_ROLE_ID;
const WHITELIST_LOG_CHANNEL_ID = process.env.WHITELIST_LOG_CHANNEL_ID;
const MC_SERVER_IP = process.env.MC_SERVER_IP || 'IP WILL BE SHARED SOON!';

const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
const WHITELIST_TRACKER_FILE = path.join(__dirname, 'whitelist_tracker.json');
const SQLITE_FILE = path.join(__dirname, 'bot_data.sqlite');

let db = null;

// Tracks voice channel join timestamps per user: Map<userId, joinTimestampMs>
const voiceJoinTimes = new Map();

const MEDAL_EMOJIS = ['🥇', '🥈', '🥉'];

/**
 * Centralized environment/config values.
 * Keep all IDs in .env so this file stays reusable across servers.
 */
const CONFIG = {
  token: process.env.DISCORD_TOKEN,
  staffRoleId: process.env.STAFF_ROLE_ID,
  staffAlertChannelId: process.env.STAFF_ALERT_CHANNEL_ID || null,
  teamOwnerRoleId: TEAM_OWNER_ROLE_ID,
  whitelistLogChannelId: WHITELIST_LOG_CHANNEL_ID || null,
  minecraftChatChannelId: process.env.MINECRAFT_CHAT_CHANNEL_ID || null,
  ticketCategoryId: process.env.TICKET_CATEGORY_ID || null,
};

if (!CONFIG.token) {
  console.error('[BOOT] DISCORD_TOKEN is missing in .env. Bot cannot start.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

/**
 * Last-resort process-level safety handlers.
 * Keep the process alive when possible while surfacing actionable logs.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[PROCESS] Uncaught exception:', error);
});

/**
 * Sanitize channel names to avoid invalid characters and overlong names.
 */
function createTicketChannelName(username) {
  const base = username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'user';

  return `ticket-${base}`;
}

/**
 * Build consistent support/ticket panel embed and button row.
 */

// ─── WHITELIST TRACKER ───────────────────────────────────────────────────────

function getDb() {
  if (!db) {
    throw new Error('Database is not initialized yet.');
  }
  return db;
}

function initializeDatabase() {
  try {
    db = new Database(SQLITE_FILE);
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        kills INTEGER NOT NULL DEFAULT 0,
        deaths INTEGER NOT NULL DEFAULT 0,
        minutes_played INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS whitelist_submissions (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        submitted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_whitelist_tickets (
        channel_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        ign TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_roster (
        team_role_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        added_by TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (team_role_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    migrateLegacyJsonData();
  } catch (error) {
    console.error('[DB] Failed to initialize SQLite database:', error);
    throw error;
  }
}

function migrateLegacyJsonData() {
  const database = getDb();

  try {
    const alreadyMigrated = database
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get('legacy_json_migration_v1');

    if (alreadyMigrated?.value === '1') {
      return;
    }

    let leaderboardCount = 0;
    let whitelistCount = 0;

    if (fs.existsSync(LEADERBOARD_FILE)) {
      try {
        const rawLeaderboard = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
        const leaderboardData = JSON.parse(rawLeaderboard);
        const insertLeaderboard = database.prepare(`
          INSERT INTO leaderboard (user_id, username, kills, deaths, minutes_played, updated_at)
          VALUES (@userId, @username, @kills, @deaths, @minutesPlayed, @updatedAt)
          ON CONFLICT(user_id) DO UPDATE SET
            username = excluded.username,
            kills = excluded.kills,
            deaths = excluded.deaths,
            minutes_played = excluded.minutes_played,
            updated_at = excluded.updated_at
        `);

        for (const [userId, stats] of Object.entries(leaderboardData || {})) {
          if (!/^\d{17,20}$/.test(userId)) continue;
          insertLeaderboard.run({
            userId,
            username: String(stats?.username || userId),
            kills: Number(stats?.kills || 0),
            deaths: Number(stats?.deaths || 0),
            minutesPlayed: Number(stats?.minutesPlayed || 0),
            updatedAt: new Date().toISOString(),
          });
          leaderboardCount += 1;
        }
      } catch (leaderboardError) {
        console.error('[DB] Failed to migrate leaderboard.json:', leaderboardError);
      }
    }

    if (fs.existsSync(WHITELIST_TRACKER_FILE)) {
      try {
        const rawWhitelist = fs.readFileSync(WHITELIST_TRACKER_FILE, 'utf8');
        const whitelistData = JSON.parse(rawWhitelist);
        const insertWhitelist = database.prepare(`
          INSERT INTO whitelist_submissions (user_id, username, submitted_at)
          VALUES (@userId, @username, @submittedAt)
          ON CONFLICT(user_id) DO UPDATE SET
            username = excluded.username,
            submitted_at = excluded.submitted_at
        `);

        for (const [userId, submission] of Object.entries(whitelistData || {})) {
          if (!/^\d{17,20}$/.test(userId)) continue;
          insertWhitelist.run({
            userId,
            username: String(submission?.username || ''),
            submittedAt: String(submission?.submittedAt || new Date().toISOString()),
          });
          whitelistCount += 1;
        }
      } catch (whitelistError) {
        console.error('[DB] Failed to migrate whitelist_tracker.json:', whitelistError);
      }
    }

    database
      .prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
      .run('legacy_json_migration_v1', '1');

    console.log(`[DB] Legacy migration complete. leaderboard=${leaderboardCount}, whitelist=${whitelistCount}`);
  } catch (error) {
    console.error('[DB] Failed during legacy JSON migration:', error);
    throw error;
  }
}

async function hasUserSubmittedWhitelist(userId) {
  try {
    const row = getDb()
      .prepare('SELECT 1 FROM whitelist_submissions WHERE user_id = ? LIMIT 1')
      .get(userId);
    return Boolean(row);
  } catch (error) {
    console.error('[WHITELIST] Failed checking whitelist submission:', error);
    return false;
  }
}

async function markWhitelistSubmission(userId, username) {
  try {
    getDb()
      .prepare(`
        INSERT INTO whitelist_submissions (user_id, username, submitted_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          submitted_at = excluded.submitted_at
      `)
      .run(userId, String(username || userId), new Date().toISOString());
  } catch (error) {
    console.error('[WHITELIST] Failed marking whitelist submission:', error);
  }
}

async function clearWhitelistSubmission(userId) {
  try {
    const result = getDb()
      .prepare('DELETE FROM whitelist_submissions WHERE user_id = ?')
      .run(userId);
    return result.changes > 0;
  } catch (error) {
    console.error('[WHITELIST] Failed clearing whitelist submission:', error);
    return false;
  }
}

async function isWhitelistTicketProcessed(channelId) {
  try {
    const row = getDb()
      .prepare('SELECT 1 FROM processed_whitelist_tickets WHERE channel_id = ? LIMIT 1')
      .get(channelId);
    return Boolean(row);
  } catch (error) {
    console.error('[WHITELIST] Failed checking processed ticket state:', error);
    return false;
  }
}

async function lockWhitelistTicket(channelId, userId, ign) {
  try {
    const result = getDb()
      .prepare(`
        INSERT OR IGNORE INTO processed_whitelist_tickets (channel_id, user_id, ign, processed_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(channelId, userId, ign, new Date().toISOString());

    return result.changes > 0;
  } catch (error) {
    console.error('[WHITELIST] Failed to lock whitelist ticket channel:', error);
    return false;
  }
}

async function upsertTeamRosterMember(teamRoleId, userId, username, addedByUserId) {
  try {
    getDb()
      .prepare(`
        INSERT INTO team_roster (team_role_id, user_id, username, added_by, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(team_role_id, user_id) DO UPDATE SET
          username = excluded.username,
          added_by = excluded.added_by,
          updated_at = excluded.updated_at
      `)
      .run(teamRoleId, userId, String(username || userId), String(addedByUserId || userId), new Date().toISOString());
  } catch (error) {
    console.error('[TEAM-ROSTER] Failed to upsert team roster member:', error);
  }
}

async function removeTeamRosterMember(teamRoleId, userId) {
  try {
    getDb()
      .prepare('DELETE FROM team_roster WHERE team_role_id = ? AND user_id = ?')
      .run(teamRoleId, userId);
  } catch (error) {
    console.error('[TEAM-ROSTER] Failed to remove team roster member:', error);
  }
}

async function removeTeamRosterByRole(teamRoleId) {
  try {
    getDb()
      .prepare('DELETE FROM team_roster WHERE team_role_id = ?')
      .run(teamRoleId);
  } catch (error) {
    console.error('[TEAM-ROSTER] Failed to purge team roster by role:', error);
  }
}

function buildTicketPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x00b894)
    .setTitle('🎫 Minecraft Support Center')
    .setDescription(
      [
        'Need help with your account, whitelist, purchases, reports, or technical issues?',
        '',
        'Select a ticket type from the dropdown below to open a private support channel.',
      ].join('\n')
    )
    .addFields(
      {
        name: '📋 Ticket Types',
        value: [
          '**General Support** — Account issues, technical help, purchases',
          '**Player Report** — Report rule violations, griefing, or bad behavior',
          '**Whitelist Application** — Submit your whitelist application (one per player)',
        ].join('\n'),
      }
    )
    .setFooter({ text: 'A staff member will respond as soon as possible.' })
    .setTimestamp();

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('ticket_type_select')
    .setPlaceholder('Select a ticket type...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('General Support')
        .setValue('ticket_general')
        .setEmoji('📋')
        .setDescription('Account, technical, or general assistance'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Player Report')
        .setValue('ticket_report')
        .setEmoji('🚨')
        .setDescription('Report a player or rule violation'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Whitelist Application')
        .setValue('ticket_whitelist')
        .setEmoji('✅')
        .setDescription('Submit a whitelist application (limit one per player)')
    );

  const row = new ActionRowBuilder().addComponents(selectMenu);

  return { embed, row };
}

/**
 * Build dynamic team registration panel.
 */
function buildTeamSystemPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Team Registration System')
    .setDescription(
      [
        'Create your own team with a dedicated role and private channels.',
        'Press the button below to register your team name.',
      ].join('\n')
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('launch_team_modal')
      .setLabel('🛡️ Create a Team')
      .setStyle(ButtonStyle.Success)
  );

  return { embed, row };
}

/**
 * Sanitize team name for role/channel safety while preserving readability.
 */
function sanitizeTeamName(input) {
  const cleaned = input
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);

  return cleaned;
}

/**
 * Convert a human team name into a Discord-safe text channel slug.
 */
function buildTeamTextSlug(teamName) {
  return (
    teamName
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 85) || 'team'
  );
}

function isValidSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

async function resolveConfiguredRole(guild, roleId, label) {
  if (!guild || !isValidSnowflake(roleId)) return null;

  const role = guild.roles.cache.get(roleId)
    || (await guild.roles.fetch(roleId).catch(() => null));

  if (!role) {
    console.warn(`[CONFIG] ${label} role ${roleId} was not found in guild ${guild.id}.`);
  }

  return role;
}

function getRoleManageabilityIssue(guild, role) {
  const botMember = guild.members.me;
  if (!botMember) {
    return 'Bot member state is not available yet. Please try again in a moment.';
  }

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'The bot is missing the Manage Roles permission.';
  }

  if (!role) {
    return 'The required role could not be found.';
  }

  if (role.managed) {
    return `${role.name} is a managed integration role and cannot be assigned manually.`;
  }

  if (botMember.roles.highest.position <= role.position) {
    return `The bot role must be placed above ${role.name} in the server role list.`;
  }

  return null;
}

function getMemberTeamRoles(member) {
  return member.roles.cache.filter((role) => role.name.startsWith('Team '));
}

function buildPlayerHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🎮 Minecraft Server - Player Help Menu')
    .setDescription('Public commands for gameplay, teams, and server information.')
    .addFields(
      {
        name: '📊 Server Status',
        value: '`!status` or `!ip` - Check if the Minecraft server is online, view the game version, and see live active player counts.',
      },
      {
        name: '👥 Team Management',
        value: '`!team` - View your current squad\'s profile, listing the owner, active members, and a shortcut link to your private HQ channel.\n`!leave-team` - Leave your current team.',
      },
      {
        name: '🏆 Leaderboards',
        value: '`!top [category]` - View the Top 10 server competitive leaderboards.\n**Categories:** `kills`, `deaths`, or `time`',
      },
      {
        name: '🆘 Emergency Support',
        value: '`!helpop <issue>` - Emergency panic button to securely alert online moderators about urgent game-breaking glitches or rule-breakers.',
      }
    )
    .setFooter({ text: `Minecraft endpoint: ${MC_SERVER_IP}` })
    .setTimestamp();
}

function buildStaffHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🛠️ Staff Administration Manual')
    .setDescription('Administrative setup and simulation commands (staff only).')
    .addFields(
      {
        name: '🎫 Support System',
        value: '`!setup-tickets` - Deploys the automated support hub featuring the ticket type dropdown menu.',
      },
      {
        name: '🛡️ Team System',
        value: '`!setup-teams-system` - Deploys the automated green button for dynamic team and channel registration.',
      },
      {
        name: '📊 Leaderboard Testing',
        value: '`!simulate-kill @user` - Manually increment a player\'s kill count.\n`!simulate-death @user` - Manually increment a player\'s death count.',
      }
    )
    .setFooter({ text: 'Staff tools only - unauthorized access is forbidden' })
    .setTimestamp();
}

function getTeamHqNameFromRole(roleName) {
  const teamName = roleName.replace(/^Team\s+/i, '');
  return `${buildTeamTextSlug(teamName)}-hq`;
}

async function fetchMinecraftStatus(serverIp) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(`https://api.mcsrvstat.us/2/${encodeURIComponent(serverIp)}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Status API returned ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function sendPrivateUserNotice(message, content) {
  try {
    await message.author.send(content);
  } catch {
    await message.channel.send({
      content: `${message.author} ${content}`,
    }).catch(() => null);
  }
}

async function resolveStaffAlertChannel(guild) {
  if (CONFIG.staffAlertChannelId) {
    const configured = guild.channels.cache.get(CONFIG.staffAlertChannelId)
      || (await guild.channels.fetch(CONFIG.staffAlertChannelId).catch(() => null));
    if (configured && configured.isTextBased()) {
      return configured;
    }
  }

  if (CONFIG.staffRoleId) {
    const maybeChannel = guild.channels.cache.get(CONFIG.staffRoleId)
      || (await guild.channels.fetch(CONFIG.staffRoleId).catch(() => null));
    if (maybeChannel && maybeChannel.isTextBased()) {
      return maybeChannel;
    }
  }

  return null;
}

async function resolveWhitelistLogChannel(guild) {
  if (!guild || !isValidSnowflake(CONFIG.whitelistLogChannelId)) return null;

  const configured = guild.channels.cache.get(CONFIG.whitelistLogChannelId)
    || (await guild.channels.fetch(CONFIG.whitelistLogChannelId).catch(() => null));

  if (configured && configured.isTextBased()) {
    return configured;
  }

  return null;
}

function getTicketOwnerIdFromChannel(channel) {
  const topic = channel?.topic || '';
  const match = topic.match(/\((\d{17,20})\)/);
  return match ? match[1] : null;
}

function normalizeWhitelistIgn(rawIgn) {
  const normalized = String(rawIgn || '')
    .trim()
    .replace(/[\r\n`]/g, '')
    .slice(0, 64);

  return normalized;
}

async function recordWhitelistIgn(message) {
  try {
    const alreadyProcessed = await isWhitelistTicketProcessed(message.channel.id);
    if (alreadyProcessed) {
      return;
    }

    const ign = normalizeWhitelistIgn(message.content);
    if (!ign) {
      await message.reply('Please send your Minecraft IGN as a plain message so it can be recorded.');
      return;
    }

    const logChannel = await resolveWhitelistLogChannel(message.guild);
    if (!logChannel) {
      await message.reply('Whitelist log channel is not configured correctly. Please ask staff to set WHITELIST_LOG_CHANNEL_ID.');
      return;
    }

    const lockAcquired = await lockWhitelistTicket(message.channel.id, message.author.id, ign);
    if (!lockAcquired) {
      return;
    }

    await message.react('✅').catch(() => null);

    const compilerMessage = [
      `📋 **New Whitelist Request Added:** \`${ign}\``,
      `**Copy-paste command:** \`/whitelist add ${ign}\``,
      `**Player:** ${message.author.tag} (${message.author.id})`,
      '',
      '```text',
      `/whitelist add ${ign}`,
      '```',
    ].join('\n');

    await logChannel.send({ content: compilerMessage });

    await message.channel.send({
      content: `✅ IGN recorded for **${ign}**. This whitelist ticket will be deleted in 5 seconds.`,
    });

    setTimeout(async () => {
      await message.channel.delete(`Whitelist IGN recorded for ${message.author.tag}`).catch((error) => {
        console.error('[WHITELIST] Failed to delete whitelist ticket channel:', error);
      });
    }, 5000);
  } catch (error) {
    console.error('[WHITELIST] Failed to process IGN submission:', error);
    await message.reply('Something went wrong while recording your IGN. Please try again or contact staff.').catch(() => null);
  }
}

function isTicketCloserAuthorized(interaction) {
  const member = interaction.member;
  const channel = interaction.channel;

  if (!member || !('permissions' in member) || !channel) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
  if (CONFIG.staffRoleId && 'roles' in member && member.roles.cache.has(CONFIG.staffRoleId)) return true;

  const topic = channel.topic || '';
  return topic.includes(`(${interaction.user.id})`);
}

async function getTeamChannelsByRole(guild, teamRoleId) {
  const fetchedChannels = await guild.channels.fetch();
  return fetchedChannels.filter((channel) => {
    if (!channel) return false;
    if (![ChannelType.GuildText, ChannelType.GuildVoice].includes(channel.type)) return false;
    return channel.permissionOverwrites.cache.has(teamRoleId);
  });
}

async function denyMemberInTeamChannels(guild, teamRoleId, memberId) {
  const teamChannels = await getTeamChannelsByRole(guild, teamRoleId);
  for (const channel of teamChannels.values()) {
    const denyPayload = { ViewChannel: false };

    if (channel.type === ChannelType.GuildText) {
      denyPayload.SendMessages = false;
      denyPayload.ReadMessageHistory = false;
    }

    if (channel.type === ChannelType.GuildVoice) {
      denyPayload.Connect = false;
      denyPayload.Speak = false;
    }

    await channel.permissionOverwrites.edit(memberId, denyPayload).catch((error) => {
      console.error(`[TEAM-SYSTEM] Failed to deny member ${memberId} in channel ${channel.id}:`, error);
    });
  }
}

async function clearMemberTeamChannelOverwrite(guild, teamRoleId, memberId) {
  const teamChannels = await getTeamChannelsByRole(guild, teamRoleId);
  for (const channel of teamChannels.values()) {
    await channel.permissionOverwrites.delete(memberId).catch(() => null);
  }
}

async function disconnectMemberFromTeamVoice(guild, teamRoleId, memberId) {
  const teamChannels = await getTeamChannelsByRole(guild, teamRoleId);
  const teamVoiceChannelIds = new Set(
    teamChannels
      .filter((channel) => channel.type === ChannelType.GuildVoice)
      .map((channel) => channel.id)
  );

  const member = await guild.members.fetch(memberId).catch(() => null);
  if (!member || !member.voice?.channelId) return;

  if (teamVoiceChannelIds.has(member.voice.channelId)) {
    await member.voice.disconnect('Removed from team; access revoked').catch((error) => {
      console.error(`[TEAM-SYSTEM] Failed to disconnect member ${memberId} from team voice:`, error);
    });
  }
}

/**
 * Resolve the team role linked to a specific team HQ channel.
 */
function resolveTeamRoleForChannel(guild, channel) {
  const roleOverwrites = channel.permissionOverwrites.cache
    .filter((overwrite) => overwrite.type === 0 || overwrite.type === 'role')
    .map((overwrite) => guild.roles.cache.get(overwrite.id))
    .filter(Boolean);

  const teamRoleFromOverwrites = roleOverwrites.find((role) => {
    if (!role.name.startsWith('Team ')) return false;
    if (CONFIG.staffRoleId && role.id === CONFIG.staffRoleId) return false;
    if (CONFIG.teamOwnerRoleId && role.id === CONFIG.teamOwnerRoleId) return false;
    return true;
  });

  if (teamRoleFromOverwrites) return teamRoleFromOverwrites;

  const channelTeamSlug = channel.name.replace(/-hq$/i, '');
  const teamRoleFromName = guild.roles.cache.find((role) => {
    if (!role.name.startsWith('Team ')) return false;
    const roleTeamName = role.name.replace(/^Team\s+/i, '');
    return buildTeamTextSlug(roleTeamName) === channelTeamSlug;
  });

  return teamRoleFromName || null;
}

function canManageSpecificTeam(member, teamRole) {
  if (!member || !('roles' in member) || !teamRole) return false;
  if (!CONFIG.teamOwnerRoleId || !member.roles.cache.has(CONFIG.teamOwnerRoleId)) return false;
  return member.roles.cache.has(teamRole.id);
}

/**
 * Handle modal submission that adds a member to the team associated with this channel.
 */
async function handleAddMemberModalSubmission(interaction) {
  try {
    const { guild, channel, member } = interaction;
    if (!guild || !channel || !member || !('roles' in member)) {
      await interaction.reply({
        content: 'This action can only be completed inside a server text channel.',
        ephemeral: true,
      });
      return;
    }

    if (!CONFIG.teamOwnerRoleId || !member.roles.cache.has(CONFIG.teamOwnerRoleId)) {
      await interaction.reply({
        content: '❌ Only a Team Owner can add members.',
        ephemeral: true,
      });
      return;
    }

    const rawMemberId = interaction.fields.getTextInputValue('member_id_input') || '';
    const targetMemberId = rawMemberId.replace(/\D/g, '');

    if (!targetMemberId || targetMemberId.length < 17 || targetMemberId.length > 20) {
      await interaction.reply({
        content: 'Please provide a valid Discord User ID.',
        ephemeral: true,
      });
      return;
    }

    const targetMember = await guild.members.fetch(targetMemberId).catch(() => null);
    if (!targetMember) {
      await interaction.reply({
        content: 'That user ID is invalid or the member is not in this server.',
        ephemeral: true,
      });
      return;
    }

    const teamRole = resolveTeamRoleForChannel(guild, channel);
    if (!teamRole) {
      await interaction.reply({
        content: 'Could not determine the team role for this channel. Please contact staff.',
        ephemeral: true,
      });
      return;
    }

    const existingTargetTeam = getMemberTeamRoles(targetMember).first();
    if (existingTargetTeam && existingTargetTeam.id !== teamRole.id) {
      await interaction.reply({
        content: `${targetMember.user.tag} is already in ${existingTargetTeam.name}. Members can only be in one team.`,
        ephemeral: true,
      });
      return;
    }

    if (targetMember.roles.cache.has(teamRole.id)) {
      await interaction.reply({
        content: `${targetMember.user.tag} is already in ${teamRole.name}.`,
        ephemeral: true,
      });
      return;
    }

    await targetMember.roles.add(teamRole, `Added to ${teamRole.name} by ${interaction.user.tag}`);
    await clearMemberTeamChannelOverwrite(guild, teamRole.id, targetMember.id);
    await upsertTeamRosterMember(teamRole.id, targetMember.id, targetMember.user.tag, interaction.user.id);

    await interaction.reply({
      content: `Added ${targetMember.user.tag} to ${teamRole.name} successfully.`,
      ephemeral: true,
    });

    await channel.send({
      content: `👋 Welcome <@${targetMember.id}> to the team!`,
    });
  } catch (error) {
    console.error('[TEAM-SYSTEM] Failed to process add member modal submission:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Something went wrong while adding this member. Please try again.',
        ephemeral: true,
      });
    }
  }
}

/**
 * Check if a team role has zero members and auto-delete its channels.
 */
async function autoCleanupEmptyTeam(guild, teamRole) {
  if (!teamRole.name.startsWith('Team ')) return;

  const members = await guild.members.fetch();
  const hasMembers = members.some((member) => member.roles.cache.has(teamRole.id));

  if (hasMembers) return;

  console.log(`[TEAM-SYSTEM] Auto-cleanup: Deleting empty team role and channels for ${teamRole.name}`);

  const teamChannels = await getTeamChannelsByRole(guild, teamRole.id);
  for (const channel of teamChannels.values()) {
    await channel.delete(`Auto-cleanup: Team has no members`).catch((error) => {
      console.error(`[TEAM-SYSTEM] Failed to delete channel ${channel.id} during auto-cleanup:`, error);
    });
  }

  await removeTeamRosterByRole(teamRole.id);

  await teamRole.delete('Auto-cleanup: Team has no members').catch((error) => {
    console.error(`[TEAM-SYSTEM] Failed to delete role ${teamRole.id} during auto-cleanup:`, error);
  });
}

/**
 * Handle team disband request from team owner.
 */
async function handleDisbandTeam(interaction) {
  try {
    const { guild, channel, member } = interaction;
    if (!guild || !channel || !member || !('roles' in member)) {
      await interaction.reply({
        content: 'This action can only be completed inside a server text channel.',
        ephemeral: true,
      });
      return;
    }

    if (!CONFIG.teamOwnerRoleId || !member.roles.cache.has(CONFIG.teamOwnerRoleId)) {
      await interaction.reply({
        content: '❌ Only a Team Owner can disband a team.',
        ephemeral: true,
      });
      return;
    }

    const teamRole = resolveTeamRoleForChannel(guild, channel);
    if (!teamRole) {
      await interaction.reply({
        content: 'Could not determine the team role for this channel.',
        ephemeral: true,
      });
      return;
    }

    const teamName = teamRole.name;

    // Confirmation
    await interaction.reply({
      content: `⚠️ You are about to disband **${teamName}**. This will delete all team channels and remove the team role. This action cannot be undone.`,
      ephemeral: true,
    });

    // Fetch all members with this role and remove it
    const teamMembers = await guild.members.fetch();
    const membersToNotify = [];
    for (const member of teamMembers.values()) {
      if (member.roles.cache.has(teamRole.id)) {
        membersToNotify.push(member.user.username);
        await member.roles.remove(teamRole, `Team disbanded by ${interaction.user.tag}`).catch(() => null);
        await removeTeamRosterMember(teamRole.id, member.id);

        // Remove owner role if they have no other teams
        const remainingTeams = getMemberTeamRoles(member).size;
        if (remainingTeams === 0 && CONFIG.teamOwnerRoleId && member.roles.cache.has(CONFIG.teamOwnerRoleId)) {
          await member.roles.remove(CONFIG.teamOwnerRoleId, 'Removed Team Owner role after team disband').catch(() => null);
        }
      }
    }

    await removeTeamRosterByRole(teamRole.id);

    // Delete all team channels
    const teamChannels = await getTeamChannelsByRole(guild, teamRole.id);
    for (const channel of teamChannels.values()) {
      await channel.delete(`Team ${teamName} disbanded by ${interaction.user.tag}`).catch((error) => {
        console.error(`[TEAM-SYSTEM] Failed to delete channel during disband:`, error);
      });
    }

    // Delete the team role
    await teamRole.delete(`Team disbanded by ${interaction.user.tag}`).catch((error) => {
      console.error(`[TEAM-SYSTEM] Failed to delete role during disband:`, error);
    });

    // Notify staff
    const staffChannel = await resolveStaffAlertChannel(guild);
    if (staffChannel) {
      await staffChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('💥 Team Disbanded')
            .setDescription(`**${teamName}** has been disbanded by ${interaction.user.tag}`)
            .addFields({
              name: 'Members Affected',
              value: membersToNotify.length > 0 ? membersToNotify.join(', ') : 'None',
            })
            .setTimestamp(),
        ],
      }).catch(() => null);
    }
  } catch (error) {
    console.error('[TEAM-SYSTEM] Failed to disband team:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Something went wrong while disbanding the team. Please try again.',
        ephemeral: true,
      });
    }
  }
}

/**
 * Allow users to leave their team from a team HQ channel.
 */
async function handleLeaveTeam(interaction) {
  try {
    const { guild, channel, member } = interaction;
    if (!guild || !channel || !member || !('roles' in member)) {
      await interaction.reply({
        content: 'This action can only be completed inside a server text channel.',
        ephemeral: true,
      });
      return;
    }

    const teamRole = resolveTeamRoleForChannel(guild, channel);
    if (!teamRole) {
      await interaction.reply({
        content: 'Could not determine the team role for this channel.',
        ephemeral: true,
      });
      return;
    }

    if (!member.roles.cache.has(teamRole.id)) {
      await interaction.reply({
        content: `You are not a member of ${teamRole.name}.`,
        ephemeral: true,
      });
      return;
    }

    await member.roles.remove(teamRole, `Left team via HQ by ${interaction.user.tag}`);
    await denyMemberInTeamChannels(guild, teamRole.id, member.id);
    await disconnectMemberFromTeamVoice(guild, teamRole.id, member.id);
    await removeTeamRosterMember(teamRole.id, member.id);

    const hasAnyTeamLeft = getMemberTeamRoles(member).size > 0;
    if (!hasAnyTeamLeft && CONFIG.teamOwnerRoleId && member.roles.cache.has(CONFIG.teamOwnerRoleId)) {
      await member.roles.remove(CONFIG.teamOwnerRoleId, 'Removed Team Owner role after leaving final team');
    }

    // Auto-cleanup if team is now empty
    await autoCleanupEmptyTeam(guild, teamRole);

    await interaction.reply({
      content: `You have left ${teamRole.name}.`,
      ephemeral: true,
    });
  } catch (error) {
    console.error('[TEAM-SYSTEM] Failed to leave team:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Something went wrong while leaving the team. Please try again.',
        ephemeral: true,
      });
    }
  }
}

async function handleKickMemberSelect(interaction) {
  try {
    const { guild, channel, member } = interaction;
    if (!guild || !channel || !member || !('roles' in member)) {
      await interaction.reply({
        content: 'This action can only be used inside a team HQ channel.',
        ephemeral: true,
      });
      return;
    }

    const teamRole = resolveTeamRoleForChannel(guild, channel);
    if (!teamRole || !canManageSpecificTeam(member, teamRole)) {
      await interaction.reply({
        content: '❌ Only the Team Owner can manage the roster.',
        ephemeral: true,
      });
      return;
    }

    const selectedUserId = interaction.values?.[0];
    if (!selectedUserId) {
      await interaction.reply({
        content: 'No member was selected.',
        ephemeral: true,
      });
      return;
    }

    if (selectedUserId === member.id) {
      await interaction.reply({
        content: '❌ You cannot kick yourself from your own team.',
        ephemeral: true,
      });
      return;
    }

    const targetMember = await guild.members.fetch(selectedUserId).catch(() => null);
    if (!targetMember) {
      await interaction.reply({
        content: 'Could not find that member in this server.',
        ephemeral: true,
      });
      return;
    }

    if (!targetMember.roles.cache.has(teamRole.id)) {
      await interaction.reply({
        content: `${targetMember.user.tag} is not in this team.`,
        ephemeral: true,
      });
      return;
    }

    await targetMember.roles.remove(teamRole, `Kicked from ${teamRole.name} by ${interaction.user.tag}`);
    await denyMemberInTeamChannels(guild, teamRole.id, targetMember.id);
    await disconnectMemberFromTeamVoice(guild, teamRole.id, targetMember.id);
    await removeTeamRosterMember(teamRole.id, targetMember.id);

    const hasAnyTeamLeft = getMemberTeamRoles(targetMember).size > 0;
    if (!hasAnyTeamLeft && CONFIG.teamOwnerRoleId && targetMember.roles.cache.has(CONFIG.teamOwnerRoleId)) {
      await targetMember.roles.remove(CONFIG.teamOwnerRoleId, 'Removed Team Owner role after team kick');
    }

    await interaction.reply({
      content: `🥾 Removed ${targetMember} from ${teamRole.name}.`,
      ephemeral: true,
    });

    await channel.send({
      content: `🥾 **Roster Update:** ${targetMember} has been kicked from the team by the Team Owner.`,
    });

    await autoCleanupEmptyTeam(guild, teamRole);
  } catch (error) {
    console.error('[TEAM-SYSTEM] Failed to process kick member selection:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Something went wrong while kicking this member. Please try again.',
        ephemeral: true,
      });
    }
  }
}

/**
 * Close a ticket channel with permission checks.
 */
async function handleCloseTicket(interaction) {
  try {
    const { channel } = interaction;
    if (!channel || channel.type !== ChannelType.GuildText || !channel.name.startsWith('ticket-') && !channel.name.startsWith('report-') && !channel.name.startsWith('whitelist-')) {
      await interaction.reply({
        content: 'This button can only be used in a ticket channel.',
        ephemeral: true,
      });
      return;
    }

    if (!isTicketCloserAuthorized(interaction)) {
      await interaction.reply({
        content: 'You are not allowed to close this ticket.',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: '🔒 Ticket will be closed in 5 seconds...',
      ephemeral: true,
    });

    await channel.send({ content: `🔒 Ticket closed by ${interaction.user}. Deleting channel in 5 seconds...` });

    setTimeout(async () => {
      await channel.delete(`Ticket closed by ${interaction.user.tag}`).catch((error) => {
        console.error('[TICKET] Failed to delete ticket channel:', error);
      });
    }, 5000);
  } catch (error) {
    console.error('[TICKET] Failed to close ticket:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Something went wrong while closing the ticket.',
        ephemeral: true,
      });
    }
  }
}

/**
 * Handle modal submission for fully dynamic team creation.
 */
async function handleCreateTeamModalSubmission(interaction) {
  try {
    const { guild, member } = interaction;
    if (!guild || !member || !('roles' in member)) {
      await interaction.reply({
        content: 'This action can only be completed inside a server.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const rawTeamName = interaction.fields.getTextInputValue('team_name_input') || '';
    const safeTeamName = sanitizeTeamName(rawTeamName);

    if (!safeTeamName) {
      await interaction.editReply({
        content: 'Please use a valid team name with letters or numbers.',
      });
      return;
    }

    const existingMemberTeam = getMemberTeamRoles(member).first();
    if (existingMemberTeam) {
      await interaction.editReply({
        content: `You are already in ${existingMemberTeam.name}. You can only be in one team at a time.`,
      });
      return;
    }

    if (!isValidSnowflake(CONFIG.teamOwnerRoleId)) {
      await interaction.editReply({
        content: 'TEAM_OWNER_ROLE_ID is not configured correctly. Please ask staff to set a valid role ID.',
      });
      return;
    }

    const ownerRole = guild.roles.cache.get(CONFIG.teamOwnerRoleId)
      || (await guild.roles.fetch(CONFIG.teamOwnerRoleId).catch(() => null));

    if (!ownerRole) {
      await interaction.editReply({
        content: 'Configured Team Owner role was not found in this server. Please contact staff.',
      });
      return;
    }

    const ownerRoleIssue = getRoleManageabilityIssue(guild, ownerRole);
    if (ownerRoleIssue) {
      await interaction.editReply({
        content: `I cannot assign the Team Owner role right now: ${ownerRoleIssue}`,
      });
      return;
    }

    const teamRoleName = `Team ${safeTeamName}`;
    const existingRole = guild.roles.cache.find((role) => role.name === teamRoleName)
      || (await guild.roles.fetch().then((roles) => roles.find((role) => role.name === teamRoleName)).catch(() => null));

    if (existingRole) {
      await interaction.editReply({
        content: `The team name '${teamRoleName}' is already taken. Please choose another name.`,
      });
      return;
    }

    const teamSlug = buildTeamTextSlug(safeTeamName);
    const textChannelName = `${teamSlug}-hq`.slice(0, 100);
    const voiceChannelName = `${safeTeamName} Voice`.slice(0, 100);
    const everyoneRole = guild.roles.everyone;

    const permissionOverwrites = [
      {
        id: everyoneRole,
        deny: [PermissionFlagsBits.ViewChannel],
      },
    ];

    /**
     * Best-effort rollback if any step fails after creation begins.
     */
    let newTeamRole = null;
    let createdTextChannel = null;
    let createdVoiceChannel = null;
    let ownerRoleAssigned = false;

    try {
      newTeamRole = await guild.roles.create({
        name: teamRoleName,
        mentionable: true,
        reason: `Dynamic team creation by ${interaction.user.tag}`,
      });

      await member.roles.add(newTeamRole, `Assigned by dynamic team registration for ${teamRoleName}`);
      await upsertTeamRosterMember(newTeamRole.id, member.id, member.user.tag, member.id);

      await member.roles.add(ownerRole.id, `Team owner granted for ${teamRoleName}`);
      ownerRoleAssigned = true;

      createdTextChannel = await guild.channels.create({
        name: textChannelName,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          ...permissionOverwrites,
          {
            id: newTeamRole,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
        reason: `Private team text channel for ${teamRoleName}`,
      });

      createdVoiceChannel = await guild.channels.create({
        name: voiceChannelName,
        type: ChannelType.GuildVoice,
        permissionOverwrites: [
          ...permissionOverwrites,
          {
            id: newTeamRole,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
            ],
          },
        ],
        reason: `Private team voice channel for ${teamRoleName}`,
      });

      await interaction.editReply({
        content: `Success! Your team '${teamRoleName}' has been registered, your role assigned, and your private channels created.`,
      });

      const hqEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('🛡️ Team Headquarters')
        .setDescription('Welcome to your private base. Team Owners can add players or disband the team using the buttons below.')
        .setTimestamp();

      const addMemberRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('add_team_member')
          .setLabel('➕ Add Member')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('kick_member_init')
          .setLabel('🥾 Kick Member')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('disband_team')
          .setLabel('💥 Disband Team')
          .setStyle(ButtonStyle.Danger)
      );

      await createdTextChannel.send({
        content: `${interaction.user}, welcome to ${teamRoleName} HQ! ${newTeamRole}`,
        embeds: [hqEmbed],
        components: [
          addMemberRow,
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('leave_team')
              .setLabel('🚪 Leave Team')
              .setStyle(ButtonStyle.Secondary)
          ),
        ],
      });

      const tutorialEmbed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('🏰 Welcome to Your Team Headquarters!')
        .setDescription(
          [
            '📌 **Roster Control:** Type `!add-member @player` to add teammates instantly without dealing with annoying IDs.',
            "🥾 **Roster Management:** Use the blue **'Kick Member'** button on the panel above to boot anyone from the squad.",
            "💥 **Disbanding:** If you ever want to completely delete the team, channels, and roles, the Owner can press the red **'Disband Team'** button.",
            '🔊 **Private Voice:** Your dynamic team voice channel is private. Only players added to your team role can view or join it.',
          ].join('\n\n')
        )
        .setTimestamp();

      const tutorialMessage = await createdTextChannel.send({ embeds: [tutorialEmbed] });
      await tutorialMessage.pin().catch((error) => {
        console.error('[TEAM-SYSTEM] Failed to pin team tutorial message:', error);
      });
    } catch (creationError) {
      console.error('[TEAM-SYSTEM] Error while creating team resources:', creationError);

      if (createdTextChannel) {
        await createdTextChannel.delete('Rolling back failed team creation').catch(() => null);
      }

      if (createdVoiceChannel) {
        await createdVoiceChannel.delete('Rolling back failed team creation').catch(() => null);
      }

      if (newTeamRole) {
        await member.roles.remove(newTeamRole).catch(() => null);
        await newTeamRole.delete('Rolling back failed team creation').catch(() => null);
      }

      if (ownerRoleAssigned) {
        await member.roles.remove(ownerRole.id).catch(() => null);
      }

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: 'Something went wrong while creating your team. Please contact staff or try again.',
        });
      } else {
        await interaction.reply({
          content: 'Something went wrong while creating your team. Please contact staff or try again.',
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error('[TEAM-SYSTEM] Failed to handle team modal submission:', error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: 'An unexpected error occurred while registering your team.',
      });
    } else {
      await interaction.reply({
        content: 'An unexpected error occurred while registering your team.',
        ephemeral: true,
      });
    }
  }
}

/**
 * Create a private ticket channel for a user, with type-specific naming and restrictions.
 */
async function createTicketChannel(interaction, ticketType = 'general') {
  try {
    const { guild, user, member } = interaction;
    if (!guild || !member) {
      await interaction.reply({
        content: 'This button can only be used inside a server.',
        ephemeral: true,
      });
      return;
    }

    // ─── WHITELIST RESTRICTION ──────────────────────────────────────────

    if (ticketType === 'whitelist') {
      const hasExisting = await hasUserSubmittedWhitelist(user.id);
      if (hasExisting) {
        await interaction.reply({
          content: '❌ You have already submitted a whitelist application. Duplicate applications are strictly prohibited to prevent cheating.',
          ephemeral: true,
        });
        return;
      }
      await markWhitelistSubmission(user.id, user.username);
    }

    // ─── TICKET CHANNEL NAMING ──────────────────────────────────────────

    const baseSlug = user.username
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'user';

    let ticketChannelName = `ticket-${baseSlug}`;
    let ticketTypeLabel = '📋 General Support';

    if (ticketType === 'report') {
      ticketChannelName = `report-${baseSlug}`;
      ticketTypeLabel = '🚨 Player Report';
    } else if (ticketType === 'whitelist') {
      ticketChannelName = `whitelist-${baseSlug}`;
      ticketTypeLabel = '✅ Whitelist Application';
    }

    const everyoneRole = guild.roles.everyone;
    const staffRole = await resolveConfiguredRole(guild, CONFIG.staffRoleId, 'STAFF_ROLE_ID');

    const permissionOverwrites = [
      {
        id: everyoneRole,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: user,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
    ];

    if (staffRole) {
      permissionOverwrites.push({
        id: staffRole,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    const createdChannel = await guild.channels.create({
      name: ticketChannelName,
      type: ChannelType.GuildText,
      parent: CONFIG.ticketCategoryId || undefined,
      topic: `${ticketTypeLabel} for ${user.tag} (${user.id})`,
      permissionOverwrites,
      reason: `Ticket opened by ${user.tag}`,
    });

    const openingMessage = ticketType === 'whitelist'
      ? '👋 Welcome! Drop your exact Minecraft in-game name (IGN) below to get whitelisted.'
      : `${user}, welcome to your **${ticketTypeLabel}** ticket!`;

    const reportPromptEmbed = ticketType === 'report'
      ? new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('🚨 Player Report Workflow')
        .setDescription('⚠️ **Player Report Initiated.** Please reply in this channel with the exact Minecraft IGN of the player you are reporting, followed by a detailed description of the incident and any evidence.')
        .setTimestamp()
      : null;

    await createdChannel.send({
      content: [
        openingMessage,
        staffRole ? `${staffRole} will be with you shortly.` : 'A staff member will be with you shortly.',
      ].join(' '),
      embeds: reportPromptEmbed ? [reportPromptEmbed] : [],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('close_ticket')
            .setLabel('🔒 Close Ticket')
            .setStyle(ButtonStyle.Danger)
        ),
      ],
    });

    await interaction.reply({
      content: `Your ${ticketTypeLabel.toLowerCase()} has been created: ${createdChannel}`,
      ephemeral: true,
    });
  } catch (error) {
    console.error('[TICKET] Failed to create ticket channel:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Something went wrong while creating your ticket. Please try again.',
        ephemeral: true,
      });
    }
  }
}

// ─── LEADERBOARD STORAGE ─────────────────────────────────────────────────────

async function readLeaderboard() {
  try {
    const rows = getDb()
      .prepare('SELECT user_id, username, kills, deaths, minutes_played FROM leaderboard')
      .all();

    const data = {};
    for (const row of rows) {
      data[row.user_id] = {
        username: row.username,
        kills: row.kills,
        deaths: row.deaths,
        minutesPlayed: row.minutes_played,
      };
    }

    return data;
  } catch (error) {
    console.error('[LEADERBOARD] Failed to read leaderboard data:', error);
    return {};
  }
}

// ─── STAT TRACKING ───────────────────────────────────────────────────────────

async function incrementKill(userId, username) {
  try {
    getDb()
      .prepare(`
        INSERT INTO leaderboard (user_id, username, kills, deaths, minutes_played, updated_at)
        VALUES (?, ?, 1, 0, 0, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          kills = leaderboard.kills + 1,
          updated_at = excluded.updated_at
      `)
      .run(userId, String(username || userId), new Date().toISOString());
  } catch (error) {
    console.error('[LEADERBOARD] Failed to increment kill:', error);
  }
}

async function incrementDeath(userId, username) {
  try {
    getDb()
      .prepare(`
        INSERT INTO leaderboard (user_id, username, kills, deaths, minutes_played, updated_at)
        VALUES (?, ?, 0, 1, 0, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          deaths = leaderboard.deaths + 1,
          updated_at = excluded.updated_at
      `)
      .run(userId, String(username || userId), new Date().toISOString());
  } catch (error) {
    console.error('[LEADERBOARD] Failed to increment death:', error);
  }
}

async function addMinutesPlayed(userId, username, minutes) {
  if (minutes <= 0) return;
  try {
    getDb()
      .prepare(`
        INSERT INTO leaderboard (user_id, username, kills, deaths, minutes_played, updated_at)
        VALUES (?, ?, 0, 0, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          minutes_played = leaderboard.minutes_played + excluded.minutes_played,
          updated_at = excluded.updated_at
      `)
      .run(userId, String(username || userId), Number(minutes), new Date().toISOString());
  } catch (error) {
    console.error('[LEADERBOARD] Failed to add voice minutes:', error);
  }
}

// ─── LEADERBOARD DISPLAY ─────────────────────────────────────────────────────

function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours === 0) return `${mins} min${mins !== 1 ? 's' : ''}`;
  if (mins === 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  return `${hours} hour${hours !== 1 ? 's' : ''}, ${mins} min${mins !== 1 ? 's' : ''}`;
}

function getRankPrefix(index) {
  return MEDAL_EMOJIS[index] ?? `**#${index + 1}**`;
}

async function buildLeaderboardEmbed(category) {
  const data = await readLeaderboard();
  const players = Object.values(data);

  if (category === 'kills') {
    const sorted = players.sort((a, b) => b.kills - a.kills).slice(0, 10);
    if (!sorted.length || sorted[0].kills === 0) {
      return new EmbedBuilder().setColor(0xe74c3c).setTitle('⚔️ Most Kills Leaderboard').setDescription('No kills recorded yet.').setTimestamp();
    }
    const lines = sorted.map((p, i) => `${getRankPrefix(i)} **${p.username}** — ${p.kills} kill${p.kills !== 1 ? 's' : ''}`);
    return new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('⚔️ Most Kills Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Top 10 players by kills' })
      .setTimestamp();
  }

  if (category === 'deaths') {
    const active = players.filter((p) => p.kills > 0 || p.minutesPlayed > 0 || p.deaths > 0);
    const sorted = active.sort((a, b) => a.deaths - b.deaths).slice(0, 10);
    if (!sorted.length) {
      return new EmbedBuilder().setColor(0x9b59b6).setTitle('💀 Hardcore Survivors (Fewest Deaths)').setDescription('No data recorded yet.').setTimestamp();
    }
    const lines = sorted.map((p, i) => `${getRankPrefix(i)} **${p.username}** — ${p.deaths} death${p.deaths !== 1 ? 's' : ''}`);
    return new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('💀 Hardcore Survivors (Fewest Deaths)')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Top 10 players with fewest deaths (active players only)' })
      .setTimestamp();
  }

  if (category === 'time') {
    const sorted = players.sort((a, b) => b.minutesPlayed - a.minutesPlayed).slice(0, 10);
    if (!sorted.length || sorted[0].minutesPlayed === 0) {
      return new EmbedBuilder().setColor(0xf39c12).setTitle('⏱️ Most Time Played Leaderboard').setDescription('No time data recorded yet.').setTimestamp();
    }
    const lines = sorted.map((p, i) => `${getRankPrefix(i)} **${p.username}** — ${formatMinutes(p.minutesPlayed)}`);
    return new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle('⏱️ Most Time Played Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Top 10 players by voice time' })
      .setTimestamp();
  }

  return null;
}

// ─── MINECRAFT BRIDGE ────────────────────────────────────────────────────────

/**
 * Optional message formatter/hook for future Minecraft bridge integrations.
 * For now, this produces a clean relay preview and can later be wired to RCON/webhook output.
 */
function formatMinecraftRelayPreview(message) {
  const playerName = message.member?.displayName || message.author.username;
  const content = message.content.trim();
  return `§7[Discord] §b${playerName}§7: ${content}`;
}

client.once(Events.ClientReady, async (readyClient) => {
  try {
    console.log(`[BOOT] Logged in as ${readyClient.user.tag} (${readyClient.user.id})`);
  } catch (error) {
    console.error('[BOOT] Error during ready initialization:', error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const content = message.content.trim();

    if (message.channel.type === ChannelType.GuildText && message.channel.name.startsWith('whitelist-')) {
      try {
        const ticketOwnerId = getTicketOwnerIdFromChannel(message.channel);
        if (ticketOwnerId && ticketOwnerId !== message.author.id) {
          return;
        }

        await recordWhitelistIgn(message);
        return;
      } catch (error) {
        console.error('[WHITELIST] Listener failed inside whitelist channel:', error);
        await message.reply('Something went wrong while processing your whitelist request.').catch(() => null);
        return;
      }
    }

    if (content === '!help') {
      const playerEmbed = buildPlayerHelpEmbed();
      const embeds = [playerEmbed];

      const isStaff = CONFIG.staffRoleId && message.member.roles.cache.has(CONFIG.staffRoleId);
      const canManageServer = message.member.permissions.has(PermissionFlagsBits.ManageGuild);

      if (isStaff || canManageServer) {
        const staffEmbed = buildStaffHelpEmbed();
        embeds.push(staffEmbed);
      }

      await message.channel.send({ embeds });
      return;
    }

    if (content === '!ip' || content === '!status') {
      try {
        const statusData = await fetchMinecraftStatus(MC_SERVER_IP);
        const isOnline = Boolean(statusData?.online);
        const hostname = statusData?.hostname || MC_SERVER_IP;
        const port = statusData?.port || 25565;
        const version = statusData?.version || 'Unknown';
        const onlinePlayers = statusData?.players?.online ?? 0;
        const maxPlayers = statusData?.players?.max ?? 0;

        const statusEmbed = new EmbedBuilder()
          .setColor(isOnline ? 0x2ecc71 : 0xe74c3c)
          .setTitle(isOnline ? '🟢 Server Status' : '🔴 Server Status')
          .addFields(
            { name: 'Server IP/Port', value: `${hostname}:${port}`, inline: false },
            { name: 'Game Version', value: String(version), inline: true },
            { name: 'Active Players', value: `${onlinePlayers} / ${maxPlayers}`, inline: true }
          )
          .setTimestamp();

        await message.channel.send({ embeds: [statusEmbed] });
      } catch (error) {
        console.error('[MC-STATUS] Failed to fetch server status:', error);
        await message.reply('Could not reach the server. It might be offline or starting up.');
      }
      return;
    }

    if (content === '!team') {
      const member = message.member;
      const teamRole = getMemberTeamRoles(member).first();

      if (!teamRole) {
        await sendPrivateUserNotice(
          message,
          "❌ You don't belong to any registered team yet! Use the team system to create or join one."
        );
        return;
      }

      await message.guild.members.fetch().catch(() => null);
      const membersWithRole = message.guild.members.cache.filter((guildMember) => guildMember.roles.cache.has(teamRole.id));
      const rosterLines = membersWithRole.map((guildMember) => `• ${guildMember.user.tag}`).join('\n') || 'No active members found.';
      const hqChannelName = getTeamHqNameFromRole(teamRole.name);
      const hqChannel = message.guild.channels.cache.find(
        (channel) => channel.type === ChannelType.GuildText && channel.name === hqChannelName
      );

      const squadEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`🛡️ Squad Profile: ${teamRole.name}`)
        .addFields(
          { name: 'Active Members', value: rosterLines, inline: false },
          { name: 'Private HQ', value: hqChannel ? `${hqChannel}` : 'HQ channel not found', inline: false }
        )
        .setTimestamp();

      await message.channel.send({ embeds: [squadEmbed] });
      return;
    }

    if (content.startsWith('!helpop')) {
      const issueDescription = content.slice('!helpop'.length).trim();
      if (!issueDescription) {
        await message.reply('❌ Please provide an issue description. Example: `!helpop someone is destroying the team blue base!`');
        return;
      }

      await message.delete().catch(() => null);

      const emergencyEmbed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🚨 Staff Emergency Alert')
        .addFields(
          { name: 'Reporter', value: `${message.author.tag} (${message.author.id})`, inline: false },
          { name: 'Source Channel', value: `${message.channel}`, inline: false },
          { name: 'Issue Details', value: issueDescription.slice(0, 1024), inline: false },
          { name: 'Reported At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
        )
        .setTimestamp();

      const alertChannel = await resolveStaffAlertChannel(message.guild);
      const staffPingPrefix = CONFIG.staffRoleId ? `<@&${CONFIG.staffRoleId}> ` : '';

      if (alertChannel) {
        await alertChannel.send({
          content: `${staffPingPrefix}urgent player report received`,
          embeds: [emergencyEmbed],
        });
      } else {
        console.warn('[HELPOP] No dedicated alert channel could be resolved; sending in source channel.');
        await message.channel.send({
          content: `${staffPingPrefix}urgent player report received`,
          embeds: [emergencyEmbed],
        });
      }

      await sendPrivateUserNotice(message, '🚨 Your alert has been transmitted to the moderation team securely.');
      return;
    }

    if (content === '!setup-tickets') {
      const canManageGuild = message.member.permissions.has(PermissionFlagsBits.ManageGuild);
      if (!canManageGuild) {
        await message.reply('You need the Manage Server permission to use this command.');
        return;
      }

      const { embed, row } = buildTicketPanel();
      await message.channel.send({ embeds: [embed], components: [row] });
      await message.reply('Ticket panel created successfully.');
      return;
    }

    if (content === '!setup-teams-system') {
      const canManageGuild = message.member.permissions.has(PermissionFlagsBits.ManageGuild);
      if (!canManageGuild) {
        await message.reply('You need the Manage Server permission to use this command.');
        return;
      }

      const { embed, row } = buildTeamSystemPanel();
      await message.channel.send({ embeds: [embed], components: [row] });
      await message.reply('Dynamic team system panel created successfully.');
      return;
    }

    if (content.startsWith('!add-member')) {
      const teamRole = resolveTeamRoleForChannel(message.guild, message.channel);
      if (!teamRole || message.channel.type !== ChannelType.GuildText) {
        await message.reply('❌ This command can only be used inside your team HQ text channel.');
        return;
      }

      if (!canManageSpecificTeam(message.member, teamRole)) {
        await message.reply('❌ Only the Team Owner can manage the roster.');
        return;
      }

      const targetMember = message.mentions.members.first();
      if (!targetMember) {
        await message.reply('Usage: `!add-member @member`');
        return;
      }

      if (targetMember.id === message.member.id) {
        await message.reply('❌ You are already in your own team.');
        return;
      }

      const existingTargetTeam = getMemberTeamRoles(targetMember).first();
      if (existingTargetTeam && existingTargetTeam.id !== teamRole.id) {
        await message.reply(`${targetMember.user.tag} is already in ${existingTargetTeam.name}. Members can only be in one team.`);
        return;
      }

      if (targetMember.roles.cache.has(teamRole.id)) {
        await message.reply(`${targetMember.user.tag} is already in ${teamRole.name}.`);
        return;
      }

      await targetMember.roles.add(teamRole, `Added to ${teamRole.name} by ${message.author.tag}`);
      await clearMemberTeamChannelOverwrite(message.guild, teamRole.id, targetMember.id);
      await upsertTeamRosterMember(teamRole.id, targetMember.id, targetMember.user.tag, message.author.id);

      await message.reply(`➕ Added ${targetMember} to the team roster!`);
      await message.channel.send({ content: `👋 Welcome ${targetMember} to the team!` });
      return;
    }

    if (content.startsWith('!whitelist-reset')) {
      const isStaff = CONFIG.staffRoleId && message.member.roles.cache.has(CONFIG.staffRoleId);
      const canManageGuild = message.member.permissions.has(PermissionFlagsBits.ManageGuild);

      if (!isStaff && !canManageGuild) {
        await message.reply('❌ Only staff can reset whitelist requests.');
        return;
      }

      const mentionedUser = message.mentions.users.first();
      const rawArg = content.split(/\s+/)[1] || '';
      const fallbackId = rawArg.replace(/\D/g, '');
      const targetUserId = mentionedUser?.id || fallbackId;

      if (!targetUserId || targetUserId.length < 17 || targetUserId.length > 20) {
        await message.reply('Usage: !whitelist-reset @user (or !whitelist-reset USER_ID)');
        return;
      }

      const removed = await clearWhitelistSubmission(targetUserId);
      if (!removed) {
        await message.reply(`No whitelist request lock was found for <@${targetUserId}>.`);
        return;
      }

      await message.reply(`✅ Whitelist request lock removed for <@${targetUserId}>. They can submit a new whitelist ticket now.`);
      return;
    }

    if (content === '!leave-team') {
      const member = message.member;
      const memberTeamRoles = getMemberTeamRoles(member);
      const existingMemberTeam = memberTeamRoles.first();

      if (!existingMemberTeam) {
        await message.reply('You are not currently in a team.');
        return;
      }

      await member.roles.remove(existingMemberTeam, `Left team via command by ${message.author.tag}`);
      await denyMemberInTeamChannels(message.guild, existingMemberTeam.id, member.id);
      await disconnectMemberFromTeamVoice(message.guild, existingMemberTeam.id, member.id);
      await removeTeamRosterMember(existingMemberTeam.id, member.id);

      const hasAnyTeamLeft = getMemberTeamRoles(member).size > 0;
      if (!hasAnyTeamLeft && CONFIG.teamOwnerRoleId && member.roles.cache.has(CONFIG.teamOwnerRoleId)) {
        await member.roles.remove(CONFIG.teamOwnerRoleId, 'Removed Team Owner role after leaving final team');
      }

      // Auto-cleanup if team is now empty
      await autoCleanupEmptyTeam(message.guild, existingMemberTeam);

      await message.reply(`You have left ${existingMemberTeam.name}.`);
      return;
    }

    // ─── LEADERBOARD COMMANDS ─────────────────────────────────────────────

    if (content.startsWith('!simulate-kill')) {
      const staffMember = message.member;
      if (!CONFIG.staffRoleId || !staffMember.roles.cache.has(CONFIG.staffRoleId)) {
        await message.reply('❌ Only staff can use simulation commands.');
        return;
      }
      const target = message.mentions.members.first();
      if (!target) {
        await message.reply('Usage: `!simulate-kill @user`');
        return;
      }
      await incrementKill(target.id, target.user.username);
      await message.reply(`✅ Recorded a kill for **${target.user.username}**.`);
      return;
    }

    if (content.startsWith('!simulate-death')) {
      const staffMember = message.member;
      if (!CONFIG.staffRoleId || !staffMember.roles.cache.has(CONFIG.staffRoleId)) {
        await message.reply('❌ Only staff can use simulation commands.');
        return;
      }
      const target = message.mentions.members.first();
      if (!target) {
        await message.reply('Usage: `!simulate-death @user`');
        return;
      }
      await incrementDeath(target.id, target.user.username);
      await message.reply(`✅ Recorded a death for **${target.user.username}**.`);
      return;
    }

    if (content.startsWith('!top')) {
      const args = content.split(/\s+/);
      const subCmd = (args[1] || '').toLowerCase();

      if (!subCmd) {
        const navEmbed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('📊 Leaderboard Categories')
          .setDescription(
            '**Use one of the following commands to view a leaderboard:**\n\n' +
            '`!top kills` — ⚔️ Most Kills\n' +
            '`!top deaths` — 💀 Hardcore Survivors (Fewest Deaths)\n' +
            '`!top time` — ⏱️ Most Time Played'
          )
          .setFooter({ text: 'Top 10 players per category' })
          .setTimestamp();
        await message.channel.send({ embeds: [navEmbed] });
        return;
      }

      if (!['kills', 'deaths', 'time'].includes(subCmd)) {
        await message.reply('❌ Unknown category. Use `!top kills`, `!top deaths`, or `!top time`.');
        return;
      }

      const embed = await buildLeaderboardEmbed(subCmd);
      await message.channel.send({ embeds: [embed] });
      return;
    }

    if (CONFIG.minecraftChatChannelId && message.channel.id === CONFIG.minecraftChatChannelId) {
      const relayPreview = formatMinecraftRelayPreview(message);

      // Placeholder backbone behavior: acknowledge processed chat and log the relay payload.
      console.log('[MC-CHAT] Relay payload preview:', relayPreview);

      await message.react('✅').catch(() => null);
      await message.channel.send({
        content: `Processed for MC relay: ${relayPreview}`,
      });
    }
  } catch (error) {
    console.error('[MESSAGE] Error handling messageCreate event:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isUserSelectMenu()) {
      if (interaction.customId === 'kick_member_select') {
        await handleKickMemberSelect(interaction);
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'ticket_type_select') {
        const ticketType = interaction.values[0];
        const validTypes = ['ticket_general', 'ticket_report', 'ticket_whitelist'];

        if (!validTypes.includes(ticketType)) {
          await interaction.reply({
            content: '❌ Invalid ticket type selected.',
            ephemeral: true,
          });
          return;
        }

        const typeMap = {
          ticket_general: 'general',
          ticket_report: 'report',
          ticket_whitelist: 'whitelist',
        };

        await createTicketChannel(interaction, typeMap[ticketType]);
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'launch_team_modal') {
        const modal = new ModalBuilder()
          .setCustomId('team_registration_modal')
          .setTitle('Register Your Team');

        const teamNameInput = new TextInputBuilder()
          .setCustomId('team_name_input')
          .setLabel('What is your Team Name?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20);

        const row = new ActionRowBuilder().addComponents(teamNameInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'close_ticket') {
        await handleCloseTicket(interaction);
        return;
      }

      if (interaction.customId === 'disband_team') {
        await handleDisbandTeam(interaction);
        return;
      }

      if (interaction.customId === 'add_team_member') {
        const member = interaction.member;
        const teamRole = interaction.guild && interaction.channel
          ? resolveTeamRoleForChannel(interaction.guild, interaction.channel)
          : null;

        if (!teamRole || !canManageSpecificTeam(member, teamRole)) {
          await interaction.reply({
            content: '❌ Only the Team Owner can manage the roster.',
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: 'Use `!add-member @member` inside this HQ channel to add teammates instantly.',
          ephemeral: true,
        });
        return;
      }

      if (interaction.customId === 'kick_member_init') {
        const member = interaction.member;
        const teamRole = interaction.guild && interaction.channel
          ? resolveTeamRoleForChannel(interaction.guild, interaction.channel)
          : null;

        if (!teamRole || !canManageSpecificTeam(member, teamRole)) {
          await interaction.reply({
            content: '❌ Only the Team Owner can manage the roster.',
            ephemeral: true,
          });
          return;
        }

        const selectRow = new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId('kick_member_select')
            .setPlaceholder('Select a teammate to kick')
            .setMinValues(1)
            .setMaxValues(1)
        );

        await interaction.reply({
          content: 'Choose a teammate to remove from this team:',
          components: [selectRow],
          ephemeral: true,
        });
        return;
      }

      if (interaction.customId === 'leave_team') {
        await handleLeaveTeam(interaction);
        return;
      }

      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'team_registration_modal') {
        await handleCreateTeamModalSubmission(interaction);
        return;
      }

      if (interaction.customId === 'add_member_modal') {
        await handleAddMemberModalSubmission(interaction);
      }
      return;
    }
  } catch (error) {
    console.error('[INTERACTION] Error handling interaction:', error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'An unexpected error occurred while handling this interaction.',
        ephemeral: true,
      });
    }
  }
});

// ─── VOICE TIME TRACKING ─────────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId = newState.member?.id ?? oldState.member?.id;
  const username = newState.member?.user?.username ?? oldState.member?.user?.username ?? userId;
  if (!userId) return;

  const joinedChannel = !oldState.channelId && newState.channelId;
  const leftChannel = oldState.channelId && !newState.channelId;

  if (joinedChannel) {
    voiceJoinTimes.set(userId, Date.now());
    return;
  }

  if (leftChannel) {
    const joinedAt = voiceJoinTimes.get(userId);
    if (!joinedAt) return;
    voiceJoinTimes.delete(userId);
    const elapsedMinutes = Math.floor((Date.now() - joinedAt) / 60000);
    await addMinutesPlayed(userId, username, elapsedMinutes);
  }
});

(async () => {
  try {
    initializeDatabase();
    await client.login(CONFIG.token);
  } catch (error) {
    console.error('[BOOT] Failed to login to Discord:', error);
    process.exit(1);
  }
})();
