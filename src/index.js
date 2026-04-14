require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const XLSX = require("xlsx");

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  SUBMISSION_CHANNEL_ID,
  SALES_LOG_CHANNEL_ID,
  CHECKIN_LOG_CHANNEL_ID,
  LEADERBOARD_CHANNEL_ID,
  DATA_DIR,
} = process.env;

const REQUIRED_ENV = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "SUBMISSION_CHANNEL_ID",
  "SALES_LOG_CHANNEL_ID",
  "CHECKIN_LOG_CHANNEL_ID",
  "LEADERBOARD_CHANNEL_ID",
];

const MANAGER_ROLE_ID = "1493320548535636038";
const CEO_USER_ID = "1493320537185714359";
const CEO_ROLE_ID = "1493320537185714359";

const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const dataDir = DATA_DIR ? path.resolve(DATA_DIR) : path.join(__dirname, "..", "data");
const dataFile = path.join(dataDir, "submissions.json");
const leaderboardStateFile = path.join(dataDir, "leaderboard-state.json");
const submissionStateFile = path.join(dataDir, "submission-channel-state.json");

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function writeJsonFile(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadSubmissions() {
  if (!fs.existsSync(dataFile)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(dataFile, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Failed to load submissions.json, starting with empty list.", error);
    return [];
  }
}

function saveSubmissions(submissions) {
  writeJsonFile(dataFile, submissions);
}

function loadLeaderboardState() {
  if (!fs.existsSync(leaderboardStateFile)) {
    return { dailyMessageId: null, monthlyMessageId: null };
  }

  try {
    const raw = fs.readFileSync(leaderboardStateFile, "utf-8");
    const parsed = JSON.parse(raw);

    const legacyMessageId = typeof parsed.messageId === "string" ? parsed.messageId : null;
    const dailyMessageId = typeof parsed.dailyMessageId === "string" ? parsed.dailyMessageId : null;
    const monthlyMessageId =
      typeof parsed.monthlyMessageId === "string" ? parsed.monthlyMessageId : legacyMessageId;

    return {
      dailyMessageId,
      monthlyMessageId,
    };
  } catch (error) {
    console.error("Failed to load leaderboard-state.json, resetting state.", error);
    return { dailyMessageId: null, monthlyMessageId: null };
  }
}

function saveLeaderboardState(state) {
  writeJsonFile(leaderboardStateFile, state);
}

function loadSubmissionChannelState() {
  if (!fs.existsSync(submissionStateFile)) {
    return { instructionMessageId: null };
  }

  try {
    const raw = fs.readFileSync(submissionStateFile, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      instructionMessageId:
        typeof parsed.instructionMessageId === "string" ? parsed.instructionMessageId : null,
    };
  } catch (error) {
    console.error("Failed to load submission-channel-state.json, resetting state.", error);
    return { instructionMessageId: null };
  }
}

function saveSubmissionChannelState(state) {
  writeJsonFile(submissionStateFile, state);
}

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isSameLocalMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function isSameLocalYear(a, b) {
  return a.getFullYear() === b.getFullYear();
}

function isInPeriod(date, period) {
  const now = new Date();
  if (period === "daily") {
    return isSameLocalDay(date, now);
  }
  if (period === "monthly") {
    return isSameLocalMonth(date, now);
  }
  if (period === "yearly") {
    return isSameLocalYear(date, now);
  }
  return true;
}

function parseApAmount(input) {
  const cleaned = String(input).trim().replace(/[$,\s]/g, "");
  if (!cleaned) {
    return null;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function buildLeaderboard(submissions, period) {
  const totals = new Map();
  const now = new Date();

  for (const entry of submissions) {
    if ((entry.formType ?? "sales") !== "sales") {
      continue;
    }

    const agentName = entry.agentName ?? entry.performerName;
    const ap = typeof entry.ap === "number" ? entry.ap : entry.score;

    if (!agentName || !Number.isFinite(ap)) {
      continue;
    }

    const createdAt = new Date(entry.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      continue;
    }

    if (period === "daily" && !isSameLocalDay(createdAt, now)) {
      continue;
    }

    if (period === "monthly" && !isSameLocalMonth(createdAt, now)) {
      continue;
    }

    // Use Discord user ID as the canonical identity when available so
    // name typos/variants still map to the same person.
    const identityKey = entry.submittedBy ? `user:${entry.submittedBy}` : `name:${agentName.toLowerCase()}`;
    const current = totals.get(identityKey) ?? {
      totalScore: 0,
      submittedBy: entry.submittedBy ?? null,
      displayName: agentName,
    };

    current.totalScore += ap;
    current.displayName = agentName;
    if (entry.submittedBy) {
      current.submittedBy = entry.submittedBy;
    }

    totals.set(identityKey, current);
  }

  return [...totals.values()]
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 10)
    .map((item, index) => ({
      rank: index + 1,
      name: item.displayName,
      submittedBy: item.submittedBy,
      totalScore: item.totalScore,
    }));
}

function buildDailyApSummary(submissions) {
  const totals = new Map();
  const now = new Date();

  for (const entry of submissions) {
    if ((entry.formType ?? "sales") !== "sales") {
      continue;
    }

    const createdAt = new Date(entry.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !isSameLocalDay(createdAt, now)) {
      continue;
    }

    const agentName = entry.agentName ?? entry.performerName;
    const ap = typeof entry.ap === "number" ? entry.ap : entry.score;
    if (!agentName || !Number.isFinite(ap)) {
      continue;
    }

    const identityKey = entry.submittedBy ? `user:${entry.submittedBy}` : `name:${agentName.toLowerCase()}`;
    const current = totals.get(identityKey) ?? {
      totalAp: 0,
      salesCount: 0,
      submittedBy: entry.submittedBy ?? null,
      displayName: agentName,
    };

    current.totalAp += ap;
    current.salesCount += 1;
    current.displayName = agentName;
    if (entry.submittedBy) {
      current.submittedBy = entry.submittedBy;
    }

    totals.set(identityKey, current);
  }

  return [...totals.values()].sort((a, b) => b.totalAp - a.totalAp);
}

function resolveSaleAp(entry) {
  if (typeof entry.ap === "number") {
    return entry.ap;
  }
  if (typeof entry.score === "number") {
    return entry.score;
  }
  return null;
}

function resolveSaleAgentName(entry) {
  if (typeof entry.agentName === "string" && entry.agentName.trim()) {
    return entry.agentName.trim();
  }
  if (typeof entry.performerName === "string" && entry.performerName.trim()) {
    return entry.performerName.trim();
  }
  return null;
}

function buildPersonSalesSummary(submissions, { userId, agentName, period }) {
  const matches = [];

  for (const entry of submissions) {
    if ((entry.formType ?? "sales") !== "sales") {
      continue;
    }

    const createdAt = new Date(entry.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !isInPeriod(createdAt, period)) {
      continue;
    }

    const entryAgentName = resolveSaleAgentName(entry);
    const ap = resolveSaleAp(entry);
    if (!entryAgentName || ap === null) {
      continue;
    }

    const byUser = userId && entry.submittedBy === userId;
    const byAgentName =
      agentName && entryAgentName.toLowerCase() === agentName.trim().toLowerCase();

    if (!byUser && !byAgentName) {
      continue;
    }

    matches.push({
      id: entry.id,
      agentName: entryAgentName,
      submittedBy: entry.submittedBy ?? null,
      ap,
      createdAt,
    });
  }

  const totalAp = matches.reduce((sum, entry) => sum + entry.ap, 0);
  return { matches, totalAp };
}

function filterEntriesForExport(submissions, { period, userId, agentName, formType }) {
  return submissions.filter((entry) => {
    const createdAt = new Date(entry.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !isInPeriod(createdAt, period)) {
      return false;
    }

    if (formType !== "all" && (entry.formType ?? "sales") !== formType) {
      return false;
    }

    if (userId && entry.submittedBy !== userId) {
      return false;
    }

    if (agentName) {
      const resolvedName =
        (entry.agentName ?? entry.performerName ?? "").toString().trim().toLowerCase();
      if (resolvedName !== agentName.trim().toLowerCase()) {
        return false;
      }
    }

    return true;
  });
}

function formatDateForExport(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

function buildExportRows(entries, formType) {
  const sorted = entries
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (formType === "sales") {
    return sorted.map((entry) => ({
      Date: formatDateForExport(entry.createdAt),
      Name: entry.agentName ?? entry.performerName ?? "",
      Company: entry.company ?? "",
      Product: entry.product ?? "",
      AP: resolveSaleAp(entry) ?? "",
      Notes: entry.notes ?? "",
    }));
  }

  if (formType === "daily_checkin") {
    return sorted.map((entry) => ({
      Date: formatDateForExport(entry.createdAt),
      Name: entry.agentName ?? "",
      "Calls Made": entry.callsMade ?? "",
      "Appointments Made": entry.appointmentsMade ?? "",
      "Policies Closed": entry.policiesClosed ?? "",
      Notes: entry.notes ?? "",
    }));
  }

  return sorted.map((entry) => ({
    Date: formatDateForExport(entry.createdAt),
    Type: entry.formType ?? "sales",
    Name: entry.agentName ?? entry.performerName ?? "",
    Company: entry.company ?? "",
    Product: entry.product ?? "",
    AP: resolveSaleAp(entry) ?? "",
    "Calls Made": entry.callsMade ?? "",
    "Appointments Made": entry.appointmentsMade ?? "",
    "Policies Closed": entry.policiesClosed ?? "",
    Notes: entry.notes ?? "",
  }));
}

function buildEntriesWorkbookBuffer(entries, formType) {
  const rows = buildExportRows(entries, formType);
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Entries");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function getEntryById(submissions, id) {
  return submissions.find((entry) => entry.id === id) ?? null;
}

function getEntryIndexById(submissions, id) {
  return submissions.findIndex((entry) => entry.id === id);
}

function canManageEntry(interaction, entry) {
  if (!entry) {
    return false;
  }
  if (entry.submittedBy === interaction.user.id) {
    return true;
  }
  return hasManagerAccess(interaction);
}

function hasManagerAccess(interaction) {
  if (interaction.user.id === CEO_USER_ID) {
    return true;
  }

  const roles = interaction.member?.roles;
  if (!roles) {
    return false;
  }

  if (Array.isArray(roles)) {
    return roles.includes(MANAGER_ROLE_ID) || roles.includes(CEO_ROLE_ID);
  }

  if (roles.cache) {
    return roles.cache.has(MANAGER_ROLE_ID) || roles.cache.has(CEO_ROLE_ID);
  }

  return false;
}

function buildEntrySummaryLine(entry) {
  if ((entry.formType ?? "sales") === "sales") {
    const ap = resolveSaleAp(entry) ?? 0;
    return `${resolveSaleAgentName(entry) ?? "Unknown"} - ${formatCurrency(ap)}`;
  }

  const name = entry.agentName ?? "Unknown";
  return `${name} - Calls ${entry.callsMade ?? 0}, Appts ${entry.appointmentsMade ?? 0}, Policies ${entry.policiesClosed ?? 0}`;
}

function buildEntriesSelect(interaction, userEntries) {
  const options = userEntries.slice(0, 25).map((entry) => {
    const createdAt = new Date(entry.createdAt);
    const dateLabel = Number.isNaN(createdAt.getTime())
      ? "Unknown date"
      : createdAt.toLocaleDateString("en-US");
    const typeLabel = (entry.formType ?? "sales") === "sales" ? "Sales" : "Check-In";

    return {
      label: `${typeLabel} | ${dateLabel}`.slice(0, 100),
      description: buildEntrySummaryLine(entry).slice(0, 100),
      value: entry.id,
    };
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId("entries-select")
    .setPlaceholder("Pick an entry to manage")
    .addOptions(options);

  return new ActionRowBuilder().addComponents(select);
}

function buildEntryActionButtons(entryId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`entries-edit:${entryId}`)
      .setLabel("Edit")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`entries-delete:${entryId}`)
      .setLabel("Delete")
      .setStyle(ButtonStyle.Danger)
  );
}

function buildDeleteConfirmButtons(entryId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`entries-delete-confirm:${entryId}`)
      .setLabel("Confirm Delete")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`entries-delete-cancel:${entryId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildEntryDetailsEmbed(entry) {
  const isSales = (entry.formType ?? "sales") === "sales";
  const createdAt = new Date(entry.createdAt);
  const embed = new EmbedBuilder()
    .setTitle(isSales ? "Sales Entry" : "Check-In Entry")
    .setColor(isSales ? 0x2e8b57 : 0x1e90ff)
    .setFooter({ text: `Entry ID: ${entry.id}` });

  if (!Number.isNaN(createdAt.getTime())) {
    embed.setTimestamp(createdAt);
  }

  if (isSales) {
    embed.addFields(
      { name: "Agent Name", value: entry.agentName ?? "Unknown", inline: true },
      { name: "Company", value: entry.company ?? "Unknown", inline: true },
      { name: "Product", value: entry.product ?? "Unknown", inline: true },
      { name: "AP", value: formatCurrency(resolveSaleAp(entry) ?? 0), inline: true },
      { name: "Notes", value: entry.notes || "None" }
    );
  } else {
    embed.addFields(
      { name: "Agent Name", value: entry.agentName ?? "Unknown", inline: true },
      { name: "Calls Made", value: String(entry.callsMade ?? 0), inline: true },
      { name: "Appointments Made", value: String(entry.appointmentsMade ?? 0), inline: true },
      { name: "Policies Closed", value: String(entry.policiesClosed ?? 0), inline: true },
      { name: "Notes", value: entry.notes || "None" }
    );
  }

  return embed;
}

function buildEditSalesModal(entry) {
  const modal = new ModalBuilder()
    .setCustomId(`edit-sales:${entry.id}`)
    .setTitle("Edit Sales Entry");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("agentName")
        .setLabel("Agent Name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50)
        .setValue(entry.agentName ?? "")
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("company")
        .setLabel("Company")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(80)
        .setValue(entry.company ?? "")
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("product")
        .setLabel("Product")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(80)
        .setValue(entry.product ?? "")
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("ap")
        .setLabel("AP ($ amount)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(15)
        .setValue(String(resolveSaleAp(entry) ?? 0))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Notes")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500)
        .setValue(entry.notes ?? "")
    )
  );

  return modal;
}

function buildEditCheckinModal(entry) {
  const modal = new ModalBuilder()
    .setCustomId(`edit-checkin:${entry.id}`)
    .setTitle("Edit Check-In Entry");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("agentName")
        .setLabel("Agent Name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50)
        .setValue(entry.agentName ?? "")
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("callsMade")
        .setLabel("Calls Made")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(8)
        .setValue(String(entry.callsMade ?? 0))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("appointmentsMade")
        .setLabel("Appointments Made")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(8)
        .setValue(String(entry.appointmentsMade ?? 0))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("policiesClosed")
        .setLabel("Policies Closed")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(8)
        .setValue(String(entry.policiesClosed ?? 0))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Notes")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500)
        .setValue(entry.notes ?? "")
    )
  );

  return modal;
}

function buildSalesSubmissionEmbed(entry) {
  return new EmbedBuilder()
    .setTitle("New Sales Submission")
    .setColor(0x2e8b57)
    .addFields(
      { name: "Agent Name", value: entry.agentName, inline: true },
      { name: "Company", value: entry.company, inline: true },
      { name: "Product", value: entry.product, inline: true },
      { name: "AP", value: formatCurrency(entry.ap), inline: true },
      { name: "Submitted By", value: `<@${entry.submittedBy}>`, inline: true },
      { name: "Notes", value: entry.notes || "None" }
    )
    .setFooter({ text: `Submission ID: ${entry.id}` })
    .setTimestamp(new Date(entry.createdAt));
}

function buildCheckInSubmissionEmbed(entry) {
  return new EmbedBuilder()
    .setTitle("New Daily Check-In")
    .setColor(0x1e90ff)
    .addFields(
      { name: "Agent Name", value: entry.agentName, inline: true },
      { name: "Calls Made", value: String(entry.callsMade), inline: true },
      { name: "Appointments Made", value: String(entry.appointmentsMade), inline: true },
      { name: "Policies Closed", value: String(entry.policiesClosed), inline: true },
      { name: "Submitted By", value: `<@${entry.submittedBy}>`, inline: true },
      { name: "Notes", value: entry.notes || "None" }
    )
    .setFooter({ text: `Submission ID: ${entry.id}` })
    .setTimestamp(new Date(entry.createdAt));
}

function buildLeaderboardEmbed(leaderboard, period) {
  const title = period === "daily" ? "Top 10 Daily Sales" : "Top 10 Monthly Sales";
  const lines = leaderboard.length
    ? leaderboard
      .map((item) => {
        const label = item.submittedBy ? `<@${item.submittedBy}>` : item.name;
        return `**#${item.rank}** ${label} - ${formatCurrency(item.totalScore)}`;
      })
      .join("\n")
    : period === "daily"
      ? "No sales submissions yet for today."
      : "No sales submissions yet for this month.";

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines)
    .setColor(0xffa500)
    .setTimestamp();
}

