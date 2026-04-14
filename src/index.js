require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

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

function buildSalesSubmissionEmbed(entry) {
  return new EmbedBuilder()
    .setTitle("New Sales Submission")
    .setColor(0x2e8b57)
    .addFields(
      { name: "Agent Name", value: entry.agentName, inline: true },
      { name: "Company", value: entry.company, inline: true },
      { name: "Product", value: entry.product, inline: true },
      { name: "AP", value: String(entry.ap), inline: true },
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
        return `**#${item.rank}** ${label} - ${item.totalScore}`;
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
    .setName("top")
    .setDescription("Update the daily and monthly top 10 sales leaderboards."),
  new SlashCommandBuilder()
    .setName("manager_daily_ap")
    .setDescription("Manager: show today's AP summary for all agents.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
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
          .setLabel("AP (number)")
          .setPlaceholder("Example: 10")
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

      if (interaction.commandName === "top") {
        const submissions = loadSubmissions();
        await postLeaderboards(client, submissions);
        await interaction.reply({
          content: "Daily and monthly leaderboard messages updated.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "manager_daily_ap") {
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
            return `**${index + 1}.** ${label} - AP: ${row.totalAp} (Sales: ${row.salesCount})`;
          })
          .join("\n")
          .slice(0, 4000);

        const summaryEmbed = new EmbedBuilder()
          .setTitle("Manager Daily AP Summary")
          .setDescription(description)
          .addFields(
            { name: "Total AP Today", value: String(totalAp), inline: true },
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
    }

    if (interaction.isModalSubmit() && interaction.customId === "submit-sales-modal") {
      const agentName = interaction.fields.getTextInputValue("agentName").trim();
      const company = interaction.fields.getTextInputValue("company").trim();
      const product = interaction.fields.getTextInputValue("product").trim();
      const apRaw = interaction.fields.getTextInputValue("ap").trim();
      const notes = interaction.fields.getTextInputValue("notes").trim();

      const ap = Number(apRaw);
      if (!Number.isFinite(ap) || ap < 0) {
        await interaction.reply({
          content: "AP must be a non-negative number.",
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