function buildSubmissionInstructionsEmbed() {
  return new EmbedBuilder()
    .setTitle("How To Submit")
    .setDescription(
      [
        "Use these commands in this channel:",
        "",
        "`/sales`",
        "Fields: Agent Name, Company, Product, AP, Notes",
        "",
        "`/checkin`",
        "Fields: Agent Name, Calls Made, Appointments Made, Policies Closed, Notes",
      ].join("\n")
    )
    .setColor(0x5865f2)
    .setTimestamp();
}

async function upsertLeaderboardMessage(channel, messageId, embed) {
  if (messageId) {
    try {
      const existing = await channel.messages.fetch(messageId);
      await existing.edit({ embeds: [embed] });
      return messageId;
    } catch (error) {
      console.error("Existing leaderboard message not found, creating a new one.", error);
    }
  }

  const created = await channel.send({ embeds: [embed] });
  return created.id;
}

async function upsertSubmissionInstructions(client) {
  const submissionChannel = await client.channels.fetch(SUBMISSION_CHANNEL_ID);
  if (!submissionChannel || submissionChannel.type !== ChannelType.GuildText) {
    throw new Error("SUBMISSION_CHANNEL_ID is invalid or not a text channel.");
  }

  const state = loadSubmissionChannelState();
  const embed = buildSubmissionInstructionsEmbed();

  if (state.instructionMessageId) {
    try {
      const message = await submissionChannel.messages.fetch(state.instructionMessageId);
      await message.edit({ embeds: [embed] });
      return;
    } catch (error) {
      console.error("Instruction message not found, creating a new one.", error);
    }
  }

  const newMessage = await submissionChannel.send({ embeds: [embed] });
  saveSubmissionChannelState({ instructionMessageId: newMessage.id });
}

async function postLeaderboards(client, submissions) {
  const leaderboardChannel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  if (!leaderboardChannel || leaderboardChannel.type !== ChannelType.GuildText) {
    throw new Error("LEADERBOARD_CHANNEL_ID is invalid or not a text channel.");
  }

  const dailyLeaderboard = buildLeaderboard(submissions, "daily");
  const monthlyLeaderboard = buildLeaderboard(submissions, "monthly");
  const dailyEmbed = buildLeaderboardEmbed(dailyLeaderboard, "daily");
  const monthlyEmbed = buildLeaderboardEmbed(monthlyLeaderboard, "monthly");
  const state = loadLeaderboardState();

  const dailyMessageId = await upsertLeaderboardMessage(
    leaderboardChannel,
    state.dailyMessageId,
    dailyEmbed
  );
  const monthlyMessageId = await upsertLeaderboardMessage(
    leaderboardChannel,
    state.monthlyMessageId,
    monthlyEmbed
  );

  saveLeaderboardState({ dailyMessageId, monthlyMessageId });
}

const commands = [
  new SlashCommandBuilder()
    .setName("sales")
    .setDescription("Open the sales submission form."),
  new SlashCommandBuilder()
    .setName("checkin")
    .setDescription("Open the daily check-in form."),
  new SlashCommandBuilder()
    .setName("entries")
    .setDescription("View your entries, or manager-read-only view of another user's entries.")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to view (manager read-only)")
    ),
  new SlashCommandBuilder()
    .setName("entires")
    .setDescription("Alias for /entries.")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to view (manager read-only)")
    ),
  new SlashCommandBuilder()
    .setName("top")
    .setDescription("Update the daily and monthly top 10 sales leaderboards."),
  new SlashCommandBuilder()
    .setName("dailyap")
    .setDescription("Manager: show today's AP summary for all agents.")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("saleslookup")
    .setDescription("Manager: view one person's sales by period.")
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("period")
        .setDescription("Time range")
        .setRequired(true)
        .addChoices(
          { name: "Daily", value: "daily" },
          { name: "Monthly", value: "monthly" },
          { name: "Yearly", value: "yearly" },
          { name: "All Time", value: "all_time" }
        )
    )
    .addUserOption((option) =>
      option.setName("user").setDescription("Discord user to look up")
    )
    .addStringOption((option) =>
      option.setName("agent_name").setDescription("Agent name to look up")
    ),
  new SlashCommandBuilder()
    .setName("downloadentries")
    .setDescription("Manager: download entries as an Excel file.")
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("period")
        .setDescription("Time range")
        .setRequired(true)
        .addChoices(
          { name: "Daily", value: "daily" },
          { name: "Monthly", value: "monthly" },
          { name: "Yearly", value: "yearly" },
          { name: "All Time", value: "all_time" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("form_type")
        .setDescription("Filter by form type")
        .setRequired(false)
        .addChoices(
          { name: "All", value: "all" },
          { name: "Sales", value: "sales" },
          { name: "Check-In", value: "daily_checkin" }
        )
    )
    .addUserOption((option) =>
      option.setName("user").setDescription("Filter by submitting user")
    )
    .addStringOption((option) =>
      option.setName("agent_name").setDescription("Filter by agent name")
    ),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });
  console.log("Slash commands registered.");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await upsertSubmissionInstructions(client);
  } catch (error) {
    console.error("Failed to post submission instructions:", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "sales") {
        if (interaction.channelId !== SUBMISSION_CHANNEL_ID) {
          await interaction.reply({
            content: `Please submit in <#${SUBMISSION_CHANNEL_ID}>.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId("submit-sales-modal")
          .setTitle("Sales Submission");

        const performerNameInput = new TextInputBuilder()
          .setCustomId("agentName")
          .setLabel("Agent Name")
          .setPlaceholder("Example: Alex")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50);

        const companyInput = new TextInputBuilder()
          .setCustomId("company")
          .setLabel("Company")
          .setPlaceholder("Example: Acme Corp")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80);

        const productInput = new TextInputBuilder()
          .setCustomId("product")
          .setLabel("Product")
          .setPlaceholder("Example: Premium Plan")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80);

        const apInput = new TextInputBuilder()
          .setCustomId("ap")
          .setLabel("AP ($ amount)")
          .setPlaceholder("Example: $10.50")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(10);

        const notesInput = new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("Notes")
          .setPlaceholder("Optional details")
          .setRequired(false)
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(500);

        modal.addComponents(
          new ActionRowBuilder().addComponents(performerNameInput),
          new ActionRowBuilder().addComponents(companyInput),
          new ActionRowBuilder().addComponents(productInput),
          new ActionRowBuilder().addComponents(apInput),
          new ActionRowBuilder().addComponents(notesInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.commandName === "checkin") {
        if (interaction.channelId !== SUBMISSION_CHANNEL_ID) {
          await interaction.reply({
            content: `Please submit in <#${SUBMISSION_CHANNEL_ID}>.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId("submit-checkin-modal")
          .setTitle("Daily Check-In");

        const agentNameInput = new TextInputBuilder()
          .setCustomId("agentName")
          .setLabel("Agent Name")
          .setPlaceholder("Example: Jordan")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50);

        const callsMadeInput = new TextInputBuilder()
          .setCustomId("callsMade")
          .setLabel("Calls Made")
          .setPlaceholder("Example: 40")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(8);

        const appointmentsMadeInput = new TextInputBuilder()
          .setCustomId("appointmentsMade")
          .setLabel("Appointments Made")
          .setPlaceholder("Example: 6")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(8);

        const policiesClosedInput = new TextInputBuilder()
          .setCustomId("policiesClosed")
          .setLabel("Policies Closed")
          .setPlaceholder("Example: 2")
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(8);

        const notesInput = new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("Notes")
          .setPlaceholder("Optional details")
          .setRequired(false)
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(500);

        modal.addComponents(
          new ActionRowBuilder().addComponents(agentNameInput),
          new ActionRowBuilder().addComponents(callsMadeInput),
          new ActionRowBuilder().addComponents(appointmentsMadeInput),
          new ActionRowBuilder().addComponents(policiesClosedInput),
          new ActionRowBuilder().addComponents(notesInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.commandName === "entries" || interaction.commandName === "entires") {
        const selectedUser = interaction.options.getUser("user");
        const targetUser = selectedUser ?? interaction.user;
        const viewingOwn = targetUser.id === interaction.user.id;

        if (!viewingOwn && !hasManagerAccess(interaction)) {
          await interaction.reply({
            content: "Only managers can view another user's entries.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const submissions = loadSubmissions();
        const userEntries = submissions
          .filter((entry) => entry.submittedBy === targetUser.id)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        if (userEntries.length === 0) {
          await interaction.reply({
            content: `${viewingOwn ? "You do" : "That user does"} not have any entries yet.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!viewingOwn) {
          const lines = userEntries.slice(0, 20).map((entry) => {
            const typeLabel = (entry.formType ?? "sales") === "sales" ? "Sales" : "Check-In";
            const createdAt = new Date(entry.createdAt);
            const dateLabel = Number.isNaN(createdAt.getTime())
              ? "Unknown date"
              : createdAt.toLocaleDateString("en-US");
            return `- ${typeLabel} | ${dateLabel} | ${buildEntrySummaryLine(entry)} | ID: ${entry.id}`;
          });

          const embed = new EmbedBuilder()
            .setTitle(`Entries for ${targetUser.tag}`)
            .setDescription(lines.join("\n").slice(0, 4000))
            .setColor(0x7289da)
            .setTimestamp();

          await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: "Select an entry to edit or delete:",
          components: [buildEntriesSelect(interaction, userEntries)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "top") {
        const submissions = loadSubmissions();
        await postLeaderboards(client, submissions);
        await interaction.reply({
          content: "Daily and monthly leaderboard messages updated.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "dailyap") {
        if (!hasManagerAccess(interaction)) {
          await interaction.reply({
            content: "Only managers or the CEO can use this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const submissions = loadSubmissions();
        const summaryRows = buildDailyApSummary(submissions);

        if (summaryRows.length === 0) {
          await interaction.reply({
            content: "No sales submissions found for today.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const totalAp = summaryRows.reduce((sum, row) => sum + row.totalAp, 0);
        const totalSales = summaryRows.reduce((sum, row) => sum + row.salesCount, 0);
        const description = summaryRows
          .map((row, index) => {
            const label = row.submittedBy ? `<@${row.submittedBy}>` : row.displayName;
            return `**${index + 1}.** ${label} - AP: ${formatCurrency(row.totalAp)} (Sales: ${row.salesCount})`;
          })
          .join("\n")
          .slice(0, 4000);

        const summaryEmbed = new EmbedBuilder()
          .setTitle("Manager Daily AP Summary")
          .setDescription(description)
          .addFields(
            { name: "Total AP Today", value: formatCurrency(totalAp), inline: true },
            { name: "Total Sales Today", value: String(totalSales), inline: true },
            { name: "Agents Reported", value: String(summaryRows.length), inline: true }
          )
          .setColor(0x00b894)
          .setTimestamp();

        await interaction.reply({
          embeds: [summaryEmbed],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "saleslookup") {
        if (!hasManagerAccess(interaction)) {
          await interaction.reply({
            content: "Only managers or the CEO can use this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const user = interaction.options.getUser("user");
        const agentName = interaction.options.getString("agent_name");
        const period = interaction.options.getString("period", true);

        if (!user && !agentName) {
          await interaction.reply({
            content: "Provide either `user` or `agent_name`.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const submissions = loadSubmissions();
        const { matches, totalAp } = buildPersonSalesSummary(submissions, {
          userId: user?.id ?? null,
          agentName: agentName ?? null,
          period,
        });

        if (matches.length === 0) {
          await interaction.reply({
            content: "No matching sales found for that person and period.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const periodLabel =
          period === "daily"
            ? "Daily"
            : period === "monthly"
              ? "Monthly"
              : period === "yearly"
                ? "Yearly"
                : "All Time";
        const personLabel = user ? `<@${user.id}>` : agentName;
        const lines = matches
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 20)
          .map((entry) => {
            const date = entry.createdAt.toLocaleDateString("en-US");
            return `- ${date} - ${formatCurrency(entry.ap)} (${entry.agentName})`;
          })
          .join("\n");

        const embed = new EmbedBuilder()
          .setTitle("Sales Lookup")
          .setDescription(lines)
          .addFields(
            { name: "Person", value: String(personLabel), inline: true },
            { name: "Period", value: periodLabel, inline: true },
            { name: "Entries", value: String(matches.length), inline: true },
            { name: "Total AP", value: formatCurrency(totalAp) }
          )
          .setColor(0x2d9cdb)
          .setTimestamp();

        await interaction.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "downloadentries") {
        if (!hasManagerAccess(interaction)) {
          await interaction.reply({
            content: "Only managers or the CEO can use this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const period = interaction.options.getString("period", true);
        const formType = interaction.options.getString("form_type") ?? "all";
        const user = interaction.options.getUser("user");
        const agentName = interaction.options.getString("agent_name");

        const submissions = loadSubmissions();
        const filteredEntries = filterEntriesForExport(submissions, {
          period,
          userId: user?.id ?? null,
          agentName: agentName ?? null,
          formType,
        });

        if (filteredEntries.length === 0) {
          await interaction.reply({
            content: "No entries matched those filters.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const workbookBuffer = buildEntriesWorkbookBuffer(filteredEntries, formType);
        const dateStamp = new Date().toISOString().slice(0, 10);
        const filename = `entries-${period}-${formType}-${dateStamp}.xlsx`;
        const attachment = new AttachmentBuilder(workbookBuffer, { name: filename });

        await interaction.reply({
          content: `Export ready. ${filteredEntries.length} entries included.`,
          files: [attachment],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "entries-select") {
      const entryId = interaction.values[0];
      const submissions = loadSubmissions();
      const entry = getEntryById(submissions, entryId);

      if (!canManageEntry(interaction, entry)) {
        await interaction.update({
          content: "You do not have permission to manage that entry.",
          embeds: [],
          components: [],
        });
        return;
      }

      await interaction.update({
        content: "Entry selected. Choose an action:",
        embeds: [buildEntryDetailsEmbed(entry)],
        components: [buildEntryActionButtons(entry.id)],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("entries-edit:")) {
      const entryId = interaction.customId.split(":")[1];
      const submissions = loadSubmissions();
      const entry = getEntryById(submissions, entryId);

      if (!canManageEntry(interaction, entry)) {
        await interaction.reply({
          content: "You do not have permission to edit that entry.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if ((entry.formType ?? "sales") === "sales") {
        await interaction.showModal(buildEditSalesModal(entry));
      } else {
        await interaction.showModal(buildEditCheckinModal(entry));
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("entries-delete:")) {
      const entryId = interaction.customId.split(":")[1];
      const submissions = loadSubmissions();
      const entry = getEntryById(submissions, entryId);

      if (!canManageEntry(interaction, entry)) {
        await interaction.update({
          content: "You do not have permission to delete that entry.",
          embeds: [],
          components: [],
        });
        return;
      }

      await interaction.update({
        content: "Are you sure you want to delete this entry?",
        embeds: [buildEntryDetailsEmbed(entry)],
        components: [buildDeleteConfirmButtons(entry.id)],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("entries-delete-confirm:")) {
      const entryId = interaction.customId.split(":")[1];
      const submissions = loadSubmissions();
      const entryIndex = getEntryIndexById(submissions, entryId);
      const entry = entryIndex >= 0 ? submissions[entryIndex] : null;

      if (!canManageEntry(interaction, entry)) {
        await interaction.update({
          content: "You do not have permission to delete that entry.",
          embeds: [],
          components: [],
        });
        return;
      }

      submissions.splice(entryIndex, 1);
      saveSubmissions(submissions);

      if ((entry.formType ?? "sales") === "sales") {
        await postLeaderboards(client, submissions);
      }

      await interaction.update({
        content: "Entry deleted successfully.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("entries-delete-cancel:")) {
      const entryId = interaction.customId.split(":")[1];
      const submissions = loadSubmissions();
      const entry = getEntryById(submissions, entryId);

      if (!canManageEntry(interaction, entry)) {
        await interaction.update({
          content: "Action cancelled.",
          embeds: [],
          components: [],
        });
        return;
      }

      await interaction.update({
        content: "Delete cancelled. Choose an action:",
        embeds: [buildEntryDetailsEmbed(entry)],
        components: [buildEntryActionButtons(entry.id)],
      });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("edit-sales:")) {
      const entryId = interaction.customId.split(":")[1];
      const submissions = loadSubmissions();
      const entryIndex = getEntryIndexById(submissions, entryId);
      const entry = entryIndex >= 0 ? submissions[entryIndex] : null;

      if (!canManageEntry(interaction, entry)) {
        await interaction.reply({
          content: "You do not have permission to edit that entry.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const agentName = interaction.fields.getTextInputValue("agentName").trim();
      const company = interaction.fields.getTextInputValue("company").trim();
      const product = interaction.fields.getTextInputValue("product").trim();
      const apRaw = interaction.fields.getTextInputValue("ap").trim();
      const notes = interaction.fields.getTextInputValue("notes").trim();
      const ap = parseApAmount(apRaw);

      if (!agentName || !company || !product || ap === null) {
        await interaction.reply({
          content: "Invalid values. Please provide Agent Name, Company, Product, and a valid AP amount.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      submissions[entryIndex] = {
        ...entry,
        agentName,
        company,
        product,
        ap,
        notes,
      };
      saveSubmissions(submissions);
      await postLeaderboards(client, submissions);

      await interaction.reply({
        content: "Sales entry updated successfully.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("edit-checkin:")) {
      const entryId = interaction.customId.split(":")[1];
      const submissions = loadSubmissions();
      const entryIndex = getEntryIndexById(submissions, entryId);
      const entry = entryIndex >= 0 ? submissions[entryIndex] : null;

      if (!canManageEntry(interaction, entry)) {
        await interaction.reply({
          content: "You do not have permission to edit that entry.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const agentName = interaction.fields.getTextInputValue("agentName").trim();
      const callsMade = Number(interaction.fields.getTextInputValue("callsMade").trim());
      const appointmentsMade = Number(interaction.fields.getTextInputValue("appointmentsMade").trim());
      const policiesClosed = Number(interaction.fields.getTextInputValue("policiesClosed").trim());
      const notes = interaction.fields.getTextInputValue("notes").trim();

      if (
        !agentName ||
        !Number.isFinite(callsMade) ||
        !Number.isFinite(appointmentsMade) ||
        !Number.isFinite(policiesClosed) ||
        callsMade < 0 ||
        appointmentsMade < 0 ||
        policiesClosed < 0
      ) {
        await interaction.reply({
          content: "Invalid values. Please provide valid non-negative numbers.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      submissions[entryIndex] = {
        ...entry,
        agentName,
        callsMade,
        appointmentsMade,
        policiesClosed,
        notes,
      };
      saveSubmissions(submissions);

      await interaction.reply({
        content: "Check-in entry updated successfully.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "submit-sales-modal") {
      const agentName = interaction.fields.getTextInputValue("agentName").trim();
      const company = interaction.fields.getTextInputValue("company").trim();
      const product = interaction.fields.getTextInputValue("product").trim();
      const apRaw = interaction.fields.getTextInputValue("ap").trim();
      const notes = interaction.fields.getTextInputValue("notes").trim();

      const ap = parseApAmount(apRaw);
      if (ap === null) {
        await interaction.reply({
          content: "AP must be a non-negative amount (examples: 10, $10, 1,250.50).",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const entry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        formType: "sales",
        agentName,
        company,
        product,
        ap,
        notes,
        submittedBy: interaction.user.id,
        createdAt: new Date().toISOString(),
      };

      const submissions = loadSubmissions();
      submissions.push(entry);
      saveSubmissions(submissions);

      const salesLogChannel = await client.channels.fetch(SALES_LOG_CHANNEL_ID);
      if (!salesLogChannel || salesLogChannel.type !== ChannelType.GuildText) {
        throw new Error("SALES_LOG_CHANNEL_ID is invalid or not a text channel.");
      }

      await salesLogChannel.send({ embeds: [buildSalesSubmissionEmbed(entry)] });
      await postLeaderboards(client, submissions);

      await interaction.reply({
        content: "Sales submission recorded and leaderboard updated.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === "submit-checkin-modal") {
      const agentName = interaction.fields.getTextInputValue("agentName").trim();
      const callsMadeRaw = interaction.fields.getTextInputValue("callsMade").trim();
      const appointmentsMadeRaw = interaction.fields.getTextInputValue("appointmentsMade").trim();
      const policiesClosedRaw = interaction.fields.getTextInputValue("policiesClosed").trim();
      const notes = interaction.fields.getTextInputValue("notes").trim();

      const callsMade = Number(callsMadeRaw);
      const appointmentsMade = Number(appointmentsMadeRaw);
      const policiesClosed = Number(policiesClosedRaw);

      if (
        !Number.isFinite(callsMade) ||
        !Number.isFinite(appointmentsMade) ||
        !Number.isFinite(policiesClosed) ||
        callsMade < 0 ||
        appointmentsMade < 0 ||
        policiesClosed < 0
      ) {
        await interaction.reply({
          content: "Calls made, appointments made, and policies closed must be non-negative numbers.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const entry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        formType: "daily_checkin",
        agentName,
        callsMade,
        appointmentsMade,
        policiesClosed,
        notes,
        submittedBy: interaction.user.id,
        createdAt: new Date().toISOString(),
      };

      const submissions = loadSubmissions();
      submissions.push(entry);
      saveSubmissions(submissions);

      const checkInLogChannel = await client.channels.fetch(CHECKIN_LOG_CHANNEL_ID);
      if (!checkInLogChannel || checkInLogChannel.type !== ChannelType.GuildText) {
        throw new Error("CHECKIN_LOG_CHANNEL_ID is invalid or not a text channel.");
      }

      await checkInLogChannel.send({ embeds: [buildCheckInSubmissionEmbed(entry)] });

      await interaction.reply({
        content: "Daily check-in recorded and posted to the tracking channel.",
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    console.error("Interaction handling failed:", error);

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: "Something went wrong while processing that request.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: "Something went wrong while processing that request.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
});

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
